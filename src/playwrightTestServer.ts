/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import path from 'path';
import { ConfigFindRelatedTestFilesReport, ConfigListFilesReport } from './listTests';
import * as vscodeTypes from './vscodeTypes';
import * as reporterTypes from './upstream/reporter';
import { TeleReporterReceiver } from './upstream/teleReceiver';
import { TestServerConnection } from './upstream/testServerConnection';
import { startBackend } from './backend';
import type { PlaywrightTestOptions, PlaywrightTestRunOptions } from './playwrightTestTypes';
import { escapeRegex, pathSeparator } from './utils';
import { debugSessionName } from './debugSessionName';
import type { TestModel } from './testModel';
import { TestServerInterface } from './upstream/testServerInterface';

export class PlaywrightTestServer {
  private _vscode: vscodeTypes.VSCode;
  private _options: PlaywrightTestOptions;
  private _model: TestModel;
  private _testServerPromise: Promise<TestServerConnection | null> | undefined;

  constructor(vscode: vscodeTypes.VSCode, model: TestModel, options: PlaywrightTestOptions) {
    this._vscode = vscode;
    this._model = model;
    this._options = options;
  }

  reset() {
    this._disposeTestServer();
  }

  async listFiles(): Promise<ConfigListFilesReport> {
    const testServer = await this._testServer();
    if (!testServer)
      throw new Error('Internal error: unable to connect to the test server');

    const result: ConfigListFilesReport = {
      projects: [],
    };

    // TODO: remove ConfigListFilesReport and report suite directly once CLI is deprecated.
    const { report } = await testServer.listFiles({});
    const teleReceiver = new TeleReporterReceiver({
      onBegin(rootSuite) {
        for (const projectSuite of rootSuite.suites) {
          const project = projectSuite.project()!;
          const files: string[] = [];
          result.projects.push({
            name: project.name,
            testDir: project.testDir,
            use: project.use || {},
            files,
          });
          for (const fileSuite of projectSuite.suites)
            files.push(fileSuite.location!.file);
        }
      },
      onError(error) {
        result.error = error;
      },
    }, {
      mergeProjects: true,
      mergeTestCases: true,
      resolvePath: (rootDir: string, relativePath: string) => this._vscode.Uri.file(path.join(rootDir, relativePath)).fsPath,
    });
    for (const message of report)
      teleReceiver.dispatch(message);
    return result;
  }

  async listTests(locations: string[], reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    const testServer = await this._testServer();
    if (token?.isCancellationRequested)
      return;
    if (!testServer)
      return;
    // Locations are regular expressions.
    locations = locations.map(escapeRegex);
    const { report } = await testServer.listTests({ locations });
    const teleReceiver = new TeleReporterReceiver(reporter, {
      mergeProjects: true,
      mergeTestCases: true,
      resolvePath: (rootDir: string, relativePath: string) => this._vscode.Uri.file(path.join(rootDir, relativePath)).fsPath,
    });
    for (const message of report)
      teleReceiver.dispatch(message);
  }

  async runGlobalHooks(type: 'setup' | 'teardown', testListener: reporterTypes.ReporterV2): Promise<'passed' | 'failed' | 'interrupted' | 'timedout'> {
    const testServer = await this._testServer();
    if (!testServer)
      return 'failed';

    const teleReceiver = new TeleReporterReceiver(testListener, {
      mergeProjects: true,
      mergeTestCases: true,
      resolvePath: (rootDir: string, relativePath: string) => this._vscode.Uri.file(path.join(rootDir, relativePath)).fsPath,
    });
    const disposable = testServer.onStdio(params => {
      if (params.type === 'stdout')
        testListener.onStdOut?.(unwrapString(params));
      if (params.type === 'stderr')
        testListener.onStdErr?.(unwrapString(params));
    });

    try {
      if (type === 'setup') {
        const { report, status } = await testServer.runGlobalSetup({});
        testListener.onStdOut?.('\x1b[2mRunning global setup if any\u2026\x1b[0m\n');
        for (const message of report)
          teleReceiver.dispatch(message);
        return status;
      }
      const { report, status } = await testServer.runGlobalTeardown({});
      for (const message of report)
        teleReceiver.dispatch(message);
      return status;
    } finally {
      disposable.dispose();
    }
  }

  async startDevServer(): Promise<reporterTypes.FullResult['status']> {
    const testServer = await this._testServer();
    if (!testServer)
      return 'failed';
    const result = await testServer.startDevServer({});
    return result.status;
  }

  async stopDevServer(): Promise<reporterTypes.FullResult['status']> {
    const testServer = await this._testServer();
    if (!testServer)
      return 'failed';
    const result = await testServer.stopDevServer({});
    return result.status;
  }

  async clearCache(): Promise<void> {
    const testServer = await this._testServer();
    await testServer?.clearCache({});
  }

  async runTests(items: vscodeTypes.TestItem[], runOptions: PlaywrightTestRunOptions, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    const testServer = await this._testServer();
    if (token?.isCancellationRequested)
      return;
    if (!testServer)
      return;

    const { locations, testIds } = this._model.narrowDownLocations(items);
    if (!locations && !testIds)
      return;

    // Locations are regular expressions.
    const locationPatterns = locations ? locations.map(escapeRegex) : undefined;
    const options: Parameters<TestServerInterface['runTests']>['0'] = {
      projects: this._model.enabledProjectsFilter(),
      locations: locationPatterns,
      testIds,
      ...runOptions,
    };
    testServer.runTests(options);

    token.onCancellationRequested(() => {
      testServer.stopTestsNoReply({});
    });
    const disposable = testServer.onStdio(params => {
      if (params.type === 'stdout')
        reporter.onStdOut?.(unwrapString(params));
      if (params.type === 'stderr')
        reporter.onStdErr?.(unwrapString(params));
    });
    await this._wireTestServer(testServer, reporter, token);
    disposable.dispose();
  }

  async debugTests(items: vscodeTypes.TestItem[], runOptions: PlaywrightTestRunOptions, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    // Important, VSCode will change c:\\ to C:\\ in the program argument.
    // This forks globals into 2 worlds, hence we specify it relative than absolute.
    const configFile = path.relative(this._model.config.workspaceFolder, this._model.config.configFile);
    const args = ['test-server', '-c', configFile];

    const addressPromise = new Promise<string>(f => {
      const disposable = this._options.onStdOut(output => {
        const match = output.match(/Listening on (.*)/);
        if (match) {
          disposable.dispose();
          f(match[1]);
        }
      });
    });

    const testDirs = this._model.enabledProjects().map(project => project.project.testDir);

    let testServer: TestServerConnection | undefined;
    let disposable: vscodeTypes.Disposable | undefined;
    try {
      await this._vscode.debug.startDebugging(undefined, {
        type: 'pwa-node',
        name: debugSessionName,
        request: 'launch',
        cwd: this._model.config.workspaceFolder,
        env: {
          ...process.env,
          CI: this._options.isUnderTest ? undefined : process.env.CI,
          ...this._options.envProvider(),
          // Reset VSCode's options that affect nested Electron.
          ELECTRON_RUN_AS_NODE: undefined,
          FORCE_COLOR: '1',
          PW_TEST_SOURCE_TRANSFORM: require.resolve('./debugTransform'),
          PW_TEST_SOURCE_TRANSFORM_SCOPE: testDirs.join(pathSeparator),
          PWDEBUG: 'console',
        },
        program: this._model.config.cli,
        args,
      });

      if (token?.isCancellationRequested)
        return;
      const address = await addressPromise;
      testServer = new TestServerConnection(address);
      await testServer.initialize({
        serializer: require.resolve('./oopReporter'),
        closeOnDisconnect: true,
      });
      if (token?.isCancellationRequested)
        return;

      const { locations, testIds } = this._model.narrowDownLocations(items);
      if (!locations && !testIds)
        return;

      // Locations are regular expressions.
      const locationPatterns = locations ? locations.map(escapeRegex) : undefined;
      const options: Parameters<TestServerInterface['runTests']>['0'] = {
        projects: this._model.enabledProjectsFilter(),
        locations: locationPatterns,
        testIds,
        ...runOptions,
      };
      testServer.runTests(options);

      token.onCancellationRequested(() => {
        testServer!.stopTestsNoReply({});
      });
      disposable = testServer.onStdio(params => {
        if (params.type === 'stdout')
          reporter.onStdOut?.(unwrapString(params));
        if (params.type === 'stderr')
          reporter.onStdErr?.(unwrapString(params));
      });
      const testEndPromise = this._wireTestServer(testServer, reporter, token);
      await testEndPromise;
    } finally {
      disposable?.dispose();
      testServer?.close();
      await this._options.runHooks.onDidRunTests(true);
    }
  }

  async watchFiles(fileNames: string[]) {
    const testServer = await this._testServer();
    if (!testServer)
      return;
    await testServer.watch({ fileNames });
  }

  async findRelatedTestFiles(files: string[]): Promise<ConfigFindRelatedTestFilesReport> {
    const testServer = await this._testServer();
    if (!testServer)
      return { testFiles: files, errors: [{ message: 'Internal error: unable to connect to the test server' }] };
    return await testServer.findRelatedTestFiles({ files });
  }

  private _testServer() {
    if (this._testServerPromise)
      return this._testServerPromise;
    this._testServerPromise = this._createTestServer();
    return this._testServerPromise;
  }

  private async _createTestServer(): Promise<TestServerConnection | null> {
    const args = [this._model.config.cli, 'test-server', '-c', this._model.config.configFile];
    const wsEndpoint = await startBackend(this._vscode, {
      args,
      cwd: this._model.config.workspaceFolder,
      envProvider: () => {
        return {
          ...this._options.envProvider(),
          FORCE_COLOR: '1',
        };
      },
      dumpIO: false,
      onClose: () => {
        this._testServerPromise = undefined;
      },
      onError: error => {
        this._testServerPromise = undefined;
      },
    });
    if (!wsEndpoint)
      return null;
    const testServer = new TestServerConnection(wsEndpoint);
    testServer.onTestFilesChanged(params => this._testFilesChanged(params.testFiles));
    await testServer.initialize({
      serializer: require.resolve('./oopReporter'),
      interceptStdio: true,
      closeOnDisconnect: true,
    });
    return testServer;
  }

  private async _wireTestServer(testServer: TestServerConnection, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken) {
    const teleReceiver = new TeleReporterReceiver(reporter, {
      mergeProjects: true,
      mergeTestCases: true,
      resolvePath: (rootDir: string, relativePath: string) => this._vscode.Uri.file(path.join(rootDir, relativePath)).fsPath,
    });
    return new Promise<void>(resolve => {
      const disposables = [
        testServer.onReport(message => {
          if (token.isCancellationRequested && message.method !== 'onEnd')
            return;
          teleReceiver.dispatch(message);
          if (message.method === 'onEnd') {
            disposables.forEach(d => d.dispose());
            resolve();
          }
        }),
        testServer.onClose(() => {
          disposables.forEach(d => d.dispose());
          resolve();
        }),
      ];
    });
  }

  private _testFilesChanged(testFiles: string[]) {
    this._model.testFilesChanged(testFiles.map(f => this._vscode.Uri.file(f).fsPath));
  }

  private _disposeTestServer() {
    const testServer = this._testServerPromise;
    this._testServerPromise = undefined;
    if (testServer)
      testServer.then(server => server?.close());
  }
}

function unwrapString(params: { text?: string, buffer?: string }): string | Buffer {
  return params.buffer ? Buffer.from(params.buffer, 'base64') : params.text || '';
}

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
import { TeleReporterReceiver, JsonConfig } from './upstream/teleReceiver';
import { WebSocketTestServerTransport, TestServerConnection, TestServerConnectionClosedError, TestServerTransport } from './upstream/testServerConnection';
import { startBackend } from './backend';
import { escapeRegex, pathSeparator } from './utils';
import { debugSessionName } from './debugSessionName';
import type { TestModel } from './testModel';
import { TestServerInterface } from './upstream/testServerInterface';

export type TestConfig = {
  workspaceFolder: string;
  configFile: string;
  cli: string;
  version: number;
  // Legacy attribute, this is now part of FullProject['use'].
  // Remove once https://github.com/microsoft/playwright/commit/1af4e367f4a46323f3b5a013527b944fe3176203 is widely available.
  testIdAttributeName?: string;
};

export type PlaywrightTestRunOptions = {
  headed?: boolean;
  workers?: string | number;
  trace?: 'on' | 'off';
  video?: 'on' | 'off';
  reuseContext?: boolean;
  connectWsEndpoint?: string;
  updateSnapshots?: 'all' | 'changed' | 'missing' | 'none' | undefined;
  updateSourceMethod?: 'overwrite' | 'patch' | '3way' | undefined;
};

export type PlaywrightTestOptions = {
  isUnderTest: boolean;
  envProvider: (configFile: string) => NodeJS.ProcessEnv;
  onStdOut: vscodeTypes.Event<string>;
  testPausedHandler: (params: { errors: reporterTypes.TestError[] }) => void;
  debugLogger: vscodeTypes.LogOutputChannel;
};


export class PlaywrightTestServer {
  private _vscode: vscodeTypes.VSCode;
  private _options: PlaywrightTestOptions;
  private _model: TestModel;
  private _testServerPromise: Promise<TestServerConnectionWrapper> | undefined;
  private _config?: JsonConfig;
  private _globalSetupEnv: { [key: string]: string | undefined } = {};

  constructor(vscode: vscodeTypes.VSCode, model: TestModel, options: PlaywrightTestOptions) {
    this._vscode = vscode;
    this._model = model;
    this._options = options;
  }

  reset() {
    this._disposeTestServer();
  }

  config() {
    return this._config;
  }

  async listFiles(): Promise<ConfigListFilesReport> {
    const testServer = await this._testServer();
    if (!testServer.connection) {
      const errors = testServer.errors.length ? '. Test server errors: ' + testServer.errors.join('\n') : '';
      throw new Error('Internal error: unable to connect to the test server.' + errors);
    }

    const result: ConfigListFilesReport = {
      projects: [],
    };

    // TODO: remove ConfigListFilesReport and report suite directly once CLI is deprecated.
    const { report } = await testServer.connection.listFiles({});
    const teleReceiver = new TeleReporterReceiver({
      onConfigure: (config: JsonConfig) => {
        this._config = config;
      },
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
      resolvePath,
    });
    for (const message of report)
      void teleReceiver.dispatch(message);
    return result;
  }

  async listTests(locations: string[], reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    const { connection } = await this._testServer();
    if (token?.isCancellationRequested)
      return;
    if (!connection)
      return;
    // Locations are regular expressions.
    locations = locations.map(escapeRegex);
    const { report } = await connection.listTests({ locations });
    const teleReceiver = new TeleReporterReceiver(reporter, {
      mergeProjects: true,
      mergeTestCases: true,
      resolvePath,
    });
    for (const message of report)
      void teleReceiver.dispatch(message);
  }

  private _pipeStdio(testServer: TestServerConnection, reporter: reporterTypes.ReporterV2) {
    return testServer.onStdio(params => {
      if (params.type === 'stdout')
        reporter.onStdOut?.(unwrapString(params));
      if (params.type === 'stderr')
        reporter.onStdErr?.(unwrapString(params));
    });
  }

  async runGlobalHooks(type: 'setup' | 'teardown', testListener: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<'passed' | 'failed' | 'interrupted' | 'timedout'> {
    const { connection } = await this._testServer();
    if (!connection)
      return 'failed';
    return await this._runGlobalHooksInServer(connection, type, testListener, token, true);
  }

  private async _runGlobalHooksInServer(testServer: TestServerConnection, type: 'setup' | 'teardown', testListener: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken, saveEnv: boolean): Promise<'passed' | 'failed' | 'interrupted' | 'timedout'> {
    const teleReceiver = new TeleReporterReceiver(testListener, {
      mergeProjects: true,
      mergeTestCases: true,
      resolvePath,
    });
    const disposable = this._pipeStdio(testServer, testListener);

    try {
      if (type === 'setup' && (!this._config || this._config.globalSetup))
        testListener.onStdOut?.('\x1b[2mRunning global setup if any\u2026\x1b[0m\n');
      const result = await Promise.race([
        type === 'setup' ? testServer.runGlobalSetup({}) : testServer.runGlobalTeardown({}).then(result => ({ ...result, env: [] })),
        new Promise<{ status: 'interrupted', report: [] }>(f => token.onCancellationRequested(() => f({ status: 'interrupted', report: [] }))),
      ]);
      for (const message of result.report)
        void teleReceiver.dispatch(message);
      if (type === 'setup' && saveEnv && 'env' in result)
        this._globalSetupEnv = Object.fromEntries(result.env.map(([key, value]) => [key, value ?? undefined]));
      if (type === 'teardown' && saveEnv)
        this._globalSetupEnv = {};
      return result.status;
    } finally {
      disposable.dispose();
    }
  }

  async startDevServer(): Promise<reporterTypes.FullResult['status']> {
    const { connection } = await this._testServer();
    if (!connection)
      return 'failed';
    const result = await connection.startDevServer({});
    return result.status;
  }

  async stopDevServer(): Promise<reporterTypes.FullResult['status']> {
    const { connection } = await this._testServer();
    if (!connection)
      return 'failed';
    const result = await connection.stopDevServer({});
    return result.status;
  }

  async clearCache(): Promise<void> {
    const { connection } = await this._testServer();
    await connection?.clearCache({});
  }

  async runTests(request: vscodeTypes.TestRunRequest, runOptions: PlaywrightTestRunOptions, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    const { connection } = await this._testServer();
    if (token?.isCancellationRequested)
      return;
    if (!connection)
      return;

    const { locations, testIds } = this._model.narrowDownLocations(request);
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
    const disposables = [
      token.onCancellationRequested(() => {
        connection.stopTestsNoReply({});
      })
    ];
    this._wireTestServer(connection, reporter, token, disposables);

    try {
      await connection.runTests(options);
    } finally {
      for (const disposable of disposables)
        disposable.dispose();
    }
  }

  private _normalizePaths() {
    let cwd = this._model.config.workspaceFolder;
    if (process.platform === 'win32') {
      /**
       * The Windows Filesystem is case-insensitive, but Node.js module loading is case-sensitive.
       * That means that on Windows, C:\foo and c:\foo point to the same file,
       * but on Node.js require-ing both of them will result in two instances of the file.
       * This can lead to two instances of @playwright/test being loaded, which can't happen.
       *
       * On top of that, Node.js' require algorithm sometimes turns `c:\foo` into `C:\foo`.
       * So we need to make sure that we always pass uppercase paths to Node.js.
       *
       * VS Code knows about this problem and already performs this for us, e.g. when we call `vscode.debug.startDebugging`.
       * But lots of other places do not, like Playwright's `--config <file>` or the CWD passed into node:child_process.
       *
       * More on this in https://github.com/microsoft/playwright-vscode/pull/538#issuecomment-2404265216.
       */
      cwd = cwd[0].toUpperCase() + cwd.substring(1);
    }
    return {
      cwd,
      cli: path.relative(cwd, this._model.config.cli),
      config: path.relative(cwd, this._model.config.configFile),
    };
  }

  async debugTests(request: vscodeTypes.TestRunRequest, runOptions: PlaywrightTestRunOptions, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken, debugGlobalSetup: boolean): Promise<void> {
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

    let debugTestServer: TestServerConnection | undefined;
    let mainDebugRun: vscodeTypes.DebugSession | undefined;
    const disposables: vscodeTypes.Disposable[] = [];
    try {
      const debugEnd = new this._vscode.CancellationTokenSource();
      token.onCancellationRequested(() => debugEnd.cancel());

      this._vscode.debug.onDidStartDebugSession(session => {
        if (session.name === debugSessionName)
          mainDebugRun ??= session;
      });
      this._vscode.debug.onDidTerminateDebugSession(session => {
        // child processes have their own debug sessions,
        // but we only want to stop debugging if the user cancels the main session
        if (session.id === mainDebugRun?.id)
          debugEnd.cancel();
      });

      token = debugEnd.token;

      const paths = this._normalizePaths();
      const kMinTestPausedVersion = 1.58;

      await this._vscode.debug.startDebugging(undefined, {
        type: 'pwa-node',
        name: debugSessionName,
        request: 'launch',
        cwd: paths.cwd,
        skipFiles: ['<node_internals>/**', '**/node_modules/playwright/**', '**/node_modules/playwright-core/**'],
        env: {
          ...process.env,
          CI: this._options.isUnderTest ? undefined : process.env.CI,
          ...this._options.envProvider(this._model.config.configFile),
          ...(debugGlobalSetup ? {} : this._globalSetupEnv),
          // Reset VSCode's options that affect nested Electron.
          ELECTRON_RUN_AS_NODE: undefined,
          FORCE_COLOR: '1',
          PW_TEST_SOURCE_TRANSFORM: this._model.config.version < kMinTestPausedVersion ? require.resolve('./debugTransform') : undefined,
          PW_TEST_SOURCE_TRANSFORM_SCOPE: this._model.config.version < kMinTestPausedVersion ? testDirs.join(pathSeparator) : undefined,
          PWDEBUG: 'console',
        },
        program: paths.cli,
        args: ['test-server', '-c', paths.config],
      });

      if (token?.isCancellationRequested)
        return;
      const address = await addressPromise;
      debugTestServer = new TestServerConnection(new TestServerTransportDebugger(new WebSocketTestServerTransport(address), this._options.debugLogger));
      await debugTestServer.initialize({
        serializer: require.resolve('./oopReporter'),
        closeOnDisconnect: true,
      });
      if (token?.isCancellationRequested)
        return;

      const { locations, testIds, isSingleTest } = this._model.narrowDownLocations(request);
      if (!locations && !testIds)
        return;

      if (debugGlobalSetup) {
        const result = await this._runGlobalHooksInServer(debugTestServer, 'setup', reporter, token, false);
        if (result !== 'passed')
          return;
      }

      // Locations are regular expressions.
      const locationPatterns = locations ? locations.map(escapeRegex) : undefined;
      const options: Parameters<TestServerInterface['runTests']>['0'] = {
        projects: this._model.enabledProjectsFilter(),
        locations: locationPatterns,
        testIds,
        timeout: 0,
        pauseAtEnd: isSingleTest,
        pauseOnError: true,
        ...runOptions,
      };

      disposables.push(token.onCancellationRequested(() => {
        debugTestServer!.stopTestsNoReply({});
      }));
      disposables.push(debugTestServer.onTestPaused(params => this._options.testPausedHandler(params)));
      this._wireTestServer(debugTestServer, reporter, token, disposables);
      try {
        await debugTestServer.runTests(options);
      } catch (e) {
        if (e instanceof TestServerConnectionClosedError)
          return; // User stopped debugging.
        throw e;
      }
    } finally {
      disposables.forEach(disposable => disposable.dispose());
      if (debugGlobalSetup && !token.isCancellationRequested && debugTestServer && !debugTestServer.isClosed())
        await this._runGlobalHooksInServer(debugTestServer, 'teardown', reporter, token, false);
      if (debugTestServer) {
        // Should exit upon close automatically.
        debugTestServer.close();
      } else if (mainDebugRun) {
        // When canceled before connecting to the test server, stop the debug session manually.
        void this._vscode.debug.stopDebugging(mainDebugRun);
      }
    }
  }

  async watchFiles(fileNames: string[]) {
    const { connection } = await this._testServer();
    await connection?.watch({ fileNames });
  }

  async findRelatedTestFiles(files: string[]): Promise<ConfigFindRelatedTestFilesReport> {
    const testServer = await this._testServer();
    if (!testServer.connection)
      return { testFiles: files, errors: [{ message: 'Internal error: unable to connect to the test server' }] };
    return await testServer.connection.findRelatedTestFiles({ files });
  }

  private _testServer() {
    if (this._testServerPromise)
      return this._testServerPromise;
    this._testServerPromise = this._createTestServer();
    return this._testServerPromise;
  }

  private async _createTestServer(): Promise<TestServerConnectionWrapper> {
    const paths = this._normalizePaths();
    const errors: string[] = [];
    const wsEndpoint = await startBackend(this._vscode, {
      args: [
        paths.cli,
        'test-server',
        '-c', paths.config,
      ],
      cwd: paths.cwd,
      envProvider: () => {
        return {
          ...this._options.envProvider(this._model.config.configFile),
          FORCE_COLOR: '1',
          // Reset VSCode's options that affect nested Electron.
          ELECTRON_RUN_AS_NODE: undefined,
        };
      },
      dumpIO: false,
      errors,
      onClose: () => {
        this._testServerPromise = undefined;
      },
      onError: error => {
        this._testServerPromise = undefined;
      },
    });
    if (!wsEndpoint)
      return { connection: null, errors };
    const connection = new TestServerConnection(new TestServerTransportDebugger(new WebSocketTestServerTransport(wsEndpoint), this._options.debugLogger));
    connection.onTestFilesChanged(params => this._testFilesChanged(params.testFiles));
    await connection.initialize({
      serializer: require.resolve('./oopReporter'),
      interceptStdio: true,
      closeOnDisconnect: true,
    });
    return { connection, errors };
  }

  private _wireTestServer(testServer: TestServerConnection, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken, disposables: vscodeTypes.Disposable[]): void {
    const teleReceiver = new TeleReporterReceiver(reporter, {
      mergeProjects: true,
      mergeTestCases: true,
      resolvePath,
    });
    disposables.push(
        testServer.onReport(message => {
          if (token.isCancellationRequested && message.method !== 'onEnd')
            return;
          void teleReceiver.dispatch(message);
        }),
        this._pipeStdio(testServer, reporter),
    );
  }

  private _testFilesChanged(testFiles: string[]) {
    this._model.testFilesChanged(testFiles);
  }

  private _disposeTestServer() {
    const testServer = this._testServerPromise;
    this._testServerPromise = undefined;
    if (testServer)
      void testServer.then(server => server.connection?.close());
  }
}

function unwrapString(params: { text?: string, buffer?: string }): string | Buffer {
  return params.buffer ? Buffer.from(params.buffer, 'base64') : params.text || '';
}

function resolvePath(rootDir: string, relativePath: string) {
  return path.join(rootDir, relativePath);
}

type TestServerConnectionWrapper = {
  connection: TestServerConnection | null;
  errors: string[];
};

class TestServerTransportDebugger implements TestServerTransport {
  constructor(private _inner: TestServerTransport, private _logger: vscodeTypes.LogOutputChannel) {}

  send(message: string): void {
    this._logger.debug('-->', message);
    this._inner.send(message);
  }

  onmessage(callback: (message: string) => void) {
    this._inner.onmessage((message: string) => {
      this._logger.debug('<--', message);
      callback(message);
    });
  }

  onerror(listener: () => void): void {
    this._inner.onerror(() => {
      this._logger.debug('<-- transport error');
      listener();
    });
  }

  onclose(listener: () => void): void {
    this._inner.onclose(() => {
      this._logger.debug('<-- transport close');
      listener();
    });
  }

  onopen(listener: () => void): void {
    this._inner.onopen(() => {
      this._logger.debug('<-- transport open');
      listener();
    });
  }

  close(): void {
    this._logger.debug('<-- transport close');
    this._inner.close();
  }
}
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

import { spawn } from 'child_process';
import path from 'path';
import { debugSessionName } from './debugSessionName';
import { ConfigFindRelatedTestFilesReport, ConfigListFilesReport } from './listTests';
import { ReporterServer } from './reporterServer';
import { findNode, spawnAsync } from './utils';
import * as vscodeTypes from './vscodeTypes';
import { SettingsModel } from './settingsModel';
import { TestServerController } from './testServerController';
import * as reporterTypes from './reporter';

export type TestConfig = {
  workspaceFolder: string;
  configFile: string;
  cli: string;
  version: number;
  testIdAttributeName?: string;
};

const pathSeparator = process.platform === 'win32' ? ';' : ':';

export type PlaywrightTestOptions = {
  headed?: boolean,
  oneWorker?: boolean,
  trace?: 'on' | 'off',
  projects?: string[];
  grep?: string;
  reuseContext?: boolean,
  connectWsEndpoint?: string;
};

export interface RunHooks {
  onWillRunTests(config: TestConfig, debug: boolean): Promise<{ connectWsEndpoint?: string }>;
  onDidRunTests(debug: boolean): Promise<void>;
}

export class PlaywrightTest {
  private _testLog: string[] = [];
  private _isUnderTest: boolean;
  private _runHooks: RunHooks;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _vscode: vscodeTypes.VSCode;
  private _settingsModel: SettingsModel;
  private _testServerController: TestServerController;

  constructor(vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, runHooks: RunHooks, isUnderTest: boolean, testServerController: TestServerController, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._settingsModel = settingsModel;
    this._runHooks = runHooks;
    this._isUnderTest = isUnderTest;
    this._testServerController = testServerController;
    this._envProvider = envProvider;
  }

  async getPlaywrightInfo(workspaceFolder: string, configFilePath: string): Promise<{ version: number, cli: string }> {
    const pwtInfo = await this._runNode([
      require.resolve('./playwrightFinder'),
    ], path.dirname(configFilePath));
    const { version, cli, error } = JSON.parse(pwtInfo) as { version: number, cli: string, error?: string };
    if (error)
      throw new Error(error);
    let cliOverride = cli;
    if (cli.includes('/playwright/packages/playwright-test/') && configFilePath.includes('playwright-test'))
      cliOverride = path.join(workspaceFolder, 'tests/playwright-test/stable-test-runner/node_modules/@playwright/test/cli.js');
    return { cli: cliOverride, version };
  }

  async listFiles(config: TestConfig): Promise<ConfigListFilesReport> {
    try {
      let result: ConfigListFilesReport;
      if (this._useTestServer(config))
        result = await this._listFilesServer(config);
      else
        result = await this._listFilesCLI(config);
      // TODO: merge getPlaywrightInfo and listFiles to avoid this.
      // Override the cli entry point with the one obtained from the config.
      if (result.cliEntryPoint)
        config.cli = result.cliEntryPoint;
      for (const project of result.projects)
        project.files = project.files.map(f => this._vscode.Uri.file(f).fsPath);
      if (result.error?.location)
        result.error.location.file = this._vscode.Uri.file(result.error.location.file).fsPath;
      return result;
    } catch (error: any) {
      return {
        error: {
          location: { file: config.configFile, line: 0, column: 0 },
          message: error.message,
        },
        projects: [],
      };
    }
  }

  private async _listFilesCLI(config: TestConfig): Promise<ConfigListFilesReport> {
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    const allArgs = [config.cli, 'list-files', '-c', configFile];
    {
      // For tests.
      this._log(`${escapeRegex(path.relative(config.workspaceFolder, configFolder))}> playwright list-files -c ${configFile}`);
    }
    const output = await this._runNode(allArgs, configFolder);
    const result = JSON.parse(output) as ConfigListFilesReport;
    return result;
  }

  private async _listFilesServer(config: TestConfig): Promise<ConfigListFilesReport> {
    const testServer = await this._testServerController.testServerFor(config);
    if (!testServer)
      throw new Error('Internal error: unable to connect to the test server');
    return await testServer.listFiles({ configFile: config.configFile });
  }

  async runTests(config: TestConfig, projectNames: string[], locations: string[] | null, listener: reporterTypes.ReporterV2, parametrizedTestTitle: string | undefined, token: vscodeTypes.CancellationToken) {
    const locationArg = locations ? locations : [];
    if (token?.isCancellationRequested)
      return;
    const externalOptions = await this._runHooks.onWillRunTests(config, false);
    const showBrowser = this._settingsModel.showBrowser.get() && !!externalOptions.connectWsEndpoint;

    let trace: 'on' | 'off' | undefined;
    if (this._settingsModel.showTrace.get())
      trace = 'on';
    // "Show browser" mode forces context reuse that survives over multiple test runs.
    // Playwright Test sets up `tracesDir` inside the `test-results` folder, so it will be removed between runs.
    // When context is reused, its ongoing tracing will fail with ENOENT because trace files
    // were suddenly removed. So we disable tracing in this case.
    if (this._settingsModel.showBrowser.get())
      trace = 'off';

    const options: PlaywrightTestOptions = {
      grep: parametrizedTestTitle,
      projects: projectNames.length ? projectNames.filter(Boolean) : undefined,
      headed: showBrowser && !this._isUnderTest,
      oneWorker: showBrowser,
      trace,
      reuseContext: showBrowser,
      connectWsEndpoint: showBrowser ? externalOptions.connectWsEndpoint : undefined,
    };

    try {
      if (token?.isCancellationRequested)
        return;
      await this._test(config, locationArg, 'test', options, listener, token);
    } finally {
      await this._runHooks.onDidRunTests(false);
    }
  }

  async listTests(config: TestConfig, files: string[]): Promise<{ rootSuite: reporterTypes.Suite, errors: reporterTypes.TestError[] }> {
    const errors: reporterTypes.TestError[] = [];
    let rootSuite: reporterTypes.Suite | undefined;
    await this._test(config, files, 'list', {}, {
      onBegin: (suite: reporterTypes.Suite) => {
        rootSuite = suite;
      },
      onError: (error: reporterTypes.TestError) => {
        errors.push(error);
      },
    }, new this._vscode.CancellationTokenSource().token);
    return { rootSuite: rootSuite!, errors };
  }

  private _useTestServer(config: TestConfig) {
    return this._settingsModel.useTestServer.get();
  }

  private async _test(config: TestConfig, locations: string[], mode: 'list' | 'test', options: PlaywrightTestOptions, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    if (this._useTestServer(config))
      await this._testWithServer(config, locations, mode, options, reporter, token);
    else
      await this._testWithCLI(config, locations, mode, options, reporter, token);
  }

  private async _testWithCLI(config: TestConfig, locations: string[], mode: 'list' | 'test', options: PlaywrightTestOptions, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    // Playwright will restart itself as child process in the ESM mode and won't inherit the 3/4 pipes.
    // Always use ws transport to mitigate it.
    const reporterServer = new ReporterServer(this._vscode);
    const node = await findNode(this._vscode, config.workspaceFolder);
    if (token?.isCancellationRequested)
      return;
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    const escapedLocations = locations.map(escapeRegex).sort();
    const args = [];
    if (mode === 'list')
      args.push('--list', '--reporter=null');

    if (options.projects)
      options.projects.forEach(p => args.push(`--project=${p}`));
    if (options.grep)
      args.push(`--grep=${escapeRegex(options.grep)}`);

    {
      // For tests.
      const relativeLocations = locations.map(f => path.relative(configFolder, f)).map(escapeRegex).sort();
      this._log(`${escapeRegex(path.relative(config.workspaceFolder, configFolder))}> playwright test -c ${configFile}${args.length ? ' ' + args.join(' ') : ''}${relativeLocations.length ? ' ' + relativeLocations.join(' ') : ''}`);
    }
    const allArgs = [config.cli, 'test',
      '-c', configFile,
      ...args,
      ...escapedLocations,
      '--repeat-each', '1',
      '--retries', '0',
    ];

    if (options.headed)
      allArgs.push('--headed');
    if (options.oneWorker)
      allArgs.push('--workers', '1');
    if (options.trace)
      allArgs.push('--trace', options.trace);

    const childProcess = spawn(node, allArgs, {
      cwd: configFolder,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CI: this._isUnderTest ? undefined : process.env.CI,
        // Don't debug tests when running them.
        NODE_OPTIONS: undefined,
        ...this._envProvider(),
        PW_TEST_REUSE_CONTEXT: options.reuseContext ? '1' : undefined,
        PW_TEST_CONNECT_WS_ENDPOINT: options.connectWsEndpoint,
        ...(await reporterServer.env()),
        // Reset VSCode's options that affect nested Electron.
        ELECTRON_RUN_AS_NODE: undefined,
        FORCE_COLOR: '1',
        PW_TEST_HTML_REPORT_OPEN: 'never',
        PW_TEST_NO_REMOVE_OUTPUT_DIRS: '1',
      }
    });

    const stdio = childProcess.stdio;
    stdio[1].on('data', data => reporter.onStdOut?.(data));
    stdio[2].on('data', data => reporter.onStdErr?.(data));
    await reporterServer.wireTestListener(mode, reporter, token);
  }

  private async _testWithServer(config: TestConfig, locations: string[], mode: 'list' | 'test', options: PlaywrightTestOptions, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    const testServer = await this._testServerController.testServerFor(config);
    if (token?.isCancellationRequested)
      return;
    if (!testServer)
      return;
    const oopReporter = require.resolve('./oopReporter');
    if (mode === 'list')
      testServer.listTests({ configFile: config.configFile, locations, reporter: oopReporter });
    if (mode === 'test') {
      testServer.test({ configFile: config.configFile, locations, reporter: oopReporter, ...options });
      token.onCancellationRequested(() => {
        testServer.stop({ configFile: config.configFile });
      });
      testServer.on('stdio', params => {
        if (params.type === 'stdout')
          reporter.onStdOut?.(unwrapString(params));
        if (params.type === 'stderr')
          reporter.onStdErr?.(unwrapString(params));
      });
    }

    await testServer.wireTestListener(mode, reporter, token);
  }

  async findRelatedTestFiles(config: TestConfig, files: string[]): Promise<ConfigFindRelatedTestFilesReport> {
    if (this._useTestServer(config))
      return await this._findRelatedTestFilesServer(config, files);
    else
      return await this._findRelatedTestFilesCLI(config, files);
  }

  async _findRelatedTestFilesCLI(config: TestConfig, files: string[]): Promise<ConfigFindRelatedTestFilesReport> {
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    const allArgs = [config.cli, 'find-related-test-files', '-c', configFile, ...files];
    {
      // For tests.
      this._log(`${escapeRegex(path.relative(config.workspaceFolder, configFolder))}> playwright find-related-test-files -c ${configFile}`);
    }
    try {
      const output = await this._runNode(allArgs, configFolder);
      const result = JSON.parse(output) as ConfigFindRelatedTestFilesReport;
      return result;
    } catch (error: any) {
      return {
        errors: [{
          location: { file: configFile, line: 0, column: 0 },
          message: error.message,
        }],
        testFiles: files,
      };
    }
  }

  async _findRelatedTestFilesServer(config: TestConfig, files: string[]): Promise<ConfigFindRelatedTestFilesReport> {
    const testServer = await this._testServerController.testServerFor(config);
    if (!testServer)
      return { testFiles: files, errors: [{ message: 'Internal error: unable to connect to the test server' }] };
    return await testServer.findRelatedTestFiles({ configFile: config.configFile, files });
  }

  async debugTests(vscode: vscodeTypes.VSCode, config: TestConfig, projectNames: string[], testDirs: string[], settingsEnv: NodeJS.ProcessEnv, locations: string[] | null, reporter: reporterTypes.ReporterV2, parametrizedTestTitle: string | undefined, token: vscodeTypes.CancellationToken) {
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    locations = locations || [];
    const escapedLocations = locations.map(escapeRegex);
    const args = ['test',
      '-c', configFile,
      ...escapedLocations,
      '--headed',
      ...projectNames.filter(Boolean).map(p => `--project=${p}`),
      '--repeat-each', '1',
      '--retries', '0',
      '--timeout', '0',
      '--workers', '1'
    ];
    if (parametrizedTestTitle)
      args.push(`--grep=${escapeRegex(parametrizedTestTitle)}`);

    {
      // For tests.
      const relativeLocations = locations.map(f => path.relative(configFolder, f)).map(escapeRegex);
      this._log(`${escapeRegex(path.relative(config.workspaceFolder, configFolder))}> debug -c ${configFile}${relativeLocations.length ? ' ' + relativeLocations.join(' ') : ''}`);
    }

    const reporterServer = new ReporterServer(this._vscode);
    const testOptions = await this._runHooks.onWillRunTests(config, true);
    try {
      await vscode.debug.startDebugging(undefined, {
        type: 'pwa-node',
        name: debugSessionName,
        request: 'launch',
        cwd: configFolder,
        env: {
          ...process.env,
          CI: this._isUnderTest ? undefined : process.env.CI,
          ...settingsEnv,
          PW_TEST_CONNECT_WS_ENDPOINT: testOptions.connectWsEndpoint,
          ...(await reporterServer.env()),
          // Reset VSCode's options that affect nested Electron.
          ELECTRON_RUN_AS_NODE: undefined,
          FORCE_COLOR: '1',
          PW_TEST_SOURCE_TRANSFORM: require.resolve('./debugTransform'),
          PW_TEST_SOURCE_TRANSFORM_SCOPE: testDirs.join(pathSeparator),
          PW_TEST_HTML_REPORT_OPEN: 'never',
          PWDEBUG: 'console',
        },
        program: config.cli,
        args,
      });
      await reporterServer.wireTestListener('test', reporter, token);
    } finally {
      await this._runHooks.onDidRunTests(true);
    }
  }

  private _log(line: string) {
    this._testLog.push(line);
  }

  testLog(): string[] {
    return this._testLog.slice();
  }

  private async _runNode(args: string[], cwd: string): Promise<string> {
    return await spawnAsync(await findNode(this._vscode, cwd), args, cwd, this._envProvider());
  }
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unwrapString(params: { text?: string, buffer?: string }): string | Buffer {
  return params.buffer ? Buffer.from(params.buffer, 'base64') : params.text || '';
}

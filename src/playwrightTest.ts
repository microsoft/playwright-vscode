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
import { ConfigListFilesReport } from './listTests';
import type { TestError, Entry, StepBeginParams, StepEndParams, TestBeginParams, TestEndParams } from './oopReporter';
import { ReporterServer } from './reporterServer';
import { findNode, spawnAsync } from './utils';
import * as vscodeTypes from './vscodeTypes';
import { SettingsModel } from './settingsModel';
import { TestServerController } from './testServerController';

export type TestConfig = {
  workspaceFolder: string;
  configFile: string;
  cli: string;
  version: number;
  testIdAttributeName?: string;
};

export interface TestListener {
  onBegin?(params: { projects: Entry[] }): void;
  onTestBegin?(params: TestBeginParams): void;
  onTestEnd?(params: TestEndParams): void;
  onStepBegin?(params: StepBeginParams): void;
  onStepEnd?(params: StepEndParams): void;
  onError?(params: { error: TestError }): void;
  onEnd?(): void;
  onStdOut?(data: Buffer | string): void;
  onStdErr?(data: Buffer | string): void;
}

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
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    const allArgs = [config.cli, 'list-files', '-c', configFile];
    {
      // For tests.
      this._log(`${escapeRegex(path.relative(config.workspaceFolder, configFolder))}> playwright list-files -c ${configFile}`);
    }
    try {
      const output = await this._runNode(allArgs, configFolder);
      const result = JSON.parse(output) as ConfigListFilesReport;
      // TODO: merge getPlaywrightInfo and listFiles to avoid this.
      // Override the cli entry point with the one obtained from the config.
      if (result.cliEntryPoint)
        config.cli = result.cliEntryPoint;
      return result;
    } catch (error: any) {
      return {
        error: {
          location: { file: configFile, line: 0, column: 0 },
          message: error.message,
        },
        projects: [],
      };
    }
  }

  async runTests(config: TestConfig, projectNames: string[], locations: string[] | null, listener: TestListener, parametrizedTestTitle: string | undefined, token: vscodeTypes.CancellationToken) {
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
      await this._test(config, locationArg, 'run', options, listener, token);
    } finally {
      await this._runHooks.onDidRunTests(false);
    }
  }

  async listTests(config: TestConfig, files: string[]): Promise<{ entries: Entry[], errors: TestError[] }> {
    let entries: Entry[] = [];
    const errors: TestError[] = [];
    await this._test(config, files, 'list', {}, {
      onBegin: params => {
        entries = params.projects as Entry[];
      },
      onError: params => {
        errors.push(params.error);
      },
    }, new this._vscode.CancellationTokenSource().token);
    return { entries, errors };
  }

  private async _test(config: TestConfig, locations: string[], mode: 'list' | 'run', options: PlaywrightTestOptions, listener: TestListener, token: vscodeTypes.CancellationToken): Promise<void> {
    if (config.version >= 1.43 || this._settingsModel.useTestServer.get())
      await this._testWithServer(config, locations, mode, options, listener, token);
    else
      await this._testWithCLI(config, locations, mode, options, listener, token);
  }

  private async _testWithCLI(config: TestConfig, locations: string[], mode: 'list' | 'run', options: PlaywrightTestOptions, listener: TestListener, token: vscodeTypes.CancellationToken): Promise<void> {
    // Playwright will restart itself as child process in the ESM mode and won't inherit the 3/4 pipes.
    // Always use ws transport to mitigate it.
    const reporterServer = new ReporterServer(this._vscode);
    const node = await findNode(this._vscode, config.workspaceFolder);
    if (token?.isCancellationRequested)
      return;
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    const escapedLocations = locations.map(escapeRegex);
    const args = [];
    if (mode === 'list')
      args.push('--list', '--reporter=null');

    if (options.projects)
      options.projects.forEach(p => args.push(`--project=${p}`));
    if (options.grep)
      args.push(`--grep=${escapeRegex(options.grep)}`);

    {
      // For tests.
      const relativeLocations = locations.map(f => path.relative(configFolder, f)).map(escapeRegex);
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
        ...(await reporterServer.env({ selfDestruct: true })),
        // Reset VSCode's options that affect nested Electron.
        ELECTRON_RUN_AS_NODE: undefined,
        FORCE_COLOR: '1',
        PW_TEST_HTML_REPORT_OPEN: 'never',
        PW_TEST_NO_REMOVE_OUTPUT_DIRS: '1',
      }
    });

    const stdio = childProcess.stdio;
    stdio[1].on('data', data => listener.onStdOut?.(data));
    stdio[2].on('data', data => listener.onStdErr?.(data));
    await reporterServer.wireTestListener(listener, token);
  }

  private async _testWithServer(config: TestConfig, locations: string[], mode: 'list' | 'run', options: PlaywrightTestOptions, listener: TestListener, token: vscodeTypes.CancellationToken): Promise<void> {
    const reporterServer = new ReporterServer(this._vscode);
    const testServer = await this._testServerController.testServerFor(config);
    if (!testServer)
      return;
    if (token?.isCancellationRequested)
      return;
    const env = await reporterServer.env({ selfDestruct: false });
    const reporter = reporterServer.reporterFile();
    if (mode === 'list')
      testServer.list({ locations, reporter, env });
    if (mode === 'run') {
      testServer.test({ locations, reporter, env, options });
      token.onCancellationRequested(() => {
        testServer.stop();
      });
      testServer.on('stdio', params => {
        if (params.type === 'stdout')
          listener.onStdOut?.(unwrapString(params));
        if (params.type === 'stderr')
          listener.onStdErr?.(unwrapString(params));
      });
    }

    await reporterServer.wireTestListener(listener, token);
  }

  async debugTests(vscode: vscodeTypes.VSCode, config: TestConfig, projectNames: string[], testDirs: string[], settingsEnv: NodeJS.ProcessEnv, locations: string[] | null, listener: TestListener, parametrizedTestTitle: string | undefined, token: vscodeTypes.CancellationToken) {
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
          ...(await reporterServer.env({ selfDestruct: true })),
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
      await reporterServer.wireTestListener(listener, token);
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

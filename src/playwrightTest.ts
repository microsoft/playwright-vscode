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
import { ReporterServer } from './reporterServer';
import { debugSessionName } from './debugSessionName';
import { Entry, StepBeginParams, StepEndParams, TestBeginParams, TestEndParams } from './oopReporter';
import type { TestError } from './reporter';
import { createGuid, spawnAsync } from './utils';
import which from 'which';
import * as vscodeTypes from './vscodeTypes';

export type TestConfig = {
  workspaceFolder: string;
  configFile: string;
  cli: string;
  version: number;
};

export type ProjectListFilesReport = {
  testDir: string;
  name: string;
  files: string[];
};

export type ConfigListFilesReport = {
  projects: ProjectListFilesReport[];
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

export class PlaywrightTest {
  private _pathToNodeJS: string | undefined;
  private _testLog: string[] = [];
  private _isUnderTest: boolean;
  private _browserServerWS: string | undefined;

  constructor(isUnderTest: boolean) {
    this._isUnderTest = isUnderTest;
  }

  async getPlaywrightInfo(workspaceFolder: string, configFilePath: string): Promise<{ version: number, cli: string } | null> {
    try {
      const pwtInfo = await this._runNode([
        '-e',
        'try { const pwtIndex = require.resolve("@playwright/test"); const version = require("@playwright/test/package.json").version; console.log(JSON.stringify({ pwtIndex, version})); } catch { console.log("undefined"); }',
      ], path.dirname(configFilePath));
      const { pwtIndex, version } = JSON.parse(pwtInfo);
      const v = parseFloat(version);

      // We only depend on playwright-core in 1.15+, bail out.
      if (v < 1.19)
        return { cli: '', version: v };

      // Resolve playwright-core relative to @playwright/test.
      const coreInfo = await this._runNode([
        '-e',
        'try { const coreIndex = require.resolve("playwright-core"); console.log(JSON.stringify({ coreIndex })); } catch { console.log("undefined"); }',
      ], path.dirname(pwtIndex));
      const { coreIndex } = JSON.parse(coreInfo);
      let cli = path.resolve(coreIndex, '..', 'lib', 'cli', 'cli');

      // Dogfood for 'ttest'
      if (cli.includes('packages/playwright-core') && configFilePath.includes('playwright-test'))
        cli = path.join(workspaceFolder, 'tests/playwright-test/stable-test-runner/node_modules/playwright-core/lib/cli/cli');

      return { cli, version: v };
    } catch {
    }
    return null;
  }

  async listFiles(config: TestConfig): Promise<ConfigListFilesReport | null> {
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    const allArgs = [config.cli, 'list-files', '-c', configFile];
    {
      // For tests.
      this._log(`${escapeRegex(path.relative(config.workspaceFolder, configFolder))}> playwright list-files -c ${configFile}`);
    }
    const output = await this._runNode(allArgs, configFolder);
    try {
      return JSON.parse(output) as ConfigListFilesReport;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  async runTests(config: TestConfig, projectNames: string[], locations: string[] | null, listener: TestListener, parametrizedTestTitle: string | undefined, token?: vscodeTypes.CancellationToken) {
    const locationArg = locations ? locations : [];
    const args = projectNames.filter(Boolean).map(p => `--project=${p}`);
    if (parametrizedTestTitle)
      args.push(`--grep=${escapeRegex(parametrizedTestTitle)}`);
    await this._test(config, locationArg,  args, listener, 'run', token);
  }

  async listTests(config: TestConfig, files: string[]): Promise<Entry[]> {
    let result: Entry[] = [];
    await this._test(config, files, ['--list'], {
      onBegin: params => {
        result = params.projects as Entry[];
      },
    }, 'list');
    return result;
  }

  private async _test(config: TestConfig, locations: string[], args: string[], listener: TestListener, mode: 'list' | 'run', token?: vscodeTypes.CancellationToken): Promise<void> {
    // Playwright will restart itself as child process in the ESM mode and won't inherit the 3/4 pipes.
    // Always use ws transport to mitigate it.
    const reporterServer = new ReporterServer();
    const node = await this.findNode();
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    const escapedLocations = locations.map(escapeRegex);
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
    if (this._isUnderTest || !!this._browserServerWS)
      allArgs.push('--workers', '1');
    // Disable original reporters when listing files.
    if (mode === 'list')
      allArgs.push('--reporter', 'null');
    const browserServerEnv = this._browserServerWS ? {
      PW_TEST_REUSE_CONTEXT: '1',
      PW_TEST_CONNECT_WS_ENDPOINT: this._browserServerWS,
    } : {};
    const childProcess = spawn(node, allArgs, {
      cwd: configFolder,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(await reporterServer.env()),
        ...browserServerEnv,
        // Don't debug tests when running them.
        NODE_OPTIONS: undefined,
        // Reset VSCode's options that affect nested Electron.
        ELECTRON_RUN_AS_NODE: undefined,
        FORCE_COLORS: '1',
        PW_TEST_HTML_REPORT_OPEN: 'never',
      }
    });

    const stdio = childProcess.stdio;
    stdio[1].on('data', data => listener.onStdOut?.(data));
    stdio[2].on('data', data => listener.onStdErr?.(data));
    await reporterServer.wireTestListener(listener, token);
  }

  async debugTests(vscode: vscodeTypes.VSCode, config: TestConfig, projectNames: string[], testDirs: string[], locations: string[] | null, listener: TestListener, parametrizedTestTitle: string | undefined, token?: vscodeTypes.CancellationToken) {
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

    const reporterServer = new ReporterServer();
    await vscode.debug.startDebugging(undefined, {
      type: 'pwa-node',
      name: debugSessionName,
      request: 'launch',
      cwd: configFolder,
      env: {
        ...process.env,
        ...(await reporterServer.env()),
        // Reset VSCode's options that affect nested Electron.
        ELECTRON_RUN_AS_NODE: undefined,
        FORCE_COLORS: '1',
        PW_OUT_OF_PROCESS_DRIVER: '1',
        PW_TEST_SOURCE_TRANSFORM: require.resolve('./debugTransform'),
        PW_TEST_SOURCE_TRANSFORM_SCOPE: testDirs.join(pathSeparator),
        PW_TEST_HTML_REPORT_OPEN: 'never',
      },
      program: config.cli,
      args,
    });
    await reporterServer.wireTestListener(listener, token);
  }

  async runBrowserServer(config: TestConfig, token: vscodeTypes.CancellationToken) {
    if (this._browserServerWS)
      return;

    const node = await this.findNode();

    const allArgs = [
      config.cli,
      'run-server',
      '--reuse-browser',
      `--path=/${createGuid()}`
    ];

    const serverProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdio = serverProcess.stdio;
    stdio[1].on('data', data => {
      const match = data.toString().match(/Listening on (.*)/);
      if (!match)
        return;
      this._browserServerWS = match[1];
    });

    let error: string | undefined = undefined;
    stdio[2].on('data', data => {
      error = data.toString();
    });

    token.onCancellationRequested(() => {
      serverProcess.stdin.write('<EOL>');
      this._browserServerWS = undefined;
    });

    await new Promise<void>((f, r) => {
      serverProcess.on('error', e => {
        r(e);
      });
      serverProcess.on('exit', () => {
        if (error)
          r(new Error(error));
        else
          f();
      });
    });
    this._browserServerWS = undefined;
  }

  private _log(line: string) {
    this._testLog.push(line);
  }

  testLog(): string[] {
    return this._testLog.slice();
  }

  async findNode(): Promise<string> {
    if (this._pathToNodeJS)
      return this._pathToNodeJS;

    const node = await which('node');
    if (!node)
      throw new Error('Unable to launch `node`, make sure it is in your PATH');
    this._pathToNodeJS = node;
    return node;
  }

  private async _runNode(args: string[], cwd: string): Promise<string> {
    return await spawnAsync(await this.findNode(), args, cwd);
  }
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

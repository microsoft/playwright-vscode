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

import { spawn, spawnSync } from 'child_process';
import path from 'path';
import { DebugServer } from './debugServer';
import { Entry, StepBeginParams, StepEndParams, TestBeginParams, TestEndParams } from './oopReporter';
import type { TestError } from './reporter';
import { ConnectionTransport, PipeTransport } from './transport';
import { findInPath } from './utils';
import * as vscodeTypes from './vscodeTypes';

export type TestConfig = {
  workspaceFolder: string;
  configFile: string;
  cli: string;
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

export class PlaywrightTest {
  private _pathToNodeJS: string | undefined;
  private _testLog: string[] = [];
  private _isUnderTest: boolean;

  constructor(isUnderTest: boolean) {
    this._isUnderTest = isUnderTest;
  }

  getPlaywrightInfo(workspaceFolder: string, configFilePath: string): { version: number, cli: string } | null {
    const node = this._findNode();
    const configFolder = path.dirname(configFilePath);
    const childProcess = spawnSync(node, [
      '-e',
      'try { const index = require.resolve("playwright-core"); const version = require("@playwright/test/package.json").version; console.log(JSON.stringify({ index, version})); } catch { console.log("undefined"); }',
    ],
    {
      cwd: configFolder,
      env: { ...process.env }
    }
    );
    const output = childProcess.stdout.toString();
    try {
      const { index, version } = JSON.parse(output);
      let cli = path.resolve(index, '..', 'lib', 'cli', 'cli');

      // Dogfood for 'ttest'
      if (cli.includes('packages/playwright-core') && configFilePath.includes('playwright-test'))
        cli = path.join(workspaceFolder, 'tests/playwright-test/stable-test-runner/node_modules/playwright-core/lib/cli/cli');

      return { cli, version: parseFloat(version) };
    } catch {
    }
    return null;
  }

  listFiles(config: TestConfig): ConfigListFilesReport | null {
    const node = this._findNode();
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    const allArgs = [config.cli, 'list-files', '-c', configFile];
    {
      // For tests.
      this._log(`${path.relative(config.workspaceFolder, configFolder)}> playwright list-files -c ${configFile}`);
    }
    const childProcess = spawnSync(node, allArgs, {
      cwd: configFolder,
      env: { ...process.env }
    });
    const output = childProcess.stdout.toString();
    if (!output)
      return null;
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
    await this._test(config, locationArg,  args, listener, token);
  }

  async listTests(config: TestConfig, files: string[]): Promise<Entry[]> {
    let result: Entry[] = [];
    await this._test(config, files, ['--list'], {
      onBegin: params => {
        result = params.projects as Entry[];
        return true;
      },
    });
    return result;
  }

  private async _test(config: TestConfig, locations: string[], args: string[], listener: TestListener, token?: vscodeTypes.CancellationToken): Promise<void> {
    const node = this._findNode();
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    {
      // For tests.
      const relativeLocations = locations.map(f => path.relative(configFolder, f));
      this._log(`${path.relative(config.workspaceFolder, configFolder)}> playwright test -c ${configFile}${args.length ? ' ' + args.join(' ') : ''}${relativeLocations.length ? ' ' + relativeLocations.join(' ') : ''}`);
    }
    const allArgs = [config.cli, 'test',
      '-c', configFile,
      ...args,
      ...locations,
      '--repeat-each', '1',
      '--retries', '0',
    ];
    if (this._isUnderTest)
      allArgs.push('--workers', '1');
    const childProcess = spawn(node, allArgs, {
      cwd: configFolder,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Don't debug tests that we run in tests.
        NODE_OPTIONS: this._isUnderTest ? undefined : process.env.NODE_OPTIONS,
        FORCE_COLORS: '1',
        PW_TEST_REPORTER: require.resolve('./oopReporter'),
        PW_TEST_HTML_REPORT_OPEN: 'never',
      }
    });
    if (token) {
      token.onCancellationRequested(() => {
        childProcess.kill('SIGINT');
      });
    }

    const stdio = childProcess.stdio;
    stdio[1].on('data', data => listener.onStdOut?.(data));
    stdio[2].on('data', data => listener.onStdErr?.(data));
    const transport = new PipeTransport((stdio as any)[3]!, (stdio as any)[4]!);
    await this._wireTestListener(transport, listener, token);
  }

  async debugTests(vscode: vscodeTypes.VSCode, config: TestConfig, projectNames: string[], locations: string[] | null, listener: TestListener, parametrizedTestTitle: string | undefined, token?: vscodeTypes.CancellationToken) {
    const debugServer = new DebugServer();
    const wsEndpoint = await debugServer.listen();
    const configFolder = path.dirname(config.configFile);
    const configFile = path.basename(config.configFile);
    const locationArg = (locations ? locations : []).map(f => path.relative(configFolder, f));
    const args = ['test',
      '-c', configFile,
      ...locationArg,
      '--headed',
      ...projectNames.filter(Boolean).map(p => `--project=${p}`),
      '--repeat-each', '1',
      '--retries', '0',
      '--timeout', '0',
      '--workers', '1'
    ];
    if (parametrizedTestTitle)
      args.push(`--grep=${escapeRegex(parametrizedTestTitle)}`);
    vscode.debug.startDebugging(undefined, {
      type: 'pwa-node',
      name: 'Playwright Test',
      request: 'launch',
      cwd: configFolder,
      env: {
        ...process.env,
        FORCE_COLORS: '1',
        PW_OUT_OF_PROCESS_DRIVER: '1',
        PW_TEST_SOURCE_TRANSFORM: require.resolve('./debugTransform'),
        PW_TEST_REPORTER: require.resolve('./oopReporter'),
        PW_TEST_REPORTER_WS_ENDPOINT: wsEndpoint,
        PW_TEST_HTML_REPORT_OPEN: 'never',
      },
      program: config.cli,
      args,
    });
    const transport = await debugServer.transport();
    await this._wireTestListener(transport, listener, token);
  }

  private _wireTestListener(transport: ConnectionTransport, listener: TestListener, token?: vscodeTypes.CancellationToken) {
    token?.onCancellationRequested(() => {
      transport.close();
    });
    transport.onmessage = message => {
      if (token?.isCancellationRequested && message.method !== 'onEnd')
        return;
      switch (message.method) {
        case 'onBegin': listener.onBegin?.(message.params); break;
        case 'onTestBegin': listener.onTestBegin?.(message.params); break;
        case 'onTestEnd': listener.onTestEnd?.(message.params); break;
        case 'onStepBegin': listener.onStepBegin?.(message.params); break;
        case 'onStepEnd': listener.onStepEnd?.(message.params); break;
        case 'onError': listener.onError?.(message.params); break;
        case 'onEnd': {
          listener.onEnd?.();
          transport.close();
          break;
        }
      }
    };
    return new Promise<void>(f => {
      transport.onclose = f;
    });
  }

  private _log(line: string) {
    this._testLog.push(line);
  }

  testLog(): string[] {
    return this._testLog.slice();
  }

  private _findNode(): string {
    if (this._pathToNodeJS)
      return this._pathToNodeJS;
    const node = findInPath('node', process.env);
    if (!node)
      throw new Error('Unable to launch `node`, make sure it is in your PATH');
    this._pathToNodeJS = node;
    return node;
  }
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

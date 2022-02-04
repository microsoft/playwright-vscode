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
import { Config } from './testTree';
import { ConnectionTransport, PipeTransport } from './transport';
import { findInPath, resolveSourceMap } from './utils';
import * as vscodeTypes from './vscodeTypes';

export type ListFilesReport = {
  projects: {
    testDir: string;
    name: string;
    files: string[];
  }[];
};

export interface TestListener {
  onBegin?(params: { files: Entry[] }): void;
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
  private _fileToSources: Map<string, string[]> = new Map();
  private _sourceToFile: Map<string, string> = new Map();

  constructor() {
  }

  getPlaywrightInfo(workspaceFolder: string, configFilePath: string): { version: number, cli: string } | null {
    const node = this._findNode();
    const childProcess = spawnSync(node, [
      '-e',
      'try { const index = require.resolve("playwright-core"); const version = require("@playwright/test/package.json").version; console.log(JSON.stringify({ index, version})); } catch { console.log("undefined"); }',
    ],
    {
      cwd: workspaceFolder,
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

  reset() {
    this._fileToSources.clear();
    this._sourceToFile.clear();
  }

  async listFiles(config: Config): Promise<ListFilesReport | null> {
    const node = this._findNode();
    const allArgs = [config.cli, 'list-files', '-c', config.configFile];
    const childProcess = spawnSync(node, allArgs, {
      cwd: config.workspaceFolder,
      env: { ...process.env }
    });
    const output = childProcess.stdout.toString();
    if (!output)
      return null;
    try {
      const report = JSON.parse(output) as ListFilesReport;
      for (const project of report.projects) {
        const files: string[] = [];
        for (const file of project.files)
          files.push(...await resolveSourceMap(file, this._fileToSources, this._sourceToFile));
        project.files = files;
      }
      return report;
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  async runTests(config: Config, projectName: string, locations: string[] | null, listener: TestListener, token?: vscodeTypes.CancellationToken) {
    const locationArg = locations ? locations : [];
    await this._test(config, locationArg,  ['--project', projectName], listener, token);
  }

  private _mapSourcesToFiles(sources: string[]): string[] {
    const result: string[] = [];

    // When we see
    //   src/foo.ts in the source,
    // we want to pass
    //   out/bundle.js:0 src/foo.ts
    // When we see
    //   src/foo.ts:14 in the source,
    // we want to pass
    //   out/bundle.js:0 src/foo.ts:14
    // It looks wrong, but it actually achieves the right result.

    for (const source of sources) {
      const match = source.match(/^(.*)([:]\d+)$/);
      const sourceFile = match ? match[1] : source;
      const bundleFile = this._sourceToFile.get(sourceFile);
      if (bundleFile)
        result.push(bundleFile + ':0');
      result.push(source);
    }
    return result;
  }

  async listTests(config: Config, files: string[]): Promise<Entry[]> {
    let result: Entry[] = [];
    await this._test(config, files, ['--list'], {
      onBegin: params => {
        result = params.files as Entry[];
        return true;
      },
    });
    return result;
  }

  private async _test(config: Config, files: string[], args: string[], listener: TestListener, token?: vscodeTypes.CancellationToken): Promise<void> {
    const node = this._findNode();
    const allArgs = [config.cli, 'test',
      '-c', config.configFile,
      ...this._mapSourcesToFiles(files),
      ...args,
      '--repeat-each', '1',
      '--retries', '0',
    ];
    const childProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
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

  async debugTests(vscode: vscodeTypes.VSCode, config: Config, projectName: string, locations: string[] | null, listener: TestListener, token?: vscodeTypes.CancellationToken) {
    const debugServer = new DebugServer();
    const wsEndpoint = await debugServer.listen();
    const locationArg = locations ? locations : [];
    const args = ['test',
      '-c', config.configFile,
      ...this._mapSourcesToFiles(locationArg),
      '--headed',
      '--project', projectName,
      '--repeat-each', '1',
      '--retries', '0',
      '--timeout', '0',
      '--workers', '1'
    ];
    vscode.debug.startDebugging(undefined, {
      type: 'pwa-node',
      name: 'Playwright Test',
      request: 'launch',
      cwd: config.workspaceFolder,
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

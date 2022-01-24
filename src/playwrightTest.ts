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
import fs from 'fs';
import path from 'path';
import vscode from 'vscode';
import { Entry, TestBeginParams, TestEndParams } from './oopReporter';
import { TestError } from './reporter';
import { Config } from './testTree';
import { PipeTransport } from './transport';
import { findInPath } from './utils';

export type ListFilesReport = {
  testDir?: string;
  projects: {
    name: string;
    files: string[];
  }[];
};

export interface TestListener {
  onBegin?(params: { files: Entry[] }): boolean;
  onTestBegin?(params: TestBeginParams): void;
  onTestEnd?(params: TestEndParams): void;
  onError?(params: { error: TestError }): void;
  onEnd?(): void;
  onStdOut?(data: Buffer | string): void;
  onStdErr?(data: Buffer | string): void;
}

export class PlaywrightTest {
  private _isDogFood = false;
  private _pathToNodeJS: string | undefined;

  constructor() {
  }

  async reconsiderDogFood() {
    this._isDogFood = false;
    try {
      const packages = await vscode.workspace.findFiles('package.json');
      if (packages.length === 1) {
        const content = await fs.promises.readFile(packages[0].fsPath, 'utf-8');
        if (JSON.parse(content).name === 'playwright-internal')
          this._isDogFood = true;
      }
    } catch {
    }
  }

  async listFiles(config: Config): Promise<ListFilesReport | null> {
    const node = this._findNode();
    const allArgs = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'list-tests', '-c', config.configFile];
    const childProcess = spawnSync(node, allArgs, {
      cwd: config.workspaceFolder,
      env: { ...process.env }
    });
    const output = childProcess.stdout.toString();
    if (!output)
      return null;
    try {
      const report = JSON.parse(output);
      return report as ListFilesReport;
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  async runTests(config: Config, projectName: string, location: string | null, listener: TestListener, token?: vscode.CancellationToken) {
    const args = location ? [location, '--project', projectName] : ['--project', projectName];
    await this._test(config, args, listener, token);
  }

  async listTests(config: Config, files: string[]): Promise<Entry[]> {
    let result: Entry[] = [];
    await this._test(config, [...files, '--list'], {
      onBegin: params => {
        result = params.files as Entry[];
        return true;
      }
    });
    return result;
  }

  private async _test(config: Config, args: string[], listener: TestListener, token?: vscode.CancellationToken): Promise<void> {
    const node = this._findNode();
    const allArgs = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'test', '-c', config.configFile, ...args, '--reporter', path.join(__dirname, 'oopReporter.js')];
    const childProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env }
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
    transport.onmessage = message => {
      if (token?.isCancellationRequested && message.method !== 'onEnd')
        return;
      switch (message.method) {
        case 'onBegin': {
          const terminate = !!listener.onBegin?.(message.params);
          if (terminate)
            transport.close();
          break;
        }
        case 'onTestBegin': listener.onTestBegin?.(message.params); break;
        case 'onTestEnd': listener.onTestEnd?.(message.params); break;
        case 'onError': listener.onError?.(message.params); break;
        case 'onEnd': {
          listener.onEnd?.();
          transport.close();
          break;
        }
      }
    };
    return new Promise(f => {
      transport.onclose = f;
    });
  }

  async debugTest(config: Config, projectName: string, location: string) {
    const args = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'test', '-c', config.configFile, location!, '--project', projectName, '--headed', '--timeout', '0'];
    vscode.debug.startDebugging(undefined, {
      type: 'pwa-node',
      name: 'Playwright Test',
      request: 'launch',
      cwd: config.workspaceFolder,
      env: { ...process.env, PW_OUT_OF_PROCESS: '1', PW_IGNORE_COMPILE_CACHE: '1' },
      args,
      resolveSourceMapLocations: [],
      outFiles: [],
    });
  }

  private _nodeModules(config: Config) {
    if (!this._isDogFood)
      return 'node_modules';

    if (config.configFile.includes('playwright-test'))
      return 'tests/playwright-test/stable-test-runner/node_modules';
    return 'packages';
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

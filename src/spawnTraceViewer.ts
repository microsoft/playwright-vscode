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

import { ChildProcess, spawn } from 'child_process';
import type { TestConfig } from './playwrightTestTypes';
import { findNode } from './utils';
import * as vscodeTypes from './vscodeTypes';
import { TraceViewer } from './traceViewer';

export class SpawnTraceViewer implements TraceViewer {
  private _vscode: vscodeTypes.VSCode;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _traceViewerProcess: ChildProcess | undefined;
  private _currentFile?: string;
  private _config: TestConfig;
  private _serverUrlPrefixForTest?: string;

  constructor(vscode: vscodeTypes.VSCode, envProvider: () => NodeJS.ProcessEnv, config: TestConfig) {
    this._vscode = vscode;
    this._envProvider = envProvider;
    this._config = config;
  }

  currentFile() {
    return this._currentFile;
  }

  async willRunTests() {
    await this._startIfNeeded();
  }

  async open(file?: string) {
    this._currentFile = file;
    if (!file && !this._traceViewerProcess)
      return;
    await this._startIfNeeded();
    this._traceViewerProcess?.stdin?.write(file + '\n');
  }

  private async _startIfNeeded() {
    const node = await findNode(this._vscode, this._config.workspaceFolder);
    if (this._traceViewerProcess)
      return;
    const allArgs = [this._config.cli, 'show-trace', `--stdin`];
    if (this._vscode.env.remoteName) {
      allArgs.push('--host', '0.0.0.0');
      allArgs.push('--port', '0');
    }
    const traceViewerProcess = spawn(node, allArgs, {
      cwd: this._config.workspaceFolder,
      stdio: 'pipe',
      detached: true,
      env: {
        ...process.env,
        ...this._envProvider(),
      },
    });
    this._traceViewerProcess = traceViewerProcess;

    traceViewerProcess.stdout?.on('data', data => console.log(data.toString()));
    traceViewerProcess.stderr?.on('data', data => console.log(data.toString()));
    traceViewerProcess.on('exit', () => {
      this._traceViewerProcess = undefined;
      this._currentFile = undefined;
    });
    traceViewerProcess.on('error', error => {
      this._vscode.window.showErrorMessage(error.message);
      this.close();
    });
    if (this._vscode.isUnderTest) {
      traceViewerProcess.stdout?.on('data', data => {
        const match = data.toString().match(/Listening on (.*)/);
        if (match)
          this._serverUrlPrefixForTest = match[1];
      });
    }
  }

  close() {
    this._traceViewerProcess?.stdin?.end();
    this._traceViewerProcess = undefined;
    this._currentFile = undefined;
    this._serverUrlPrefixForTest = undefined;
  }

  async infoForTest() {
    return {
      type: 'spawn',
      serverUrlPrefix: this._serverUrlPrefixForTest,
      testConfigFile: this._config.configFile,
      traceFile: this._currentFile,
      visible: !!this._serverUrlPrefixForTest
    };
  }
}

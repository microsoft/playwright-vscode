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

export type TraceViewer = SpawnTraceViewer;

export class SpawnTraceViewer {
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

  isStarted() {
    return !!this._traceViewerProcess;
  }

  currentFile() {
    return this._currentFile;
  }

  async willRunTests() {
    await this._startIfNeeded();
  }

  async open(file: string) {
    await this._startIfNeeded();
    this._traceViewerProcess?.stdin?.write(file + '\n');
    this._currentFile = file;
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

  checkVersion() {
    const version = 1.35;
    if (this._config.version < version) {
      const message = this._vscode.l10n.t('this feature');
      this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Playwright v{0}+ is required for {1} to work, v{2} found', version, message, this._config.version)
      );
      return false;
    }
    return true;
  }

  close() {
    this._traceViewerProcess?.stdin?.end();
    this._traceViewerProcess = undefined;
    this._currentFile = undefined;
    this._serverUrlPrefixForTest = undefined;
  }

  infoForTest() {
    if (!this._serverUrlPrefixForTest)
      return;
    return {
      type: 'spawn',
      serverUrlPrefix: this._serverUrlPrefixForTest,
      testConfigFile: this._config.configFile,
      traceFile: this.currentFile(),
    };
  }
}

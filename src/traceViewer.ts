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
import { SettingsModel } from './settingsModel';
import { findNode } from './utils';
import * as vscodeTypes from './vscodeTypes';

export class TraceViewer implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _disposables: vscodeTypes.Disposable[] = [];
  private _traceViewerProcess: ChildProcess | undefined;
  private _settingsModel: SettingsModel;
  private _currentFile?: string;

  constructor(vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._envProvider = envProvider;
    this._settingsModel = settingsModel;

    this._disposables.push(settingsModel.showTrace.onChange(value => {
      if (!value && this._traceViewerProcess)
        this.close().catch(() => {});
    }));
  }

  currentFile() {
    return this._currentFile;
  }

  async willRunTests(config: TestConfig) {
    if (this._settingsModel.showTrace.get())
      await this._startIfNeeded(config);
  }

  async open(file: string, config: TestConfig) {
    if (!this._settingsModel.showTrace.get())
      return;
    if (!this._checkVersion(config))
      return;
    if (!file && !this._traceViewerProcess)
      return;
    await this._startIfNeeded(config);
    this._traceViewerProcess?.stdin?.write(file + '\n');
    this._currentFile = file;
  }

  dispose() {
    this.close().catch(() => {});
    for (const d of this._disposables)
      d.dispose();
    this._disposables = [];
  }

  private async _startIfNeeded(config: TestConfig) {
    const node = await findNode(this._vscode, config.workspaceFolder);
    if (this._traceViewerProcess)
      return;
    const allArgs = [config.cli, 'show-trace', `--stdin`];
    if (this._vscode.env.remoteName) {
      allArgs.push('--host', '0.0.0.0');
      allArgs.push('--port', '0');
    }
    const traceViewerProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
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
      this.close().catch(() => {});
    });
  }

  private _checkVersion(
    config: TestConfig,
    message: string = this._vscode.l10n.t('this feature')
  ): boolean {
    if (config.version < 1.35) {
      this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Playwright v1.35+ is required for {0} to work, v{1} found', message, config.version)
      );
      return false;
    }
    return true;
  }

  async close() {
    this._traceViewerProcess?.stdin?.end();
    this._traceViewerProcess = undefined;
  }
}

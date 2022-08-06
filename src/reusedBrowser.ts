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
import { PlaywrightTest, TestConfig } from './playwrightTest';
import { SidebarViewProvider } from './sidebarView';
import { TestModel } from './testModel';
import { createGuid } from './utils';
import * as vscodeTypes from './vscodeTypes';

export class ReusedBrowser implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  private _sidebarView!: SidebarViewProvider;
  private _playwrightTest: PlaywrightTest;
  private _serverProcess: ChildProcess | undefined;
  private _selectorExplorerBox: vscodeTypes.InputBox | undefined;

  constructor(vscode: vscodeTypes.VSCode, context: vscodeTypes.ExtensionContext, sidebarView: SidebarViewProvider, playwrightTest: PlaywrightTest) {
    this._vscode = vscode;
    this._sidebarView = sidebarView;
    this._playwrightTest = playwrightTest;
    const disposables = [
      this._sidebarView.onDidChangeReuseBrowser(async reuseBrowser => {
        if (!reuseBrowser)
          this.stop();
      }),
      this,
    ];
    context.subscriptions.push(...disposables);
  }

  dispose() {
    this.stop();
  }

  async startIfNeeded(config: TestConfig) {
    if (this._selectorExplorerBox) {
      this._selectorExplorerBox.dispose();
      this._selectorExplorerBox = undefined;
    }

    if (!this._sidebarView.reuseBrowser() || this._serverProcess)
      return;

    if (config.version < 1.25) {
      this._vscode.window.showErrorMessage(`Playwright v1.25+ is required for browser reuse, v${config.version} found`);
      return;
    }
    const node = await this._playwrightTest.findNode();
    const allArgs = [
      config.cli,
      'run-server',
      '--reuse-browser',
      `--path=/${createGuid()}`
    ];
    this._serverProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, PW_CODEGEN_NO_INSPECTOR: '1' },
    });

    this._serverProcess.stdout?.on('data', () => {});
    this._serverProcess.stderr?.on('data', () => {});
    this._serverProcess.on('exit', () => {
      this._setBrowserServerWS(undefined);
      this._serverProcess = undefined;
    });
    this._serverProcess.on('error', error => {
      this._vscode.window.showErrorMessage(error.message);
      this.stop();
    });

    await new Promise<void>((f, r) => {
      this._serverProcess!.on('exit', () => f());
      this._serverProcess!.on('message', (message: any) => {
        if (message.method === 'ready') {
          this._setBrowserServerWS(message.params.wsEndpoint);
          f();
          return;
        }

        if (message.method === 'inspectRequested') {
          if (this._selectorExplorerBox)
            this._selectorExplorerBox.value = message.params.selector;
          return;
        }

        if (message.method === 'error') {
          console.error(message.params.error);
          return;
        }
      });
    });

  }

  private _setBrowserServerWS(wsEndpoint: string | undefined) {
    this._playwrightTest.setBrowserServerWS(wsEndpoint);
  }

  async inspect(models: TestModel[]) {
    if (!this._serverProcess)
      await this.startIfNeeded(models[0].config);

    if (this._selectorExplorerBox)
      this._selectorExplorerBox.dispose();
    this._send('inspect', { enabled: true });
    this._selectorExplorerBox = this._vscode.window.createInputBox();
    this._selectorExplorerBox.title = 'Pick selector';
    this._selectorExplorerBox.value = '';
    this._selectorExplorerBox.prompt = 'Accept to copy selector into clipboard';
    this._selectorExplorerBox.ignoreFocusOut = true;
    this._selectorExplorerBox.onDidChangeValue(selector => {
      this._send('highlight', { selector });
    });
    this._selectorExplorerBox.onDidHide(() => {
      this._send('inspect', { enabled: false });
      this._selectorExplorerBox = undefined;
    });
    this._selectorExplorerBox.onDidAccept(() => {
      this._vscode.env.clipboard.writeText(this._selectorExplorerBox!.value);
      this._selectorExplorerBox?.dispose();
    });
    this._selectorExplorerBox.show();
  }

  stop() {
    this._send('kill');
    this._serverProcess = undefined;
  }

  private _send(method: string, params = {}) {
    this._serverProcess?.send({ method, params });
  }
}

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
import { TestConfig } from './playwrightTest';
import { TestModel, TestProject } from './testModel';
import { createGuid, findNode } from './utils';
import * as vscodeTypes from './vscodeTypes';
import path from 'path';
import fs from 'fs';
import EventEmitter from 'events';

export class ReusedBrowser implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  private _selectorExplorerBox: vscodeTypes.InputBox | undefined;
  private _browserServerWS: string | undefined;
  private _showReuseBrowserForTests = false;
  private _backend: Backend | undefined;

  constructor(vscode: vscodeTypes.VSCode) {
    this._vscode = vscode;
  }

  dispose() {
    this.stop();
  }

  setReuseBrowserForTests(enabled: boolean) {
    this._showReuseBrowserForTests = enabled;
  }

  async startIfNeeded(config: TestConfig) {
    // Unconditionally close selector dialog, it might send inspect(enabled: false).
    if (this._backend) {
      await this._cleanupModes();
      return;
    }

    const node = await findNode();
    const allArgs = [
      config.cli,
      'run-server',
      '--reuse-browser',
      `--path=/${createGuid()}`
    ];
    const serverProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, PW_CODEGEN_NO_INSPECTOR: '1' },
    });

    serverProcess.stdout?.on('data', () => {});
    serverProcess.stderr?.on('data', () => {});
    serverProcess.on('exit', () => {
      this._browserServerWS = undefined;
      this._backend = undefined;
    });
    serverProcess.on('error', error => {
      this._vscode.window.showErrorMessage(error.message);
      this.stop();
    });

    this._backend = new Backend(serverProcess);
    this._backend.on('inspectRequested', params => {
      if (this._selectorExplorerBox)
        this._selectorExplorerBox.value = params.selector;
    });

    await new Promise<void>(f => {
      serverProcess!.on('exit', () => f());
      this._backend!.on('ready', params => {
        this._browserServerWS = params.wsEndpoint;
        f();
      });
    });
  }

  browserServerEnv(): NodeJS.ProcessEnv | undefined {
    return this._showReuseBrowserForTests && this._browserServerWS ? {
      PW_TEST_REUSE_CONTEXT: '1',
      PW_TEST_CONNECT_WS_ENDPOINT: this._browserServerWS,
    } : undefined;
  }

  async inspect(models: TestModel[]) {
    if (!this._checkVersion(models[0].config, 'selector picker'))
      return;

    await this.startIfNeeded(models[0].config);
    await this._backend?.setMode({ mode: 'inspecting' });

    this._selectorExplorerBox = this._vscode.window.createInputBox();
    this._selectorExplorerBox.title = 'Pick selector';
    this._selectorExplorerBox.value = '';
    this._selectorExplorerBox.prompt = 'Accept to copy selector into clipboard';
    this._selectorExplorerBox.ignoreFocusOut = true;
    this._selectorExplorerBox.onDidChangeValue(selector => {
      this._backend?.highlight({ selector }).catch(() => {});
    });
    this._selectorExplorerBox.onDidHide(() => {
      this._backend?.setMode({ mode: 'none' }).catch(() => {});
      this._selectorExplorerBox = undefined;
    });
    this._selectorExplorerBox.onDidAccept(() => {
      this._vscode.env.clipboard.writeText(this._selectorExplorerBox!.value);
      this._selectorExplorerBox?.dispose();
    });
    this._selectorExplorerBox.show();
  }

  async record(models: TestModel[]) {
    if (!this._checkVersion(models[0].config))
      return;

    await this._vscode.window.withProgress({
      location: this._vscode.ProgressLocation.Notification,
      title: 'Recording Playwright script',
      cancellable: true
    }, async (progress, token) => this._doRecord(models[0], token));
  }

  private _checkVersion(config: TestConfig, message: string = 'this feature'): boolean {
    if (config.version < 1.25) {
      this._vscode.window.showWarningMessage(`Playwright v1.25+ is required for ${message} to work, v${config.version} found`);
      return false;
    }
    return true;
  }

  private async _doRecord(model: TestModel, token: vscodeTypes.CancellationToken) {
    const [, file] = await Promise.all([
      this.startIfNeeded(model.config),
      this._createFileForNewTest(model),
    ]);

    await new Promise(f => {
      this._backend?.setMode({ mode: 'recording', file, language: 'test' });
      token.onCancellationRequested(f);
    });
    await this._backend?.setMode({ mode: 'none' });
  }

  private async _createFileForNewTest(model: TestModel) {
    const project = model.projects.values().next().value as TestProject;
    if (!project)
      return;
    let file;
    for (let i = 1; i < 100; ++i) {
      file = path.join(project.testDir, `test-${i}.spec.ts`);
      if (fs.existsSync(file))
        continue;
      break;
    }
    if (!file)
      return;

    await fs.promises.writeFile(file, `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  // Recording...
});`);

    const document = await this._vscode.workspace.openTextDocument(file);
    await this._vscode.window.showTextDocument(document);
    return file;
  }

  async willRunTests(config: TestConfig) {
    if (!this._checkVersion(config, 'Show & reuse browser'))
      return;
    if (this._showReuseBrowserForTests)
      await this.startIfNeeded(config);
    this._backend?.setAutoClose({ enabled: false });
  }

  async didRunTests(config: TestConfig) {
    this._backend?.setAutoClose({ enabled: true });
  }

  private async _cleanupModes() {
    // This won't wait for setMode(none).
    if (this._selectorExplorerBox) {
      this._selectorExplorerBox.dispose();
      this._selectorExplorerBox = undefined;
    }
    // This will though.
    await this._backend?.setMode({ mode: 'none' });
  }

  stop() {
    this._backend?.kill();
    this._backend = undefined;
  }
}

class Backend extends EventEmitter {
  private _serverProcess: ChildProcess;
  private static _lastId = 0;
  private _callbacks = new Map<number, { fulfill: (a: any) => void, reject: (e: Error) => void }>();

  constructor(serverProcess: ChildProcess) {
    super();
    this._serverProcess = serverProcess;
    this._serverProcess!.on('message', (message: any) => {
      if (!message.id) {
        this.emit(message.method, message.params);
        return;
      }
      const pair = this._callbacks.get(message.id);
      if (!pair)
        return;
      this._callbacks.delete(message.id);
      if ('error' in message)
        pair.reject(new Error(message.error));
      else
        pair.fulfill(message.result);
    });
  }

  async setMode(params: { mode: 'none' | 'inspecting' | 'recording', language?: string, file?: string }) {
    this._send('setMode', params);
  }

  async setAutoClose(params: { enabled: boolean }) {
    this._send('setAutoClose', params);
  }

  async highlight(params: { selector: string }) {
    this._send('highlight', params);
  }

  async kill() {
    this._send('kill');
  }

  private _send(method: string, params: any = {}): Promise<any> {
    return new Promise((fulfill, reject) => {
      const id = ++Backend._lastId;
      this._serverProcess?.send({ id, method, params });
      this._callbacks.set(id, { fulfill, reject });
    });
  }
}

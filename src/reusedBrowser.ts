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
import { installBrowsers } from './installer';

export type Snapshot = {
  browsers: BrowserSnapshot[];
};

export type BrowserSnapshot = {
  guid: string;
  name: string;
  contexts: ContextSnapshot[];
};

export type ContextSnapshot = {
  guid: string;
  pages: PageSnapshot[];
};

export type PageSnapshot = {
  guid: string;
  url: string;
};

export class ReusedBrowser implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  private _browserServerWS: string | undefined;
  private _shouldReuseBrowserForTests = false;
  private _backend: Backend | undefined;
  private _cancelRecording: (() => void) | undefined;
  private _updateOrCancelInspecting: ((params: { selector?: string, cancel?: boolean }) => void) | undefined;
  private _isRunningTests = false;

  constructor(vscode: vscodeTypes.VSCode) {
    this._vscode = vscode;
  }

  dispose() {
    this.stop();
  }

  setReuseBrowserForRunningTests(enabled: boolean) {
    this._shouldReuseBrowserForTests = enabled;
  }

  private async _startBackendIfNeeded(config: TestConfig) {
    // Unconditionally close selector dialog, it might send inspect(enabled: false).
    if (this._backend) {
      await this._reset();
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
      this._updateOrCancelInspecting?.({ selector: params.selector });
    });
    this._backend.on('browsersChanged', params => {
      const pages: PageSnapshot[] = [];
      for (const browser of params.browsers) {
        for (const context of browser.contexts)
          pages.push(...context.pages);
      }
      this._pagesUpdated(pages);
    });

    await new Promise<void>(f => {
      serverProcess!.on('exit', () => f());
      this._backend!.on('ready', params => {
        this._browserServerWS = params.wsEndpoint;
        f();
      });
    });
  }

  private _pagesUpdated(pages: PageSnapshot[]) {
    if (pages.length)
      return;
    if (this._isRunningTests)
      return;
    if (!this._cancelRecording && !this._updateOrCancelInspecting)
      return;
    this._reset();
  }

  browserServerEnv(): NodeJS.ProcessEnv | undefined {
    return this._shouldReuseBrowserForTests && this._browserServerWS ? {
      PW_TEST_REUSE_CONTEXT: '1',
      PW_TEST_CONNECT_WS_ENDPOINT: this._browserServerWS,
    } : undefined;
  }

  async inspect(models: TestModel[]) {
    if (!this._checkVersion(models[0].config, 'selector picker'))
      return;

    await this._startBackendIfNeeded(models[0].config);
    try {
      await this._backend?.setMode({ mode: 'inspecting' });
    } catch (e) {
      showExceptionAsUserError(this._vscode, models[0], e as Error);
      return;
    }

    const selectorExplorerBox = this._vscode.window.createInputBox();
    selectorExplorerBox.title = 'Pick selector';
    selectorExplorerBox.value = '';
    selectorExplorerBox.prompt = 'Accept to copy selector into clipboard';
    selectorExplorerBox.ignoreFocusOut = true;
    selectorExplorerBox.onDidChangeValue(selector => {
      this._backend?.highlight({ selector }).catch(() => {});
    });
    selectorExplorerBox.onDidHide(() => this._reset().catch(() => {}));
    selectorExplorerBox.onDidAccept(() => {
      this._vscode.env.clipboard.writeText(selectorExplorerBox!.value);
      selectorExplorerBox.hide();
    });
    selectorExplorerBox.show();
    this._updateOrCancelInspecting = params => {
      if (params.cancel)
        selectorExplorerBox.dispose();
      else if (params.selector)
        selectorExplorerBox.value = params.selector;
    };
  }

  async record(models: TestModel[], reset: boolean) {
    if (!this._checkVersion(models[0].config))
      return;

    await this._vscode.window.withProgress({
      location: this._vscode.ProgressLocation.Notification,
      title: 'Recording Playwright script',
      cancellable: true
    }, async (progress, token) => this._doRecord(models[0], reset, token));
  }

  hideHighlight(): boolean {
    this._backend?.hideHighlight().catch(() => {});
    return !!this._backend;
  }

  private _checkVersion(config: TestConfig, message: string = 'this feature'): boolean {
    if (config.version < 1.25) {
      this._vscode.window.showWarningMessage(`Playwright v1.25+ is required for ${message} to work, v${config.version} found`);
      return false;
    }
    return true;
  }

  private async _doRecord(model: TestModel, reset: boolean, token: vscodeTypes.CancellationToken) {
    const [, file] = await Promise.all([
      this._startBackendIfNeeded(model.config),
      this._createFileForNewTest(model),
    ]);

    if (reset) {
      await this._backend?.resetForReuse();
      await this._backend?.navigate({ url: 'about:blank' });
    }

    try {
      await this._backend?.setMode({ mode: 'recording', file, language: 'test' });
    } catch (e) {
      showExceptionAsUserError(this._vscode, model, e as Error);
      this._reset();
      return;
    }

    await Promise.race([
      new Promise<void>(f => token.onCancellationRequested(f)),
      new Promise<void>(f => this._cancelRecording = f),
    ]);
    await this._reset();
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
    if (!this._shouldReuseBrowserForTests)
      return;
    if (!this._checkVersion(config, 'Show & reuse browser'))
      return;
    await this._startBackendIfNeeded(config);
    this._backend?.setAutoClose({ enabled: false });
    this._isRunningTests = true;
  }

  async didRunTests(config: TestConfig) {
    this._isRunningTests = false;
    this._backend?.setAutoClose({ enabled: true });
  }

  private async _reset() {
    // This won't wait for setMode(none).
    this._updateOrCancelInspecting?.({ cancel: true });
    this._updateOrCancelInspecting = undefined;
    this._cancelRecording?.();
    this._cancelRecording = undefined;

    // This will though.
    await this._backend?.setMode({ mode: 'none' });
  }

  stop() {
    this._backend?.kill();
    this._backend = undefined;
    this._reset().catch(() => {});
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

  async resetForReuse() {
    await this._send('resetForReuse');
  }

  async navigate(params: { url: string }) {
    await this._send('navigate', params);
  }

  async setMode(params: { mode: 'none' | 'inspecting' | 'recording', language?: string, file?: string }) {
    await this._send('setMode', params);
  }

  async setAutoClose(params: { enabled: boolean }) {
    await this._send('setAutoClose', params);
  }

  async highlight(params: { selector: string }) {
    await this._send('highlight', params);
  }

  async hideHighlight() {
    await this._send('hideHighlight');
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

function showExceptionAsUserError(vscode: vscodeTypes.VSCode, model: TestModel, error: Error) {
  if (error.message.includes('Looks like Playwright Test or Playwright'))
    installBrowsers(vscode, model);
  else
    vscode.window.showErrorMessage(error.message);
}

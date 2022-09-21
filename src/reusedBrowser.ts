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
import events from 'events';
import EventEmitter from 'events';
import { installBrowsers } from './installer';
import { WebSocketTransport } from './transport';

export type Snapshot = {
  browsers: BrowserSnapshot[];
};

export type BrowserSnapshot = {
  contexts: ContextSnapshot[];
};

export type ContextSnapshot = {
  pages: PageSnapshot[];
};

export type PageSnapshot = {
  url: string;
};

export type SourceHighlight = {
  line: number;
  type: 'running' | 'paused' | 'error';
};

export type Source = {
  isRecorded: boolean;
  id: string;
  label: string;
  text: string;
  language: string;
  highlight: SourceHighlight[];
  revealLine?: number;
  // used to group the language generators
  group?: string;
};

export class ReusedBrowser implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  private _browserServerWS: string | undefined;
  private _shouldReuseBrowserForTests = false;
  private _backend: Backend | LegacyBackend | undefined;
  private _cancelRecording: (() => void) | undefined;
  private _updateOrCancelInspecting: ((params: { selector?: string, cancel?: boolean }) => void) | undefined;
  private _isRunningTests = false;
  private _autoCloseTimer: any;
  private _editor: vscodeTypes.TextEditor | undefined;

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

    const legacyMode = config.version < 1.27;

    const node = await findNode();
    const allArgs = [
      config.cli,
      'run-server',
      `--path=/${createGuid()}`
    ];
    if (legacyMode)
      allArgs.push('--reuse-browser');

    const serverProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: legacyMode ? ['pipe', 'pipe', 'pipe', 'ipc'] : 'pipe',
      env: { ...process.env, PW_CODEGEN_NO_INSPECTOR: '1' },
    });

    if (legacyMode)
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

    this._backend = legacyMode ? new LegacyBackend(serverProcess) : new Backend();
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
    this._backend.on('sourcesChanged', params => {
      if (!this._editor)
        return;
      const sources: Source[] = params.sources;
      for (const source of sources) {
        if (source.id !== 'test' || !source.isRecorded || source.language !== 'javascript' || source.label !== 'Test Runner')
          continue;
        const start = new this._vscode.Position(0, 0);
        const end = new this._vscode.Position(Number.MAX_VALUE, Number.MAX_VALUE);
        const range = this._editor.document.validateRange(new this._vscode.Range(start, end));
        this._editor?.edit(async editBuilder => {
          editBuilder.replace(range, source.text);
        });
      }
    });

    let connectedCallback: (wsEndpoint: string) => void;
    const wsEndpointPromise = new Promise<string>(f => connectedCallback = f);

    if (legacyMode) {
      this._backend!.on('ready', params => connectedCallback(params.wsEndpoint));
    } else {
      serverProcess.stdout?.on('data', data => {
        const match = data.toString().match(/Listening on (.*)/);
        if (!match)
          return;
        const wse = match[1];
        (this._backend as Backend).connect(wse).then(() => connectedCallback(wse));
      });
    }

    await Promise.race([
      wsEndpointPromise.then(wse => this._browserServerWS = wse),
      events.once(serverProcess, 'exit'),
    ]);
  }

  private _pagesUpdated(pages: PageSnapshot[]) {
    if (this._autoCloseTimer)
      clearTimeout(this._autoCloseTimer);
    if (pages.length)
      return;
    if (this._isRunningTests)
      return;
    if (!this._cancelRecording && !this._updateOrCancelInspecting)
      return;
    this._reset();
    this._autoCloseTimer = setTimeout(() => this.stop(), 30000);
  }

  browserServerEnv(debug: boolean): NodeJS.ProcessEnv | undefined {
    return (debug || this._shouldReuseBrowserForTests) && this._browserServerWS ? {
      PW_TEST_REUSE_CONTEXT: this._shouldReuseBrowserForTests ? '1' : undefined,
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

  highlight(selector: string) {
    this._backend?.highlight({ selector }).catch(() => {});
  }

  hideHighlight() {
    this._backend?.hideHighlight().catch(() => {});
  }

  private _checkVersion(config: TestConfig, message: string = 'this feature'): boolean {
    if (config.version < 1.25) {
      this._vscode.window.showWarningMessage(`Playwright v1.25+ is required for ${message} to work, v${config.version} found`);
      return false;
    }
    return true;
  }

  private async _doRecord(model: TestModel, reset: boolean, token: vscodeTypes.CancellationToken) {
    const startBackend = this._startBackendIfNeeded(model.config);
    const [, editor] = await Promise.all([
      startBackend,
      this._createFileForNewTest(model),
    ]);
    this._editor = editor;

    if (reset) {
      await this._backend?.resetForReuse();
      await this._backend?.navigate({ url: 'about:blank' });
    }

    try {
      await this._backend?.setMode({ mode: 'recording', language: 'test' });
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
    return await this._vscode.window.showTextDocument(document);
  }

  async willRunTests(config: TestConfig, debug: boolean) {
    if (!this._shouldReuseBrowserForTests && !debug)
      return;
    if (!this._checkVersion(config, 'Show & reuse browser'))
      return;
    await this._startBackendIfNeeded(config);
    await this._backend!.setReuseBrowser({ enabled: true });
    await this._backend!.setAutoClose({ enabled: false });
    this._isRunningTests = true;
  }

  async didRunTests(debug: boolean) {
    this._isRunningTests = false;
    if (debug && !this._shouldReuseBrowserForTests) {
      this.stop();
    } else {
      this._backend?.setAutoClose({ enabled: true });
      this._backend?.setReuseBrowser({ enabled: false });
    }
  }

  private async _reset() {
    // This won't wait for setMode(none).
    this._editor = undefined;
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
  private static _lastId = 0;
  private _callbacks = new Map<number, { fulfill: (a: any) => void, reject: (e: Error) => void }>();
  private _transport!: WebSocketTransport;

  constructor() {
    super();
  }

  async connect(wsEndpoint: string) {
    this._transport = await WebSocketTransport.connect(wsEndpoint, {
      'x-playwright-debug-controller': 'true'
    });
    this._transport.onmessage = (message: any) => {
      if (!message.id) {
        this.emit(message.method, message.params);
        return;
      }
      const pair = this._callbacks.get(message.id);
      if (!pair)
        return;
      this._callbacks.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.error?.message || message.error.value);
        error.stack = message.error.error?.stack;
        pair.reject(error);
      } else {
        pair.fulfill(message.result);
      }
    };
    this.setTrackHierarchy({ enabled: true });
  }

  async resetForReuse() {
    await this._send('resetForReuse');
  }

  async navigate(params: { url: string }) {
    await this._send('navigateAll', params);
  }

  async setMode(params: { mode: 'none' | 'inspecting' | 'recording', language?: string, file?: string }) {
    await this._send('setRecorderMode', params);
  }

  async setTrackHierarchy(params: { enabled: boolean }) {
    await this._send('setTrackHierarchy', params);
  }

  async setReuseBrowser(params: { enabled: boolean }) {
    await this._send('setReuseBrowser', params);
  }

  async setAutoClose(params: { enabled: boolean }) {
  }

  async highlight(params: { selector: string }) {
    await this._send('highlightAll', params);
  }

  async hideHighlight() {
    await this._send('hideHighlightAll');
  }

  async kill() {
    this._send('kill');
  }

  private _send(method: string, params: any = {}): Promise<any> {
    return new Promise((fulfill, reject) => {
      const id = ++Backend._lastId;
      const command = { id, guid: 'DebugController', method, params, metadata: {} };
      this._transport.send(command as any);
      this._callbacks.set(id, { fulfill, reject });
    });
  }
}

class LegacyBackend extends EventEmitter {
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

  async setReuseBrowser() {}

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
      const id = ++LegacyBackend._lastId;
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

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
import { createGuid, findNode, spawnAsync } from './utils';
import * as vscodeTypes from './vscodeTypes';
import path from 'path';
import fs from 'fs';
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
    if (this._backend && this._backend.config.docker !== config.docker)
      this.stop();

    // Unconditionally close selector dialog, it might send inspect(enabled: false).
    if (this._backend) {
      await this._reset();
      return;
    }

    try {
      const legacyMode = config.version < 1.27;
      if (legacyMode)
        this._backend = await LegacyBackend.create(config);
      else if (config.docker)
        this._backend = await Backend.createForDocker(config);
      else
        this._backend = await Backend.create(config);
    } catch (error) {
      this._vscode.window.showErrorMessage((error as Error).message);
      throw error;
    }
    this._backend!.on('close', () => this.stop());
    this._backend!.on('inspectRequested', params => {
      this._updateOrCancelInspecting?.({ selector: params.selector });
    });
    this._backend!.on('browsersChanged', params => {
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
    return (debug || this._shouldReuseBrowserForTests) && this._backend?.wsEndpoint ? {
      PW_TEST_REUSE_CONTEXT: this._shouldReuseBrowserForTests ? '1' : undefined,
      PW_TEST_CONNECT_WS_ENDPOINT: this._backend?.wsEndpoint,
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
    const [, editor] = await Promise.all([
      this._startBackendIfNeeded(model.config),
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
    this._backend?.stop();
    this._backend = undefined;
    this._reset().catch(() => {});
  }
}

class Backend extends EventEmitter {
  private static _lastId = 0;
  private _callbacks = new Map<number, { fulfill: (a: any) => void, reject: (e: Error) => void }>();
  private _transport!: WebSocketTransport;
  private _isStopped: boolean = false;
  readonly config: TestConfig;
  readonly wsEndpoint: string;

  static async create(config: TestConfig) {
    const serverProcess = spawn(await findNode(), [
      config.cli,
      'run-server',
      `--path=/${createGuid()}`
    ], {
      cwd: config.workspaceFolder,
      stdio: 'pipe',
      env: { ...process.env, PW_CODEGEN_NO_INSPECTOR: '1' },
    });

    serverProcess.stderr?.on('data', () => {});
    const { wsEndpoint, error } = await new Promise<{ wsEndpoint?: string, error?: Error }>(resolve => {
      serverProcess.once('exit', () => resolve({ error: new Error('failed to connect to server') }));
      serverProcess.once('error', error => resolve({ error }));
      serverProcess.stdout?.on('data', data => {
        const match = data.toString().match(/Listening on (.*)/);
        if (!match)
          return;
        resolve({ wsEndpoint: match[1] });
      });
    });
    if (error)
      throw error;
    if (!wsEndpoint)
      throw new Error('Internal error: Failed to connect to backend');
    const backend = new Backend(config, wsEndpoint);
    await backend.connect();
    return backend;
  }

  static async createForDocker(config: TestConfig) {
    const result = await spawnAsync(await findNode(), [
      config.cli,
      'docker',
      `print-status-json`
    ], config.workspaceFolder);
    const { containerWSEndpoint } = JSON.parse(result);
    const backend = new Backend(config, containerWSEndpoint);
    await backend.connect('use-global-network-tethering');
    return backend;
  }

  constructor(config: TestConfig, wsEndpoint: string) {
    super();
    this.config = config;
    this.wsEndpoint = wsEndpoint;
  }

  async connect(networkMode?: string) {
    const headers: any = {
      'x-playwright-debug-controller': 'true'
    };
    if (networkMode)
      headers['x-playwright-proxy'] = networkMode;
    this._transport = await WebSocketTransport.connect(this.wsEndpoint, headers);
    this._transport.onclose = () => {
      this.stop();
      this.emit('close');
    };
    this._transport.onmessage = (message: any) => {
      if (this._isStopped)
        return;
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

  async stop() {
    if (this._isStopped)
      return;
    if (this.config.docker) {
      this._send('closeAllBrowsers');
      this._transport.close();
    } else {
      this._send('kill');
    }
    this._isStopped = true;
  }

  private _send(method: string, params: any = {}): Promise<any> {
    if (this._isStopped)
      return Promise.reject(new Error('cannot send to stopped backend'));
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
  private _isStopped: boolean = false;
  private static _lastId = 0;
  private _callbacks = new Map<number, { fulfill: (a: any) => void, reject: (e: Error) => void }>();
  readonly config: TestConfig;
  wsEndpoint: string = '';

  static async create(config: TestConfig) {
    const backend = new LegacyBackend(await findNode(), config);
    const result =  await Promise.race([
      backend.once('ready', params => {
        backend.wsEndpoint = params.wsEndpoint;
        return true;
      }),
      backend.once('close', () => false),
    ]);
    if (!result)
      throw new Error('failed to connect to legacy endpoint');
    return backend;
  }

  constructor(node: string, config: TestConfig) {
    super();
    this.config = config;
    this._serverProcess = spawn(node, [
      config.cli,
      'run-server',
      `--path=/${createGuid()}`,
      '--reuse-browser',
    ], {
      cwd: config.workspaceFolder,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, PW_CODEGEN_NO_INSPECTOR: '1' },
    });

    this._serverProcess.stdout?.on('data', () => {});
    this._serverProcess.stderr?.on('data', () => {});
    this._serverProcess.on('exit', () => {
      this.stop();
      this.emit('close');
    });
    this._serverProcess.on('error', error => this.emit('error', error));
    this._serverProcess!.on('message', (message: any) => {
      if (this._isStopped)
        return;
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

  async stop() {
    if (this._isStopped)
      return;
    this._send('kill');
    this._isStopped = true;
  }

  private _send(method: string, params: any = {}): Promise<any> {
    if (this._isStopped)
      return Promise.reject(new Error('cannot send to stopped backend'));
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

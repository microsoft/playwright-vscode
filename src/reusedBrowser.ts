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
import { SettingsModel } from './settingsModel';

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
  private _shouldLogApiCalls = false;
  private _backend: Backend | LegacyBackend | undefined;
  private _cancelRecording: (() => void) | undefined;
  private _updateOrCancelInspecting: ((params: { selector?: string, cancel?: boolean }) => void) | undefined;
  private _isRunningTests = false;
  private _editor: vscodeTypes.TextEditor | undefined;
  private _isInlineEdit = false;
  private _insertedEditActionCount = 0;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _disposables: vscodeTypes.Disposable[] = [];
  private _pageCount = 0;
  private _sawPages = false;
  readonly onPageCountChanged: vscodeTypes.Event<number>;
  private _onPageCountChangedEvent: vscodeTypes.EventEmitter<number>;
  readonly onRunningTestsChanged: vscodeTypes.Event<boolean>;
  private _onRunningTestsChangedEvent: vscodeTypes.EventEmitter<boolean>;
  private _isLegacyMode = false;
  private _editOperations = Promise.resolve();

  constructor(vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._envProvider = envProvider;
    this._onPageCountChangedEvent = new vscode.EventEmitter();
    this.onPageCountChanged = this._onPageCountChangedEvent.event;
    this._onRunningTestsChangedEvent = new vscode.EventEmitter();
    this.onRunningTestsChanged = this._onRunningTestsChangedEvent.event;

    this._disposables.push(settingsModel.setting<boolean>('reuseBrowser').onChange(value => {
      this._shouldReuseBrowserForTests = value;
    }));
    this._shouldReuseBrowserForTests = settingsModel.get<boolean>('reuseBrowser');

    this._disposables.push(settingsModel.setting<boolean>('logApiCalls').onChange(value => {
      this._shouldLogApiCalls = value;
    }));
    this._shouldLogApiCalls = settingsModel.get<boolean>('logApiCalls');
  }

  dispose() {
    this._reset(true).catch(() => {});
    for (const d of this._disposables)
      d.dispose();
    this._disposables = [];
  }

  private async _startBackendIfNeeded(config: TestConfig) {
    // Unconditionally close selector dialog, it might send inspect(enabled: false).
    if (this._backend) {
      await this._reset(false);
      return;
    }

    const legacyMode = config.version < 1.28;
    this._isLegacyMode = legacyMode;

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
      env: {
        ...process.env,
        ...this._envProvider(),
        PW_CODEGEN_NO_INSPECTOR: '1',
      },
    });

    const backend = legacyMode ? new LegacyBackend(serverProcess) : new Backend();
    if (legacyMode)
      this._pageCount = 1;  // Auto-close is handled on server-side.
    this._backend = backend;

    if (legacyMode)
      serverProcess.stdout?.on('data', () => {});
    serverProcess.stderr?.on('data', () => {});
    serverProcess.on('exit', () => {
      if (backend === this._backend) {
        this._backend = undefined;
        this._reset(false);
      }
    });
    serverProcess.on('error', error => {
      this._vscode.window.showErrorMessage(error.message);
      this._reset(true).catch(() => {});
    });

    this._backend.on('inspectRequested', params => {
      this._updateOrCancelInspecting?.({ selector: params.locator || params.selector });
    });

    if (!legacyMode) {
      this._backend.on('stateChanged', params => {
        this._pageCountChanged(params.pageCount);
      });
      this._backend.on('sourceChanged', async params => {
        this._scheduleEdit(async () => {
          if (!this._editor)
            return;
          if (this._isInlineEdit) {
            if (params.actions?.length > this._insertedEditActionCount) {
              // Collapse selection to start recoding a new action.
              this._editor.selections = [new this._vscode.Selection(this._editor.selection.end, this._editor.selection.end)];
            }
            this._insertedEditActionCount = params.actions.length;
            if (params.actions?.length) {
              await this._editor.edit(async editBuilder => {
                if (!this._editor)
                  return;
                const indent = guessIndentation(this._editor);
                const action = params.actions[params.actions.length - 1];
                const lineNumber = this._editor.selection.start.line;
                const line = this._editor.document.lineAt(lineNumber);
                const lineStart = new this._vscode.Position(lineNumber, 0);
                const lineEnd = new this._vscode.Position(lineNumber, line.text.length);
                // If there is text before cursor, we insert actions in a new line, otherwise, we insert them in the current line.
                const hasTextBeforeCursor = !!line.text.substring(0, this._editor.selection.start.character).trim();
                const selection = hasTextBeforeCursor
                  ? new this._vscode.Selection(lineEnd, lineEnd)
                  : new this._vscode.Selection(lineStart, this._editor.selection.end);
                editBuilder.replace(selection, (hasTextBeforeCursor ? '\n' : '') + indentBlock(action, indent) + '\n');
              });
            }
          } else {
            const start = new this._vscode.Position(0, 0);
            const end = new this._vscode.Position(Number.MAX_VALUE, Number.MAX_VALUE);
            const range = this._editor.document.validateRange(new this._vscode.Range(start, end));
            this._editor.edit(async editBuilder => {
              editBuilder.replace(range, params.text);
              if (this._editor) {
                const lastLine = this._editor.document.lineCount - 1;
                this._editor.selections = [new this._vscode.Selection(lastLine, 0, lastLine, 0)];
              }
            });
          }
        });
      });
    }

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
      wsEndpointPromise.then(wse => {
        this._browserServerWS = wse;
        this._backend!.setReportStateChanged({ enabled: true });
      }),
      events.once(serverProcess, 'exit'),
    ]);
  }

  private _scheduleEdit(callback: () => Promise<void>) {
    this._editOperations = this._editOperations.then(callback).catch(() => {});
  }

  private _pageCountChanged(pageCount: number) {
    this._pageCount = pageCount;
    this._onPageCountChangedEvent.fire(pageCount);
    if (this._isRunningTests)
      return;
    if (!this._sawPages) {
      this._sawPages = !!pageCount;
      return;
    }
    if (pageCount)
      return;
    this._reset(true).catch(() => {});
  }

  browserServerEnv(debug: boolean): NodeJS.ProcessEnv | undefined {
    return (debug || this._shouldReuseBrowserForTests) && this._browserServerWS ? {
      PW_TEST_REUSE_CONTEXT: this._shouldReuseBrowserForTests ? '1' : undefined,
      PW_TEST_CONNECT_WS_ENDPOINT: this._browserServerWS,
    } : undefined;
  }

  browserServerWSForTest() {
    return this._browserServerWS;
  }

  logApiCallsEnv(): NodeJS.ProcessEnv | undefined {
    return this._shouldLogApiCalls ? {
      DEBUG: 'pw:api'
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
    selectorExplorerBox.onDidHide(() => this._reset(false).catch(() => {}));
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

  async record(models: TestModel[], isInlineEdit: boolean) {
    if (!this._checkVersion(models[0].config))
      return;
    if (this._isLegacyMode)
      isInlineEdit = false;
    await this._vscode.window.withProgress({
      location: this._vscode.ProgressLocation.Notification,
      title: 'Playwright codegen',
      cancellable: true
    }, async (progress, token) => this._doRecord(progress, models[0], isInlineEdit, token));
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

  private async _doRecord(progress: vscodeTypes.Progress<{ message?: string; increment?: number }>, model: TestModel, isInlineEdit: boolean, token: vscodeTypes.CancellationToken) {
    const startBackend = this._startBackendIfNeeded(model.config);
    if (isInlineEdit)
      this._editor = this._vscode.window.activeTextEditor;
    else
      this._editor = await this._createFileForNewTest(model);
    await startBackend;
    this._isInlineEdit = isInlineEdit;
    this._insertedEditActionCount = 0;

    progress.report({ message: 'starting\u2026' });

    if (!isInlineEdit) {
      await this._backend?.resetForReuse();
      await this._backend?.navigate({ url: 'about:blank' });
    }

    try {
      await this._backend?.setMode({ mode: 'recording', file: this._editor?.document.uri.fsPath });
    } catch (e) {
      showExceptionAsUserError(this._vscode, model, e as Error);
      await this._reset(true);
      return;
    }

    progress.report({ message: 'recording\u2026' });

    await Promise.race([
      new Promise<void>(f => token.onCancellationRequested(f)),
      new Promise<void>(f => this._cancelRecording = f),
    ]);
    await this._reset(false);
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
    this._isRunningTests = true;
    this._onRunningTestsChangedEvent.fire(true);
    await this._startBackendIfNeeded(config);
    await this._backend!.setAutoClose({ enabled: false });
  }

  async didRunTests(debug: boolean) {
    if (debug && !this._shouldReuseBrowserForTests) {
      this._reset(true);
    } else {
      this._backend?.setAutoClose({ enabled: true });
      if (!this._pageCount)
        await this._reset(true);
    }
    this._isRunningTests = false;
    this._onRunningTestsChangedEvent.fire(false);
  }

  closeAllBrowsers() {
    this._reset(true).catch(() => {});
  }

  private async _reset(stop: boolean) {
    // This won't wait for setMode(none).
    this._editor = undefined;
    this._isInlineEdit = false;
    this._insertedEditActionCount = 0;
    this._updateOrCancelInspecting?.({ cancel: true });
    this._updateOrCancelInspecting = undefined;
    this._cancelRecording?.();
    this._cancelRecording = undefined;

    // This will though.
    if (stop) {
      this._backend?.kill();
      this._backend = undefined;
      this._browserServerWS = undefined;
      this._pageCount = 0;
      this._sawPages = false;
    } else {
      await this._backend?.setMode({ mode: 'none' });
    }
  }
}

export class Backend extends EventEmitter {
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
  }

  async resetForReuse() {
    await this._send('resetForReuse');
  }

  async navigate(params: { url: string }) {
    await this._send('navigate', params);
  }

  async setMode(params: { mode: 'none' | 'inspecting' | 'recording', file?: string }) {
    await this._send('setRecorderMode', params);
  }

  async setReportStateChanged(params: { enabled: boolean }) {
    await this._send('setReportStateChanged', params);
  }

  async setAutoClose(params: { enabled: boolean }) {
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
        if (message.method === 'inspectRequested') {
          const { selector, locators } = message.params;
          this.emit(message.method, { selector, locator: locators.find((l: any) => l.name === 'javascript').value });
        } else {
          this.emit(message.method, message.params);
        }
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

  async setReportStateChanged(params: { enabled: boolean }) {
  }

  async resetForReuse() {
    await this._send('resetForReuse');
  }

  async navigate(params: { url: string }) {
    await this._send('navigate', params);
  }

  async setMode(params: { mode: 'none' | 'inspecting' | 'recording', file?: string }) {
    await this._send('setMode', { ...params, language: 'test' });
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

function guessIndentation(editor: vscodeTypes.TextEditor): number {
  const lineNumber = editor.selection.start.line;
  const line = editor.document.lineAt(lineNumber);
  if (line.text.substring(0, editor.selection.start.character).trim())
    return line.firstNonWhitespaceCharacterIndex;

  for (let i = lineNumber - 1; i >= 0; ++i) {
    const line = editor.document.lineAt(i);
    if (!line.isEmptyOrWhitespace)
      return line.firstNonWhitespaceCharacterIndex;
  }
  return 0;
}

function indentBlock(block: string, indent: number) {
  const lines = block.split('\n');
  if (!lines.length)
    return block;

  const blockIndent = lines[0].match(/\s*/)![0].length;
  const shift = ' '.repeat(Math.max(0, indent - blockIndent));
  if (!shift)
    return block;
  return lines.map(l => shift + l).join('\n');
}

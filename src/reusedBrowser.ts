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

import { spawn } from 'child_process';
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
import { InspectAssertDialog } from './InspectAssertDialog';
import { WaitingDialog } from './waitingDialog';

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
  private _backend: Backend | undefined;
  private _cancelRecording: (() => void) | undefined;
  private _updateOrCancelInspecting: ((params: { selector?: string, cancel?: boolean }) => void) | undefined;
  private _isRunningTests = false;
  private _editor: vscodeTypes.TextEditor | undefined;
  private _insertedEditActionCount = 0;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _disposables: vscodeTypes.Disposable[] = [];
  private _pageCount = 0;
  readonly onPageCountChanged: vscodeTypes.Event<number>;
  private _onPageCountChangedEvent: vscodeTypes.EventEmitter<number>;
  readonly onRunningTestsChanged: vscodeTypes.Event<boolean>;
  readonly _onHighlightRequestedForTestEvent: vscodeTypes.EventEmitter<string>;
  readonly onHighlightRequestedForTest: vscodeTypes.Event<string>;
  private _onRunningTestsChangedEvent: vscodeTypes.EventEmitter<boolean>;
  private _editOperations = Promise.resolve();
  private _pausedOnPagePause = false;

  constructor(vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._envProvider = envProvider;
    this._onPageCountChangedEvent = new vscode.EventEmitter();
    this.onPageCountChanged = this._onPageCountChangedEvent.event;
    this._onRunningTestsChangedEvent = new vscode.EventEmitter();
    this.onRunningTestsChanged = this._onRunningTestsChangedEvent.event;
    this._onHighlightRequestedForTestEvent = new vscode.EventEmitter();
    this.onHighlightRequestedForTest = this._onHighlightRequestedForTestEvent.event;

    this._disposables.push(settingsModel.setting<boolean>('reuseBrowser').onChange(value => {
      this._shouldReuseBrowserForTests = value;
    }));
    this._shouldReuseBrowserForTests = settingsModel.get<boolean>('reuseBrowser');
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

    const node = await findNode();
    const allArgs = [
      config.cli,
      'run-server',
      `--path=/${createGuid()}`
    ];

    const serverProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: 'pipe',
      env: {
        ...process.env,
        ...this._envProvider(),
        PW_CODEGEN_NO_INSPECTOR: '1',
      },
    });

    const backend = new Backend();
    this._backend = backend;

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

    this._backend.on('paused', async params => {
      if (!this._pausedOnPagePause && params.paused) {
        this._pausedOnPagePause = true;
        await this._vscode.window.showInformationMessage('Paused', { modal: false }, 'Resume');
        this._pausedOnPagePause = false;
        this._backend?.resume();
      }
    });
    this._backend.on('stateChanged', params => {
      this._pageCountChanged(params.pageCount);
    });
    this._backend.on('sourceChanged', async params => {
      this._scheduleEdit(async () => {
        if (!this._editor)
          return;
        if (!params.actions || !params.actions.length)
          return;
        const targetIndentation = guessIndentation(this._editor);

        // Previous action committed, insert new line & collapse selection.
        if (params.actions.length > 1 && params.actions?.length > this._insertedEditActionCount) {
          const range = new this._vscode.Range(this._editor.selection.end, this._editor.selection.end);
          await this._editor.edit(async editBuilder => {
            editBuilder.replace(range, '\n' + ' '.repeat(targetIndentation));
          });
          this._editor.selection = new this._vscode.Selection(this._editor.selection.end, this._editor.selection.end);
          this._insertedEditActionCount = params.actions.length;
        }

        // Replace selection with the current action.
        if (params.actions.length) {
          const selectionStart = this._editor.selection.start;
          await this._editor.edit(async editBuilder => {
            if (!this._editor)
              return;
            const action = params.actions[params.actions.length - 1];
            editBuilder.replace(this._editor.selection, indentBlock(action, targetIndentation));
          });
          const selectionEnd = this._editor.selection.end;
          this._editor.selection = new this._vscode.Selection(selectionStart, selectionEnd);
        }
      });
    });

    let connectedCallback: (wsEndpoint: string) => void;
    const wsEndpointPromise = new Promise<string>(f => connectedCallback = f);

    serverProcess.stdout?.on('data', async data => {
      const match = data.toString().match(/Listening on (.*)/);
      if (!match)
        return;
      const wse = match[1];
      await (this._backend as Backend).connect(wse);
      await this._backend?.initialize();
      connectedCallback(wse);
    });

    await Promise.race([
      wsEndpointPromise.then(wse => {
        this._browserServerWS = wse;
        this._backend!.setReportStateChanged({ enabled: true });
      }),
      events.once(serverProcess, 'exit'),
    ]);
  }

  private _scheduleEdit(callback: () => Promise<void>) {
    this._editOperations = this._editOperations.then(callback).catch(e => console.log(e));
  }

  isRunningTests() {
    return this._isRunningTests;
  }

  pageCount() {
    return this._pageCount;
  }

  private _pageCountChanged(pageCount: number) {
    this._pageCount = pageCount;
    this._onPageCountChangedEvent.fire(pageCount);
    if (this._isRunningTests)
      return;
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
    selectorExplorerBox.title = 'Pick locator';
    selectorExplorerBox.value = '';
    selectorExplorerBox.prompt = 'Accept to copy locator into clipboard';
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

  /**
   * Pick a locator and insert assertion
   * NOTICE: Modifications Copyright 2022.12.05 @csbun
   */
  async inspectAssert(models: TestModel[]) {
    if (!this._checkVersion(models[0].config, 'inspect and assert'))
      return;

    await this._startBackendIfNeeded(models[0].config);
    try {
      await this._backend?.setMode({ mode: 'inspecting' });
    } catch (e) {
      showExceptionAsUserError(this._vscode, models[0], e as Error);
      return;
    }

    const assertDialog = new InspectAssertDialog(this._vscode, this._vscode.window.activeTextEditor);
    this._updateOrCancelInspecting = params => {
      if (!params.cancel && params.selector) {
        assertDialog.updateOrCancelInspectAssert(params.selector)
            .then(() => {
              this._reset(false).catch(() => {});
              // TODO: resume record
            });
      }
    };
  }

  /**
   * Forced to wait for some time
   * NOTICE: Modifications Copyright 2023.03.22 @Simmon12
   */
  async waitSomeTime(models: TestModel[]) {
    if (!this._checkVersion(models[0].config, 'forced to wait for some time'))
      return;
    const toolBoxDialog = new WaitingDialog(this._vscode, this._vscode.window.activeTextEditor);
    toolBoxDialog.openDialog();
  }
  
  canRecord() {
    return !this._isRunningTests;
  }

  canClose() {
    return !this._isRunningTests && !!this._pageCount;
  }

  async record(models: TestModel[], recordNew: boolean) {
    if (!this._checkVersion(models[0].config))
      return;
    if (!this.canRecord()) {
      this._vscode.window.showWarningMessage(`Can't record while running tests`);
      return;
    }
    await this._vscode.window.withProgress({
      location: this._vscode.ProgressLocation.Notification,
      title: 'Playwright codegen',
      cancellable: true
    }, async (progress, token) => this._doRecord(progress, models[0], recordNew, token));
  }

  highlight(selector: string) {
    this._backend?.highlight({ selector }).catch(() => {});
    this._onHighlightRequestedForTestEvent.fire(selector);
  }

  hideHighlight() {
    this._backend?.hideHighlight().catch(() => {});
    this._onHighlightRequestedForTestEvent.fire('');
  }

  private _checkVersion(config: TestConfig, message: string = 'this feature'): boolean {
    if (config.version < 1.25) {
      this._vscode.window.showWarningMessage(`Playwright v1.25+ is required for ${message} to work, v${config.version} found`);
      return false;
    }
    return true;
  }

  private async _doRecord(progress: vscodeTypes.Progress<{ message?: string; increment?: number }>, model: TestModel, recordNew: boolean, token: vscodeTypes.CancellationToken) {
    const startBackend = this._startBackendIfNeeded(model.config);
    let editor: vscodeTypes.TextEditor | undefined;
    if (recordNew)
      editor = await this._createFileForNewTest(model);
    else
      editor = this._vscode.window.activeTextEditor;
    await startBackend;
    this._editor = editor;
    this._insertedEditActionCount = 0;

    progress.report({ message: 'starting\u2026' });

    if (recordNew) {
      await this._backend?.resetForReuse();
      await this._backend?.navigate({ url: 'about:blank' });
    }

    try {
      await this._backend?.setMode({ mode: 'recording', testIdAttributeName: model.config.testIdAttributeName });
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
    const editor = await this._vscode.window.showTextDocument(document);
    editor.selection = new this._vscode.Selection(new this._vscode.Position(3, 2), new this._vscode.Position(3, 2 + '// Recording...'.length));
    return editor;
  }

  async willRunTests(config: TestConfig, debug: boolean) {
    if (!this._shouldReuseBrowserForTests && !debug)
      return;
    if (!this._checkVersion(config, 'Show & reuse browser'))
      return;
    this._pausedOnPagePause = false;
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
    if (!this.canClose()) {
      this._vscode.window.showWarningMessage(`Can't close browsers while running tests`);
      return;
    }
    this._reset(true).catch(() => {});
  }

  private async _reset(stop: boolean) {
    // This won't wait for setMode(none).
    this._editor = undefined;
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

  async initialize() {
    await this._send('initialize', { codegenId: 'playwright-test', sdkLanguage: 'javascript' });
  }

  async resetForReuse() {
    await this._send('resetForReuse');
  }

  async navigate(params: { url: string }) {
    await this._send('navigate', params);
  }

  async setMode(params: { mode: 'none' | 'inspecting' | 'recording', testIdAttributeName?: string }) {
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

  async resume() {
    this._send('resume');
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

function showExceptionAsUserError(vscode: vscodeTypes.VSCode, model: TestModel, error: Error) {
  if (error.message.includes('Looks like Playwright Test or Playwright'))
    installBrowsers(vscode, model);
  else
    vscode.window.showErrorMessage(error.message);
}

function guessIndentation(editor: vscodeTypes.TextEditor): number {
  const lineNumber = editor.selection.start.line;
  for (let i = lineNumber; i >= 0; --i) {
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
  return lines.map((l, i) => i ? shift + l : l.trimStart()).join('\n');
}

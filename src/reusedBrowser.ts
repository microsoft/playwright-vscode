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

import type { TestConfig } from './playwrightTestServer';
import type { TestModel, TestModelCollection, TestProject } from './testModel';
import { createGuid } from './utils';
import * as vscodeTypes from './vscodeTypes';
import { installBrowsers } from './installer';
import { SettingsModel } from './settingsModel';
import { BackendServer, BackendClient } from './backend';

type RecorderMode = 'none' | 'standby' | 'inspecting' | 'recording';

export class ReusedBrowser implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  _testingBackend: Backend | undefined;
  private _cancelRecording: (() => void) | undefined;
  private _isRunningTests = false;
  private _insertedEditActionCount = 0;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _disposables: vscodeTypes.Disposable[] = [];
  private _testingPageCount = 0; // test runner pagecount
  private _openBrowsers = new Map<Backend, { id?: string; name: string; channel?: string; title: string }[]>();
  private _onPageCountChangedEvent: vscodeTypes.EventEmitter<number>;
  readonly onPageCountChanged: vscodeTypes.Event<number>;
  readonly _onHighlightRequestedForTestEvent: vscodeTypes.EventEmitter<string>;
  readonly onHighlightRequestedForTest: vscodeTypes.Event<string>;
  private _onRunningTestsChangedEvent: vscodeTypes.EventEmitter<boolean>;
  readonly onRunningTestsChanged: vscodeTypes.Event<boolean>;
  private _onInspectRequestedEvent: vscodeTypes.EventEmitter<{ locator: string, ariaSnapshot: string, backendVersion: number }>;
  readonly onInspectRequested: vscodeTypes.Event<{ locator: string, ariaSnapshot: string, backendVersion: number }>;
  private _editOperations = Promise.resolve();
  private _pausedOnPagePause = false;
  private _settingsModel: SettingsModel;
  private _recorderModeForTest: RecorderMode = 'none';
  _moderniseForTest = false;

  constructor(vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._envProvider = envProvider;
    this._onPageCountChangedEvent = new vscode.EventEmitter();
    this.onPageCountChanged = this._onPageCountChangedEvent.event;
    this._onRunningTestsChangedEvent = new vscode.EventEmitter();
    this.onRunningTestsChanged = this._onRunningTestsChangedEvent.event;
    this._onHighlightRequestedForTestEvent = new vscode.EventEmitter();
    this.onHighlightRequestedForTest = this._onHighlightRequestedForTestEvent.event;
    this._onInspectRequestedEvent = new vscode.EventEmitter();
    this.onInspectRequested = this._onInspectRequestedEvent.event;

    this._settingsModel = settingsModel;

    this._disposables.push(
        this._onPageCountChangedEvent,
        this._onHighlightRequestedForTestEvent,
        this._onRunningTestsChangedEvent,
        settingsModel.showBrowser.onChange(value => {
          if (!value)
            this.closeAllBrowsers();
        }),
    );
  }

  dispose() {
    this._stop();
    for (const d of this._disposables)
      d.dispose();
    this._disposables = [];
  }

  private async _startBackendIfNeeded(model: TestModel): Promise<{ errors?: string[] }> {
    // Unconditionally close selector dialog, it might send inspect(enabled: false).
    if (this._testingBackend) {
      await this._reset('none', this._testingBackend);
      return {};
    }

    const args = [
      model.config.cli,
      'run-server',
      `--path=/${createGuid()}`
    ];
    const cwd = model.config.workspaceFolder;
    const envProvider = () => ({
      ...this._envProvider(),
      PW_CODEGEN_NO_INSPECTOR: '1',
      PW_EXTENSION_MODE: '1',
    });

    const errors: string[] = [];
    const backendServer = new BackendServer(this._vscode, () => new Backend(this._vscode, model.config.version), {
      args,
      cwd,
      envProvider,
      errors,
      dumpIO: false,
    });
    const backend = await backendServer.startAndConnect();
    if (!backend)
      return { errors };
    backend.onClose(() => {
      if (backend === this._testingBackend) {
        void this._reset('none', this._testingBackend);
        this._testingBackend = undefined;
      }
    });
    backend.onError(e => {
      if (backend === this._testingBackend) {
        void this._vscode.window.showErrorMessage(e.message);
        void this._reset('none', this._testingBackend);
        this._testingBackend = undefined;
      }
    });

    this._testingBackend = backend;
    this._addDebugController(backend, model);
    return {};
  }

  async connectToDebugController({ wsEndpoint, version, onClose }: { wsEndpoint: string, version: number, onClose: () => void }) {
    const backend = new Backend(this._vscode, version);
    backend.onClose(onClose);
    backend.onError(onClose);
    this._addDebugController(backend);
    // connect after attaching listeners, so we get the initial state event
    await backend._connect(wsEndpoint);
  }

  private _addDebugController(backend: Backend, model?: TestModel) {
    this._openBrowsers.set(backend, []);
    backend.onClose(() => {
      this._openBrowsers.delete(backend);
      this._onPageCountChangedEvent.fire(this.pageCount());
    });
    backend.onError(e => {
      void this._vscode.window.showErrorMessage(e.message);
      this._openBrowsers.delete(backend);
      this._onPageCountChangedEvent.fire(this.pageCount());
    });

    backend.on('inspectRequested', params => {
      if (this._settingsModel.pickLocatorCopyToClipboard.get() && params.locator)
        void this._vscode.env.clipboard.writeText(params.locator);
      this._onInspectRequestedEvent.fire({ backendVersion: backend.version, ...params });
    });

    backend.on('setModeRequested', params => {
      if (params.mode === 'standby') {
        // When "pick locator" is cancelled from inside the browser UI,
        // get rid of the recorder toolbar for better experience.
        // Assume "pick locator" is active when we are not recording.
        void this._reset(this._cancelRecording ? 'standby' : 'none', backend);
        return;
      }
      if (params.mode === 'recording' && !this._cancelRecording) {
        this._onRecord();
        return;
      }
    });

    backend.on('paused', async params => {
      if (!this._pausedOnPagePause && params.paused) {
        this._pausedOnPagePause = true;
        await this._vscode.window.showInformationMessage('Paused', { modal: false }, 'Resume');
        this._pausedOnPagePause = false;
        backend?.resumeNoWait();
      }
    });
    backend.on('stateChanged', (params: DebugControllerState) => {
      // compat for <1.56
      if (model && (!params.browsers || this._moderniseForTest)) {
        let name = model.projects()[0]?.name || 'chromium';
        if (!['chromium', 'firefox', 'webkit'].includes(name))
          name = 'Browser';
        this._openBrowsers.set(backend, [{
          name,
          title: name,
        }]);
      } else {
        this._openBrowsers.set(backend, params.browsers.map(b => {
          let title = b.channel ?? b.name;
          const pages = b.contexts.flatMap(c => c.pages);
          const url = pages[0]?.url;
          if (url)
            title += ` - ${new URL(url).hostname || url}`;

          return {
            id: b.id,
            name: b.name,
            channel: b.channel,
            title,
          };
        }));
      }

      this._onPageCountChangedEvent.fire(this.pageCount());

      if (backend === this._testingBackend) {
        this._testingPageCount = params.pageCount;
        this._maybeStopTestingBackend();
      }
    });
    backend.on('sourceChanged', async params => {
      if (!this._cancelRecording)
        return;
      this._scheduleEdit(async () => {
        const editor = this._vscode.window.activeTextEditor;
        if (!editor)
          return;
        if (!params.actions || !params.actions.length)
          return;
        const targetIndentation = guessIndentation(editor);

        // Previous action committed, insert new line & collapse selection.
        if (params.actions.length > 1 && params.actions?.length > this._insertedEditActionCount) {
          const range = new this._vscode.Range(editor.selection.end, editor.selection.end);
          await editor.edit(async editBuilder => {
            editBuilder.replace(range, '\n' + ' '.repeat(targetIndentation));
          });
          editor.selection = new this._vscode.Selection(editor.selection.end, editor.selection.end);
          this._insertedEditActionCount = params.actions.length;
        }

        // Replace selection with the current action.
        if (params.actions.length) {
          const selectionStart = editor.selection.start;
          await editor.edit(async editBuilder => {
            if (!editor)
              return;
            const action = params.actions[params.actions.length - 1];
            const newText = indentBlock(action, targetIndentation);
            if (editor.document.getText(editor.selection) !== newText)
              editBuilder.replace(editor.selection, newText);
          });
          const selectionEnd = editor.selection.end;
          editor.selection = new this._vscode.Selection(selectionStart, selectionEnd);
        }
      });
    });
  }

  private _findBackend(browserId: string) {
    for (const [backend, browsers] of this._openBrowsers) {
      if (browsers.find(b => b.id === browserId))
        return backend;
    }
  }

  private async _findOrStartBackend(browserId?: string, model?: TestModel) {
    if (browserId) {
      const backend = this._findBackend(browserId);
      if (backend)
        return [backend];
    }

    if (!this._openBrowsers.size && model) {
      const { errors } = await this._startBackendIfNeeded(model);
      if (errors) {
        void this._vscode.window.showErrorMessage('Error starting the backend: ' + errors.join('\n'));
        return [];
      }
    }

    return [...this._openBrowsers.keys()];
  }

  private _maybeStopTestingBackend() {
    if (this._isRunningTests)
      return;

    if (this._testingPageCount > 0 && this._settingsModel.showBrowser.get())
      return;

    this._stop();
  }

  private _scheduleEdit(callback: () => Promise<void>) {
    this._editOperations = this._editOperations.then(callback).catch(e => console.log(e));
  }

  isRunningTests() {
    return this._isRunningTests;
  }

  pageCount() {
    let sum = 0;
    for (const browsers of this._openBrowsers.values())
      sum += browsers.length;
    return sum;
  }

  openBrowsers() {
    return [...this._openBrowsers.values()].flat();
  }

  browserServerWSEndpoint() {
    return this._testingBackend?.wsEndpoint;
  }

  recorderModeForTest() {
    return this._recorderModeForTest;
  }

  private _getTestIdAttribute(model: TestModel, project?: TestProject): string | undefined {
    return project?.project?.use?.testIdAttribute ?? model.config.testIdAttributeName;
  }

  async inspect(models: TestModelCollection, browserId?: string) {
    const selectedModel = models.selectedModel();
    if (!selectedModel || !this._checkVersion(selectedModel.config, 'selector picker'))
      return;

    const testIdAttributeName = this._getTestIdAttribute(selectedModel, selectedModel.enabledProjects()[0]);
    for (const backend of await this._findOrStartBackend(browserId, selectedModel)) {
      // Keep running, errors could be non-fatal.
      try {
        await backend.setRecorderMode({
          mode: 'inspecting',
          testIdAttributeName,
          browserId,
        });
        this._recorderModeForTest = 'inspecting';
      } catch (e) {
        showExceptionAsUserError(this._vscode, selectedModel, e as Error);
        continue;
      }
    }
  }

  canRecord() {
    return !this._isRunningTests;
  }

  async record(model: TestModel, project?: TestProject) {
    if (!this._checkVersion(model.config))
      return;
    if (!this.canRecord()) {
      void this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Can\'t record while running tests')
      );
      return;
    }
    const testIdAttributeName = this._getTestIdAttribute(model, project);
    await this._vscode.window.withProgress({
      location: this._vscode.ProgressLocation.Notification,
      title: 'Playwright codegen',
      cancellable: true
    }, async (progress, token) => this._doRecord(progress, model, testIdAttributeName, token));
  }

  async highlight(selector: string) {
    for (const backend of this._openBrowsers.keys())
      await backend.highlight({ selector });
    this._onHighlightRequestedForTestEvent.fire(selector);
  }

  async highlightAria(ariaTemplate: string) {
    for (const backend of this._openBrowsers.keys())
      await backend.highlight({ ariaTemplate });
  }

  hideHighlight() {
    for (const backend of this._openBrowsers.keys())
      backend?.hideHighlight().catch(() => {});
    this._onHighlightRequestedForTestEvent.fire('');
  }

  private _checkVersion(
    config: TestConfig,
    message: string = this._vscode.l10n.t('this feature')
  ): boolean {
    const version = 1.25;
    if (config.version < version) {
      void this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Playwright v{0}+ is required for {1} to work, v{2} found', version, message, config.version)
      );
      return false;
    }

    if (this._vscode.env.uiKind === this._vscode.UIKind.Web && !process.env.DISPLAY) {
      void this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Show browser mode does not work in remote vscode')
      );
      return false;
    }

    return true;
  }

  private async _doRecord(progress: vscodeTypes.Progress<{ message?: string; increment?: number }>, model: TestModel, testIdAttributeName: string | undefined, token: vscodeTypes.CancellationToken) {
    await this._startBackendIfNeeded(model);
    this._insertedEditActionCount = 0;

    progress.report({ message: 'starting\u2026' });

    // Register early to have this._cancelRecording assigned during re-entry.
    const canceledPromise = Promise.race([
      new Promise<void>(f => token.onCancellationRequested(f)),
      new Promise<void>(f => this._cancelRecording = f),
    ]);

    try {
      await this._testingBackend?.setRecorderMode({
        mode: 'recording',
        testIdAttributeName,
      });
      this._recorderModeForTest = 'recording';
    } catch (e) {
      showExceptionAsUserError(this._vscode, model, e as Error);
      this._stop();
      return;
    }

    progress.report({ message: 'recording\u2026' });

    await canceledPromise;
  }

  private _onRecord() {
    this._resetExtensionState();
    void this._vscode.window.withProgress({
      location: this._vscode.ProgressLocation.Notification,
      title: 'Playwright codegen',
      cancellable: true
    }, async (progress, token) => {
      progress.report({ message: 'recording\u2026' });
      await Promise.race([
        new Promise<void>(f => token.onCancellationRequested(f)),
        new Promise<void>(f => this._cancelRecording = f),
      ]);
    });
  }

  async onWillRunTests(model: TestModel, debug: boolean) {
    if (!this._settingsModel.showBrowser.get() && !debug)
      return;
    if (!this._checkVersion(model.config, 'Show & reuse browser'))
      return;
    this._pausedOnPagePause = false;
    this._isRunningTests = true;
    this._onRunningTestsChangedEvent.fire(true);
    await this._startBackendIfNeeded(model);
  }

  async onDidRunTests() {
    this._isRunningTests = false;
    this._onRunningTestsChangedEvent.fire(false);
    this._maybeStopTestingBackend();
  }

  async closeBrowser(id: string, reason: string) {
    if (this._isRunningTests) {
      void this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Can\'t close browsers while running tests')
      );
      return;
    }

    await this._findBackend(id)?.closeBrowser(id, reason);
  }

  closeAllBrowsers() {
    if (this._isRunningTests) {
      void this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Can\'t close browsers while running tests')
      );
      return;
    }
    this._stop();
  }

  private _resetExtensionState() {
    this._insertedEditActionCount = 0;
    this._cancelRecording?.();
    this._cancelRecording = undefined;
  }

  private async _reset(mode: 'none' | 'standby', backend: Backend) {
    this._resetExtensionState();
    this._recorderModeForTest = mode;
    await backend.setRecorderMode({ mode });
  }

  private _stop() {
    this._resetExtensionState();
    this._testingBackend?.requestGracefulTermination();
    this._testingBackend = undefined;
    this._testingPageCount = 0;
  }
}

interface DebugControllerState {
  pageCount: number;
  browsers: {
    id: string;
    name: string;
    channel?: string;
    contexts: {
      pages: {
        url: string;
      }[];
    }[];
  }[];
}

class Backend extends BackendClient {
  constructor(vscode: vscodeTypes.VSCode, readonly version: number) {
    super(vscode);
  }

  override rewriteWsEndpoint(wsEndpoint: string): string {
    const url = new URL(wsEndpoint);
    url.searchParams.set('debug-controller', '');
    return url.toString();
  }

  override async initialize() {
    await this.send('initialize', { codegenId: 'playwright-test', sdkLanguage: 'javascript' });
    await this.send('setReportStateChanged', { enabled: true });
  }

  override requestGracefulTermination() {
    this.send('kill').catch(() => {});
  }

  resetRecorderModeNoWait(mode: 'none' | 'standby') {
    this.send('setRecorderMode', { mode }).catch(() => {});
  }

  async setRecorderMode(params: { mode: RecorderMode, testIdAttributeName?: string, browserId?: string }) {
    await this.send('setRecorderMode', params);
  }

  async highlight(params: { selector?: string, ariaTemplate?: string }) {
    await this.send('highlight', params);
  }

  async hideHighlight() {
    await this.send('hideHighlight');
  }

  async closeBrowser(id: string, reason: string) {
    await this.send('closeBrowser', { id, reason });
  }

  resumeNoWait() {
    this.send('resume').catch(() => {});
  }
}

function showExceptionAsUserError(vscode: vscodeTypes.VSCode, model: TestModel, error: Error) {
  if (error.message.includes('Looks like Playwright Test or Playwright'))
    void installBrowsers(vscode, model);
  else
    void vscode.window.showErrorMessage(error.message);
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

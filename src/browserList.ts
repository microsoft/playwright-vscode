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

import { installBrowsers } from './installer';
import { TestConfig } from './playwrightTestServer';
import { DebugController, DebugControllerState, ReusedBrowser } from './reusedBrowser';
import { SettingsModel } from './settingsModel';
import { TestModel, TestModelCollection, TestProject } from './testModel';
import * as vscodeTypes from './vscodeTypes';

export class BrowserList {
  private _state = new Map<DebugController, { id: string; name: string; channel?: string; title: string; pageCount: number; }[]>();
  _moderniseForTest = false;
  _recorderModeForTest: 'inspecting' | 'none' | 'standby' | 'recording' | undefined;
  private _insertedEditActionCount = 0;
  private _cancelRecording: (() => void) | undefined;
  private _editOperations = Promise.resolve();

  private _onChanged: vscodeTypes.EventEmitter<void>;
  readonly onChanged;
  private _onInspectRequestedEvent: vscodeTypes.EventEmitter<{ locator: string, ariaSnapshot: string, backendVersion: number }>;
  readonly onInspectRequested;
  readonly _onHighlightRequestedForTestEvent: vscodeTypes.EventEmitter<string>;
  readonly onHighlightRequestedForTest;

  constructor(
    private readonly _vscode: vscodeTypes.VSCode,
    private readonly _reusedBrowser: ReusedBrowser,
    private readonly _models: TestModelCollection,
    private readonly _settingsModel: SettingsModel,
  ) {
    this._onChanged = new this._vscode.EventEmitter();
    this.onChanged = this._onChanged.event;
    this._onInspectRequestedEvent = new this._vscode.EventEmitter();
    this.onInspectRequested = this._onInspectRequestedEvent.event;
    this._onHighlightRequestedForTestEvent = new this._vscode.EventEmitter();
    this.onHighlightRequestedForTest = this._onHighlightRequestedForTestEvent.event;

    this._reusedBrowser.onBackend(b => this._add(b));
  }

  private _add(backend: DebugController) {
    backend.onClose(() => {
      this._state.delete(backend);
      this._onChanged.fire();
    });
    backend.onError(() => {
      this._state.delete(backend);
      this._onChanged.fire();
    });
    backend.on('stateChanged', (params: DebugControllerState) => {
      // compat for <1.56
      if (!params.browsers || this._moderniseForTest) {
        let name = this._models.selectedModel()?.projects()[0]?.name || 'chromium';
        if (!['chromium', 'firefox', 'webkit'].includes(name))
          name = 'Browser';
        params.browsers = [{ id: 'unknown', name, contexts: [] }];
      }

      this._state.set(backend, params.browsers.map(b => {
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
          pageCount: b.contexts.flatMap(c => c.pages).length
        };
      }));
      this._onChanged.fire();
    });
    backend.on('inspectRequested', params => {
      if (this._settingsModel.pickLocatorCopyToClipboard.get() && params.locator)
        void this._vscode.env.clipboard.writeText(params.locator);
      this._onInspectRequestedEvent.fire({ backendVersion: backend.config.version, ...params });
    });
    backend.on('setModeRequested', params => {
      if (params.mode === 'standby') {
        // When "pick locator" is cancelled from inside the browser UI,
        // get rid of the recorder toolbar for better experience.
        // Assume "pick locator" is active when we are not recording.
        this._resetNoWait(backend, this._cancelRecording ? 'standby' : 'none');
        return;
      }
      if (params.mode === 'recording' && !this._cancelRecording) {
        this._onRecord();
        return;
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
    backend.on('setModeRequested', params => {
      if (params.mode === 'standby') {
        // When "pick locator" is cancelled from inside the browser UI,
        // get rid of the recorder toolbar for better experience.
        // Assume "pick locator" is active when we are not recording.
        this._resetNoWait(backend, this._cancelRecording ? 'standby' : 'none');
        return;
      }
      if (params.mode === 'recording' && !this._cancelRecording) {
        this._onRecord();
        return;
      }
    });
  }

  get() {
    return [...this._state.entries()].flatMap(([, browsers]) => browsers);
  }

  private _scheduleEdit(callback: () => Promise<void>) {
    this._editOperations = this._editOperations.then(callback).catch(e => console.log(e));
  }

  private _findBackends(browserId?: string): DebugController[] {
    if (browserId) {
      for (const [backend, browsers] of this._state) {
        if (browsers.some(b => b.id === browserId))
          return [backend];
      }
    }
    return [...this._state.keys()];
  }

  private async _findBackendsOrStart(browserId: string | undefined, selectedModel: TestModel): Promise<Iterable<DebugController>> {
    const backends = this._findBackends(browserId);
    if (backends.length || browserId)
      return backends;
    const { errors, backend } = await this._reusedBrowser.startBackendIfNeeded(selectedModel.config);
    if (errors || !backend) {
      void this._vscode.window.showErrorMessage('Error starting the backend: ' + errors?.join('\n'));
      return [];
    }
    return [backend];
  }

  async inspect(browserId: string | undefined, models: TestModelCollection) {
    const selectedModel = models.selectedModel();
    if (!selectedModel || !this._checkVersion(selectedModel.config, 'selector picker'))
      return;


    const testIdAttributeName = this._getTestIdAttribute(selectedModel, selectedModel.enabledProjects()[0]);
    for (const backend of await this._findBackendsOrStart(browserId, selectedModel)) {
      // Keep running, errors could be non-fatal.
      try {
        await backend.setRecorderMode({
          mode: 'inspecting',
          testIdAttributeName,
        });
        this._recorderModeForTest = 'inspecting';
      } catch (e) {
        showExceptionAsUserError(this._vscode, selectedModel, e as Error);
        return;
      }
    }
  }

  async record(model: TestModel, project?: TestProject) {
    if (!this._checkVersion(model.config))
      return;
    if (!this._reusedBrowser.canRecord()) {
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

  private async _doRecord(progress: vscodeTypes.Progress<{ message?: string; increment?: number }>, model: TestModel, testIdAttributeName: string | undefined, token: vscodeTypes.CancellationToken) {
    this._insertedEditActionCount = 0;

    progress.report({ message: 'starting\u2026' });

    // Register early to have this._cancelRecording assigned during re-entry.
    const canceledPromise = Promise.race([
      new Promise<void>(f => token.onCancellationRequested(f)),
      new Promise<void>(f => this._cancelRecording = f),
    ]);

    for (const backend of await this._findBackendsOrStart(undefined, model)) {
      try {
        await backend.setRecorderMode({
          mode: 'recording',
          testIdAttributeName,
        });
        this._recorderModeForTest = 'recording';
      } catch (e) {
        showExceptionAsUserError(this._vscode, model, e as Error);
        this._stop(backend);
        return;
      }
    }


    progress.report({ message: 'recording\u2026' });

    await canceledPromise;
  }

  private _getTestIdAttribute(model: TestModel, project?: TestProject): string | undefined {
    return project?.project?.use?.testIdAttribute ?? model.config.testIdAttributeName;
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

  recorderModeForTest() {
    return this._recorderModeForTest;
  }

  private _resetExtensionState() {
    this._insertedEditActionCount = 0;
    this._cancelRecording?.();
    this._cancelRecording = undefined;
  }

  private _resetNoWait(backend: DebugController, mode: 'none' | 'standby') {
    this._resetExtensionState();
    this._recorderModeForTest = mode;
    backend.resetRecorderModeNoWait(mode);
  }

  private _stop(backend: DebugController) {
    this._resetExtensionState();
    backend.requestGracefulTermination();
    this._state.delete(backend);
    this._onChanged.fire();
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

  pageCount() {
    let sum = 0;
    for (const browsers of this._state.values()) {
      for (const browser of browsers)
        sum += browser.pageCount;
    }
    return sum;
  }

  async highlight(selector: string) {
    for (const backend of this._findBackends())
      await backend.highlight({ selector });
    this._onHighlightRequestedForTestEvent.fire(selector);
  }

  async highlightAria(ariaTemplate: string) {
    for (const backend of this._findBackends())
      await backend.highlight({ ariaTemplate });
  }

  hideHighlight() {
    for (const backend of this._findBackends())
      backend.hideHighlight().catch(() => {});
    this._onHighlightRequestedForTestEvent.fire('');
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

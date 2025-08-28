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
import { createGuid } from './utils';
import * as vscodeTypes from './vscodeTypes';
import { SettingsModel } from './settingsModel';
import { BackendServer, BackendClient } from './backend';

type RecorderMode = 'none' | 'standby' | 'inspecting' | 'recording';

export class ReusedBrowser implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  _backend: DebugController | undefined;
  private _isRunningTests = false;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _disposables: vscodeTypes.Disposable[] = [];
  private _pageCount = 0;
  private _onPageCountChangedForTestEvent: vscodeTypes.EventEmitter<number>;
  readonly onPageCountChangedForTest;
  private _onBackend: vscodeTypes.EventEmitter<DebugController>;
  readonly onBackend;
  private _onRunningTestsChangedEvent: vscodeTypes.EventEmitter<boolean>;
  readonly onRunningTestsChanged;
  private _settingsModel: SettingsModel;

  constructor(vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._envProvider = envProvider;
    this._onBackend = new vscode.EventEmitter();
    this.onBackend = this._onBackend.event;
    this._onRunningTestsChangedEvent = new vscode.EventEmitter();
    this.onRunningTestsChanged = this._onRunningTestsChangedEvent.event;
    this._onPageCountChangedForTestEvent = new vscode.EventEmitter();
    this.onPageCountChangedForTest = this._onPageCountChangedForTestEvent.event;

    this._settingsModel = settingsModel;

    this._disposables.push(
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

  async startBackendIfNeeded(config: TestConfig): Promise<{ errors?: string[], backend?: DebugController }> {
    // Unconditionally close selector dialog, it might send inspect(enabled: false).
    if (this._backend) {
      this._resetNoWait('none');
      return {};
    }

    const args = [
      config.cli,
      'run-server',
      `--path=/${createGuid()}`
    ];
    const cwd = config.workspaceFolder;
    const envProvider = () => ({
      ...this._envProvider(),
      PW_CODEGEN_NO_INSPECTOR: '1',
      PW_EXTENSION_MODE: '1',
    });

    const errors: string[] = [];
    const backendServer = new BackendServer(this._vscode, () => new DebugController(this._vscode, config), {
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
      if (backend === this._backend) {
        this._backend = undefined;
        this._resetNoWait('none');
      }
    });
    backend.onError(e => {
      if (backend === this._backend) {
        void this._vscode.window.showErrorMessage(e.message);
        this._backend = undefined;
        this._resetNoWait('none');
      }
    });

    this._backend = backend;
    this._onBackend.fire(backend);

    this._backend.on('stateChanged', params => {
      this._pageCountChanged(params.pageCount);
    });

    return { backend };
  }

  isRunningTests() {
    return this._isRunningTests;
  }

  private _pageCountChanged(pageCount: number) {
    this._pageCount = pageCount;
    this._onPageCountChangedForTestEvent.fire(pageCount);
    if (this._isRunningTests)
      return;
    if (pageCount)
      return;
    this._stop();
  }

  browserServerWSEndpoint() {
    return this._backend?.wsEndpoint;
  }

  canRecord() {
    return !this._isRunningTests;
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

  async onWillRunTests(config: TestConfig, debug: boolean) {
    if (!this._settingsModel.showBrowser.get() && !debug)
      return;
    if (!this._checkVersion(config, 'Show & reuse browser'))
      return;
    this._isRunningTests = true;
    this._onRunningTestsChangedEvent.fire(true);
    await this.startBackendIfNeeded(config);
  }

  async onDidRunTests(debug: boolean) {
    if (debug && !this._settingsModel.showBrowser.get()) {
      this._stop();
    } else {
      if (!this._pageCount)
        this._stop();
    }
    this._isRunningTests = false;
    this._onRunningTestsChangedEvent.fire(false);
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

  private _resetNoWait(mode: 'none' | 'standby') {
    this._backend?.resetRecorderModeNoWait(mode);
  }

  private _stop() {
    this._backend?.requestGracefulTermination();
    this._backend = undefined;
    this._pageCount = 0;
  }
}

export interface DebugControllerState {
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

export class DebugController extends BackendClient {
  constructor(vscode: vscodeTypes.VSCode, readonly config: TestConfig) {
    super(vscode);
  }

  override rewriteWsEndpoint(wsEndpoint: string): string {
    return wsEndpoint + '?debug-controller';
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

  async setRecorderMode(params: { mode: RecorderMode, testIdAttributeName?: string }) {
    await this.send('setRecorderMode', params);
  }

  async highlight(params: { selector?: string, ariaTemplate?: string }) {
    await this.send('highlight', params);
  }

  async hideHighlight() {
    await this.send('hideHighlight');
  }

  resumeNoWait() {
    this.send('resume').catch(() => {});
  }
}

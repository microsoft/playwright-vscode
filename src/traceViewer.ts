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
import type { TestConfig } from './playwrightTestTypes';
import { SettingsModel } from './settingsModel';
import { findNode, getNonce } from './utils';
import * as vscodeTypes from './vscodeTypes';
import { DisposableBase } from './disposableBase';

function getPath(uriOrPath: string | vscodeTypes.Uri) {
  return typeof uriOrPath === 'string' ?
    uriOrPath :
    uriOrPath.scheme === 'file' ?
      uriOrPath.fsPath :
      uriOrPath.toString();
}

export type TraceViewer = SpawnTraceViewer | EmbeddedTraceViewer;

export class SpawnTraceViewer extends DisposableBase {
  private _vscode: vscodeTypes.VSCode;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _traceViewerProcess: ChildProcess | undefined;
  private _settingsModel: SettingsModel;
  private _config: TestConfig;

  constructor(vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, envProvider: () => NodeJS.ProcessEnv, config: TestConfig) {
    super();
    this._vscode = vscode;
    this._envProvider = envProvider;
    this._settingsModel = settingsModel;
    this._config = config;

    this._disposables.push(settingsModel.showTrace.onChange(value => {
      if (!value && this._traceViewerProcess)
        this.close().catch(() => {});
    }));
  }

  isEnabled() {
    return this._settingsModel.showTrace.get();
  }

  isStarted() {
    return !!this._traceViewerProcess;
  }

  async willRunTests() {
    if (this.isEnabled())
      await this._startIfNeeded();
  }

  async open(file: string | vscodeTypes.Uri) {
    if (!this.isEnabled())
      return;
    if (!this.checkVersion())
      return;
    await this._startIfNeeded();
    this._traceViewerProcess?.stdin?.write(getPath(file) + '\n');
  }

  dispose() {
    this.close().catch(() => {});
    super.dispose();
  }

  private async _startIfNeeded() {
    if (this._traceViewerProcess)
      return;
    const node = await findNode(this._vscode, this._config.workspaceFolder);
    const allArgs = [this._config.cli, 'show-trace', `--stdin`];
    if (this._vscode.env.remoteName) {
      allArgs.push('--host', '0.0.0.0');
      allArgs.push('--port', '0');
    }
    const traceViewerProcess = spawn(node, allArgs, {
      cwd: this._config.workspaceFolder,
      stdio: 'pipe',
      detached: true,
      env: {
        ...process.env,
        ...this._envProvider(),
      },
    });
    this._traceViewerProcess = traceViewerProcess;

    traceViewerProcess.stdout?.on('data', data => console.log(data.toString()));
    traceViewerProcess.stderr?.on('data', data => console.log(data.toString()));
    traceViewerProcess.on('exit', () => {
      this._traceViewerProcess = undefined;
    });
    traceViewerProcess.on('error', error => {
      this._vscode.window.showErrorMessage(error.message);
      this.close().catch(() => {});
    });
  }

  checkVersion() {
    const version = 1.35;
    if (this._config.version < version) {
      const featureName = this._vscode.l10n.t('trace viewer');
      this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Playwright v{0}+ is required for {1} to work, v{2} found', version, featureName, this._config.version)
      );
      return false;
    }
    return true;
  }

  async close() {
    this._traceViewerProcess?.stdin?.end();
    this._traceViewerProcess = undefined;
  }
}

export class EmbeddedTraceViewer extends DisposableBase {
  private _vscode: vscodeTypes.VSCode;
  private _extensionUri: vscodeTypes.Uri;
  private _settingsModel: SettingsModel;
  private _currentFile?: string | vscodeTypes.Uri;
  private _traceViewerPanel: EmbeddedTraceViewerPanel | undefined;
  private _traceLoadRequestedTimeout?: NodeJS.Timeout;
  private _config: TestConfig;
  private _serverUrlPrefix?: string;

  constructor(vscode: vscodeTypes.VSCode, extensionUri: vscodeTypes.Uri, settingsModel: SettingsModel, config: TestConfig, serverUrlPrefix?: string) {
    super();
    this._vscode = vscode;
    this._extensionUri = extensionUri;
    this._settingsModel = settingsModel;
    this._config = config;
    this._serverUrlPrefix = serverUrlPrefix;

    this._disposables.push(settingsModel.showTrace.onChange(value => {
      if (!value)
        this.close().catch(() => {});
    }));
    this._disposables.push(settingsModel.embedTraceViewer.onChange(value => {
      if (!value)
        this.close().catch(() => {});
    }));
  }

  isEnabled() {
    return this._settingsModel.showTrace.get() && this._settingsModel.embedTraceViewer.get();
  }

  isStarted() {
    return !!this._traceViewerPanel;
  }

  async willRunTests() {
    if (this.isEnabled())
      await this._startIfNeeded();
  }

  async open(file: string | vscodeTypes.Uri) {
    if (!this.isEnabled())
      return;
    if (!this.checkVersion())
      return;
    this._startIfNeeded();
    this._currentFile = file;
    this._fireLoadTraceRequestedIfNeeded();
  }

  async close() {
    this._traceViewerPanel?.dispose();
    this._traceViewerPanel = undefined;
    if (this._traceLoadRequestedTimeout) {
      clearTimeout(this._traceLoadRequestedTimeout);
      this._traceLoadRequestedTimeout = undefined;
    }
  }

  dispose() {
    this.close().catch(() => {});
    super.dispose();
  }

  private _fireLoadTraceRequestedIfNeeded() {
    if (this._traceLoadRequestedTimeout) {
      clearTimeout(this._traceLoadRequestedTimeout);
      this._traceLoadRequestedTimeout = undefined;
    }
    if (!this._traceViewerPanel || !this._currentFile)
      return;
    const traceUrl = getPath(this._currentFile);
    this._traceViewerPanel.postMessage({ method: 'loadTraceRequested', params: { traceUrl } });
    if (traceUrl.endsWith('.json'))
      this._traceLoadRequestedTimeout = setTimeout(() => this._fireLoadTraceRequestedIfNeeded(), 500);
  }

  private async _startIfNeeded() {
    if (this._traceViewerPanel)
      return;
    if (!this._serverUrlPrefix)
      throw new Error(`Embedded trace viewer requires a server URL`);
    this._traceViewerPanel = new EmbeddedTraceViewerPanel(this._vscode, this._extensionUri, this._serverUrlPrefix);
    this._traceViewerPanel.onDispose(() => {
      this._traceViewerPanel = undefined;
    });
  }

  checkVersion() {
    const version = 1.46;
    if (this._config.version < version) {
      const featureName = this._vscode.l10n.t('embedded trace viewer');
      this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Playwright v{0}+ is required for {1} to work, v{2} found', version, featureName, this._config.version)
      );
      return false;
    }
    return true;
  }
}

class EmbeddedTraceViewerPanel extends DisposableBase {

  public static readonly viewType = 'playwright.traceviewer.view';

  private readonly _vscode: vscodeTypes.VSCode;
  private readonly _extensionUri: vscodeTypes.Uri;
  private readonly _webviewPanel: vscodeTypes.WebviewPanel;
  public readonly serverUrlPrefix: string;

  private readonly _onDidDispose: vscodeTypes.EventEmitter<void>;
  public readonly onDispose: vscodeTypes.Event<void>;

  constructor(
    vscode: vscodeTypes.VSCode,
    extensionUri: vscodeTypes.Uri,
    serverUrlPrefix: string
  ) {
    super();
    this._vscode = vscode;
    this._extensionUri = extensionUri;
    this.serverUrlPrefix = serverUrlPrefix;
    this._webviewPanel = vscode.window.createWebviewPanel(EmbeddedTraceViewerPanel.viewType, 'Trace Viewer', {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: true,
    }, {
      enableScripts: true,
      enableForms: true,
    });
    this._disposables.push(this._webviewPanel);
    this._webviewPanel.iconPath = vscode.Uri.joinPath(extensionUri, 'images', 'playwright-logo.svg');
    this._webviewPanel.webview.html = this.getHtml();
    this._disposables.push(this._webviewPanel.onDidDispose(() => {
      this.dispose();
    }));
    this._disposables.push(this._webviewPanel.webview.onDidReceiveMessage(message  => {
      if (message.command === 'openExternal' && message.params.url)
        // should be a Uri, but due to https://github.com/microsoft/vscode/issues/85930
        // we pass a string instead
        vscode.env.openExternal(message.params.url);
      else if (message.command === 'showErrorMessage')
        vscode.window.showErrorMessage(message.params.message);
    }));
    this._disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('workbench.colorTheme'))
        this._applyTheme();
    }));
    this._onDidDispose = new vscode.EventEmitter<void>();
    this._disposables.push(this._onDidDispose);
    this.onDispose = this._onDidDispose.event;
    this._applyTheme();
  }

  public dispose() {
    this._onDidDispose.fire();
    super.dispose();
  }

  public postMessage(msg: any) {
    this._webviewPanel.webview.postMessage(msg);
  }

  private _applyTheme() {
    const themeKind = this._vscode.window.activeColorTheme.kind;
    const theme = [this._vscode.ColorThemeKind.Dark, this._vscode.ColorThemeKind.HighContrast].includes(themeKind) ? 'dark-mode' : 'light-mode';
    this.postMessage({ method: 'applyTheme', params: { theme } });
  }

  private getHtml() {
    const nonce = getNonce();
    const cspSource = this._webviewPanel.webview.cspSource;
    const origin = new URL(this.serverUrlPrefix).origin;
    const stylesheet = this._webviewPanel.webview.asWebviewUri(this._vscode.Uri.joinPath(this._extensionUri, 'media', 'traceViewer.css'));

    return /* html */ `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <!-- CSP doesn't support IPv6 urls -->
        <meta
          http-equiv="Content-Security-Policy"
          content="default-src 'none'; img-src data: ${cspSource}; media-src ${cspSource}; script-src 'nonce-${nonce}'; style-src ${cspSource}; frame-src *">
        <!-- Disable pinch zooming -->
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">
        <title>Playwright Trace Viewer</title>
        <link rel="stylesheet" href="${stylesheet}" type="text/css" media="screen">
      </head>
      <body data-vscode-context='{ "preventDefaultContextMenuItems": true }'>
        <iframe id="traceviewer" src="${this.serverUrlPrefix}/trace/embedded.html"></iframe>
        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          const iframe = document.getElementById('traceviewer');
          let loaded = false;
          let pendingMessages = [];
          function postMessageToVSCode(data) {
            vscode.postMessage(data);
          }
          function postMessageToFrame(data) {
            if (!loaded)
              pendingMessages.push(data);
            else
              iframe.contentWindow.postMessage(data, '*');
          }
          window.addEventListener('message', ({ data, origin }) => {
            if (origin === '${origin}') {
              if (data.type === 'loaded') {
                loaded = true;
                for (const data of pendingMessages)
                  postMessageToFrame(data);
                pendingMessages = [];
              } else if (data.type === 'keyup' || data.type === 'keydown') {
                // propagate key events to vscode
                const emulatedKeyboardEvent = new KeyboardEvent(data.type, data);
                Object.defineProperty(emulatedKeyboardEvent, 'target', {
                  get: () => window,
                });
                window.dispatchEvent(emulatedKeyboardEvent);
              } else {
                postMessageToVSCode(data);
              }
            } else {
              postMessageToFrame(data);
            }
          });
        </script>
      </body>
      </html>`;
  }
}

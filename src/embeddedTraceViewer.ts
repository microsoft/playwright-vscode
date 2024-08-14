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

import type { TestConfig } from './playwrightTestTypes';
import { getNonce } from './utils';
import * as vscodeTypes from './vscodeTypes';
import { DisposableBase } from './disposableBase';
import { PlaywrightTestServer } from './playwrightTestServer';
import { TraceViewer } from './traceViewer';

export class EmbeddedTraceViewer implements TraceViewer {
  readonly vscode: vscodeTypes.VSCode;
  readonly extensionUri: vscodeTypes.Uri;
  private _currentFile?: string;
  private _traceViewerPanelPromise?: Promise<EmbeddedTraceViewerPanel | undefined>;
  private _config: TestConfig;
  private _testServer: PlaywrightTestServer;

  constructor(vscode: vscodeTypes.VSCode, extensionUri: vscodeTypes.Uri, config: TestConfig, testServer: PlaywrightTestServer) {
    this.vscode = vscode;
    this.extensionUri = extensionUri;
    this._config = config;
    this._testServer = testServer;
  }

  currentFile() {
    return this._currentFile;
  }

  async willRunTests() {
    await this._startIfNeeded();
  }

  async open(file?: string) {
    this._currentFile = file;
    if (!file && !this._traceViewerPanelPromise)
      return;
    const traceViewerPanel = await this._startIfNeeded();
    traceViewerPanel?.loadTraceRequested(file);
  }

  close() {
    this._traceViewerPanelPromise?.then(panel => panel?.dispose()).catch(() => {});
    this._traceViewerPanelPromise = undefined;
    this._currentFile = undefined;
  }

  private async _startIfNeeded() {
    if (!this._traceViewerPanelPromise)
      this._traceViewerPanelPromise = this._createTraceViewerPanel();
    return await this._traceViewerPanelPromise;
  }

  private async _createTraceViewerPanel() {
    const serverUrlPrefix = await this._testServer.ensureStartedForTraceViewer();
    if (!serverUrlPrefix)
      return;
    return new EmbeddedTraceViewerPanel(this, serverUrlPrefix);
  }

  async infoForTest() {
    const traceViewerPanel = await this._traceViewerPanelPromise;
    return {
      type: 'embedded',
      serverUrlPrefix: traceViewerPanel?.serverUrlPrefix,
      testConfigFile: this._config.configFile,
      traceFile: this._currentFile,
      visible: !!traceViewerPanel?.visibleForTest(),
    };
  }
}

class EmbeddedTraceViewerPanel extends DisposableBase {

  public static readonly viewType = 'playwright.traceviewer.view';

  private _vscode: vscodeTypes.VSCode;
  private _extensionUri: vscodeTypes.Uri;
  private _webviewPanel: vscodeTypes.WebviewPanel;
  readonly serverUrlPrefix: string;
  private _isVisible: boolean = false;
  private _viewColumn: vscodeTypes.ViewColumn | undefined;
  private _traceUrl?: string;
  private _traceLoadRequestedTimeout?: NodeJS.Timeout;

  constructor(
    embeddedTestViewer: EmbeddedTraceViewer,
    serverUrlPrefix: string
  ) {
    super();
    this._vscode = embeddedTestViewer.vscode;
    this._extensionUri = embeddedTestViewer.extensionUri;
    this.serverUrlPrefix = serverUrlPrefix;
    this._isVisible = false;
    this._webviewPanel = this._vscode.window.createWebviewPanel(EmbeddedTraceViewerPanel.viewType, 'Trace Viewer', {
      viewColumn: this._vscode.ViewColumn.Active,
      preserveFocus: true,
    }, {
      enableScripts: true,
      enableForms: true,
    });
    this._viewColumn = this._webviewPanel.viewColumn;
    this._webviewPanel.iconPath = this._vscode.Uri.joinPath(this._extensionUri, 'images', 'playwright-logo.svg');
    this._webviewPanel.webview.html = this._getHtml();
    this._disposables = [
      this._webviewPanel,
      this._webviewPanel.onDidDispose(() => {
        embeddedTestViewer.close();
      }),
      this._webviewPanel.onDidChangeViewState(({ webviewPanel }) => {
        if (this._isVisible === webviewPanel.visible && this._viewColumn === webviewPanel.viewColumn)
          return;
        this._isVisible = webviewPanel.visible;
        this._viewColumn = webviewPanel.viewColumn;
        if (this._isVisible) {
          this._applyTheme();
          this.loadTraceRequested(this._traceUrl);
        } else {
          this._clearTraceLoadRequestedTimeout();
        }
      }),
      this._webviewPanel.webview.onDidReceiveMessage(message => {
        const methodRequest = this._extractMethodRequest(message);
        if (!methodRequest)
          return;
        this._executeMethod(methodRequest).catch(() => {});
      }),
      this._vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('workbench.colorTheme'))
          this._applyTheme();
      }),
    ];
  }

  loadTraceRequested(traceUrl?: string) {
    this._traceUrl = traceUrl;
    this._fireLoadTraceRequestedIfNeeded();
  }

  dispose() {
    this._clearTraceLoadRequestedTimeout();
    super.dispose();
  }

  visibleForTest() {
    return this._isVisible;
  }

  private _clearTraceLoadRequestedTimeout() {
    if (this._traceLoadRequestedTimeout) {
      clearTimeout(this._traceLoadRequestedTimeout);
      this._traceLoadRequestedTimeout = undefined;
    }
  }

  private _fireLoadTraceRequestedIfNeeded() {
    if (this._traceLoadRequestedTimeout) {
      clearTimeout(this._traceLoadRequestedTimeout);
      this._traceLoadRequestedTimeout = undefined;
    }
    if (!this._isVisible)
      return;
    this._webviewPanel.webview.postMessage({ method: 'loadTraceRequested', params: { traceUrl: this._traceUrl } });
    if (this._traceUrl?.endsWith('.json'))
      this._traceLoadRequestedTimeout = setTimeout(() => this._fireLoadTraceRequestedIfNeeded(), 500);
  }

  private _extractMethodRequest(message: any) {
    const method: string | undefined = message.method ?? message.command;
    if (!method)
      return;
    const params = message.params;
    return { method, params };
  }

  private async _executeMethod({ method, params }: { method: string, params?: any }) {
    if (method === 'openExternal' && params.url)
      // should be a Uri, but due to https://github.com/microsoft/vscode/issues/85930
      // we pass a string instead
      await this._vscode.env.openExternal(params.url);
    else if (method === 'showErrorMessage')
      await this._vscode.window.showErrorMessage(params.message);
  }

  private _applyTheme() {
    if (!this._webviewPanel.visible)
      return;
    const themeKind = this._vscode.window.activeColorTheme.kind;
    const theme = [this._vscode.ColorThemeKind.Dark, this._vscode.ColorThemeKind.HighContrast].includes(themeKind) ? 'dark-mode' : 'light-mode';
    this._webviewPanel.webview.postMessage({ method: 'applyTheme', params: { theme } });
  }

  private _getHtml() {
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

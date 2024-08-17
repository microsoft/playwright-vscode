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
import { TraceViewer } from './traceViewer';
import { PlaywrightTestServer } from './playwrightTestServer';

export class EmbeddedTraceViewer implements TraceViewer {
  readonly vscode: vscodeTypes.VSCode;
  private _config: TestConfig;
  private _testServer: PlaywrightTestServer;
  private _traceViewerView: EmbeddedTraceViewerView;

  constructor(vscode: vscodeTypes.VSCode, config: TestConfig, testServer: PlaywrightTestServer, traceViewerView: EmbeddedTraceViewerView) {
    this.vscode = vscode;
    this._config = config;
    this._testServer = testServer;
    this._traceViewerView = traceViewerView;
    this._startIfNeeded();
  }

  currentFile() {
    return this._traceViewerView.currentFile();
  }

  async willRunTests() {
    await this._startIfNeeded();
  }

  async open(file?: string) {
    this._traceViewerView.loadTraceRequested(file);
  }

  close() {
    this._traceViewerView.reset();
  }

  private async _startIfNeeded() {
    const serverUrlPrefix = await this._testServer.ensureStartedForTraceViewer();
    this._traceViewerView.resetIfTestServerChanged(serverUrlPrefix);
  }

  async infoForTest() {
    return {
      type: 'embedded',
      serverUrlPrefix: this._traceViewerView.serverUrlPrefixForTest(),
      testConfigFile: this._config.configFile,
      traceFile: this._traceViewerView.currentFile(),
      visible: this._traceViewerView.visible(),
    };
  }
}

export class EmbeddedTraceViewerView {
  private _vscode: vscodeTypes.VSCode;
  private _extensionUri: vscodeTypes.Uri;
  private _view: vscodeTypes.WebviewView | undefined;
  private _traceUrl?: string;
  private _traceLoadRequestedTimeout?: NodeJS.Timeout;
  private _serverUrlPrefix: string | undefined;

  constructor(vscode: vscodeTypes.VSCode, extensionUri: vscodeTypes.Uri) {
    this._vscode = vscode;
    this._extensionUri = extensionUri;
  }

  currentFile() {
    return this._traceUrl;
  }

  async resolveWebviewView(view: vscodeTypes.WebviewView) {
    this._view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };
    const viewDisposables = [
      view.onDidDispose(() => {
        for (const disposable of viewDisposables)
          disposable.dispose();
        this._view = undefined;
        this.reset(this._serverUrlPrefix);
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) {
          this.resetIfTestServerChanged(this._serverUrlPrefix);
          this.loadTraceRequested(this._traceUrl);
        } else {
          this._clearTraceLoadRequestedTimeout();
        }
      }),
      view.webview.onDidReceiveMessage(message => {
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

    this.reset(this._serverUrlPrefix);
  }

  show() {
    this._view?.show();
  }

  resetIfTestServerChanged(serverUrlPrefix?: string) {
    if (this._serverUrlPrefix === serverUrlPrefix)
      return;
    this.reset(serverUrlPrefix);
  }

  reset(serverUrlPrefix?: string) {
    this._clearTraceLoadRequestedTimeout();
    this._serverUrlPrefix = serverUrlPrefix;
    this._traceUrl = undefined;

    if (!this._view)
      return;

    this._view.webview.html = this._getHtmlForWebview(this._view.webview);

    if (serverUrlPrefix) {
      this._view.show();
      this._applyTheme();
    }
  }

  loadTraceRequested(traceUrl?: string) {
    if (traceUrl && traceUrl !== this._traceUrl)
      this._view?.show();
    this._traceUrl = traceUrl;

    this._fireLoadTraceRequestedIfNeeded();
  }

  dispose() {
    this.reset();
  }

  visible() {
    return !!this._view?.visible;
  }

  serverUrlPrefixForTest() {
    return this._serverUrlPrefix;
  }

  private _clearTraceLoadRequestedTimeout() {
    if (this._traceLoadRequestedTimeout) {
      clearTimeout(this._traceLoadRequestedTimeout);
      this._traceLoadRequestedTimeout = undefined;
    }
  }

  private _fireLoadTraceRequestedIfNeeded() {
    this._clearTraceLoadRequestedTimeout();
    if (!this._view?.visible)
      return;
    this._view.webview.postMessage({ method: 'loadTraceRequested', params: { traceUrl: this._traceUrl } });
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
    if (!this._view?.visible)
      return;
    const themeKind = this._vscode.window.activeColorTheme.kind;
    const theme = [this._vscode.ColorThemeKind.Dark, this._vscode.ColorThemeKind.HighContrast].includes(themeKind) ? 'dark-mode' : 'light-mode';
    this._view.webview.postMessage({ method: 'applyTheme', params: { theme } });
  }

  private _getHtmlForWebview(webview: vscodeTypes.Webview) {
    if (!this._serverUrlPrefix)
      return 'No server URL found';

    const nonce = getNonce();
    const cspSource = webview.cspSource;
    const origin = new URL(this._serverUrlPrefix).origin;
    const stylesheet = webview.asWebviewUri(this._vscode.Uri.joinPath(this._extensionUri, 'media', 'traceViewer.css'));

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
        <iframe id="traceviewer" src="${this._serverUrlPrefix}/trace/embedded.html"></iframe>
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

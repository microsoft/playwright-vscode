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
import { escapeAttribute, findNode, getNonce } from './utils';
import * as vscodeTypes from './vscodeTypes';
import { DisposableBase } from './disposableBase';

// TODO match with playwright version that includes this feature
export const kEmbeddedMinVersion = 1.46;

function getPath(uriOrPath: string | vscodeTypes.Uri) {
  return typeof uriOrPath === 'string' ?
    uriOrPath :
    uriOrPath.scheme === 'file' ?
      uriOrPath.fsPath :
      uriOrPath.toString();
}

class TraceViewerView extends DisposableBase {

  public static readonly viewType = 'playwright.traceviewer.view';

  private readonly _vscode: vscodeTypes.VSCode;
  private readonly _extensionUri: vscodeTypes.Uri;
  private readonly _webviewPanel: vscodeTypes.WebviewPanel;

  private readonly _onDidDispose: vscodeTypes.EventEmitter<void>;
  public readonly onDispose: vscodeTypes.Event<void>;

  private _url?: string;

  constructor(
    vscode: vscodeTypes.VSCode,
    extensionUri: vscodeTypes.Uri,
  ) {
    super();
    this._vscode = vscode;
    this._extensionUri = extensionUri;
    this._webviewPanel = this._register(vscode.window.createWebviewPanel(TraceViewerView.viewType, 'Trace Viewer', {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: true,
    }, {
      retainContextWhenHidden: true,
      enableScripts: true,
      enableForms: true,
    }));
    this._webviewPanel.iconPath = vscode.Uri.joinPath(extensionUri, 'images', 'playwright-logo.svg');
    this._register(this._webviewPanel.onDidDispose(() => {
      this.dispose();
    }));
    this._register(this._webviewPanel.webview.onDidReceiveMessage(message  => {
      if (message.command === 'openExternal' && message.params.url)
        // should be a Uri, but due to https://github.com/microsoft/vscode/issues/85930
        // we pass a string instead
        vscode.env.openExternal(message.params.url);
      else if (message.command === 'showErrorMessage')
        vscode.window.showErrorMessage(message.params.message);
    }));
    this._register(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('workbench.colorTheme'))
        this._applyTheme();
    }));
    this._onDidDispose = this._register(new vscode.EventEmitter<void>());
    this.onDispose = this._onDidDispose.event;
  }

  public url() {
    return this._url;
  }

  public dispose() {
    this._onDidDispose.fire();
    super.dispose();
  }

  public postMessage(msg: any) {
    this._webviewPanel.webview.postMessage(msg);
  }

  public show(url: string) {
    this._url = url;
    this._webviewPanel.webview.html = this.getHtml(url);
    this._webviewPanel.reveal(undefined, false);
    this._applyTheme();
  }

  private _applyTheme() {
    const themeKind = this._vscode.window.activeColorTheme.kind;
    const theme = themeKind === 2 || themeKind === 3  ? 'dark-mode' : 'light-mode';
    this._webviewPanel.webview.postMessage({ method: 'applyTheme', params: { theme } });
  }

  private getHtml(url: string) {
    const nonce = getNonce();
    const cspSource = this._webviewPanel.webview.cspSource;
    const origin = new URL(url).origin;

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
        <link rel="stylesheet" href="${escapeAttribute(this.extensionResource('media', 'traceViewer.css'))}" type="text/css" media="screen">
      </head>
      <body data-vscode-context='{ "preventDefaultContextMenuItems": true }'>
        <iframe id="traceviewer" src="${url}/trace/embedded.html"></iframe>
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

  private _register<T extends vscodeTypes.Disposable>(value: T): T {
    this._disposables.push(value);
    return value;
  }

  private extensionResource(...parts: string[]) {
    return this._webviewPanel.webview.asWebviewUri(this._vscode.Uri.joinPath(this._extensionUri, ...parts));
  }
}

export class TraceViewer implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  private _extensionUri: vscodeTypes.Uri;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _disposables: vscodeTypes.Disposable[] = [];
  private _traceViewerProcess: ChildProcess | undefined;
  private _embedded: boolean = false;
  private _traceViewerView: TraceViewerView | undefined;
  private _settingsModel: SettingsModel;
  private _currentFile?: string | vscodeTypes.Uri;
  private _traceLoadRequestedTimeout?: NodeJS.Timeout;

  constructor(vscode: vscodeTypes.VSCode, extensionUri: vscodeTypes.Uri, settingsModel: SettingsModel, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._extensionUri = extensionUri;
    this._envProvider = envProvider;
    this._settingsModel = settingsModel;

    this._disposables.push(settingsModel.showTrace.onChange(value => {
      if (!value && this._traceViewerProcess)
        this.close().catch(() => {});
    }));
    this._disposables.push(settingsModel.embedTraceViewer.onChange(value => {
      if (this._embedded !== value)
        this.close().catch(() => {});
    }));
  }

  async willRunTests(config: TestConfig & { serverUrlPrefix?: string }) {
    if (this._settingsModel.showTrace.get())
      await this._startIfNeeded(config);
  }

  async open(file: string | vscodeTypes.Uri, config: TestConfig & { serverUrlPrefix?: string }) {
    if (!this._settingsModel.showTrace.get())
      return;
    if (!this._checkVersion(config))
      return;
    if (!file && !this._traceViewerProcess)
      return;
    await this._startIfNeeded(config);
    this._currentFile = file;
    const traceUrl = getPath(file);
    this._traceViewerProcess?.stdin?.write(traceUrl + '\n');
    this._maybeFireLoadTraceRequested();
  }

  dispose() {
    this.close().catch(() => {});
    for (const d of this._disposables)
      d.dispose();
    this._disposables = [];
  }

  private async _startIfNeeded(config: TestConfig & { serverUrlPrefix?: string }) {
    if (config.serverUrlPrefix) {
      this._maybeOpenEmbeddedTraceViewer(config.serverUrlPrefix);
      return;
    }

    const node = await findNode(this._vscode, config.workspaceFolder);
    if (this._traceViewerProcess)
      return;
    const allArgs = [config.cli, 'show-trace', `--stdin`];
    if (this._vscode.env.remoteName) {
      allArgs.push('--host', '0.0.0.0');
      allArgs.push('--port', '0');
    }

    const traceViewerProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: 'pipe',
      detached: true,
      env: {
        ...process.env,
        ...this._envProvider(),
      },
    });
    this._traceViewerProcess = traceViewerProcess;

    traceViewerProcess.stdout?.on('data', async data => console.log(data.toString()));
    traceViewerProcess.stderr?.on('data', data => console.log(data.toString()));
    traceViewerProcess.on('exit', () => {
      this._traceViewerProcess = undefined;
    });
    traceViewerProcess.on('error', error => {
      this._vscode.window.showErrorMessage(error.message);
      this.close().catch(() => {});
    });
  }

  private _maybeFireLoadTraceRequested() {
    if (this._traceLoadRequestedTimeout) {
      clearTimeout(this._traceLoadRequestedTimeout);
      this._traceLoadRequestedTimeout = undefined;
    }
    if (!this._traceViewerView || !this._currentFile)
      return;
    const traceUrl = getPath(this._currentFile);
    this._traceViewerView.postMessage({ method: 'loadTraceRequested', params: { traceUrl } });
    if (traceUrl.endsWith('.json'))
      this._traceLoadRequestedTimeout = setTimeout(() => this._maybeFireLoadTraceRequested(), 500);
  }

  private _maybeOpenEmbeddedTraceViewer(serverUrlPrefix: string) {
    if (this._traceViewerView?.url() === serverUrlPrefix)
      return;

    if (!this._traceViewerView) {
      this._traceViewerView = new TraceViewerView(this._vscode, this._extensionUri);
      this._traceViewerView.onDispose(() => {
        this._traceViewerView = undefined;
      });
      this._disposables.push(this._traceViewerView);
    }

    this._traceViewerView.show(serverUrlPrefix);
  }

  private _checkVersion(
    config: TestConfig,
    message: string = this._vscode.l10n.t('this feature')
  ): boolean {
    const version = 1.35;
    if (config.version < 1.35) {
      this._vscode.window.showWarningMessage(
          this._vscode.l10n.t('Playwright v{0}+ is required for {1} to work, v{2} found', version, message, config.version)
      );
      return false;
    }
    return true;
  }

  async close() {
    this._traceViewerProcess?.stdin?.end();
    this._traceViewerProcess = undefined;
    this._traceViewerView?.dispose();
    this._traceViewerView = undefined;
    if (this._traceLoadRequestedTimeout) {
      clearTimeout(this._traceLoadRequestedTimeout);
      this._traceLoadRequestedTimeout = undefined;
    }
  }
}

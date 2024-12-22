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

import { DisposableBase } from './disposableBase';
import { ReusedBrowser } from './reusedBrowser';
import { pickElementAction } from './settingsView';
import { getNonce, html } from './utils';
import * as vscodeTypes from './vscodeTypes';

export class LocatorsView extends DisposableBase implements vscodeTypes.WebviewViewProvider {
  private _vscode: vscodeTypes.VSCode;
  private _view: vscodeTypes.WebviewView | undefined;
  private _extensionUri: vscodeTypes.Uri;
  private _locator: { locator: string, error?: string } = { locator: '' };
  private _ariaSnapshot: { yaml: string, error?: string } = { yaml: '' };
  private _reusedBrowser: ReusedBrowser;
  private _backendVersion = 0;

  constructor(vscode: vscodeTypes.VSCode, reusedBrowser: ReusedBrowser, extensionUri: vscodeTypes.Uri) {
    super();
    this._vscode = vscode;
    this._extensionUri = extensionUri;
    this._reusedBrowser = reusedBrowser;
    this._disposables = [
      vscode.window.registerWebviewViewProvider('pw.extension.locatorsView', this),
      this._reusedBrowser.onInspectRequested(async ({ locator, ariaSnapshot, backendVersion }) => {
        await vscode.commands.executeCommand('pw.extension.locatorsView.focus');
        this._backendVersion = backendVersion;
        this._locator = { locator: locator || '' };
        this._ariaSnapshot = { yaml: ariaSnapshot || '' };
        this._updateValues();
      }),
      reusedBrowser.onRunningTestsChanged(() => this._updateActions()),
      reusedBrowser.onPageCountChanged(() => this._updateActions()),
    ];
  }

  public resolveWebviewView(webviewView: vscodeTypes.WebviewView, context: vscodeTypes.WebviewViewResolveContext, token: vscodeTypes.CancellationToken) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = htmlForWebview(this._vscode, this._extensionUri, webviewView.webview);
    this._disposables.push(webviewView.webview.onDidReceiveMessage(data => {
      if (data.method === 'execute') {
        this._vscode.commands.executeCommand(data.params.command);
      } else if (data.method === 'locatorChanged') {
        this._locator.locator = data.params.locator;
        this._reusedBrowser.highlight(this._locator.locator).then(() => {
          this._locator.error = undefined;
          this._updateValues();
        }).catch(e => {
          this._locator.error = e.message;
          this._updateValues();
        });
      } else if (data.method === 'ariaSnapshotChanged') {
        this._ariaSnapshot.yaml = data.params.ariaSnapshot;
        this._reusedBrowser.highlightAria(this._ariaSnapshot.yaml).then(() => {
          this._ariaSnapshot.error = undefined;
          this._updateValues();
        }).catch(e => {
          this._ariaSnapshot.error = e.message;
          this._updateValues();
        });
      }
    }));

    this._disposables.push(webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible)
        return;
      this._updateValues();
    }));
    this._updateActions();
    this._updateValues();
  }

  private _updateActions() {
    const actions = [
      pickElementAction(this._vscode),
    ];
    if (this._view)
      this._view.webview.postMessage({ method: 'actions', params: { actions } });
  }

  private _updateValues() {
    this._view?.webview.postMessage({
      method: 'update',
      params: {
        locator: this._locator,
        ariaSnapshot: this._ariaSnapshot,
        hideAria: this._backendVersion && this._backendVersion < 1.50
      }
    });
  }
}

function htmlForWebview(vscode: vscodeTypes.VSCode, extensionUri: vscodeTypes.Uri, webview: vscodeTypes.Webview) {
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'common.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'locatorsView.script.js'));
  const nonce = getNonce();

  return html`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link href="${style}" rel="stylesheet">
      <title>Playwright</title>
    </head>
    <body class="locators-view">
      <div class="section">
        <div class="hbox">
          <div id="actions"></div>
          <label id="locatorLabel">${vscode.l10n.t('Locator')}</label>
        </div>
        <input id="locator" placeholder="${vscode.l10n.t('Locator')}" aria-labelledby="locatorLabel">
        <p id="locatorError" class="error"></p>
      </div>
      <div id="ariaSection" class="section">
        <label id="ariaSnapshotLabel">Aria</label>
        <textarea id="ariaSnapshot" placeholder="Aria" rows="10" aria-labelledby="ariaSnapshotLabel"></textarea>
        <p id="ariaSnapshotError" class="error"></p>
      </div>
    </body>
    <script nonce="${nonce}" src="${script}"></script>
    </html>
  `;
}

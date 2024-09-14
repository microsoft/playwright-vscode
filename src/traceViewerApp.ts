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
import { TestServerConnection } from './upstream/testServerConnection';
import { TraceViewerEvent } from './upstream/testServerInterface';
import * as vscodeTypes from './vscodeTypes';

export class TraceViewerApp extends DisposableBase {
  private _vscode: vscodeTypes.VSCode;
  private _testServer: TestServerConnection;
  private _onClose?: () => void;
  private _loadedPromise: Promise<void>;
  private _traceViewerURL?: string;
  private _disposed = false;

  constructor(
    vscode: vscodeTypes.VSCode,
    testServer: TestServerConnection,
    wsURL: string,
    onClose?: () => void
  ) {
    super();
    this._vscode = vscode;
    this._testServer = testServer;
    this._onClose = onClose;
    this._disposables = [
      this._onTraceViewerEvent('didClose', () => this.dispose()),
      this._onTraceViewerEvent('openSourceLocation', params => this._openSourceFile(params).catch(() => {})),
    ];
    this._loadedPromise = new Promise(resolve => {
      this._disposables.push(this._onTraceViewerEvent('loaded', resolve));
    });
    this._start(wsURL).catch(() => {});
  }

  serverUrlPrefixForTest() {
    return this._traceViewerURL;
  }

  dispose() {
    if (this._disposed)
      return;
    this._close().catch(() => {});
    super.dispose();
    this._disposed = true;
  }

  async dispatchEvent(event: TraceViewerEvent) {
    await this._loadedPromise;
    this._testServer.dispatchTraceViewerEventNoReply(event);
  }

  private async _start(_wsURL: string) {
    const openInBrowser = !!this._vscode.env.remoteName;
    const url = new URL(_wsURL);
    url.protocol = url.protocol === 'wss' ? 'https' : 'http';
    url.protocol = 'http:';
    url.pathname = '';
    if (openInBrowser && ['[::1]', '0.0.0.0'].includes(url.hostname))
      url.hostname = 'localhost';
    const traceViewerURL = String(await this._vscode.env.asExternalUri(this._vscode.Uri.parse(url.toString())));
    await Promise.all([
      this._loadedPromise,
      this._testServer.openTraceViewer({ traceViewerURL, openInBrowser }),
    ]);
    this._traceViewerURL = traceViewerURL;
  }

  private async _close() {
    if (this._disposed)
      return;
    this._onClose?.();
    await this._loadedPromise;
    await this._testServer.closeTraceViewer({});
  }

  private async _openSourceFile({ file, line, column }: { file: string, line?: number, column?: number }) {
    // received line and column are 1-based
    line = line ? line - 1 : 0;
    column = column ? column - 1 : 0;
    try {
      const document = await this._vscode.workspace.openTextDocument(file);
      const pos = new this._vscode.Position(line, column);
      const selection = new this._vscode.Range(pos, pos);
      await this._vscode.window.showTextDocument(document, { selection });
    } catch (e) {
      // ignore
    }
  }

  private _onTraceViewerEvent(method: string, listener: (params: any) => any) {
    return this._testServer.onTraceViewerEvent(event => {
      if (event.method !== method)
        return;
      listener(event.params);
    });
  }
}

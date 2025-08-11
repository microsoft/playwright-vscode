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
import { Backend, DebugControllerState, ReusedBrowser } from './reusedBrowser';
import { TestModelCollection } from './testModel';
import * as vscodeTypes from './vscodeTypes';

const kFallbackBrowserName = 'vscode';

export class McpConnection extends DisposableBase {

  shouldBeConnectedTo?: string;
  isConnectedTo?: string;

  constructor(private readonly _vscode: vscodeTypes.VSCode, private _reusedBrowser: ReusedBrowser, models: TestModelCollection) {
    super();

    const detection = setInterval(async () => {
      const model = models.selectedModel();
      if (model && this._tools().length) {
        clearInterval(detection);
        try {
          if (!_reusedBrowser.backend())
            await _reusedBrowser._startBackendIfNeeded(model.config);
          await this.connectToBrowser(_reusedBrowser.backend()!, this.shouldBeConnectedTo);
        } catch (error) {
          console.error(error);
        }
      }
    }, 500);

    this._disposables.push(
        new this._vscode.Disposable(() => clearInterval(detection)),
        _reusedBrowser.onPageCountChanged(() => this.onDebugControllerState(_reusedBrowser.state()))
    );
  }

  onDebugControllerState(state: DebugControllerState) {
    if (state.browsers.some(b => b.guid === this.shouldBeConnectedTo))
      this.isConnectedTo = this.shouldBeConnectedTo;
    else if (state.browsers.some(b => b.assistantMode))
      this.isConnectedTo = kFallbackBrowserName;
    else
      this.isConnectedTo = undefined;

    if (this.shouldBeConnectedTo === this.isConnectedTo)
      void this._vscode.window.showInformationMessage('Connection match');
    else
      void this._vscode.window.showWarningMessage(`Connection mismatch: ${this.shouldBeConnectedTo} !== ${this.isConnectedTo}`);
  }

  async connectToBrowser(browserServer: Backend, guid?: string) {
    this._reusedBrowser.setKeepAlive(true);
    guid = kFallbackBrowserName;
    const connectionString = new URL(browserServer.wsEndpoint);
    connectionString.searchParams.set('connect', guid);
    this.shouldBeConnectedTo = guid;
    await this._browser_connect({ connectionString, lib: browserServer.config.lib });
  }

  async disconnect() {
    this._reusedBrowser.setKeepAlive(false);
    this.shouldBeConnectedTo = undefined;
    await this._browser_connect({});
  }

  private _tools() {
    return this._vscode.lm.tools.filter(t => t.name.endsWith('browser_connect'));
  }

  private async _browser_connect(options: any) {
    for (const tool of this._tools()) {
      await this._vscode.lm.invokeTool(tool.name, {
        input: { method: 'vscode', options },
        toolInvocationToken: undefined,
      });
      await this._vscode.window.showInformationMessage(`Connected ${JSON.stringify(options)}`);
    }
  }
}
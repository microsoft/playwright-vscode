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
import { DebugControllerState, ReusedBrowser } from './reusedBrowser';
import { TestModelCollection } from './testModel';
import * as vscodeTypes from './vscodeTypes';

const kFallbackBrowserName = 'vscode';

export class McpConnection extends DisposableBase {
  private _shouldBeConnectedTo?: string;
  private _isConnectedTo?: string;

  constructor(private readonly _vscode: vscodeTypes.VSCode, private _reusedBrowser: ReusedBrowser, private readonly _models: TestModelCollection) {
    super();

    const detection = setInterval(async () => {
      if (this._models.selectedModel() && this._tools().length) {
        clearInterval(detection);
        try {
          await this.connectToBrowser(this._shouldBeConnectedTo ?? kFallbackBrowserName);
        } catch (error) {
          console.error(error);
        }
      }
    }, 500);

    this._disposables.push(
        new this._vscode.Disposable(() => clearInterval(detection)),
        _reusedBrowser.onPageCountChanged(() => this.onDebugControllerState(_reusedBrowser.state()).catch(e => console.error(e)))
    );
  }

  async onDebugControllerState(state: DebugControllerState) {
    if (state.browsers.some(b => b.guid === this._shouldBeConnectedTo)) {
      this._isConnectedTo = this._shouldBeConnectedTo;
    } else if (state.browsers.some(b => b.assistantMode)) {
      this._shouldBeConnectedTo = kFallbackBrowserName;
      this._isConnectedTo = kFallbackBrowserName;
    } else {
      this._isConnectedTo = undefined;
    }

    if (!this._shouldBeConnectedTo && !this._isConnectedTo) {
      const testingBrowser = state.browsers.find(b => !b.assistantMode);
      await this.connectToBrowser(testingBrowser?.guid ?? kFallbackBrowserName);
    }
  }

  async connectToBrowser(nameOrGuid: string) {
    const model = this._models.selectedModel();
    if (!this._reusedBrowser.backend() && model)
      await this._reusedBrowser._startBackendIfNeeded(model.config);

    const backend = this._reusedBrowser.backend();
    if (!backend)
      return;

    this._reusedBrowser.setKeepAlive(true);
    const connectionString = new URL(backend.wsEndpoint);
    connectionString.searchParams.set('connect', nameOrGuid);
    this._shouldBeConnectedTo = nameOrGuid;
    await this._browser_connect({ connectionString, lib: backend.config.lib });
  }

  async disconnect() {
    this._reusedBrowser.setKeepAlive(false);
    this._shouldBeConnectedTo = undefined;
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
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
import { SettingsModel } from './settingsModel';
import { TestModelCollection } from './testModel';
import * as vscodeTypes from './vscodeTypes';

export class McpConnection extends DisposableBase {
  private _tool: vscodeTypes.LanguageModelToolInformation | undefined;
  private _isConnected = false;
  private _isStartingBackend = false;

  constructor(private readonly _vscode: vscodeTypes.VSCode, private readonly _reusedBrowser: ReusedBrowser, private readonly _settingsModel: SettingsModel, private readonly _models: TestModelCollection) {
    super();

    const scanInterval = setInterval(() => {
      const tool = _vscode.lm.tools.find(t => t.name.endsWith('browser_connect'));
      if (tool && !this._tool) {
        this._tool = tool;
        void this._reconcile();
      }
      if (!tool && this._tool) {
        this._tool = undefined;
        void this._reconcile();
      }
    }, 500);

    this._disposables.push(
        new _vscode.Disposable(() => clearInterval(scanInterval)),
        this._models.onUpdated(() => this._reconcile()),
        this._reusedBrowser.onBackendChange(() => this._reconcile()),
        this._settingsModel.connectCopilot.onChange(() => this._reconcile()),
        this._reusedBrowser.onRunningTestsChanged(runStarted => {
          if (runStarted) {
            this._isConnected = false; // force reconnecting
            void this._reconcile();
          }
        }),
    );
  }

  private async _reconcile() {
    if (!this._tool)
      return;

    if (!this._reusedBrowser.hasBackend() && !this._isStartingBackend)
      this._isConnected = false;

    const shouldBeConnected = !!this._settingsModel.connectCopilot.get();
    if (this._isConnected === shouldBeConnected)
      return;
    this._isConnected = shouldBeConnected;
    this._reusedBrowser.setKeepAlive(this._isConnected);

    if (!shouldBeConnected) {
      // TODO: update MCP to support going to default without parsing
      const method = this._tool.description.match(/"(.*)"/)?.[1];
      if (!method)
        throw new Error('Default method not found in tool description');
      await this._vscode.lm.invokeTool(this._tool.name, {
        input: { method: method },
        toolInvocationToken: undefined,
      });
      return;
    }

    const model = this._models.selectedModel()!;
    this._isStartingBackend = true;
    const connectionString = await this._reusedBrowser.getMCPConnectionString(model).finally(() => {
      this._isStartingBackend = false;
    });

    await this._vscode.lm.invokeTool(this._tool.name, {
      input: { method: 'vscode', params: { connectionString, lib: model.config.lib } },
      toolInvocationToken: undefined,
    });
  }
}
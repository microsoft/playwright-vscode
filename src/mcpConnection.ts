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
import { EventEmitter } from './upstream/events';
import * as vscodeTypes from './vscodeTypes';

export class McpConnection extends DisposableBase {
  private _tool: vscodeTypes.LanguageModelToolInformation | undefined;
  private _onUpdate = new EventEmitter<void>();
  onUpdate = this._onUpdate.event;
  private _isConnected = false;
  private _isStartingBackend = false;

  constructor(private readonly _vscode: vscodeTypes.VSCode, private readonly _reusedBrowser: ReusedBrowser, private readonly _settingsModel: SettingsModel, private readonly _models: TestModelCollection) {
    super();

    const scanInterval = setInterval(() => {
      const tool = _vscode.lm.tools.find(t => t.name.endsWith('browser_connect'));
      if (tool && !this._tool) {
        this._tool = tool;
        this._onUpdate.fire();
      }
      if (!tool && this._tool) {
        this._tool = undefined;
        this._onUpdate.fire();
      }
    }, 500);

    this._disposables.push(
        new _vscode.Disposable(() => clearInterval(scanInterval)),
        this._models.onUpdated(() => this._onUpdate.fire()),
        this.onUpdate(() => this._reconcile()),
        this._reusedBrowser.onBackendChange(() => this._reconcile()),
        this._settingsModel.connectCopilot.onChange(() => this._reconcile()),
    );
  }

  private async _reconcile() {
    if (!this._tool)
      return;

    if (!this._reusedBrowser.hasBackend() && !this._isStartingBackend)
      this._isConnected = false;

    const shouldBeConnected = !this.disabledReason() && !!this._settingsModel.connectCopilot.get();
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

  disabledReason(): string | undefined {
    if (!this._tool)
      return this._vscode.l10n.t(`Couldn't find Playwright MCP server.`);
    if (!this._models.selectedModel())
      return this._vscode.l10n.t('No Playwright tests found.');
    if (!this._settingsModel.showBrowser.get())
      return this._vscode.l10n.t(`Disabled because "Show Browser" setting is off.`);
  }
}
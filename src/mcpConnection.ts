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
import { CommandQueue } from './commandQueue';
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
  private _commandQueue = new CommandQueue();
  private _isConnected = false;

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

  private _reconcile() {
    void this._commandQueue.run(async () => {
      if (!this._tool)
        return;

      if (!this._reusedBrowser.hasBackend())
        this._isConnected = false;

      const shouldBeConnected = !this.disabledReason() && this._settingsModel.connectCopilot.get();
      if (this._isConnected === shouldBeConnected)
        return;

      if (shouldBeConnected) {
        this._reusedBrowser.setKeepAlive(true);
        const model = this._models.selectedModel()!;
        const connectionString = await this._reusedBrowser.getMCPConnectionString(model);
        await this._vscode.lm.invokeTool(this._tool.name, {
          input: { method: 'vscode', params: { connectionString, lib: model.config.lib } },
          toolInvocationToken: undefined,
        });
        this._isConnected = true;
        return;
      }

      this._reusedBrowser.setKeepAlive(false);
      // TODO: solve this without regex matching
      const method = this._tool.description.match(/"(.*)"/)?.[1];
      if (!method)
        throw new Error('Default method not found in tool description');
      await this._vscode.lm.invokeTool(this._tool.name, {
        input: { method: method },
        toolInvocationToken: undefined,
      });
      this._isConnected = false;

    }).catch(console.error);
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
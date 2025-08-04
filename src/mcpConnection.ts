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

      const shouldBeConnected = !this.disabledReason() && this._settingsModel.connectCopilot.get();
      if (this._reusedBrowser.isConnectedToMCP() !== shouldBeConnected) {
        if (shouldBeConnected)
          await this._reusedBrowser.connectMCP(this, this._models.selectedModel()!);
        else
          await this._reusedBrowser.disconnectMCP(this);
      }
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

  async browser_connect(input: { method: string, params?: any }) {
    if (!this._tool)
      throw new Error('Not available');
    await this._vscode.lm.invokeTool(this._tool.name, {
      input,
      toolInvocationToken: undefined,
    });
  }

  async disconnect() {
    if (!this._tool)
      throw new Error('Not available');

    // TODO: solve this without regex matching
    const defaultMethod = this._tool.description.match(/"(.*)"/)?.[1];
    if (!defaultMethod)
      throw new Error('Default method not found in tool description');

    await this._vscode.lm.invokeTool(this._tool.name, {
      input: { method: defaultMethod },
      toolInvocationToken: undefined,
    });
  }
}
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

import * as vscodeTypes from './vscodeTypes';

export class SidebarViewProvider implements vscodeTypes.TreeDataProvider<vscodeTypes.TreeItem> {
  private _onDidChangeTreeData: vscodeTypes.EventEmitter<vscodeTypes.TreeItem | undefined | null | void>;
  readonly onDidChangeTreeData: vscodeTypes.Event<vscodeTypes.TreeItem | undefined | null | void>;
  private _onDidChangeReuseBrowser: vscodeTypes.EventEmitter<boolean>;
  readonly onDidChangeReuseBrowser: vscodeTypes.Event<boolean>;
  private _onDidChangeHeaded: vscodeTypes.EventEmitter<boolean>;
  readonly onDidChangeHeaded: vscodeTypes.Event<boolean>;
  private _vscode: vscodeTypes.VSCode;

  constructor(vscode: vscodeTypes.VSCode, context: vscodeTypes.ExtensionContext) {
    this._vscode = vscode;
    this._onDidChangeTreeData = new this._vscode.EventEmitter<vscodeTypes.TreeItem | undefined | null | void>();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;

    this._onDidChangeReuseBrowser = new this._vscode.EventEmitter<boolean>();
    this.onDidChangeReuseBrowser = this._onDidChangeReuseBrowser.event;

    this._onDidChangeHeaded = new this._vscode.EventEmitter<boolean>();
    this.onDidChangeHeaded = this._onDidChangeHeaded.event;

    const disposables = [
      vscode.window.registerTreeDataProvider('pw.extension.settingsView', this),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('playwright.reuseBrowser')) {
          this._onDidChangeReuseBrowser.fire(this.reuseBrowser());
          this._onDidChangeTreeData.fire();
        }
        if (event.affectsConfiguration('playwright.headed')) {
          this._onDidChangeReuseBrowser.fire(this.reuseBrowser());
          this._onDidChangeTreeData.fire();
        }
      }),
      vscode.commands.registerCommand('pw.extension.toggle.reuseBrowser', async () => {
        const configuration = vscode.workspace.getConfiguration('playwright');
        const value = configuration.get('reuseBrowser');
        await configuration.update('reuseBrowser', !value, true);
      }),
      vscode.commands.registerCommand('pw.extension.toggle.headed', async () => {
        const configuration = vscode.workspace.getConfiguration('playwright');
        const value = configuration.get('headed');
        await configuration.update('headed', !value, true);
      }),
    ];
    context.subscriptions.push(...disposables);
  }

  getTreeItem(element: vscodeTypes.TreeItem): vscodeTypes.TreeItem {
    return element;
  }

  reuseBrowser(): boolean {
    const configuration = this._vscode.workspace.getConfiguration('playwright');
    return configuration.get('reuseBrowser') as boolean;
  }

  headed(): boolean {
    const configuration = this._vscode.workspace.getConfiguration('playwright');
    return configuration.get('headed') as boolean;
  }

  toggleRe() {
    this._onDidChangeTreeData.fire();
  }

  getChildren(element?: vscodeTypes.TreeItem): Thenable<vscodeTypes.TreeItem[]> {
    if (element)
      return Promise.resolve([]);
    return Promise.resolve([
      this._createCheckboxSettingItem('Show browser', 'headed'),
      this._createCheckboxSettingItem('Show & reuse Browser', 'reuseBrowser')
    ]);
  }

  private _createCheckboxSettingItem(title: string, settingName: string): vscodeTypes.TreeItem {
    const treeItem = new this._vscode.TreeItem(title);
    const configuration = this._vscode.workspace.getConfiguration('playwright');
    const checked = configuration.get(settingName) as boolean;
    treeItem.iconPath = {
      light: checked ? checkedBox(this._vscode, 'darkGray') : empyBox(this._vscode, 'darkGray'),
      dark: checked ? checkedBox(this._vscode, 'lightGray') : empyBox(this._vscode, 'lightGray'),
    };
    treeItem.command = {
      title,
      command: `pw.extension.toggle.${settingName}`,
      arguments: [settingName, !checked]
    };
    return treeItem;
  }
}

const empyBox = (vscode: vscodeTypes.VSCode, color: string) => vscode.Uri.parse(`data:image/svg+xml,<svg fill="${color}" xmlns="http://www.w3.org/2000/svg" height="48" width="48"><path d="M9 42q-1.2 0-2.1-.9Q6 40.2 6 39V9q0-1.2.9-2.1Q7.8 6 9 6h30q1.2 0 2.1.9.9.9.9 2.1v30q0 1.2-.9 2.1-.9.9-2.1.9Zm0-3h30V9H9v30Z"/></svg>`);
const checkedBox = (vscode: vscodeTypes.VSCode, color: string) => vscode.Uri.parse(`data:image/svg+xml,<svg fill="${color}" xmlns="http://www.w3.org/2000/svg" height="48" width="48"><path d="M20.95 31.95 35.4 17.5l-2.15-2.15-12.3 12.3L15 21.7l-2.15 2.15ZM9 42q-1.2 0-2.1-.9Q6 40.2 6 39V9q0-1.2.9-2.1Q7.8 6 9 6h30q1.2 0 2.1.9.9.9.9 2.1v30q0 1.2-.9 2.1-.9.9-2.1.9Zm0-3h30V9H9v30ZM9 9v30V9Z"/></svg>`);

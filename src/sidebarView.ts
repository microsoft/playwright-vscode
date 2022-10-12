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

import { ReusedBrowser } from './reusedBrowser';
import * as vscodeTypes from './vscodeTypes';

export class SidebarViewProvider implements vscodeTypes.TreeDataProvider<vscodeTypes.TreeItem>, vscodeTypes.Disposable {
  private _onDidChangeTreeData: vscodeTypes.EventEmitter<vscodeTypes.TreeItem | undefined | null | void>;
  readonly onDidChangeTreeData: vscodeTypes.Event<vscodeTypes.TreeItem | undefined | null | void>;
  private _vscode: vscodeTypes.VSCode;
  private _disposables: vscodeTypes.Disposable[];
  private _disposed = false;
  private _reusedBrowser: ReusedBrowser;
  private _reuseBrowserSetting: Setting<boolean>;
  private _logApiCallsSetting: Setting<boolean>;

  constructor(vscode: vscodeTypes.VSCode, reusedBrowser: ReusedBrowser) {
    this._vscode = vscode;
    this._reusedBrowser = reusedBrowser;
    this._onDidChangeTreeData = new this._vscode.EventEmitter<vscodeTypes.TreeItem | undefined | null | void>();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._reuseBrowserSetting = new Setting(vscode, 'reuseBrowser');
    this._logApiCallsSetting = new Setting(vscode, 'logApiCalls');

    this._disposables = [
      vscode.window.registerTreeDataProvider('pw.extension.settingsView', this),
      vscode.window.onDidChangeActiveColorTheme(() => this._onDidChangeTreeData.fire()),
      this._reuseBrowserSetting,
      this._logApiCallsSetting,
    ];

    this._reuseBrowserSetting.onChange(value => {
      this._reusedBrowser.setReuseBrowserForRunningTests(value);
      this._onDidChangeTreeData.fire();
    });
    this._reusedBrowser.setReuseBrowserForRunningTests(this._reuseBrowserSetting.get());

    this._logApiCallsSetting.onChange(value => {
      this._reusedBrowser.setLogApiCalls(value);
      this._onDidChangeTreeData.fire();
    });
    this._reusedBrowser.setLogApiCalls(this._logApiCallsSetting.get());

  }

  dispose() {
    for (const d of this._disposables)
      d?.dispose?.();
    this._disposables = [];
    this._disposed = true;
  }

  getTreeItem(element: vscodeTypes.TreeItem): vscodeTypes.TreeItem {
    return element;
  }

  async getChildren(element?: vscodeTypes.TreeItem): Promise<vscodeTypes.TreeItem[]> {
    if (this._disposed)
      return [];

    // Root elements.
    if (!element) {
      const result: vscodeTypes.TreeItem[] = [
        this._createCheckboxSettingItem('Show browser', this._reuseBrowserSetting),
        this._createSeparator(),
        this._createCommandItem('Pick selector', 'pw.extension.command.inspect', pickSelectorIcon),
        this._createCommandItem('Record new', 'pw.extension.command.recordNew', recordIcon),
        this._createCommandItem('Record from here', 'pw.extension.command.recordFromHere', recordIcon),
        this._createCommandItem('Reveal test output', 'testing.showMostRecentOutput', logIcon),
        this._createCommandItem('Close all browsers', 'pw.extension.command.closeBrowsers', closeIcon),
      ];
      return result;
    }

    return [];
  }

  private _createCommandItem(title: string, command: string, icon: IconFactory): vscodeTypes.TreeItem {
    const treeItem = new this._vscode.TreeItem(title);
    treeItem.command = {
      title,
      command,
    };
    treeItem.iconPath = iconPath(this._vscode, icon);
    return treeItem;
  }

  private _createSeparator(): vscodeTypes.TreeItem {
    const treeItem = new this._vscode.TreeItem('————————');
    treeItem.tooltip = '';
    return treeItem;
  }

  private _createCheckboxSettingItem(title: string, setting: Setting<boolean>): vscodeTypes.TreeItem {
    const settingName = setting.settingName;
    const checked = setting.get();
    const treeItem = new this._vscode.TreeItem(title);
    treeItem.iconPath = iconPath(this._vscode, checked ? checkedBoxIcon : empyBoxIcon);
    treeItem.command = {
      title,
      command: `pw.extension.toggle.${settingName}`,
      arguments: [settingName, !checked]
    };
    return treeItem;
  }
}

class Setting<T> implements vscodeTypes.Disposable {
  readonly settingName: string;
  readonly onChange: vscodeTypes.Event<T>;

  private _onChange: vscodeTypes.EventEmitter<T>;
  private _vscode: vscodeTypes.VSCode;
  private _disposables: vscodeTypes.Disposable[];

  constructor(vscode: vscodeTypes.VSCode, settingName: string) {
    this._vscode = vscode;
    this.settingName = settingName;
    this._onChange = new vscode.EventEmitter<T>();
    this.onChange = this._onChange.event;

    const configuration = this._vscode.workspace.getConfiguration('playwright');
    const settingFQN = `playwright.${settingName}`;
    this._disposables = [
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(settingFQN))
          this._onChange.fire(this.get());
      }),
      vscode.commands.registerCommand(`pw.extension.toggle.${settingName}`, async () => {
        await configuration.update(settingName, !this.get(), true);
      }),
    ];
  }

  get(): T {
    const configuration = this._vscode.workspace.getConfiguration('playwright');
    return configuration.get(this.settingName) as T;
  }

  dispose() {
    for (const disposable of this._disposables)
      disposable.dispose();
    this._disposables = [];
  }
}

type IconFactory = (vscode: vscodeTypes.VSCode, color: string) => vscodeTypes.Uri;
const empyBoxIcon: IconFactory = (vscode, color) => vscode.Uri.parse(`data:image/svg+xml,<svg fill="${color}" xmlns="http://www.w3.org/2000/svg" height="48" width="48"><path d="M9 42q-1.2 0-2.1-.9Q6 40.2 6 39V9q0-1.2.9-2.1Q7.8 6 9 6h30q1.2 0 2.1.9.9.9.9 2.1v30q0 1.2-.9 2.1-.9.9-2.1.9Zm0-3h30V9H9v30Z"/></svg>`);
const checkedBoxIcon: IconFactory = (vscode, color) => vscode.Uri.parse(`data:image/svg+xml,<svg fill="${color}" xmlns="http://www.w3.org/2000/svg" height="48" width="48"><path d="M20.95 31.95 35.4 17.5l-2.15-2.15-12.3 12.3L15 21.7l-2.15 2.15ZM9 42q-1.2 0-2.1-.9Q6 40.2 6 39V9q0-1.2.9-2.1Q7.8 6 9 6h30q1.2 0 2.1.9.9.9.9 2.1v30q0 1.2-.9 2.1-.9.9-2.1.9Zm0-3h30V9H9v30ZM9 9v30V9Z"/></svg>`);
const pickSelectorIcon: IconFactory = (vscode, color) => vscode.Uri.parse(`data:image/svg+xml,<svg fill="${color}" xmlns="http://www.w3.org/2000/svg" width="48" height="48"><path d="M18 42h-7.5c-3 0-4.5-1.5-4.5-4.5v-27C6 7.5 7.5 6 10.5 6h27C42 6 42 10.404 42 10.5V18h-3V9H9v30h9v3Zm27-15-9 6 9 9-3 3-9-9-6 9-6-24 24 6Z"/></svg>`);
const recordIcon: IconFactory = (vscode, color) => vscode.Uri.parse(`data:image/svg+xml,<svg fill="${color}" xmlns="http://www.w3.org/2000/svg" height="48" width="48"><path d="M22.65 34h3v-8.3H34v-3h-8.35V14h-3v8.7H14v3h8.65ZM24 44q-4.1 0-7.75-1.575-3.65-1.575-6.375-4.3-2.725-2.725-4.3-6.375Q4 28.1 4 23.95q0-4.1 1.575-7.75 1.575-3.65 4.3-6.35 2.725-2.7 6.375-4.275Q19.9 4 24.05 4q4.1 0 7.75 1.575 3.65 1.575 6.35 4.275 2.7 2.7 4.275 6.35Q44 19.85 44 24q0 4.1-1.575 7.75-1.575 3.65-4.275 6.375t-6.35 4.3Q28.15 44 24 44Zm.05-3q7.05 0 12-4.975T41 23.95q0-7.05-4.95-12T24 7q-7.05 0-12.025 4.95Q7 16.9 7 24q0 7.05 4.975 12.025Q16.95 41 24.05 41ZM24 24Z"/></svg>`);
const closeIcon: IconFactory = (vscode, color) => vscode.Uri.parse(`data:image/svg+xml,<svg fill="${color}" xmlns="http://www.w3.org/2000/svg" height="48" width="48"><path xmlns="http://www.w3.org/2000/svg" d="m12.45 37.65-2.1-2.1L21.9 24 10.35 12.45l2.1-2.1L24 21.9l11.55-11.55 2.1 2.1L26.1 24l11.55 11.55-2.1 2.1L24 26.1Z"/></svg>`);
const logIcon: IconFactory = (vscode, color) => vscode.Uri.parse(`data:image/svg+xml,<svg fill="${color}" xmlns="http://www.w3.org/2000/svg" height="48" width="48"><path d="M11.85 25.3H29.9v-3H11.85Zm0-6.45H29.9v-3H11.85ZM7 40q-1.2 0-2.1-.9Q4 38.2 4 37V11q0-1.2.9-2.1Q5.8 8 7 8h34q1.2 0 2.1.9.9.9.9 2.1v26q0 1.2-.9 2.1-.9.9-2.1.9Zm0-3h34V11H7v26Zm0 0V11v26Z"/></svg>`);

function iconPath(vscode: vscodeTypes.VSCode, factory: IconFactory): { light: vscodeTypes.Uri, dark: vscodeTypes.Uri } {
  return {
    light: factory(vscode, 'rgb(80,80,80)'),
    dark: factory(vscode, 'lightGray'),
  };
}

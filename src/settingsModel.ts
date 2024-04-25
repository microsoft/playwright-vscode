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
import * as vscodeTypes from './vscodeTypes';

export type ProjectSettings = {
  name: string;
  enabled: boolean;
};

export type ConfigSettings = {
  relativeConfigFile: string;
  projects: ProjectSettings[];
  enabled: boolean;
  selected: boolean;
};

export type WorkspaceSettings = {
  configs?: ConfigSettings[];
};

export class SettingsModel extends DisposableBase {
  private _vscode: vscodeTypes.VSCode;
  private _settings = new Map<string, Setting<any>>();
  readonly onChange: vscodeTypes.Event<void>;
  private _onChange: vscodeTypes.EventEmitter<void>;
  showBrowser: Setting<boolean>;
  showTrace: Setting<boolean>;
  workspaceSettings: Setting<WorkspaceSettings>;

  constructor(vscode: vscodeTypes.VSCode) {
    super();
    this._vscode = vscode;
    this._onChange = new vscode.EventEmitter();
    this.onChange = this._onChange.event;

    this.showBrowser = this._createSetting('reuseBrowser');
    this.showTrace = this._createSetting('showTrace');
    this.workspaceSettings = this._createSetting('workspaceSettings', true);

    this.showBrowser.onChange(enabled => {
      if (enabled && this.showTrace.get())
        this.showTrace.set(false);
    });
    this.showTrace.onChange(enabled => {
      if (enabled && this.showBrowser.get())
        this.showBrowser.set(false);
    });
  }

  private _createSetting<T>(settingName: string, perWorkspace = false): Setting<T> {
    const setting = new Setting<T>(this._vscode, settingName, perWorkspace);
    this._disposables.push(setting);
    this._disposables.push(setting.onChange(() => this._onChange.fire()));
    this._settings.set(settingName, setting);
    return setting;
  }

  json(): Record<string, boolean | string> {
    const result: Record<string, boolean | string> = {};
    for (const [key, setting] of this._settings)
      result[key] = setting.get();
    return result;
  }
}

export class Setting<T> extends DisposableBase {
  readonly settingName: string;
  readonly onChange: vscodeTypes.Event<T>;
  private _onChange: vscodeTypes.EventEmitter<T>;
  private _vscode: vscodeTypes.VSCode;
  private _perWorkspace: boolean;

  constructor(vscode: vscodeTypes.VSCode, settingName: string, perWorkspace: boolean) {
    super();
    this._vscode = vscode;
    this.settingName = settingName;
    this._perWorkspace = perWorkspace;
    this._onChange = new vscode.EventEmitter<T>();
    this.onChange = this._onChange.event;

    const settingFQN = `playwright.${settingName}`;
    this._disposables = [
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration(settingFQN))
          this._onChange.fire(this.get());
      }),
      vscode.commands.registerCommand(`pw.extension.toggle.${settingName}`, async () => {
        this.set(!this.get() as T);
      }),
    ];
  }

  get(): T {
    const configuration = this._vscode.workspace.getConfiguration('playwright');
    return configuration.get(this.settingName) as T;
  }

  async set(value: T) {
    const configuration = this._vscode.workspace.getConfiguration('playwright');
    if (this._perWorkspace) {
      // These are not dispatched :shrug:
      configuration.update(this.settingName, value, false);
      this._onChange.fire(value);
      return;
    }
    const existsInWorkspace = configuration.inspect(this.settingName)?.workspaceValue !== undefined;
    if (existsInWorkspace)
      configuration.update(this.settingName, value, false);
    // Intentionally fall through.
    configuration.update(this.settingName, value, true);
  }
}

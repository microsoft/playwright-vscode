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

export const workspaceStateKey = 'pw.workspace-settings';

export class SettingsModel extends DisposableBase {
  private _vscode: vscodeTypes.VSCode;
  private _settings = new Map<string, Setting<any>>();
  private _context: vscodeTypes.ExtensionContext;
  readonly onChange: vscodeTypes.Event<void>;
  private _onChange: vscodeTypes.EventEmitter<void>;
  showBrowser: Setting<boolean>;
  showTrace: Setting<boolean>;
  embeddedTraceViewer: Setting<boolean>;

  constructor(vscode: vscodeTypes.VSCode, context: vscodeTypes.ExtensionContext) {
    super();
    this._vscode = vscode;
    this._context = context;
    this._onChange = new vscode.EventEmitter();
    this.onChange = this._onChange.event;

    this.showBrowser = this._createSetting('reuseBrowser');
    this.showTrace = this._createSetting('showTrace');
    this.embeddedTraceViewer = this._createSetting('embeddedTraceViewer');

    this.showBrowser.onChange(enabled => {
      if (enabled && this.showTrace.get())
        this.showTrace.set(false);
    });
    this.showTrace.onChange(enabled => {
      if (enabled && this.showBrowser.get())
        this.showBrowser.set(false);
    });

    this._modernize();
  }

  private _modernize() {
    const workspaceSettings = this._vscode.workspace.getConfiguration('playwright').get('workspaceSettings') as any;
    if (workspaceSettings?.configs && !this._context.workspaceState.get(workspaceStateKey)) {
      this._context.workspaceState.update(workspaceStateKey, { configs: workspaceSettings.configs });
      this._vscode.workspace.getConfiguration('playwright').update('workspaceSettings', undefined);
    }
  }

  private _createSetting<T>(settingName: string): Setting<T> {
    const setting = new Setting<T>(this._vscode, settingName);
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

  constructor(vscode: vscodeTypes.VSCode, settingName: string) {
    super();
    this._vscode = vscode;
    this.settingName = settingName;
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
    const existsInWorkspace = configuration.inspect(this.settingName)?.workspaceValue !== undefined;
    if (existsInWorkspace)
      configuration.update(this.settingName, value, false);
    // Intentionally fall through.
    configuration.update(this.settingName, value, true);
  }
}

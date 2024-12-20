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
import type { ReusedBrowser } from './reusedBrowser';
import type { SettingsModel } from './settingsModel';
import type { TestModelCollection } from './testModel';
import { getNonce } from './utils';
import * as vscodeTypes from './vscodeTypes';
import path from 'path';

type ConfigEntry = {
  label: string;
  configFile: string;
  selected: boolean;
  enabled: boolean;
  projects: ProjectEntry[];
};

type ProjectEntry = {
  name: string;
  enabled: boolean;
};

export class SettingsView extends DisposableBase implements vscodeTypes.WebviewViewProvider {
  private _view: vscodeTypes.WebviewView | undefined;
  private _vscode: vscodeTypes.VSCode;
  private _extensionUri: vscodeTypes.Uri;
  private _settingsModel: SettingsModel;
  private _reusedBrowser: ReusedBrowser;
  private _models: TestModelCollection;

  constructor(vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, models: TestModelCollection, reusedBrowser: ReusedBrowser, extensionUri: vscodeTypes.Uri) {
    super();
    this._vscode = vscode;
    this._settingsModel = settingsModel;
    this._models = models;
    this._reusedBrowser = reusedBrowser;
    this._extensionUri = extensionUri;
    this._disposables = [
      reusedBrowser.onRunningTestsChanged(() => this._updateActions()),
      reusedBrowser.onPageCountChanged(() => this._updateActions()),
      vscode.window.registerWebviewViewProvider('pw.extension.settingsView', this),
    ];
    this._models.onUpdated(() => {
      this._updateModels();
      this._updateActions();
    });
  }

  public resolveWebviewView(webviewView: vscodeTypes.WebviewView, context: vscodeTypes.WebviewViewResolveContext, token: vscodeTypes.CancellationToken) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = htmlForWebview(this._vscode, this._extensionUri, webviewView.webview);
    this._disposables.push(webviewView.webview.onDidReceiveMessage(data => {
      if (data.method === 'execute') {
        this._vscode.commands.executeCommand(data.params.command);
      } else if (data.method === 'toggle') {
        this._vscode.commands.executeCommand(`pw.extension.toggle.${data.params.setting}`);
      } else if (data.method === 'set') {
        this._settingsModel.setting(data.params.setting)!.set(data.params.value);
      } else if (data.method === 'setProjectEnabled') {
        const { configFile, projectName, enabled } = data.params;
        this._models.setProjectEnabled(configFile, projectName, enabled);
      } else if (data.method === 'setAllProjectsEnabled') {
        const { configFile, enabled } = data.params;
        this._models.setAllProjectsEnabled(configFile, enabled);
      } else if (data.method === 'selectModel') {
        this._models.selectModel(data.params.configFile);
      }
    }));

    this._disposables.push(this._settingsModel.onChange(() => {
      this._updateSettings();
      this._updateActions();
    }));

    this._disposables.push(webviewView.onDidChangeVisibility(() => {
      if (!webviewView.visible)
        return;
      this._updateSettings();
      this._updateModels();
      this._updateActions();
    }));
    this._updateSettings();
    this._updateModels();
    this._updateActions();
  }

  updateActions() {
    if (this._view)
      this._updateActions();
  }

  private _updateSettings() {
    this._view!.webview.postMessage({ method: 'settings', params: { settings: this._settingsModel.json() } });
  }

  private _updateActions() {
    const actions = [
      pickElementAction(this._vscode),
      recordNewAction(this._vscode, this._reusedBrowser),
      recordAtCursorAction(this._vscode, this._reusedBrowser),
      revealTestOutputAction(this._vscode),
      closeBrowsersAction(this._vscode, this._reusedBrowser),
      {
        ...runGlobalSetupAction(this._vscode, this._settingsModel, this._models),
        location: 'rareActions',
      },
      {
        ...runGlobalTeardownAction(this._vscode, this._settingsModel, this._models),
        location: 'rareActions',
      },
      {
        ...clearCacheAction(this._vscode, this._models),
        location: 'rareActions',
      },
      {
        ...toggleModelsAction(this._vscode),
        location: 'configToolbar',
      },
    ];
    if (this._view)
      this._view.webview.postMessage({ method: 'actions', params: { actions } });
  }

  private _updateModels() {
    if (!this._view)
      return;
    const configs: ConfigEntry[] = [];
    const workspaceFolders = new Set<string>();
    this._models.enabledModels().forEach(model => workspaceFolders.add(model.config.workspaceFolder));

    for (const model of this._models.enabledModels()) {
      const prefix = workspaceFolders.size > 1 ? path.basename(model.config.workspaceFolder) + path.sep : '';
      configs.push({
        label: prefix + path.relative(model.config.workspaceFolder, model.config.configFile),
        configFile: model.config.configFile,
        selected: model === this._models.selectedModel(),
        enabled: model.isEnabled,
        projects: model.projects().map(p => ({ name: p.name, enabled: p.isEnabled })),
      });
    }

    this._view.webview.postMessage({ method: 'models', params: { configs, showModelSelector: this._models.models().length > 1 } });
  }

  toggleModels() {
    const options: vscodeTypes.QuickPickItem[] = [];
    const itemMap = new Map<string, vscodeTypes.QuickPickItem>();
    const workspaceFolders = new Set<string>();
    this._models.models().forEach(model => workspaceFolders.add(model.config.workspaceFolder));

    for (const model of this._models.models()) {
      const prefix = workspaceFolders.size > 1 ? path.basename(model.config.workspaceFolder) + path.sep : '';
      const modelItem: vscodeTypes.QuickPickItem = {
        label: prefix + path.relative(model.config.workspaceFolder, model.config.configFile),
        picked: model.isEnabled,
      };
      itemMap.set(model.config.configFile, modelItem);
      options.push(modelItem);
    }
    options.sort((a, b) => a.label.localeCompare(b.label));
    this._vscode.window.showQuickPick(options, {
      title: this._vscode.l10n.t('Toggle Playwright Configs'),
      canPickMany: true,
    }).then(result => {
      if (!result)
        return;
      for (const model of this._models.models()) {
        const modelItem = itemMap.get(model.config.configFile);
        if (!modelItem)
          continue;
        this._models.setModelEnabled(model.config.configFile, !!result?.includes(modelItem), true);
      }
      this._models.ensureHasEnabledModels();
      this._updateModels();
    });
  }
}

function htmlForWebview(vscode: vscodeTypes.VSCode, extensionUri: vscodeTypes.Uri, webview: vscodeTypes.Webview) {
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'common.css'));
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'settingsView.script.js'));
  const nonce = getNonce();

  return `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link href="${style}" rel="stylesheet">
      <title>Playwright</title>
    </head>
    <body class="settings-view">
      <div class="section-header">${vscode.l10n.t('TOOLS')}</div>
      <div id="actions" class="vbox"></div>
      <div class="vbox" id="model-selector">
        <div>
          <label title="${vscode.l10n.t('Select Playwright Config')}">
            <select data-testid="models" id="models"></select>
          </label>
          <span id="configToolbar"></span>
        </div>
      </div>
      <div class="section-header">
        ${vscode.l10n.t('PROJECTS')}
        <div class="section-toolbar">
          <a id="selectAll" role="button" title="${vscode.l10n.t('Select All')}">
            <svg width="48" height="48" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M9 9H4v1h5V9z"/><path d="M7 12V7H6v5h1z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"/></svg>
          </a>
          <a id="unselectAll" role="button" title="${vscode.l10n.t('Unselect All')}" hidden>
            <svg width="48" height="48" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M9 9H4v1h5V9z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"/></svg>
          </a>
        </div>
      </div>
      <div data-testid="projects" id="projects" class="vbox"></div>
      <div class="section-header">${vscode.l10n.t('SETUP')}</div>
      <div id="rareActions" class="vbox"></div>
      <div class="section-header">${vscode.l10n.t('SETTINGS')}</div>
      <div class="vbox">
        <div class="action">
          <label title="${vscode.l10n.t('When enabled, Playwright will reuse the browser instance between tests. This will disable parallel execution.')}">
            <input type="checkbox" setting="reuseBrowser"></input>
            ${vscode.l10n.t('Show browser')}
          </label>
        </div class="action">
        <div class="action">
          <label>
            <input type="checkbox" setting="showTrace"></input>
            ${vscode.l10n.t('Show trace viewer')}
          </label>
        </div class="action">
        <div class="action">
          <label>
            <input type="checkbox" setting="runGlobalSetupOnEachRun"></input>
            ${vscode.l10n.t('Run global setup on each run')}
          </label>
        </div class="action">
        <div class="hbox">
          <div class="action-indent"></div>
          <div class="action-indent"></div>
          <label id="updateSnapshotLabel">${vscode.l10n.t('Update snapshots')}</label>
        </div>
        <div>
          <div class="action-big-indent"></div>
          <select class="combobox" setting="updateSnapshots" aria-labelledby="updateSnapshotLabel">
            <option value="all">all</option>
            <option value="changed">changed</option>
            <option value="missing">missing</option>
            <option value="none">none</option>
          </select>
          <div class="action-indent"></div>
        </div>
        <div class="hbox">
          <div class="action-indent"></div>
          <div class="action-indent"></div>
          <label id="updateSourceMethod">${vscode.l10n.t('Update method')}</label>
        </div>
        <div>
          <div class="action-big-indent"></div>
          <select class="combobox" setting="updateSourceMethod" aria-labelledby="updateSourceMethod">
            <option value="overwrite">overwrite</option>
            <option value="patch">patch</option>
            <option value="3way">3-way</option>
          </select>
          <div class="action-indent"></div>
        </div>
      </div>
    </body>
    <script src="${script}" nonce="${nonce}"></script>
  </html>`;
}

export const pickElementAction = (vscode: vscodeTypes.VSCode) => {
  return {
    command: 'pw.extension.command.inspect',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" height="48" width="48"><path d="M18 42h-7.5c-3 0-4.5-1.5-4.5-4.5v-27C6 7.5 7.5 6 10.5 6h27C42 6 42 10.404 42 10.5V18h-3V9H9v30h9v3Zm27-15-9 6 9 9-3 3-9-9-6 9-6-24 24 6Z"/></svg>`,
    text: vscode.l10n.t('Pick locator'),
  };
};

export const recordNewAction = (vscode: vscodeTypes.VSCode, reusedBrowser: ReusedBrowser) => {
  return {
    command: 'pw.extension.command.recordNew',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" height="48" width="48"><path d="M22.65 34h3v-8.3H34v-3h-8.35V14h-3v8.7H14v3h8.65ZM24 44q-4.1 0-7.75-1.575-3.65-1.575-6.375-4.3-2.725-2.725-4.3-6.375Q4 28.1 4 23.95q0-4.1 1.575-7.75 1.575-3.65 4.3-6.35 2.725-2.7 6.375-4.275Q19.9 4 24.05 4q4.1 0 7.75 1.575 3.65 1.575 6.35 4.275 2.7 2.7 4.275 6.35Q44 19.85 44 24q0 4.1-1.575 7.75-1.575 3.65-4.275 6.375t-6.35 4.3Q28.15 44 24 44Zm.05-3q7.05 0 12-4.975T41 23.95q0-7.05-4.95-12T24 7q-7.05 0-12.025 4.95Q7 16.9 7 24q0 7.05 4.975 12.025Q16.95 41 24.05 41ZM24 24Z"/></svg>`,
    text: vscode.l10n.t('Record new'),
    disabled: !reusedBrowser.canRecord(),
  };
};

export const recordAtCursorAction = (vscode: vscodeTypes.VSCode, reusedBrowser: ReusedBrowser) => {
  return {
    command: 'pw.extension.command.recordAtCursor',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" height="48" width="48"><path d="M9 39h2.2l22.15-22.15-2.2-2.2L9 36.8Zm30.7-24.3-6.4-6.4 2.1-2.1q.85-.85 2.1-.85t2.1.85l2.2 2.2q.85.85.85 2.1t-.85 2.1Zm-2.1 2.1L12.4 42H6v-6.4l25.2-25.2Zm-5.35-1.05-1.1-1.1 2.2 2.2Z"/></svg>`,
    text: vscode.l10n.t('Record at cursor'),
    disabled: !reusedBrowser.canRecord(),
  };
};

export const revealTestOutputAction = (vscode: vscodeTypes.VSCode) => {
  return {
    command: 'testing.showMostRecentOutput',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" height="48" width="48"><path d="M11.85 25.3H29.9v-3H11.85Zm0-6.45H29.9v-3H11.85ZM7 40q-1.2 0-2.1-.9Q4 38.2 4 37V11q0-1.2.9-2.1Q5.8 8 7 8h34q1.2 0 2.1.9.9.9.9 2.1v26q0 1.2-.9 2.1-.9.9-2.1.9Zm0-3h34V11H7v26Zm0 0V11v26Z"/></svg>`,
    text: vscode.l10n.t('Reveal test output'),
  };
};

export const closeBrowsersAction = (vscode: vscodeTypes.VSCode, reusedBrowser: ReusedBrowser) => {
  return {
    command: 'pw.extension.command.closeBrowsers',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" height="48" width="48"><path xmlns="http://www.w3.org/2000/svg" d="m12.45 37.65-2.1-2.1L21.9 24 10.35 12.45l2.1-2.1L24 21.9l11.55-11.55 2.1 2.1L26.1 24l11.55 11.55-2.1 2.1L24 26.1Z"/></svg>`,
    text: vscode.l10n.t('Close all browsers'),
    disabled: !reusedBrowser.canClose(),
  };
};

export const runGlobalSetupAction = (vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, models: TestModelCollection) => {
  return {
    command: 'pw.extension.command.runGlobalSetup',
    svg: `<div class="action-indent"></div>`,
    text: vscode.l10n.t('Run global setup'),
    disabled: settingsModel.runGlobalSetupOnEachRun.get() || !models.selectedModel() || !models.selectedModel()!.canRunGlobalHooks('setup'),
  };
};

export const runGlobalTeardownAction = (vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, models: TestModelCollection) => {
  return {
    command: 'pw.extension.command.runGlobalTeardown',
    svg: `<div class="action-indent"></div>`,
    text: vscode.l10n.t('Run global teardown'),
    disabled: settingsModel.runGlobalSetupOnEachRun.get() || !models.selectedModel() || !models.selectedModel()!.canRunGlobalHooks('teardown'),
  };
};

export const clearCacheAction = (vscode: vscodeTypes.VSCode, models: TestModelCollection) => {
  return {
    command: 'pw.extension.command.clearCache',
    svg: `<div class="action-indent"></div>`,
    text: vscode.l10n.t('Clear cache'),
    disabled: !models.selectedModel(),
  };
};

export const toggleModelsAction = (vscode: vscodeTypes.VSCode) => {
  return {
    command: 'pw.extension.command.toggleModels',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" height="48" viewBox="0 -960 960 960" width="48"><path d="m388-80-20-126q-19-7-40-19t-37-25l-118 54-93-164 108-79q-2-9-2.5-20.5T185-480q0-9 .5-20.5T188-521L80-600l93-164 118 54q16-13 37-25t40-18l20-127h184l20 126q19 7 40.5 18.5T669-710l118-54 93 164-108 77q2 10 2.5 21.5t.5 21.5q0 10-.5 21t-2.5 21l108 78-93 164-118-54q-16 13-36.5 25.5T592-206L572-80H388Zm48-60h88l14-112q33-8 62.5-25t53.5-41l106 46 40-72-94-69q4-17 6.5-33.5T715-480q0-17-2-33.5t-7-33.5l94-69-40-72-106 46q-23-26-52-43.5T538-708l-14-112h-88l-14 112q-34 7-63.5 24T306-642l-106-46-40 72 94 69q-4 17-6.5 33.5T245-480q0 17 2.5 33.5T254-413l-94 69 40 72 106-46q24 24 53.5 41t62.5 25l14 112Zm44-210q54 0 92-38t38-92q0-54-38-92t-92-38q-54 0-92 38t-38 92q0 54 38 92t92 38Zm0-130Z"/></svg>`,
    title: vscode.l10n.t('Toggle Playwright Configs'),
  };
};

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

import { BrowserList, getBrowserTitle } from './browserList';
import { BrowserEntry } from './common';
import { DisposableBase } from './disposableBase';
import type { ReusedBrowser } from './reusedBrowser';
import type { SettingsModel } from './settingsModel';
import type { TestModelCollection } from './testModel';
import { getNonce, html } from './utils';
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
  private _browserList: BrowserList;
  private _models: TestModelCollection;

  constructor(vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, models: TestModelCollection, reusedBrowser: ReusedBrowser, extensionUri: vscodeTypes.Uri, browserList: BrowserList) {
    super();
    this._vscode = vscode;
    this._settingsModel = settingsModel;
    this._models = models;
    this._reusedBrowser = reusedBrowser;
    this._browserList = browserList;
    this._extensionUri = extensionUri;
    this._disposables = [
      reusedBrowser.onRunningTestsChanged(() => this._updateActions()),
      reusedBrowser.onPageCountChanged(() => this._updateActions()),
      browserList.onChanged(() => this._updateBrowsers()),
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
        void this._vscode.commands.executeCommand(data.params.command, ...data.params.args);
      } else if (data.method === 'toggle') {
        void this._vscode.commands.executeCommand(`pw.extension.toggle.${data.params.setting}`);
      } else if (data.method === 'set') {
        void this._settingsModel.setting(data.params.setting)!.set(data.params.value);
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
      this._updateBrowsers();
    }));
    this._updateSettings();
    this._updateModels();
    this._updateActions();
    this._updateBrowsers();
  }

  updateActions() {
    if (this._view)
      this._updateActions();
  }

  private _updateSettings() {
    void this._view!.webview.postMessage({ method: 'settings', params: { settings: this._settingsModel.json() } });
  }

  private _updateActions() {
    const actions = [
      recordNewAction(this._vscode, this._reusedBrowser),
      recordAtCursorAction(this._vscode, this._reusedBrowser),
      revealTestOutputAction(this._vscode),
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
    ];

    void this._view?.webview.postMessage({ method: 'actions', params: { actions } });
  }

  private _updateBrowsers() {
    const browsers: BrowserEntry[] = this._browserList.get().map(b => {
      let svg = chromiumLogo;
      if (b.channel === 'msedge')
        svg = edgeLogo;
      else if (b.channel === 'chrome')
        svg = chromeLogo;
      else if (b.name === 'firefox')
        svg = firefoxLogo;
      else if (b.name === 'webkit')
        svg = webkitLogo;

      return {
        text: getBrowserTitle(b),
        svg,
        actions: [
          {
            svg: pickElementIcon,
            title: 'Pick locator',
            command: 'pw.extension.command.inspect',
            args: [b.id]
          },
          {
            svg: closeIcon,
            title: 'Close Browser',
            command: 'pw.extension.command.closeBrowser',
            args: [b.id],
          }
        ]
      };
    });

    if (browsers.length === 0) {
      browsers.push({
        svg: '',
        text: 'No browsers open.',
        actions: [
          {
            svg: pickElementIcon,
            title: 'Pick locator',
            command: 'pw.extension.command.inspect',
            args: []
          },
          {
            svg: closeIcon,
            title: 'Close Browser',
            command: 'pw.extension.command.closeBrowser',
            args: [],
            state: 'disabled'
          }
        ],
      });
    }

    void this._view?.webview.postMessage({ method: 'browsers', params: { browsers } });
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

    void this._view.webview.postMessage({ method: 'models', params: { configs, showModelSelector: this._models.models().length > 1 } });
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
    void this._vscode.window.showQuickPick(options, {
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

  return html`<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <link href="${style}" rel="stylesheet">
      <title>Playwright</title>
    </head>
    <body class="settings-view">
      <section>
        <h2 class="section-header">${vscode.l10n.t('BROWSERS')}</h2>
        <div id="browsers" class="vbox"></div>
      </section>

      <h2 class="section-header">${vscode.l10n.t('TOOLS')}</h2>
      <div id="actions" class="vbox"></div>

      <div id="model-selector" class="vbox" style="display: none">
        <h2 class="section-header">
          ${vscode.l10n.t('CONFIGS')}
          <div class="section-toolbar">
            <a id="toggleModels" role="button" title="${vscode.l10n.t('Toggle Playwright Configs')}">
              <svg xmlns="http://www.w3.org/2000/svg" height="48" viewBox="0 -960 960 960" width="48"><path d="m388-80-20-126q-19-7-40-19t-37-25l-118 54-93-164 108-79q-2-9-2.5-20.5T185-480q0-9 .5-20.5T188-521L80-600l93-164 118 54q16-13 37-25t40-18l20-127h184l20 126q19 7 40.5 18.5T669-710l118-54 93 164-108 77q2 10 2.5 21.5t.5 21.5q0 10-.5 21t-2.5 21l108 78-93 164-118-54q-16 13-36.5 25.5T592-206L572-80H388Zm48-60h88l14-112q33-8 62.5-25t53.5-41l106 46 40-72-94-69q4-17 6.5-33.5T715-480q0-17-2-33.5t-7-33.5l94-69-40-72-106 46q-23-26-52-43.5T538-708l-14-112h-88l-14 112q-34 7-63.5 24T306-642l-106-46-40 72 94 69q-4 17-6.5 33.5T245-480q0 17 2.5 33.5T254-413l-94 69 40 72 106-46q24 24 53.5 41t62.5 25l14 112Zm44-210q54 0 92-38t38-92q0-54-38-92t-92-38q-54 0-92 38t-38 92q0 54 38 92t92 38Zm0-130Z"/></svg>
            </a>
          </div>
        </h2>
        <div class="combobox">
          <select data-testid="models" id="models" title="${vscode.l10n.t('Select Playwright Config')}" ></select>
        </div>
      </div>
      <h2 class="section-header">
        ${vscode.l10n.t('PROJECTS')}
        <div class="section-toolbar">
          <a id="selectAll" role="button" title="${vscode.l10n.t('Select All')}">
            <svg width="48" height="48" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M9 9H4v1h5V9z"/><path d="M7 12V7H6v5h1z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"/></svg>
          </a>
          <a id="unselectAll" role="button" title="${vscode.l10n.t('Unselect All')}" hidden>
            <svg width="48" height="48" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M9 9H4v1h5V9z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M5 3l1-1h7l1 1v7l-1 1h-2v2l-1 1H3l-1-1V6l1-1h2V3zm1 2h4l1 1v4h2V3H6v2zm4 1H3v7h7V6z"/></svg>
          </a>
        </div>
      </h2>
      <div data-testid="projects" id="projects" class="vbox"></div>
      <h2 class="section-header">${vscode.l10n.t('SETUP')}</h2>
      <div id="rareActions" class="vbox"></div>
      <h2 class="section-header">${vscode.l10n.t('SETTINGS')}</h2>
      <div class="vbox">
        <div class="action">
          <label title="${vscode.l10n.t('When enabled, Playwright will reuse the browser instance between tests. This will disable parallel execution.')}">
            <input type="checkbox" setting="reuseBrowser"></input>
            <div>${vscode.l10n.t('Show browser')}</div>
            <div class="inactive" style="padding-left: 5px;">— ${vscode.l10n.t('one worker')}</div>
          </label>
        </div>
        <div class="action">
          <label>
            <input type="checkbox" setting="showTrace"></input>
            <div>${vscode.l10n.t('Show trace viewer')}</div>
          </label>
        </div>
        <div class="action">
          <label>
            <input type="checkbox" setting="runGlobalSetupOnEachRun"></input>
            <div>${vscode.l10n.t('Run global setup on each run')}</div>
          </label>
        </div>
        <div class="hbox">
          <label id="updateSnapshotLabel">${vscode.l10n.t('Update snapshots')}</label>
        </div>
        <div class="combobox">
          <select setting="updateSnapshots" aria-labelledby="updateSnapshotLabel">
            <option value="no-override">no override</option>
            <option value="all">all</option>
            <option value="changed">changed</option>
            <option value="missing">missing</option>
            <option value="none">none</option>
          </select>
        </div>
        <div class="hbox">
          <label id="updateSourceMethod">${vscode.l10n.t('Update method')}</label>
        </div>
        <div class="combobox">
          <select setting="updateSourceMethod" aria-labelledby="updateSourceMethod">
            <option value="no-override">no override</option>
            <option value="overwrite">overwrite</option>
            <option value="patch">patch</option>
            <option value="3way">3-way</option>
          </select>
        </div>
      </div>
    </body>
    <script src="${script}" nonce="${nonce}"></script>
  </html>`;
}

const pickElementIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M18 42h-7.5c-3 0-4.5-1.5-4.5-4.5v-27C6 7.5 7.5 6 10.5 6h27C42 6 42 10.404 42 10.5V18h-3V9H9v30h9v3Zm27-15-9 6 9 9-3 3-9-9-6 9-6-24 24 6Z"/></svg>`;

export const pickElementAction = (vscode: vscodeTypes.VSCode) => {
  return {
    command: 'pw.extension.command.inspect',
    svg: pickElementIcon,
    text: vscode.l10n.t('Pick locator'),
  };
};

export const recordNewAction = (vscode: vscodeTypes.VSCode, reusedBrowser: ReusedBrowser) => {
  return {
    command: 'pw.extension.command.recordNew',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M22.65 34h3v-8.3H34v-3h-8.35V14h-3v8.7H14v3h8.65ZM24 44q-4.1 0-7.75-1.575-3.65-1.575-6.375-4.3-2.725-2.725-4.3-6.375Q4 28.1 4 23.95q0-4.1 1.575-7.75 1.575-3.65 4.3-6.35 2.725-2.7 6.375-4.275Q19.9 4 24.05 4q4.1 0 7.75 1.575 3.65 1.575 6.35 4.275 2.7 2.7 4.275 6.35Q44 19.85 44 24q0 4.1-1.575 7.75-1.575 3.65-4.275 6.375t-6.35 4.3Q28.15 44 24 44Zm.05-3q7.05 0 12-4.975T41 23.95q0-7.05-4.95-12T24 7q-7.05 0-12.025 4.95Q7 16.9 7 24q0 7.05 4.975 12.025Q16.95 41 24.05 41ZM24 24Z"/></svg>`,
    text: vscode.l10n.t('Record new'),
    disabled: !reusedBrowser.canRecord(),
  };
};

export const recordAtCursorAction = (vscode: vscodeTypes.VSCode, reusedBrowser: ReusedBrowser) => {
  return {
    command: 'pw.extension.command.recordAtCursor',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M9 39h2.2l22.15-22.15-2.2-2.2L9 36.8Zm30.7-24.3-6.4-6.4 2.1-2.1q.85-.85 2.1-.85t2.1.85l2.2 2.2q.85.85.85 2.1t-.85 2.1Zm-2.1 2.1L12.4 42H6v-6.4l25.2-25.2Zm-5.35-1.05-1.1-1.1 2.2 2.2Z"/></svg>`,
    text: vscode.l10n.t('Record at cursor'),
    disabled: !reusedBrowser.canRecord(),
  };
};

export const revealTestOutputAction = (vscode: vscodeTypes.VSCode) => {
  return {
    command: 'testing.showMostRecentOutput',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path d="M11.85 25.3H29.9v-3H11.85Zm0-6.45H29.9v-3H11.85ZM7 40q-1.2 0-2.1-.9Q4 38.2 4 37V11q0-1.2.9-2.1Q5.8 8 7 8h34q1.2 0 2.1.9.9.9.9 2.1v26q0 1.2-.9 2.1-.9.9-2.1.9Zm0-3h34V11H7v26Zm0 0V11v26Z"/></svg>`,
    text: vscode.l10n.t('Reveal test output'),
  };
};

const closeIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path xmlns="http://www.w3.org/2000/svg" d="m12.45 37.65-2.1-2.1L21.9 24 10.35 12.45l2.1-2.1L24 21.9l11.55-11.55 2.1 2.1L26.1 24l11.55 11.55-2.1 2.1L24 26.1Z"/></svg>`;

export const closeBrowsersAction = (vscode: vscodeTypes.VSCode, reusedBrowser: ReusedBrowser) => {
  return {
    command: 'pw.extension.command.closeBrowsers',
    svg: closeIcon,
    text: vscode.l10n.t('Close all browsers'),
    disabled: !reusedBrowser.canClose(),
  };
};

export const runGlobalSetupAction = (vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, models: TestModelCollection) => {
  return {
    command: 'pw.extension.command.runGlobalSetup',
    svg: ``,
    text: vscode.l10n.t('Run global setup'),
    disabled: settingsModel.runGlobalSetupOnEachRun.get() || !models.selectedModel() || !models.selectedModel()!.canRunGlobalHooks('setup'),
  };
};

export const runGlobalTeardownAction = (vscode: vscodeTypes.VSCode, settingsModel: SettingsModel, models: TestModelCollection) => {
  return {
    command: 'pw.extension.command.runGlobalTeardown',
    svg: ``,
    text: vscode.l10n.t('Run global teardown'),
    disabled: settingsModel.runGlobalSetupOnEachRun.get() || !models.selectedModel() || !models.selectedModel()!.canRunGlobalHooks('teardown'),
  };
};

export const clearCacheAction = (vscode: vscodeTypes.VSCode, models: TestModelCollection) => {
  return {
    command: 'pw.extension.command.clearCache',
    svg: ``,
    text: vscode.l10n.t('Clear cache'),
    disabled: !models.selectedModel(),
  };
};

const chromiumLogo = `<svg xmlns:xlink="http://www.w3.org/1999/xlink" xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg" version="1.1" id="svg44" width="511.98489" height="511.98489" viewBox="0 0 511.98489 511.98489">  <defs id="defs18">    <linearGradient xlink:href="#linearGradient4975" id="linearGradient4633" gradientUnits="userSpaceOnUse" gradientTransform="matrix(231.62575,0,0,231.62472,111.11013,159.99363)" x2="0.5565635" x1="0.46521288" y1="-0.67390651" y2="0.81129867"/>    <linearGradient id="linearGradient4975">      <stop style="stop-color:#1972e7" offset="0" id="stop4971"/>      <stop style="stop-color:#1969d5" offset="1" id="stop4973"/>    </linearGradient>    <linearGradient xlink:href="#3" id="linearGradient1331" x1="101.74381" y1="33.726189" x2="101.59915" y2="135.466" gradientUnits="userSpaceOnUse" gradientTransform="matrix(3.7794235,0,0,3.7794067,0.00151555,0.00377865)"/>    <linearGradient id="3" x2="1" gradientTransform="matrix(61.286,0,0,61.286,29.399,42.333)" gradientUnits="userSpaceOnUse">      <stop offset="0" id="stop1397" style="stop-color:#afccfb"/>      <stop offset="1" id="stop1399" style="stop-color:#8bb5f8"/>    </linearGradient>    <linearGradient xlink:href="#1" id="linearGradient2962" gradientUnits="userSpaceOnUse" gradientTransform="matrix(94.931559,164.42687,-164.4276,94.931137,97.555991,173.61083)" x2="1.7695541" x1="0.018202547" y1="-0.51170158" y2="0.4994337"/>    <linearGradient id="1" x2="1" gradientTransform="matrix(25.118,43.506,-43.506,25.118,25.812,45.935)" gradientUnits="userSpaceOnUse">      <stop offset="0" id="stop3122" style="stop-color:#659cf6"/>      <stop offset="1" id="stop3124" style="stop-color:#4285f4"/>    </linearGradient>    <linearGradient xlink:href="#2" id="linearGradient2688" x1="67.452377" y1="40.320694" x2="67.733002" y2="95.25" gradientUnits="userSpaceOnUse" gradientTransform="matrix(3.7794235,0,0,3.7794067,0.00150043,0.00377865)"/>    <linearGradient id="2">      <stop style="stop-color:#3680f0" offset="0" id="stop2682"/>      <stop style="stop-color:#2678ec" offset="1" id="stop2684"/>    </linearGradient>  </defs>  <path d="m 255.99319,255.99433 110.85049,63.99671 -110.85049,191.99385 c 141.38068,0 255.9917,-114.61051 255.9917,-255.99056 0,-46.64165 -12.53559,-90.3316 -34.33115,-127.99716 h -221.6632 z" id="path34-4" style="fill:url('#linearGradient1331')"/>  <path d="M 255.99054,0 C 161.2404,0 78.576848,51.513314 34.31224,128.0274 l 110.82781,191.96363 110.85049,-63.9967 V 127.99717 h 221.6632 C 433.38157,51.501975 350.72936,0 255.99054,0 Z" id="path36-1" style="fill:url('#linearGradient4633')"/>  <path d="m 0.00151177,255.99433 c 0,141.38005 114.60723823,255.99056 255.99168823,255.99056 L 366.84368,319.99103 255.9932,255.99433 145.14271,319.99103 34.314897,128.0274 C 12.531434,165.68239 0,209.35646 0,255.99056" id="path38-7" style="fill:url('#linearGradient2962')"/>  <path d="m 383.99094,255.99433 c 0,70.69003 -57.30741,127.99717 -127.99775,127.99717 -70.69034,0 -127.99773,-57.30714 -127.99773,-127.99717 0,-70.69002 57.30739,-127.99716 127.99773,-127.99716 70.69034,0 127.99775,57.30714 127.99775,127.99716" fill="#ffffff" id="path40"/>  <path d="m 359.99158,255.99433 c 0,57.43565 -46.56249,103.99794 -103.99839,103.99794 -57.4359,0 -103.9984,-46.56229 -103.9984,-103.99794 0,-57.43564 46.5625,-103.99793 103.9984,-103.99793 57.4359,0 103.99839,46.56229 103.99839,103.99793" id="path42-5" style="fill:url('#linearGradient2688')"/></svg>`;
const chromeLogo = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 48 48"><defs><linearGradient id="a" x1="3.2173" y1="15" x2="44.7812" y2="15" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#d93025"/><stop offset="1" stop-color="#ea4335"/></linearGradient><linearGradient id="b" x1="20.7219" y1="47.6791" x2="41.5039" y2="11.6837" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fcc934"/><stop offset="1" stop-color="#fbbc04"/></linearGradient><linearGradient id="c" x1="26.5981" y1="46.5015" x2="5.8161" y2="10.506" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1e8e3e"/><stop offset="1" stop-color="#34a853"/></linearGradient></defs><circle cx="24" cy="23.9947" r="12" style="fill:#fff"/><path d="M3.2154,36A24,24,0,1,0,12,3.2154,24,24,0,0,0,3.2154,36ZM34.3923,18A12,12,0,1,1,18,13.6077,12,12,0,0,1,34.3923,18Z" style="fill:none"/><path d="M24,12H44.7812a23.9939,23.9939,0,0,0-41.5639.0029L13.6079,30l.0093-.0024A11.9852,11.9852,0,0,1,24,12Z" style="fill:url('#a')"/><circle cx="24" cy="24" r="9.5" style="fill:#1a73e8"/><path d="M34.3913,30.0029,24.0007,48A23.994,23.994,0,0,0,44.78,12.0031H23.9989l-.0025.0093A11.985,11.985,0,0,1,34.3913,30.0029Z" style="fill:url('#b')"/><path d="M13.6086,30.0031,3.218,12.006A23.994,23.994,0,0,0,24.0025,48L34.3931,30.0029l-.0067-.0068a11.9852,11.9852,0,0,1-20.7778.007Z" style="fill:url('#c')"/></svg>`;
const edgeLogo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><radialGradient id="b" cx="161.8" cy="68.9" r="95.4" gradientTransform="matrix(1 0 0 -.95 0 248.8)" gradientUnits="userSpaceOnUse"><stop offset=".7" stop-opacity="0"/><stop offset=".9" stop-opacity=".5"/><stop offset="1"/></radialGradient><radialGradient id="d" cx="-340.3" cy="63" r="143.2" gradientTransform="matrix(.15 -.99 -.8 -.12 176.6 -125.4)" gradientUnits="userSpaceOnUse"><stop offset=".8" stop-opacity="0"/><stop offset=".9" stop-opacity=".5"/><stop offset="1"/></radialGradient><radialGradient id="e" cx="113.4" cy="570.2" r="202.4" gradientTransform="matrix(-.04 1 2.13 .08 -1179.5 -106.7)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#35c1f1"/><stop offset=".1" stop-color="#34c1ed"/><stop offset=".2" stop-color="#2fc2df"/><stop offset=".3" stop-color="#2bc3d2"/><stop offset=".7" stop-color="#36c752"/></radialGradient><radialGradient id="f" cx="376.5" cy="568" r="97.3" gradientTransform="matrix(.28 .96 .78 -.23 -303.8 -148.5)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#66eb6e"/><stop offset="1" stop-color="#66eb6e" stop-opacity="0"/></radialGradient><linearGradient id="a" x1="63.3" y1="84" x2="241.7" y2="84" gradientTransform="matrix(1 0 0 -1 0 266)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0c59a4"/><stop offset="1" stop-color="#114a8b"/></linearGradient><linearGradient id="c" x1="157.3" y1="161.4" x2="46" y2="40.1" gradientTransform="matrix(1 0 0 -1 0 266)" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1b9de2"/><stop offset=".2" stop-color="#1595df"/><stop offset=".7" stop-color="#0680d7"/><stop offset="1" stop-color="#0078d4"/></linearGradient></defs><path d="M235.7 195.5a93.7 93.7 0 0 1-10.6 4.7 101.9 101.9 0 0 1-35.9 6.4c-47.3 0-88.5-32.5-88.5-74.3a31.5 31.5 0 0 1 16.4-27.3c-42.8 1.8-53.8 46.4-53.8 72.5 0 74 68.1 81.4 82.8 81.4 7.9 0 19.8-2.3 27-4.6l1.3-.4a128.3 128.3 0 0 0 66.6-52.8 4 4 0 0 0-5.3-5.6Z" transform="translate(-4.6 -5)" style="fill:url('#a')"/><path d="M235.7 195.5a93.7 93.7 0 0 1-10.6 4.7 101.9 101.9 0 0 1-35.9 6.4c-47.3 0-88.5-32.5-88.5-74.3a31.5 31.5 0 0 1 16.4-27.3c-42.8 1.8-53.8 46.4-53.8 72.5 0 74 68.1 81.4 82.8 81.4 7.9 0 19.8-2.3 27-4.6l1.3-.4a128.3 128.3 0 0 0 66.6-52.8 4 4 0 0 0-5.3-5.6Z" transform="translate(-4.6 -5)" style="isolation:isolate;opacity:.35;fill:url('#b')"/><path d="M110.3 246.3A79.2 79.2 0 0 1 87.6 225a80.7 80.7 0 0 1 29.5-120c3.2-1.5 8.5-4.1 15.6-4a32.4 32.4 0 0 1 25.7 13 31.9 31.9 0 0 1 6.3 18.7c0-.2 24.5-79.6-80-79.6-43.9 0-80 41.6-80 78.2a130.2 130.2 0 0 0 12.1 56 128 128 0 0 0 156.4 67 75.5 75.5 0 0 1-62.8-8Z" transform="translate(-4.6 -5)" style="fill:url('#c')"/><path d="M110.3 246.3A79.2 79.2 0 0 1 87.6 225a80.7 80.7 0 0 1 29.5-120c3.2-1.5 8.5-4.1 15.6-4a32.4 32.4 0 0 1 25.7 13 31.9 31.9 0 0 1 6.3 18.7c0-.2 24.5-79.6-80-79.6-43.9 0-80 41.6-80 78.2a130.2 130.2 0 0 0 12.1 56 128 128 0 0 0 156.4 67 75.5 75.5 0 0 1-62.8-8Z" transform="translate(-4.6 -5)" style="opacity:.41;fill:url('#d');isolation:isolate"/><path d="M157 153.8c-.9 1-3.4 2.5-3.4 5.6 0 2.6 1.7 5.2 4.8 7.3 14.3 10 41.4 8.6 41.5 8.6a59.6 59.6 0 0 0 30.3-8.3 61.4 61.4 0 0 0 30.4-52.9c.3-22.4-8-37.3-11.3-43.9C228 28.8 182.3 5 132.6 5a128 128 0 0 0-128 126.2c.5-36.5 36.8-66 80-66 3.5 0 23.5.3 42 10a72.6 72.6 0 0 1 30.9 29.3c6.1 10.6 7.2 24.1 7.2 29.5s-2.7 13.3-7.8 19.9Z" transform="translate(-4.6 -5)" style="fill:url('#e')"/><path d="M157 153.8c-.9 1-3.4 2.5-3.4 5.6 0 2.6 1.7 5.2 4.8 7.3 14.3 10 41.4 8.6 41.5 8.6a59.6 59.6 0 0 0 30.3-8.3 61.4 61.4 0 0 0 30.4-52.9c.3-22.4-8-37.3-11.3-43.9C228 28.8 182.3 5 132.6 5a128 128 0 0 0-128 126.2c.5-36.5 36.8-66 80-66 3.5 0 23.5.3 42 10a72.6 72.6 0 0 1 30.9 29.3c6.1 10.6 7.2 24.1 7.2 29.5s-2.7 13.3-7.8 19.9Z" transform="translate(-4.6 -5)" style="fill:url('#f')"/></svg>`;
const firefoxLogo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><radialGradient id="g" cx="210%" cy="-100%" r="290%"><stop offset=".1" stop-color="#ffe226"/><stop offset=".79" stop-color="#ff7139"/></radialGradient><radialGradient id="c" cx="49%" cy="40%" r="128%" gradientTransform="matrix(.82 0 0 1 .088 0)"><stop offset=".3" stop-color="#960e18"/><stop offset=".35" stop-color="#b11927" stop-opacity=".74"/><stop offset=".43" stop-color="#db293d" stop-opacity=".34"/><stop offset=".5" stop-color="#f5334b" stop-opacity=".09"/><stop offset=".53" stop-color="#ff3750" stop-opacity="0"/></radialGradient><radialGradient id="d" cx="48%" cy="-12%" r="140%"><stop offset=".13" stop-color="#fff44f"/><stop offset=".53" stop-color="#ff980e"/></radialGradient><radialGradient id="e" cx="22.76%" cy="110.11%" r="100%"><stop offset=".35" stop-color="#3a8ee6"/><stop offset=".67" stop-color="#9059ff"/><stop offset="1" stop-color="#c139e6"/></radialGradient><radialGradient id="f" cx="52%" cy="33%" r="59%" gradientTransform="scale(.9 1)"><stop offset=".21" stop-color="#9059ff" stop-opacity="0"/><stop offset=".97" stop-color="#6e008b" stop-opacity=".6"/></radialGradient><radialGradient id="b" cx="87.4%" cy="-12.9%" r="128%" gradientTransform="matrix(.8 0 0 1 .178 .129)"><stop offset=".13" stop-color="#ffbd4f"/><stop offset=".28" stop-color="#ff980e"/><stop offset=".47" stop-color="#ff3750"/><stop offset=".78" stop-color="#eb0878"/><stop offset=".86" stop-color="#e50080"/></radialGradient><radialGradient id="h" cx="84%" cy="-41%" r="180%"><stop offset=".11" stop-color="#fff44f"/><stop offset=".46" stop-color="#ff980e"/><stop offset=".72" stop-color="#ff3647"/><stop offset=".9" stop-color="#e31587"/></radialGradient><radialGradient id="i" cx="16.1%" cy="-18.6%" r="348.8%" gradientTransform="scale(1 .47) rotate(84 .279 -.297)"><stop offset="0" stop-color="#fff44f"/><stop offset=".3" stop-color="#ff980e"/><stop offset=".57" stop-color="#ff3647"/><stop offset=".74" stop-color="#e31587"/></radialGradient><radialGradient id="j" cx="18.9%" cy="-42.5%" r="238.4%"><stop offset=".14" stop-color="#fff44f"/><stop offset=".48" stop-color="#ff980e"/><stop offset=".66" stop-color="#ff3647"/><stop offset=".9" stop-color="#e31587"/></radialGradient><radialGradient id="k" cx="159.3%" cy="-44.72%" r="313.1%"><stop offset=".09" stop-color="#fff44f"/><stop offset=".63" stop-color="#ff980e"/></radialGradient><linearGradient id="a" x1="87.25%" y1="15.5%" x2="9.4%" y2="93.1%"><stop offset=".05" stop-color="#fff44f"/><stop offset=".37" stop-color="#ff980e"/><stop offset=".53" stop-color="#ff3647"/><stop offset=".7" stop-color="#e31587"/></linearGradient><linearGradient id="l" x1="80%" y1="14%" x2="18%" y2="84%"><stop offset=".17" stop-color="#fff44f" stop-opacity=".8"/><stop offset=".6" stop-color="#fff44f" stop-opacity="0"/></linearGradient></defs><path d="M478.711 166.353c-10.445-25.124-31.6-52.248-48.212-60.821 13.52 26.505 21.345 53.093 24.335 72.936 0 .039.015.136.047.4C427.706 111.135 381.627 83.823 344 24.355c-1.9-3.007-3.805-6.022-5.661-9.2a73.716 73.716 0 01-2.646-4.972A43.7 43.7 0 01332.1.677a.626.626 0 00-.546-.644.818.818 0 00-.451 0c-.034.012-.084.051-.12.065-.053.021-.12.069-.176.1.027-.036.083-.117.1-.136-60.37 35.356-80.85 100.761-82.732 133.484a120.249 120.249 0 00-66.142 25.488 71.355 71.355 0 00-6.225-4.7 111.338 111.338 0 01-.674-58.732c-24.688 11.241-43.89 29.01-57.85 44.7h-.111c-9.527-12.067-8.855-51.873-8.312-60.184-.114-.515-7.107 3.63-8.023 4.255a175.073 175.073 0 00-23.486 20.12 210.478 210.478 0 00-22.442 26.913c0 .012-.007.026-.011.038 0-.013.007-.026.011-.038a202.838 202.838 0 00-32.247 72.805c-.115.521-.212 1.061-.324 1.586-.452 2.116-2.08 12.7-2.365 15-.022.177-.032.347-.053.524a229.066 229.066 0 00-3.9 33.157c0 .41-.025.816-.025 1.227C16 388.418 123.6 496 256.324 496c118.865 0 217.56-86.288 236.882-199.63.407-3.076.733-6.168 1.092-9.271 4.777-41.21-.53-84.525-15.587-120.746zM201.716 354.447c1.124.537 2.18 1.124 3.334 1.639.048.033.114.07.163.1a126.191 126.191 0 01-3.497-1.739zm55.053-144.93zm198.131-30.59l-.032-.233c.012.085.027.174.04.259z" fill="url('#a')"/><path d="M478.711 166.353c-10.445-25.124-31.6-52.248-48.212-60.821 13.52 26.505 21.345 53.093 24.335 72.936 0-.058.011.048.036.226.012.085.027.174.04.259 22.675 61.47 10.322 123.978-7.479 162.175-27.539 59.1-94.215 119.67-198.576 116.716C136.1 454.651 36.766 370.988 18.223 261.41c-3.379-17.28 0-26.054 1.7-40.084-2.071 10.816-2.86 13.94-3.9 33.157 0 .41-.025.816-.025 1.227C16 388.418 123.6 496 256.324 496c118.865 0 217.56-86.288 236.882-199.63.407-3.076.733-6.168 1.092-9.271 4.777-41.21-.53-84.525-15.587-120.746z" fill="url('#b')"/><path d="M478.711 166.353c-10.445-25.124-31.6-52.248-48.212-60.821 13.52 26.505 21.345 53.093 24.335 72.936 0-.058.011.048.036.226.012.085.027.174.04.259 22.675 61.47 10.322 123.978-7.479 162.175-27.539 59.1-94.215 119.67-198.576 116.716C136.1 454.651 36.766 370.988 18.223 261.41c-3.379-17.28 0-26.054 1.7-40.084-2.071 10.816-2.86 13.94-3.9 33.157 0 .41-.025.816-.025 1.227C16 388.418 123.6 496 256.324 496c118.865 0 217.56-86.288 236.882-199.63.407-3.076.733-6.168 1.092-9.271 4.777-41.21-.53-84.525-15.587-120.746z" fill="url('#c')"/><path d="M361.922 194.6c.524.368 1 .734 1.493 1.1a130.706 130.706 0 00-22.31-29.112C266.4 91.892 321.516 4.626 330.811.194c.027-.036.083-.117.1-.136-60.37 35.356-80.85 100.761-82.732 133.484 2.8-.194 5.592-.429 8.442-.429 45.051 0 84.289 24.77 105.301 61.487z" fill="url('#d')"/><path d="M256.772 209.514c-.393 5.978-21.514 26.593-28.9 26.593-68.339 0-79.432 41.335-79.432 41.335 3.027 34.81 27.261 63.475 56.611 78.643 1.339.692 2.694 1.317 4.05 1.935a132.768 132.768 0 007.059 2.886 106.743 106.743 0 0031.271 6.031c119.78 5.618 142.986-143.194 56.545-186.408 22.137-3.85 45.115 5.053 57.947 14.067-21.012-36.714-60.25-61.484-105.3-61.484-2.85 0-5.641.235-8.442.429a120.249 120.249 0 00-66.142 25.488c3.664 3.1 7.8 7.244 16.514 15.828 16.302 16.067 58.13 32.705 58.219 34.657z" fill="url('#e')"/><path d="M256.772 209.514c-.393 5.978-21.514 26.593-28.9 26.593-68.339 0-79.432 41.335-79.432 41.335 3.027 34.81 27.261 63.475 56.611 78.643 1.339.692 2.694 1.317 4.05 1.935a132.768 132.768 0 007.059 2.886 106.743 106.743 0 0031.271 6.031c119.78 5.618 142.986-143.194 56.545-186.408 22.137-3.85 45.115 5.053 57.947 14.067-21.012-36.714-60.25-61.484-105.3-61.484-2.85 0-5.641.235-8.442.429a120.249 120.249 0 00-66.142 25.488c3.664 3.1 7.8 7.244 16.514 15.828 16.302 16.067 58.13 32.705 58.219 34.657z" fill="url('#f')"/><path d="M170.829 151.036a244.042 244.042 0 014.981 3.3 111.338 111.338 0 01-.674-58.732c-24.688 11.241-43.89 29.01-57.85 44.7 1.155-.033 36.014-.66 53.543 10.732z" fill="url('#g')"/><path d="M18.223 261.41C36.766 370.988 136.1 454.651 248.855 457.844c104.361 2.954 171.037-57.62 198.576-116.716 17.8-38.2 30.154-100.7 7.479-162.175l-.008-.026-.032-.233c-.025-.178-.04-.284-.036-.226 0 .039.015.136.047.4 8.524 55.661-19.79 109.584-64.051 146.044l-.133.313c-86.245 70.223-168.774 42.368-185.484 30.966a144.108 144.108 0 01-3.5-1.743c-50.282-24.029-71.054-69.838-66.6-109.124-42.457 0-56.934-35.809-56.934-35.809s38.119-27.179 88.358-3.541c46.53 21.893 90.228 3.543 90.233 3.541-.089-1.952-41.917-18.59-58.223-34.656-8.713-8.584-12.85-12.723-16.514-15.828a71.355 71.355 0 00-6.225-4.7 282.929 282.929 0 00-4.981-3.3c-17.528-11.392-52.388-10.765-53.543-10.735h-.111c-9.527-12.067-8.855-51.873-8.312-60.184-.114-.515-7.107 3.63-8.023 4.255a175.073 175.073 0 00-23.486 20.12 210.478 210.478 0 00-22.442 26.919c0 .012-.007.026-.011.038 0-.013.007-.026.011-.038a202.838 202.838 0 00-32.247 72.805c-.115.521-8.65 37.842-4.44 57.199z" fill="url('#h')"/><path d="M341.105 166.587a130.706 130.706 0 0122.31 29.112c1.323.994 2.559 1.985 3.608 2.952 54.482 50.2 25.936 121.2 23.807 126.26 44.261-36.46 72.575-90.383 64.051-146.044C427.706 111.135 381.627 83.823 344 24.355c-1.9-3.007-3.805-6.022-5.661-9.2a73.716 73.716 0 01-2.646-4.972A43.7 43.7 0 01332.1.677a.626.626 0 00-.546-.644.818.818 0 00-.451 0c-.034.012-.084.051-.12.065-.053.021-.12.069-.176.1-9.291 4.428-64.407 91.694 10.298 166.389z" fill="url('#i')"/><path d="M367.023 198.651c-1.049-.967-2.285-1.958-3.608-2.952-.489-.368-.969-.734-1.493-1.1-12.832-9.014-35.81-17.917-57.947-14.067 86.441 43.214 63.235 192.026-56.545 186.408a106.743 106.743 0 01-31.271-6.031 134.51 134.51 0 01-7.059-2.886c-1.356-.618-2.711-1.243-4.05-1.935.048.033.114.07.163.1 16.71 11.4 99.239 39.257 185.484-30.966l.133-.313c2.129-5.054 30.675-76.057-23.807-126.258z" fill="url('#j')"/><path d="M148.439 277.443s11.093-41.335 79.432-41.335c7.388 0 28.509-20.615 28.9-26.593s-43.7 18.352-90.233-3.541c-50.239-23.638-88.358 3.541-88.358 3.541s14.477 35.809 56.934 35.809c-4.453 39.286 16.319 85.1 66.6 109.124 1.124.537 2.18 1.124 3.334 1.639-29.348-15.169-53.582-43.834-56.609-78.644z" fill="url('#k')"/><path d="M478.711 166.353c-10.445-25.124-31.6-52.248-48.212-60.821 13.52 26.505 21.345 53.093 24.335 72.936 0 .039.015.136.047.4C427.706 111.135 381.627 83.823 344 24.355c-1.9-3.007-3.805-6.022-5.661-9.2a73.716 73.716 0 01-2.646-4.972A43.7 43.7 0 01332.1.677a.626.626 0 00-.546-.644.818.818 0 00-.451 0c-.034.012-.084.051-.12.065-.053.021-.12.069-.176.1.027-.036.083-.117.1-.136-60.37 35.356-80.85 100.761-82.732 133.484 2.8-.194 5.592-.429 8.442-.429 45.053 0 84.291 24.77 105.3 61.484-12.832-9.014-35.81-17.917-57.947-14.067 86.441 43.214 63.235 192.026-56.545 186.408a106.743 106.743 0 01-31.271-6.031 134.51 134.51 0 01-7.059-2.886c-1.356-.618-2.711-1.243-4.05-1.935.048.033.114.07.163.1a144.108 144.108 0 01-3.5-1.743c1.124.537 2.18 1.124 3.334 1.639-29.35-15.168-53.584-43.833-56.611-78.643 0 0 11.093-41.335 79.432-41.335 7.388 0 28.509-20.615 28.9-26.593-.089-1.952-41.917-18.59-58.223-34.656-8.713-8.584-12.85-12.723-16.514-15.828a71.355 71.355 0 00-6.225-4.7 111.338 111.338 0 01-.674-58.732c-24.688 11.241-43.89 29.01-57.85 44.7h-.111c-9.527-12.067-8.855-51.873-8.312-60.184-.114-.515-7.107 3.63-8.023 4.255a175.073 175.073 0 00-23.486 20.12 210.478 210.478 0 00-22.435 26.916c0 .012-.007.026-.011.038 0-.013.007-.026.011-.038a202.838 202.838 0 00-32.247 72.805c-.115.521-.212 1.061-.324 1.586-.452 2.116-2.486 12.853-2.77 15.156-.022.177.021-.176 0 0a279.565 279.565 0 00-3.544 33.53c0 .41-.025.816-.025 1.227C16 388.418 123.6 496 256.324 496c118.865 0 217.56-86.288 236.882-199.63.407-3.076.733-6.168 1.092-9.271 4.777-41.21-.53-84.525-15.587-120.746zm-23.841 12.341c.012.085.027.174.04.259l-.008-.026-.032-.233z" fill="url('#l')"/></svg>`;
const webkitLogo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 510 552" version="1.1"><defs><linearGradient x1="50%" y1="0%" x2="50%" y2="100%" id="blues"><stop stop-color="#34AADC" offset="0%"/><stop stop-color="#007AFF" offset="100%"/></linearGradient><filter x="-50%" y="-50%" width="200%" height="200%" id="shadow"><feOffset dx="0" dy="5" in="SourceAlpha" result="offset"/><feGaussianBlur stdDeviation="2.5" in="offset" result="blur"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.07 0" in="blur" type="matrix" result="matrix"/><feMerge><feMergeNode in="matrix"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><path d="M 477.861111 306.92819 C 512.046296 333.587507 512.046296 377.446382 477.861111 404.320693 L 317.015432 530.737452 C 282.830247 557.396768 227.169753 557.396768 192.984568 530.737452 L 32.1388889 404.535688 C -2.0462963 377.876371 -2.0462963 334.017496 32.1388889 307.143185 L 192.984568 180.726426 C 227.169753 154.06711 282.830247 154.06711 317.015432 180.726426 L 477.861111 306.92819 Z" fill="rgb(255, 157, 0)" id="base"/><path d="M 193.370239 451.831773 L 31.8122232 324.860059 C 15.5243578 312.097996 6.5 295.009809 6.5 276.840092 C 6.5 258.670375 15.5243578 241.582189 31.8122232 228.820125 L 193.370239 101.632105 C 209.658105 88.8700422 231.668733 81.7319391 255 81.7319391 C 278.331267 81.7319391 300.121789 88.8700422 316.629761 101.632105 L 478.187777 228.603819 C 494.475642 241.365882 503.5 258.454069 503.5 276.623786 C 503.5 294.793503 494.475642 311.881689 478.187777 324.643753 L 316.629761 451.615467 C 300.121789 464.593836 278.331267 471.731939 255 471.731939 C 231.668733 471.731939 209.878211 464.593836 193.370239 451.831773 Z" fill="rgba(0, 0, 0, 0.1)" filter="url('#shadow')" id="mid-shadow"/><path d="M 193.370239 451.831773 L 31.8122232 324.860059 C 15.5243578 312.097996 6.5 295.009809 6.5 276.840092 C 6.5 258.670375 15.5243578 241.582189 31.8122232 228.820125 L 193.370239 101.632105 C 209.658105 88.8700422 231.668733 81.7319391 255 81.7319391 C 278.331267 81.7319391 300.121789 88.8700422 316.629761 101.632105 L 478.187777 228.603819 C 494.475642 241.365882 503.5 258.454069 503.5 276.623786 C 503.5 294.793503 494.475642 311.881689 478.187777 324.643753 L 316.629761 451.615467 C 300.121789 464.593836 278.331267 471.731939 255 471.731939 C 231.668733 471.731939 209.878211 464.593836 193.370239 451.831773 Z" fill="rgb(255, 204, 0)" id="mid"/><path d="M 193.370239 371.831773 L 31.8122232 244.860059 C 15.5243578 232.097996 6.5 215.009809 6.5 196.840092 C 6.5 178.670375 15.5243578 161.582189 31.8122232 148.820125 L 193.370239 21.6321055 C 209.658105 8.87004222 231.668733 1.73193906 255 1.73193906 C 278.331267 1.73193906 300.121789 8.87004222 316.629761 21.6321055 L 478.187777 148.603819 C 494.475642 161.365882 503.5 178.454069 503.5 196.623786 C 503.5 214.793503 494.475642 231.881689 478.187777 244.643753 L 316.629761 371.615467 C 300.121789 384.593836 278.331267 391.731939 255 391.731939 C 231.668733 391.731939 209.878211 384.593836 193.370239 371.831773 Z" fill="rgba(0, 0, 0, 0.1)" filter="url('#shadow')" id="top-shadow"/><path d="M 193.370239 371.831773 L 31.8122232 244.860059 C 15.5243578 232.097996 6.5 215.009809 6.5 196.840092 C 6.5 178.670375 15.5243578 161.582189 31.8122232 148.820125 L 193.370239 21.6321055 C 209.658105 8.87004222 231.668733 1.73193906 255 1.73193906 C 278.331267 1.73193906 300.121789 8.87004222 316.629761 21.6321055 L 478.187777 148.603819 C 494.475642 161.365882 503.5 178.454069 503.5 196.623786 C 503.5 214.793503 494.475642 231.881689 478.187777 244.643753 L 316.629761 371.615467 C 300.121789 384.593836 278.331267 391.731939 255 391.731939 C 231.668733 391.731939 209.878211 384.593836 193.370239 371.831773 Z" fill="url('#blues')" id="top"/><path d="M 255.557796 318.523438 L 255.557796 318.523438 C 338.113251 318.523438 405.03767 263.81823 405.03767 196.335938 C 405.03767 128.853645 338.113251 74.1484375 255.557796 74.1484375 C 173.002341 74.1484375 106.077922 128.853645 106.077922 196.335938 C 106.077922 263.81823 173.002341 318.523438 255.557796 318.523438 L 255.557796 318.523438 Z M 255.557796 331.101563 L 255.557796 331.101563 C 164.503985 331.101563 90.6902879 270.764937 90.6902879 196.335938 C 90.6902879 121.906938 164.503985 61.5703125 255.557796 61.5703125 C 346.611606 61.5703125 420.425304 121.906938 420.425304 196.335938 C 420.425304 270.764937 346.611606 331.101563 255.557796 331.101563 L 255.557796 331.101563 Z" fill="white" id="ring"/><path d="M 266.575605 248.199383 C 274.839361 247.116964 282.893943 244.813421 290.267395 241.288755 L 337.32129 260.629992 L 312.674012 223.705812 C 325.63867 207.004736 325.63867 185.850561 312.674012 169.149485 L 337.32129 132.225305 L 292.974868 150.45365 L 291.700073 169.952942 C 309.829164 185.157289 309.365846 209.169068 290.527893 223.847168 C 285.721068 227.691529 280.20166 230.389527 274.405151 232.306091 L 266.575605 248.199383 Z M 244.579776 144.624146 C 230.931152 146.398682 220.701293 151.565675 220.701293 151.565675 L 173.690288 132.225305 L 198.337566 169.149485 C 185.372907 185.850561 185.372907 207.004736 198.337566 223.705812 L 173.690288 260.629992 L 219.248736 241.90345 L 220.218932 223.640565 C 201.161804 208.480714 201.314025 184.227967 220.529419 169.002319 C 224.999999 165.000001 235.105895 160.762757 236.622498 160.537354 C 236.622497 160.537354 244.579776 144.624146 244.579776 144.624146 Z" fill="rgb(140, 200, 246)" id="rosette"/><path d="M 232.944378 192.304563 L 226.682617 303.302063 L 277.389053 200.3587 L 284.649978 89.5703125 L 232.944378 192.304563 Z M 232.289215 281.968558 L 272.904208 199.563458 L 237.312925 193.069439 L 232.289215 281.968558 Z" fill="white" fill-rule="evenodd" id="needle"/></svg>`;

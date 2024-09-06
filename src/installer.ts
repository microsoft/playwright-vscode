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

import path from 'path';
import fs from 'fs';
import os from 'os';
import * as vscodeTypes from './vscodeTypes';
import { TestModel } from './testModel';

export async function installPlaywright(vscode: vscodeTypes.VSCode) {
  const [workspaceFolder] = vscode.workspace.workspaceFolders || [];
  if (!workspaceFolder) {
    await vscode.window.showErrorMessage('Please open a folder in VS Code to initialize Playwright. Either an empty folder or a folder with an existing package.json.');
    return;
  }
  const options: vscodeTypes.QuickPickItem[] = [];
  options.push({ label: 'Select browsers to install', kind: vscode.QuickPickItemKind.Separator });
  options.push(chromiumItem, firefoxItem, webkitItem);
  options.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  options.push(useJavaScriptItem);
  options.push(addActionItem);
  if (process.platform === 'linux') {
    updateInstallDepsPicked();
    options.push(installDepsItem);
  }
  const result = await vscode.window.showQuickPick(options, {
    title: 'Install Playwright',
    canPickMany: true,
  });
  if (result === undefined)
    return;

  const terminal = vscode.window.createTerminal({
    name: 'Install Playwright',
    cwd: workspaceFolder.uri.fsPath,
    env: process.env,
  });

  terminal.show();

  const args: string[] = [];
  if (result.includes(chromiumItem))
    args.push('--browser=chromium');
  if (result.includes(firefoxItem))
    args.push('--browser=firefox');
  if (result.includes(webkitItem))
    args.push('--browser=webkit');
  if (!result.includes(chromiumItem) && !result.includes(firefoxItem) && !result.includes(webkitItem))
    args.push('--no-browsers');
  if (result.includes(useJavaScriptItem))
    args.push('--lang=js');
  if (result.includes(addActionItem))
    args.push('--gha');
  if (result.includes(installDepsItem))
    args.push('--install-deps');

  terminal.sendText(`npm init playwright@latest --yes ${quote('--')} ${quote('--quiet')} ${args.map(quote).join(' ')}`, true);
}

function quote(s: string): string {
  return `'${s}'`;
}

export async function installBrowsers(vscode: vscodeTypes.VSCode, model: TestModel) {
  const options: vscodeTypes.QuickPickItem[] = [];
  options.push({ label: 'Select browsers to install', kind: vscode.QuickPickItemKind.Separator });
  options.push(chromiumItem, firefoxItem, webkitItem);
  options.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  if (process.platform === 'linux') {
    updateInstallDepsPicked();
    options.push(installDepsItem);
  }
  const result = await vscode.window.showQuickPick(options, {
    title: `Install browsers for Playwright v${model.config.version}:`,
    canPickMany: true,
  });
  if (!result?.length)
    return;

  const terminal = vscode.window.createTerminal({
    name: 'Install Playwright',
    cwd: model.config.workspaceFolder,
    env: process.env,
  });

  terminal.show();

  const args: string[] = [];
  const installCommand = result.includes(installDepsItem) ? 'install --with-deps' : 'install';
  if (result.includes(chromiumItem))
    args.push('chromium');
  if (result.includes(firefoxItem))
    args.push('firefox');
  if (result.includes(webkitItem))
    args.push('webkit');

  if (args.length)
    terminal.sendText(`npx playwright ${installCommand} ${args.join(' ')}`, true);
  else if (result.includes(installDepsItem))
    terminal.sendText(`npx playwright install-deps`, true);
}

const chromiumItem: vscodeTypes.QuickPickItem = {
  label: 'Chromium',
  picked: true,
  description: '— powers Google Chrome, Microsoft Edge, etc\u2026',
};
const firefoxItem: vscodeTypes.QuickPickItem = {
  label: 'Firefox',
  picked: true,
  description: '— powers Mozilla Firefox',
};
const webkitItem: vscodeTypes.QuickPickItem = {
  label: 'WebKit',
  picked: true,
  description: '— powers  Apple Safari',
};
const addActionItem: vscodeTypes.QuickPickItem = {
  label: 'Add GitHub Actions workflow',
  picked: true,
  description: '— adds GitHub Actions recipe'
};
const useJavaScriptItem: vscodeTypes.QuickPickItem = {
  label: 'Use JavaScript',
  picked: false,
  description: '— use JavaScript (TypeScript is the default)'
};
const installDepsItem: vscodeTypes.QuickPickItem = {
  label: 'Install Linux dependencies',
  picked: false,
};

function updateInstallDepsPicked() {
  installDepsItem.picked = process.platform === 'linux' && !fs.existsSync(path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright'));
}

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

export async function installPlaywright(vscode: vscodeTypes.VSCode) {
  const [workspaceFolder] = vscode.workspace.workspaceFolders || [];
  if (!workspaceFolder)
    return;
  const chromium: vscodeTypes.QuickPickItem = {
    label: 'Chromium',
    picked: true,
    description: '— powers Google Chrome, Microsoft Edge, etc\u2026',
  };
  const firefox: vscodeTypes.QuickPickItem = {
    label: 'Firefox',
    picked: true,
    description: '— powers Mozilla Firefox',
  };
  const webkit: vscodeTypes.QuickPickItem = {
    label: 'WebKit',
    picked: true,
    description: '— powers  Apple Safari',
  };
  const addAction: vscodeTypes.QuickPickItem = {
    label: 'Add GitHub Actions workflow',
    picked: true,
    description: '— adds GitHub Actions recipe'
  };
  const installDepsAction: vscodeTypes.QuickPickItem = {
    label: 'Install Linux dependencies',
    picked: process.platform === 'linux' && !fs.existsSync(path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright')),
  };
  const hasQuickPickSeparator = parseFloat(vscode.version) >= 1.64;
  const options: vscodeTypes.QuickPickItem[] = [];
  if (hasQuickPickSeparator)
    options.push({ label: 'Select browsers to install', kind: vscode.QuickPickItemKind.Separator });
  options.push(chromium, firefox, webkit);
  if (hasQuickPickSeparator)
    options.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  options.push(addAction);
  if (process.platform === 'linux')
    options.push(installDepsAction);
  const result = await vscode.window.showQuickPick(options, {
    title: 'Install Playwright',
    canPickMany: true,
  });
  if (!result?.length)
    return;

  const terminal = vscode.window.createTerminal({
    name: 'Install Playwright',
    cwd: workspaceFolder.uri.fsPath,
    env: process.env,
  });

  terminal.show();

  const args: string[] = [];
  if (result.includes(chromium))
    args.push('--browser=chromium');
  if (result.includes(firefox))
    args.push('--browser=firefox');
  if (result.includes(webkit))
    args.push('--browser=webkit');
  if (result.includes(addAction))
    args.push('--gha');
  if (result.includes(installDepsAction))
    args.push('--install-deps');

  terminal.sendText(`npm init --yes playwright@latest -- --quiet ${args.join(' ')}`, true);
}

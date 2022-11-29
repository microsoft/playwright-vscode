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

import { expect, test } from './utils';

test('should toggle settings', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });
  const configuration = vscode.workspace.getConfiguration('playwright');

  expect(configuration.get('reuseBrowser')).toBe(false);
  await vscode.commands.executeCommand('pw.extension.toggle.reuseBrowser');
  expect(configuration.get('reuseBrowser')).toBe(true);
  await vscode.commands.executeCommand('pw.extension.toggle.reuseBrowser');
  expect(configuration.get('reuseBrowser')).toBe(false);
});

test('should toggle setting from webview', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  const configuration = vscode.workspace.getConfiguration('playwright');

  expect(configuration.get('reuseBrowser')).toBe(false);
  await webView.getByLabel('Show browser').click();
  expect(configuration.get('reuseBrowser')).toBe(true);
});

test('should reflect changes to setting', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const configuration = vscode.workspace.getConfiguration('playwright');
  await vscode.commands.executeCommand('pw.extension.toggle.reuseBrowser');
  expect(configuration.get('reuseBrowser')).toBe(true);

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await expect(webView.getByLabel('Show browser')).toBeChecked();
});

test('should open test results', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await webView.getByText('Reveal test output').click();
  expect(vscode.commandLog).toEqual(['testing.showMostRecentOutput']);
});

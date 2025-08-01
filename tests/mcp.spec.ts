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

test('setting visibility depends on browser_connect tool being available', async ({ activate }) => {
  const { vscode } = await activate({ 'playwright.config.js': `module.exports = {}` });
  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await expect(webView.getByLabel('Connect Copilot')).not.toBeVisible();
  const tool = vscode.lm.registerTool('playwright_browser_connect', { invoke: () => ({ content: [] }) });
  await expect(webView.getByLabel('Connect Copilot')).toBeVisible();
  tool.dispose();
  await expect(webView.getByLabel('Connect Copilot')).not.toBeVisible();
});

test('setting is disabled when no playwright was found', async ({ activate }) => {
  const { vscode, workspaceFolder } = await activate({});
  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await webView.getByLabel('Show Browser').setChecked(true);
  vscode.lm.registerTool('playwright_browser_connect', { invoke: () => ({ content: [] }) });
  await expect(webView.getByLabel('Connect Copilot')).toBeDisabled();
  await workspaceFolder.addFile('playwright.config.js', `module.exports = {}`);
  await expect(webView.getByLabel('Connect Copilot')).toBeEnabled();
});

test('setting is disabled when Show Browser is disabled', async ({ activate }) => {
  const { vscode } = await activate({ 'playwright.config.js': `module.exports = {}` });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  vscode.lm.registerTool('playwright_browser_connect', { invoke: () => ({ content: [] }) });
  await webView.getByLabel('Show Browser').setChecked(false);
  await expect(webView.getByLabel('Connect Copilot')).toBeDisabled();
  await webView.getByLabel('Show Browser').setChecked(true);
  await expect(webView.getByLabel('Connect Copilot')).toBeEnabled();
});


test('should eagerly connect', async ({ activate }) => {
  const { vscode } = await activate({ 'playwright.config.js': `module.exports = {}` });
  const webView = vscode.webViews.get('pw.extension.settingsView')!;

  const connect = expect.objectContaining({ connectionString: expect.any(String) });
  const disconnect = { connectionString: undefined };
  const invocations: any[] = [];
  vscode.lm.registerTool('playwright_browser_connect', {
    invoke: ({ input }) => {
      invocations.push(input);
      return { content: [] };
    }
  });
  await webView.getByLabel('Show Browser').check();
  await expect.poll(() => invocations).toEqual([]);

  await webView.getByLabel('Connect Copilot').check();
  await expect.poll(() => invocations).toEqual([connect]);

  await vscode.commands.executeCommand('pw.extension.command.inspect');
  await webView.getByRole('button', { name: 'Close all browsers' }).click();
  await expect.poll(() => invocations, 'after closing reusable browser, we immediately start a new one and connect to it').toEqual([connect, connect]);

  await webView.getByLabel('Connect Copilot').uncheck();
  await expect.poll(() => invocations).toEqual([connect, connect, disconnect]);
});

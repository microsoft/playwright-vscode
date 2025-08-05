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

test('should eagerly connect', async ({ activate }) => {
  const { vscode } = await activate({ 'playwright.config.js': `module.exports = {}` });
  const webView = vscode.webViews.get('pw.extension.settingsView')!;

  const connect = expect.objectContaining({ method: 'vscode', params: { connectionString: expect.any(String), lib: expect.any(String) } });
  const disconnect = { method: 'isolated' };
  const invocations: any[] = [];
  vscode.lm.registerTool('playwright_browser_connect', {
    description: `
    Connect to a browser using one of the available methods:
    - "isolated" - connect to a browser in an isolated environment.
    - "vscode" - connect to vscode.
    `,
    invoke: ({ input }) => {
      invocations.push(input);
      return { content: [] };
    }
  });
  await webView.getByLabel('Show Browser').check();
  await expect.poll(() => invocations).toEqual([]);

  await webView.getByLabel('Connect Copilot').check();
  await expect.poll(() => invocations).toEqual([connect]);

  const playwright = require(invocations[0].params.lib);
  expect(playwright.chromium).toBeDefined();

  await vscode.commands.executeCommand('pw.extension.command.inspect');
  await webView.getByRole('button', { name: 'Close all browsers' }).click();
  await expect.poll(() => invocations, 'after closing reusable browser, we immediately start a new one and connect to it').toEqual([connect, connect]);

  await webView.getByLabel('Connect Copilot').uncheck();
  await expect.poll(() => invocations).toEqual([connect, connect, disconnect]);
});

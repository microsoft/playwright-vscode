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

import { connectToSharedBrowser, expect, test, waitForPage } from './utils';

test.beforeAll(async () => {
  process.env.PW_DEBUG_CONTROLLER_HEADLESS = '1';
});

test('should pick locator', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  const [inputBox] = await Promise.all([
    new Promise<any>(f => vscode.onDidShowInputBox(f)),
    webView.getByText('Pick locator').click(),
  ]);
  expect(inputBox.title).toBe('Pick locator');
  expect(inputBox.value).toBe('');
  expect(inputBox.prompt).toBe('Accept to copy locator into clipboard');

  // It is important that we await for input to be visible to want for the context to be set up.
  const valuePromise = new Promise(f => inputBox.onDidAssignValue(f));
  const browser = await connectToSharedBrowser(vscode);
  const page = await waitForPage(browser);
  await page.locator('body').click();
  const value = await valuePromise;
  expect(value).toBe('locator(\'body\')');
});

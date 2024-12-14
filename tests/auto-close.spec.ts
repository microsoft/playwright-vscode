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

test.beforeEach(async ({ showBrowser }) => {
  test.skip(!showBrowser);
});

test('should reuse browsers', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {}`,
    'test.spec.ts': `
      import { test } from '@playwright/test';
      test('pass', async ({ page }) => {});
    `
  });

  const reusedBrowser = await vscode.extensions[0].reusedBrowserForTest();
  const events: number[] = [];
  reusedBrowser.onPageCountChanged((count: number) => events.push(count));
  await testController.run();
  await expect.poll(() => events).toEqual([1]);
  expect(reusedBrowser._backend).toBeTruthy();
});

test('should auto-close after test', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {}`,
    'test.spec.ts': `
      import { test } from '@playwright/test';
      test('pass', async ({ page }) => { await page.close(); });
    `
  });

  await testController.run();
  const reusedBrowser = await vscode.extensions[0].reusedBrowserForTest();
  await expect.poll(() => !!reusedBrowser._backend).toBeFalsy();
});

test('should auto-close after pick', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  await vscode.commands.executeCommand('pw.extension.command.inspect');

  // It is important that we await for command above to have context for reuse set up.
  const browser = await connectToSharedBrowser(vscode);
  const page = await waitForPage(browser);
  await page.close();

  const reusedBrowser = await vscode.extensions[0].reusedBrowserForTest();
  await expect.poll(() => !!reusedBrowser._backend).toBeFalsy();
});

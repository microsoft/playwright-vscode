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

import { connectToSharedBrowser, enableProjects, expect, test, waitForPage } from './utils';

test.skip(({ showBrowser }) => !showBrowser);

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

test('should be closed with Close Browser button', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'firefox', use: { browserName: 'firefox' } }]  }`,
    'test.spec.ts': `
      import { test } from '@playwright/test';
      test('pass', async ({ page }) => {});
    `
  });
  await enableProjects(vscode, ['chromium', 'firefox']);

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await expect(webView.getByRole('list', { name: 'Browsers' })).toMatchAriaSnapshot(`
    - list:
      - listitem:
        - button "Close Browser" [disabled]
  `);
  const reusedBrowser = await vscode.extensions[0].reusedBrowserForTest();
  await testController.run();
  expect(reusedBrowser._backend).toBeTruthy();
  await expect(webView.getByRole('list', { name: 'Browsers' })).toMatchAriaSnapshot(`
    - list:
      - listitem /chromium/:
        - button "Close Browser"
      - listitem /firefox/:
        - button "Close Browser"
  `);
  await webView.getByRole('listitem', { name: 'chromium' }).getByRole('button', { name: 'Close Browser' }).click();

  await expect(webView.getByRole('list', { name: 'Browsers' })).toMatchAriaSnapshot(`
    - list:
      - /children: equal
      - listitem /firefox/
  `);
  expect(reusedBrowser._backend).toBeTruthy();

  await webView.getByRole('listitem', { name: 'firefox' }).getByRole('button', { name: 'Close Browser' }).click();
  await expect.poll(() => reusedBrowser._backend).toBeFalsy();
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

test('should enact "Show Browser" setting change after test finishes', async ({ activate, createLatch }) => {
  const latch = createLatch();

  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {}`,
    'test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async ({ page }) => {
        await page.setContent('foo');
        ${latch.blockingCode}
      });
    `
  });

  const runPromise = testController.run();

  const reusedBrowser = vscode.extensions[0].reusedBrowserForTest();
  await expect.poll(() => !!reusedBrowser._backend, 'wait until test started').toBeTruthy();

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await webView.getByRole('checkbox', { name: 'Show Browser' }).uncheck();
  await expect.poll(() => !!reusedBrowser._backend, 'contrary to setting change, browser stays open during test run').toBeTruthy();
  latch.open();
  await runPromise;

  await expect.poll(() => !!reusedBrowser._backend, 'after test run, setting change is honored').toBeFalsy();
});
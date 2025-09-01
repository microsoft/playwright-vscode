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

import type { Extension } from '../src/extension';
import { enableProjects, expect, test } from './utils';

test.skip(({ showBrowser }) => !showBrowser);

test('should show list of running browsers', async ({ activate }) => {
  test.slow();

  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests', projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'firefox', use: { browserName: 'firefox' } }]  }`,
    'tests/test-1.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async ({ page }) => {});
    `,
  });
  await expect(vscode).toHaveProjectTree(`
    config: playwright.config.js
    [x] chromium
    [ ] firefox
  `);
  await enableProjects(vscode, ['chromium', 'firefox']);
  await testController.expandTestItems(/.*/);
  await expect(testController).toHaveTestTree(`
    -   tests
      -   test-1.spec.ts
        -   should pass [2:0]
          -   chromium [2:0]
          -   firefox [2:0]
  `);

  const settingsView = vscode.webViews.get('pw.extension.settingsView')!;
  await expect(settingsView.getByRole('list', { name: 'Browsers' })).toMatchAriaSnapshot(`
    - list:
      - listitem:
        - text: No open browsers.
        - button "Pick locator"
        - button "Close Browser" [disabled]
  `);

  await testController.run();
  await expect(settingsView.getByRole('list', { name: 'Browsers' })).toMatchAriaSnapshot(`
    - list:
      - listitem:
        - img
        - text: chromium - about:blank
        - button "Pick locator"
        - button "Close Browser"
      - listitem:
        - img
        - text: firefox - about:blank
        - button "Pick locator"
        - button "Close Browser"
  `);
});

test('should have good fallback for browser list', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const extension = vscode.extensions[0] as Extension;
  extension._reusedBrowser._moderniseForTest = true;

  const settingsView = vscode.webViews.get('pw.extension.settingsView')!;
  await settingsView.getByRole('button', { name: 'Pick locator' }).click();
  await expect(settingsView.getByRole('list', { name: 'Browsers' })).toMatchAriaSnapshot(`
    - list:
      - listitem:
        - img
        - text: chromium
        - button "Pick locator"
        - button "Close Browser"
  `);
});

test('should have good fallback for browser list with non-default project name', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = { projects: [{ name: 'projectOne' }] }`,
  });

  const extension = vscode.extensions[0] as Extension;
  extension._reusedBrowser._moderniseForTest = true;

  const settingsView = vscode.webViews.get('pw.extension.settingsView')!;
  await settingsView.getByRole('button', { name: 'Pick locator' }).click();
  await expect(settingsView.getByRole('list', { name: 'Browsers' })).toMatchAriaSnapshot(`
    - list:
      - listitem:
        - img
        - text: Browser
        - button "Pick locator"
        - button "Close Browser"
  `);
});

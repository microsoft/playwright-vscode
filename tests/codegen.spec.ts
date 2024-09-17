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

test('should generate code', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await webView.getByText('Record new').click();
  await expect.poll(() => vscode.lastWithProgressData).toEqual({ message: 'recording\u2026' });

  const browser = await connectToSharedBrowser(vscode);
  const page = await waitForPage(browser);
  await page.locator('body').click();
  await expect.poll(() => {
    return vscode.window.visibleTextEditors[0]?.edits;
  }).toEqual([{
    from: `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  <selection>// Recording...</selection>
});`,
    range: '[3:2 - 3:17]',
    to: `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  <selection>await page.goto('about:blank');</selection>
});`
  },
  {
    from: `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  <selection>await page.goto('about:blank');</selection>
});`,
    range: '[3:33 - 3:33]',
    to: `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('about:blank');<selection>
  </selection>
});`
  },
  {
    from: `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('about:blank');
  <selection></selection>
});`,
    range: '[4:2 - 4:2]',
    to: `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('about:blank');
  <selection>await page.locator('body').click();</selection>
});`
  }]);
});

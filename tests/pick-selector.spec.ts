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

test('should pick locator', async ({ activate, overridePlaywrightVersion }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const settingsView = vscode.webViews.get('pw.extension.settingsView')!;
  await settingsView.getByText('Pick locator').click();

  const browser = await connectToSharedBrowser(vscode);
  const page = await waitForPage(browser);
  await page.setContent(`
    <h1>Hello</h1>
    <h1>World</h1>
  `);
  await page.locator('h1').first().click();

  const locatorsView = vscode.webViews.get('pw.extension.locatorsView')!;
  await expect(locatorsView.locator('body')).toMatchAriaSnapshot(`
    - text: Locator
    - textbox "Locator": "getByRole('heading', { name: 'Hello' })"
  `);

  if (!overridePlaywrightVersion) {
    await expect(locatorsView.locator('body')).toMatchAriaSnapshot(`
      - text: Locator
      - textbox "Locator": "getByRole('heading', { name: 'Hello' })"
      - text: Aria
      - textbox "Aria": "- heading \\"Hello\\" [level=1]"
    `);
  }
});

test('should highlight locator on edit', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const settingsView = vscode.webViews.get('pw.extension.settingsView')!;
  await settingsView.getByText('Pick locator').click();

  const browser = await connectToSharedBrowser(vscode);
  const page = await waitForPage(browser);
  await page.setContent(`
    <h1>Hello</h1>
    <button>World</button>
  `);
  const box = await page.getByRole('heading', { name: 'Hello' }).boundingBox();

  const locatorsView = vscode.webViews.get('pw.extension.locatorsView')!;
  await locatorsView.getByRole('textbox', { name: 'Locator' }).fill('h1');

  await expect(page.locator('x-pw-highlight')).toBeVisible();
  expect(await page.locator('x-pw-highlight').boundingBox()).toEqual(box);
});

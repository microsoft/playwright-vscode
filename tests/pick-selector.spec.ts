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

import { selectors } from '@playwright/test';
import { connectToSharedBrowser, expect, test, waitForPage, waitForRecorderMode } from './utils';

test('should pick locator and dismiss the toolbar', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const settingsView = vscode.webViews.get('pw.extension.settingsView')!;
  await settingsView.getByText('Pick locator').click();
  await waitForRecorderMode(vscode, 'inspecting');

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

  await expect(locatorsView.locator('body')).toMatchAriaSnapshot(`
    - text: Locator
    - textbox "Locator": "getByRole('heading', { name: 'Hello' })"
    - text: Aria
    - textbox "Aria": "- heading \\"Hello\\" [level=1]"
  `);

  await page.click('x-pw-tool-item.pick-locator');
  await expect(page.locator('x-pw-tool-item.pick-locator')).toBeHidden();
  await waitForRecorderMode(vscode, 'none');
});

test('should highlight locator on edit', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const settingsView = vscode.webViews.get('pw.extension.settingsView')!;
  await settingsView.getByText('Pick locator').click();
  await waitForRecorderMode(vscode, 'inspecting');

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

test('should copy locator to clipboard', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const locatorsView = vscode.webViews.get('pw.extension.locatorsView')!;
  await locatorsView.getByRole('checkbox', { name: 'Copy on pick' }).check();
  await locatorsView.getByRole('button', { name: 'Pick locator' }).first().click();
  await waitForRecorderMode(vscode, 'inspecting');

  const browser = await connectToSharedBrowser(vscode);
  const page = await waitForPage(browser);
  await page.setContent(`
    <h1>Hello</h1>
    <h1>World</h1>
  `);
  await page.locator('h1').first().click();

  await expect.poll(() => vscode.env.clipboard.readText()).toBe(`getByRole('heading', { name: 'Hello' })`);
});

test('should pick locator and use the testIdAttribute from the config', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = { use: { testIdAttribute: 'data-testerid' } }`,
  });

  const settingsView = vscode.webViews.get('pw.extension.settingsView')!;
  await settingsView.getByText('Pick locator').click();

  const browser = await connectToSharedBrowser(vscode);
  // TODO: Get rid of 'selectors.setTestIdAttribute' once launchServer multiclient is stable and migrate to it.
  // This is a workaround for waitForPage which internally uses Browser._newContextForReuse
  // which ends up overriding the testIdAttribute back to 'data-testid'.
  selectors.setTestIdAttribute('data-testerid');
  const page = await waitForPage(browser);
  await page.setContent(`
    <div data-testerid="hello">Hello</div>
  `);
  await page.locator('div').click();

  const locatorsView = vscode.webViews.get('pw.extension.locatorsView')!;
  await expect(locatorsView.locator('body')).toMatchAriaSnapshot(`
    - text: Locator
    - textbox "Locator": "getByTestId('hello')"
  `);
  // TODO: remove as per TODO above.
  selectors.setTestIdAttribute('data-testid');
});

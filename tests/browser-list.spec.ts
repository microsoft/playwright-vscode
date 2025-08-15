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
import { expect, test } from './utils';

test('should have good fallback for browser list', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const extension = vscode.extensions[0] as Extension;
  extension._browserList._moderniseForTest = true;

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
  extension._browserList._moderniseForTest = true;

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

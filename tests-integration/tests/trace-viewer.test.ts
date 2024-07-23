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

import { test, expect } from './baseTest';

test.use({ playwrightVersion: 'next' });

test('should show tracer when test runs', async ({ workbox, getWebview }) => {
  await workbox.getByRole('tab', { name: 'Testing' }).click();

  const settingsView = await getWebview(workbox.locator('.pane', { has: workbox.getByLabel('Playwright Section') }));
  await settingsView.getByLabel('Show trace viewer').check();
  await settingsView.getByLabel('Embedded').check();

  const testExplorerPane = workbox.locator('.pane', { has: workbox.getByLabel('Test Explorer Section') });

  const testItems = testExplorerPane.getByRole('treeitem');
  await testItems.filter({ hasText: /tests/ }).locator('.monaco-tl-twistie').click();
  await testItems.filter({ hasText: /spec.ts/ }).locator('.monaco-tl-twistie').click();
  await testItems.filter({ hasText: /has title/ }).hover();
  await testItems.filter({ hasText: /has title/ }).getByLabel('Run Test', { exact: true }).click();

  const editorArea = workbox.getByRole('main');
  await expect(editorArea.getByRole('tab')).toHaveAccessibleName('Trace Viewer');
  const webviewPanel = await getWebview(editorArea);
  const listItem = webviewPanel.frameLocator('iframe').getByTestId('actions-tree').getByRole('listitem');

  await expect(
      listItem,
      'action list'
  ).toHaveText([
    /Before Hooks[\d.]+m?s/,
    /page.goto.*[\d.]+m?s/,
    /expect.toHaveTitle.*[\d.]+m?s/,
    /After Hooks[\d.]+m?s/,
  ]);
});

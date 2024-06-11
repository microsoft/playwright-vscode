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

test('should show embedded setting only when Show trace viewer setting is enabled', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  const configuration = vscode.workspace.getConfiguration('playwright');

  // hidden
  expect(configuration.get('showTrace')).toBe(false);
  await expect(webView.getByLabel('Embedded')).not.toBeVisible();

  // visible
  await webView.getByLabel('Show trace viewer').click();
  await expect(webView.getByLabel('Embedded')).toBeVisible();
  await expect(webView.getByLabel('Embedded')).not.toBeChecked();

  // hidden again
  await webView.getByLabel('Show trace viewer').click();
  await expect(webView.getByLabel('Embedded')).not.toBeVisible();
});

test('should enable "Embedded" and "Show trace viewer" setting on embedTraceViewer command', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const webView = await vscode.webViews.get('pw.extension.settingsView')!;
  const configuration = vscode.workspace.getConfiguration('playwright');

  expect(configuration.get('showTrace')).toBe(false);
  expect(configuration.get('embedTraceViewer')).toBe(false);

  await vscode.commands.executeCommand('pw.extension.toggle.embedTraceViewer');

  expect(configuration.get('showTrace')).toBe(true);
  expect(configuration.get('embedTraceViewer')).toBe(true);
  await expect(webView.getByLabel('Show trace viewer')).toBeVisible();
  await expect(webView.getByLabel('Embedded')).toBeVisible();
});

test('should show tracer when test runs', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await vscode.commands.executeCommand('pw.extension.toggle.embedTraceViewer');

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  const [webview] = await vscode.webViewsByPanelType('playwright.traceviewer.view')!;

  testItems[0].select();
  const listItem = webview.frameLocator('iframe').getByTestId('actions-tree').getByRole('listitem');
  await expect(
      listItem,
      'action list'
  ).toHaveText([
    /Before Hooks[\d.]+m?s/,
    /After Hooks[\d.]+m?s/,
  ]);
  expect(vscode.consoleErrors).toHaveLength(0);
});

test('should switch trace when selected test item changes', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass test 1', ({ page }) => page.setContent('<h1>Test 1</h1>'));
      test('should pass test 2', ({ page }) => page.setContent('<h1>Test 2</h1>'));
    `,
  });

  await vscode.commands.executeCommand('pw.extension.toggle.embedTraceViewer');

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  const [webview] = await vscode.webViewsByPanelType('playwright.traceviewer.view')!;

  testItems[0].select();
  await expect(webview.frameLocator('iframe').frameLocator('iframe.snapshot-visible').locator('h1')).toHaveText('Test 1');

  testItems[1].select();
  await expect(webview.frameLocator('iframe').frameLocator('iframe.snapshot-visible').locator('h1')).toHaveText('Test 2');
});

test('should toggle between dark and light themes', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await vscode.commands.executeCommand('pw.extension.toggle.embedTraceViewer');

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  const configuration = vscode.workspace.getConfiguration('workbench');
  const [webview] = await vscode.webViewsByPanelType('playwright.traceviewer.view')!;

  testItems[0].select();

  await expect(webview.frameLocator('iframe').locator('body')).toHaveClass('dark-mode');

  await configuration.update('colorTheme', 'Light Modern',true);
  await expect(webview.frameLocator('iframe').locator('body')).toHaveClass('light-mode');

  await configuration.update('colorTheme', 'Dark Modern', true);
  await expect(webview.frameLocator('iframe').locator('body')).toHaveClass('dark-mode');
});

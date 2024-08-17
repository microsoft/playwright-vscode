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

import { enableConfigs, expect, test, selectTestItem, traceViewerInfo, selectConfig } from './utils';

test.skip(({ showTrace, overridePlaywrightVersion }) => !!overridePlaywrightVersion || showTrace !== 'embedded');

test('should show tracer when test runs', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  const webView = vscode.webViews.get('pw.extension.embeddedTraceViewerView')!;
  const listItem = webView.frameLocator('iframe').getByTestId('actions-tree').getByRole('listitem');
  await expect(
      listItem,
      'action list'
  ).toHaveText([
    /Before Hooks[\d.]+m?s/,
    /After Hooks[\d.]+m?s/,
  ]);
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

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  const webView = vscode.webViews.get('pw.extension.embeddedTraceViewerView')!;

  selectTestItem(testItems[0]);
  await expect(webView.frameLocator('iframe').frameLocator('iframe.snapshot-visible').locator('h1')).toHaveText('Test 1');

  selectTestItem(testItems[1]);
  await expect(webView.frameLocator('iframe').frameLocator('iframe.snapshot-visible').locator('h1')).toHaveText('Test 2');
});

test('should toggle between dark and light themes', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  const configuration = vscode.workspace.getConfiguration('workbench');
  const webView = vscode.webViews.get('pw.extension.embeddedTraceViewerView')!;

  await expect(webView.frameLocator('iframe').locator('body')).toHaveClass('dark-mode');

  await configuration.update('colorTheme', 'Light Modern', true);
  await expect(webView.frameLocator('iframe').locator('body')).toHaveClass('light-mode');

  await configuration.update('colorTheme', 'Dark Modern', true);
  await expect(webView.frameLocator('iframe').locator('body')).toHaveClass('dark-mode');
});

test('should show trace viewer if webview is recreated', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const [testItem] = testController.findTestItems(/pass/);
  await testController.run();

  const webView1 = vscode.webViews.get('pw.extension.embeddedTraceViewerView')!;
  await expect(webView1.locator('iframe')).toBeVisible();

  await webView1.close();

  const webView2 = await vscode.ensureWebview('pw.extension.embeddedTraceViewerView');
  selectTestItem(testItem);
  await expect(webView2.locator('iframe')).toBeVisible();
});

test('should open snapshot popout', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', ({ page }) => page.setContent('<h1>Test</h1>'));
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  const webView = vscode.webViews.get('pw.extension.embeddedTraceViewerView')!;
  await webView.frameLocator('iframe').getByTitle('Open snapshot in a new tab').click();

  await expect.poll(() => vscode.openExternalUrls).toHaveLength(1);
  expect(vscode.openExternalUrls[0]).toContain('snapshot.html');
});

test('should not change trace viewer when running tests from different test configs', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright1.config.js': `module.exports = { testDir: 'tests1' }`,
    'playwright2.config.js': `module.exports = { testDir: 'tests2' }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', ({ page }) => page.setContent('<h1>One</h1>'));
      `,
    'tests2/test.spec.ts': `
      import { test } from '@playwright/test';
      test('two', ({ page }) => page.setContent('<h1>Two</h1>'));
      `,
  });

  await enableConfigs(vscode, ['playwright1.config.js', 'playwright2.config.js']);
  await selectConfig(vscode, 'playwright2.config.js');

  {
    await testController.expandTestItems(/test.spec/);
    const testItems = testController.findTestItems(/one/);
    await testController.run(testItems);
    const webView = vscode.webViews.get('pw.extension.embeddedTraceViewerView')!;
    const serverUrlPrefix = new URL(await webView.locator('iframe').getAttribute('src') ?? '').origin;
    expect(await traceViewerInfo(vscode)).toMatchObject({
      type: 'embedded',
      serverUrlPrefix,
      testConfigFile: expect.stringMatching('playwright2.config.js'),
    });
  }

  {
    await testController.expandTestItems(/test.spec/);
    const testItems = testController.findTestItems(/two/);
    await testController.run(testItems);
    const webView = vscode.webViews.get('pw.extension.embeddedTraceViewerView')!;
    const serverUrlPrefix = new URL(await webView.locator('iframe').getAttribute('src') ?? '').origin;
    expect(await traceViewerInfo(vscode)).toMatchObject({
      type: 'embedded',
      serverUrlPrefix,
      testConfigFile: expect.stringMatching('playwright2.config.js'),
    });
  }
});

test('should reset trace viewer when selected test config is disabled', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright1.config.js': `module.exports = { testDir: 'tests1' }`,
    'playwright2.config.js': `module.exports = { testDir: 'tests2' }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', () => {});
      `,
    'tests2/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', () => {});
      `,
  });

  await enableConfigs(vscode, ['playwright1.config.js', 'playwright2.config.js']);
  await selectConfig(vscode, 'playwright1.config.js');

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/one/);
  await testController.run(testItems);

  selectTestItem(testItems[0]);
  expect(await traceViewerInfo(vscode)).toMatchObject({
    type: 'embedded',
    testConfigFile: expect.stringMatching('playwright1.config.js'),
  });

  // disables playwright1.config.js
  await enableConfigs(vscode, ['playwright2.config.js']);
  expect.poll(() => traceViewerInfo(vscode)).toBeUndefined();
});

test('should switch to spawn trace viewer if embedded is disabled and test item is selected', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({ type: 'embedded' });

  const configuration = vscode.workspace.getConfiguration('playwright');
  configuration.update('embeddedTraceViewer', false, true);
  selectTestItem(testItems[0]);

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({ type: 'spawn' });
});

test('should switch to spawn trace viewer if embedded is disabled and tests are ran again', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await testController.run();

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({ type: 'embedded' });

  const configuration = vscode.workspace.getConfiguration('playwright');
  configuration.update('embeddedTraceViewer', false, true);

  await testController.run();

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({ type: 'spawn' });
});

test('should restore webview state when moving', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);

  await testController.run();

  selectTestItem(testItems[0]);

  const webView = vscode.webViews.get('pw.extension.embeddedTraceViewerView')!;
  await vscode.changeVisibility(webView, 'hidden');

  await expect(webView).toHaveURL(/hidden/);

  await vscode.changeVisibility(webView, 'visible');

  const listItem = webView.frameLocator('iframe').getByTestId('actions-tree').getByRole('listitem');
  await expect(
      listItem,
      'action list'
  ).toHaveText([
    /Before Hooks[\d.]+m?s/,
    /After Hooks[\d.]+m?s/,
  ]);
});

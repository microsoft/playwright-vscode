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

import { enableConfigs, expect, test, selectTestItem, traceViewerInfo, selectConfig, singleWebViewByPanelType } from './utils';

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

  const webview = await singleWebViewByPanelType(vscode, 'playwright.traceviewer.view')!;

  const listItem = webview.frameLocator('iframe').getByTestId('actions-tree').getByRole('listitem');
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

  const webview = await singleWebViewByPanelType(vscode, 'playwright.traceviewer.view')!;

  selectTestItem(testItems[0]);
  await expect(webview.frameLocator('iframe').frameLocator('iframe.snapshot-visible').locator('h1')).toHaveText('Test 1');

  selectTestItem(testItems[1]);
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

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  const configuration = vscode.workspace.getConfiguration('workbench');
  const webview = await singleWebViewByPanelType(vscode, 'playwright.traceviewer.view')!;

  await expect(webview.frameLocator('iframe').locator('body')).toHaveClass('dark-mode');

  await configuration.update('colorTheme', 'Light Modern', true);
  await expect(webview.frameLocator('iframe').locator('body')).toHaveClass('light-mode');

  await configuration.update('colorTheme', 'Dark Modern', true);
  await expect(webview.frameLocator('iframe').locator('body')).toHaveClass('dark-mode');
});

test('should reopen trace viewer if closed', async ({ activate }) => {
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

  const webview = await singleWebViewByPanelType(vscode, 'playwright.traceviewer.view')!;
  await expect(webview.locator('iframe')).toBeVisible();

  await webview.close();
  await expect.poll(() => vscode.webViewsByPanelType('playwright.traceviewer.view')).toHaveLength(0);

  selectTestItem(testItems[0]);
  await expect.poll(() => vscode.webViewsByPanelType('playwright.traceviewer.view')).toHaveLength(1);
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

  const webview = await singleWebViewByPanelType(vscode, 'playwright.traceviewer.view')!;
  await webview.frameLocator('iframe').getByTitle('Open snapshot in a new tab').click();

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
    const webview = await singleWebViewByPanelType(vscode, 'playwright.traceviewer.view')!;
    const serverUrlPrefix = new URL(await webview.locator('iframe').getAttribute('src') ?? '').origin;
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
    const webview = await singleWebViewByPanelType(vscode, 'playwright.traceviewer.view')!;
    const serverUrlPrefix = new URL(await webview.locator('iframe').getAttribute('src') ?? '').origin;
    expect(await traceViewerInfo(vscode)).toMatchObject({
      type: 'embedded',
      serverUrlPrefix,
      testConfigFile: expect.stringMatching('playwright2.config.js'),
    });
  }
});

test('should close trace viewer when selected test config is disabled', async ({ activate }) => {
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

  const webview = await singleWebViewByPanelType(vscode, 'playwright.traceviewer.view')!;
  const serverUrlPrefix = new URL(await webview.locator('iframe').getAttribute('src') ?? '').origin;

  selectTestItem(testItems[0]);
  expect(await traceViewerInfo(vscode)).toMatchObject({
    type: 'embedded',
    serverUrlPrefix,
    testConfigFile: expect.stringMatching('playwright1.config.js'),
  });

  // disables playwright1.config.js
  await enableConfigs(vscode, ['playwright2.config.js']);
  // config should close trace viewer
  await expect.poll(() => vscode.webViewsByPanelType('playwright.traceviewer.view')).toHaveLength(0);
  expect.poll(() => traceViewerInfo(vscode)).toBeUndefined();
});

test('should reopen trace viewer when another test config is selected', async ({ activate }) => {
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

  const webview1 = await singleWebViewByPanelType(vscode, 'playwright.traceviewer.view')!;
  expect(await traceViewerInfo(vscode)).toMatchObject({
    type: 'embedded',
    serverUrlPrefix: new URL(await webview1.locator('iframe').getAttribute('src') ?? '').origin,
    testConfigFile: expect.stringMatching('playwright1.config.js'),
  });

  await selectConfig(vscode, 'playwright2.config.js');
  selectTestItem(testItems[0]);
  await webview1.waitForEvent('close');

  const webview2 = await singleWebViewByPanelType(vscode, 'playwright.traceviewer.view')!;
  expect(await traceViewerInfo(vscode)).toMatchObject({
    type: 'embedded',
    serverUrlPrefix: new URL(await webview2.locator('iframe').getAttribute('src') ?? '').origin,
    testConfigFile: expect.stringMatching('playwright2.config.js'),
  });
});

test('should not open trace viewer if selected test item did not run', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);

  selectTestItem(testItems[0]);

  // wait to ensure no async webview is opened
  await new Promise(f => setTimeout(f, 1000));
  await expect.poll(() => vscode.webViewsByPanelType('playwright.traceviewer.view')).toHaveLength(0);
  expect(vscode.warnings).toHaveLength(0);
});

test('should fallback to spawn trace viewer if embedded not enabled', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  const configuration = vscode.workspace.getConfiguration('playwright');
  configuration.update('embeddedTraceViewer', false, true);

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        - ✅ should pass [2:0]
  `);

  // wait to ensure no async webview is opened
  await new Promise(f => setTimeout(f, 1000));
  await expect.poll(() => vscode.webViewsByPanelType('playwright.traceviewer.view')).toHaveLength(0);
  expect(vscode.warnings).toHaveLength(0);

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({
    type: 'spawn',
    serverUrlPrefix: expect.anything(),
    testConfigFile: expect.stringContaining('playwright.config.js')
  });
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

  const webview = await singleWebViewByPanelType(vscode, 'playwright.traceviewer.view')!;
  await vscode.changeVisibility(webview, 'hidden');

  await expect(webview).toHaveURL(/hidden/);

  await vscode.changeVisibility(webview, 'visible');

  const listItem = webview.frameLocator('iframe').getByTestId('actions-tree').getByRole('listitem');
  await expect(
      listItem,
      'action list'
  ).toHaveText([
    /Before Hooks[\d.]+m?s/,
    /After Hooks[\d.]+m?s/,
  ]);

});

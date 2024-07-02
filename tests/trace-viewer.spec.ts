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

import { enableConfigs, expect, test } from './utils';

test.beforeEach(({ showBrowser, overridePlaywrightVersion }) => {
  test.skip(!!overridePlaywrightVersion || showBrowser);
  // prevents spawn trace viewer process from opening in browser
  process.env.PWTEST_UNDER_TEST = '1';
});

test.use({ showTrace: true, embedTraceViewer: true, envRemoteName: 'ssh-remote' });

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

  const webview = await vscode.singleWebViewByPanelType('playwright.traceviewer.view')!;

  const listItem = webview.frameLocator('iframe').getByTestId('actions-tree').getByRole('listitem');
  await expect(
      listItem,
      'action list'
  ).toHaveText([
    /Before Hooks[\d.]+m?s/,
    /After Hooks[\d.]+m?s/,
  ]);

  // ensure there's no CSP errors
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

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  const webview = await vscode.singleWebViewByPanelType('playwright.traceviewer.view')!;

  testItems[0].selected();
  await expect(webview.frameLocator('iframe').frameLocator('iframe.snapshot-visible').locator('h1')).toHaveText('Test 1');

  testItems[1].selected();
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
  const webview = await vscode.singleWebViewByPanelType('playwright.traceviewer.view')!;

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

  const webview = await vscode.singleWebViewByPanelType('playwright.traceviewer.view')!;
  await expect(webview.locator('iframe')).toBeVisible();

  await webview.close();
  await expect.poll(() => vscode.webViewsByPanelType('playwright.traceviewer.view')).toHaveLength(0);

  testItems[0].selected();
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

  const webview = await vscode.singleWebViewByPanelType('playwright.traceviewer.view')!;
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
  await expect(testController).toHaveTestTree(`
    -   tests1
      -   test.spec.ts
    -   tests2
      -   test.spec.ts
  `);

  let serverUrl1: string;
  let serverUrl2: string;

  {
    await testController.expandTestItems(/test.spec/);
    const testItems = testController.findTestItems(/one/);
    await testController.run(testItems);
    const webview = await vscode.singleWebViewByPanelType('playwright.traceviewer.view')!;
    serverUrl1 = await webview.locator('iframe').getAttribute('src') ?? '';
  }

  {
    await testController.expandTestItems(/test.spec/);
    const testItems = testController.findTestItems(/two/);
    await testController.run(testItems);
    const webview = await vscode.singleWebViewByPanelType('playwright.traceviewer.view')!;
    serverUrl2 = await webview.locator('iframe').getAttribute('src') ?? '';
  }

  expect(serverUrl1).toEqual(serverUrl2);
});

test('should change trace viewer when test config changes', async ({ activate }) => {
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

  let serverUrl1: string;
  let serverUrl2: string;

  await enableConfigs(vscode, ['playwright1.config.js']);
  await expect(testController).toHaveTestTree(`
    -   tests1
      -   test.spec.ts
  `);

  {
    await testController.expandTestItems(/test.spec/);
    const testItems = testController.findTestItems(/one/);
    await testController.run(testItems);

    const webview = await vscode.singleWebViewByPanelType('playwright.traceviewer.view')!;

    testItems[0].selected();
    serverUrl1 = await webview.locator('iframe').getAttribute('src') ?? '';
  }

  await enableConfigs(vscode, ['playwright2.config.js']);
  // changing selected config should close trace viewer
  await expect.poll(() => vscode.webViewsByPanelType('playwright.traceviewer.view')).toHaveLength(0);
  await expect(testController).toHaveTestTree(`
    -   tests2
      -   test.spec.ts
  `);

  {
    await testController.expandTestItems(/test.spec/);
    const testItems = testController.findTestItems(/two/);
    await testController.run(testItems);

    const webview = await vscode.singleWebViewByPanelType('playwright.traceviewer.view')!;

    testItems[0].selected();
    serverUrl2 = await webview.locator('iframe').getAttribute('src') ?? '';
  }

  expect(serverUrl1).not.toEqual(serverUrl2);
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

  testItems[0].selected();

  // wait to ensure no async webview is opened
  await new Promise(f => setTimeout(f, 1000));
  await expect.poll(() => vscode.webViewsByPanelType('playwright.traceviewer.view')).toHaveLength(0);
  expect(vscode.warnings).toHaveLength(0);
});

test('should not open trace viewer if selected test item has no trace', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  const configuration = vscode.workspace.getConfiguration('playwright');
  await configuration.update('showTrace', false, true);

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        - ✅ should pass [2:0]
  `);

  await configuration.update('showTrace', true, true);
  testItems[0].selected();

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
  configuration.update('embedTraceViewer', false, true);

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

  // TODO intercept /Listening on http:\/\/[^:]+:\d+/
});

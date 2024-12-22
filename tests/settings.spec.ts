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

test.beforeEach(async ({ showBrowser }) => {
  test.skip(showBrowser);
});

test('should toggle settings', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });
  const configuration = vscode.workspace.getConfiguration('playwright');

  expect(configuration.get('reuseBrowser')).toBe(false);
  await vscode.commands.executeCommand('pw.extension.toggle.reuseBrowser');
  expect(configuration.get('reuseBrowser')).toBe(true);
  await vscode.commands.executeCommand('pw.extension.toggle.reuseBrowser');
  expect(configuration.get('reuseBrowser')).toBe(false);
});

test('should toggle setting from webview', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  const configuration = vscode.workspace.getConfiguration('playwright');

  expect(configuration.get('reuseBrowser')).toBe(false);
  await webView.getByLabel('Show browser').click();
  expect(configuration.get('reuseBrowser')).toBe(true);
});

test('should select-all/unselect-all', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.ts': `
      import { defineConfig } from '@playwright/test';
      export default defineConfig({
        projects: [
          { name: 'foo', testMatch: 'foo.ts' },
          { name: 'bar', testMatch: 'bar.ts' },
        ]
      });
    `,
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;

  await expect(webView.locator('body')).toMatchAriaSnapshot(`
    - text: PROJECTS
    - button "Select All"
    - checkbox "foo" [checked]
    - checkbox "bar" [checked=false]
  `);

  await webView.getByRole('checkbox', { name: 'bar' }).check();

  await expect(webView.locator('body')).toMatchAriaSnapshot(`
    - button "Unselect All"
    - checkbox "foo" [checked]
    - checkbox "bar" [checked]
  `);

  await webView.getByRole('button', { name: 'Unselect All' }).click();

  await expect(webView.locator('body')).toMatchAriaSnapshot(`
    - button "Select All"
    - checkbox "foo" [checked=false]
    - checkbox "bar" [checked=false]
  `);

  await webView.getByRole('button', { name: 'Select All' }).click();
  await expect(webView.locator('body')).toMatchAriaSnapshot(`
    - button "Unselect All"
    - checkbox "foo" [checked]
    - checkbox "bar" [checked]
  `);
});

test('should reflect changes to setting', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const configuration = vscode.workspace.getConfiguration('playwright');
  await vscode.commands.executeCommand('pw.extension.toggle.reuseBrowser');
  expect(configuration.get('reuseBrowser')).toBe(true);

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await expect(webView.getByLabel('Show browser')).toBeChecked();
});

test('should open test results', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {}`,
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await webView.getByText('Reveal test output').click();
  expect(vscode.commandLog.filter(f => f !== 'testing.getExplorerSelection')).toEqual(['testing.showMostRecentOutput']);
});

test('should support playwright.env', async ({ activate }) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = {}`,
    'example.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {
        console.log('foo=' + process.env.FOO);
        console.log('bar=' + process.env.BAR);
      });
    `,
  }, {
    env: {
      'FOO': 'foo-value',
      'BAR': { prop: 'bar-value' },
    }
  });

  const testItems = testController.findTestItems(/example.spec.ts/);
  expect(testItems.length).toBe(1);

  const testRun = await testController.run(testItems);
  const output = testRun.renderLog({ output: true });
  expect(output).toContain(`foo=foo-value`);
  expect(output).toContain(`bar={"prop":"bar-value"}`);
});

test('should reload when playwright.env changes', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {}`,
    'example.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {
        console.log('foo=' + process.env.FOO);
        console.log('bar=' + process.env.BAR);
      });
    `,
  }, {
    env: {
      'FOO': 'foo-value',
      'BAR': { prop: 'bar-value' },
    }
  });

  const configuration = vscode.workspace.getConfiguration('playwright');
  configuration.update('env', {
    'FOO': 'foo-value',
    'BAR': { prop: 'bar-value' },
  }, true);

  // Changes to settings will trigger async update.
  await expect.poll(() => testController.findTestItems(/Loading/)).toHaveLength(1);
  // That will finish.
  await expect.poll(() => testController.findTestItems(/Loading/)).toHaveLength(0);

  const testItems = testController.findTestItems(/example.spec.ts/);
  expect(testItems.length).toBe(1);

  const testRun = await testController.run(testItems);
  const output = testRun.renderLog({ output: true });
  expect(output).toContain(`foo=foo-value`);
  expect(output).toContain(`bar={"prop":"bar-value"}`);
});

test('should sync project enabled state to workspace settings', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.ts': `
      import { defineConfig } from '@playwright/test';
      export default defineConfig({
        projects: [
          { name: 'foo', testMatch: 'foo.ts' },
          { name: 'bar', testMatch: 'bar.ts' },
        ]
      });
    `,
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;

  await expect(webView.locator('body')).toMatchAriaSnapshot(`
    - text: PROJECTS
    - checkbox "foo" [checked]
    - checkbox "bar" [checked=false]
  `);
  await testController.run(testController.findTestItems(/example.spec.ts/));
  expect(vscode.context.workspaceState.get('pw.workspace-settings')).toEqual({
    configs: [
      {
        enabled: true,
        projects: [
          {
            enabled: true,
            name: 'foo',
          },
          {
            enabled: false,
            name: 'bar',
          },
        ],
        relativeConfigFile: 'playwright.config.ts',
        selected: true,
      },
    ],
  });

  await webView.getByRole('checkbox', { name: 'bar' }).check();
  await expect(webView.locator('body')).toMatchAriaSnapshot(`
    - checkbox "foo" [checked]
    - checkbox "bar" [checked]
  `);
  expect(vscode.context.workspaceState.get('pw.workspace-settings')).toEqual(expect.objectContaining({
    configs: [
      expect.objectContaining({
        enabled: true,
        projects: [
          expect.objectContaining({ name: 'foo', enabled: true }),
          expect.objectContaining({ name: 'bar', enabled: true }),
        ]
      })
    ]
  }));
});

test('should read project enabled state from workspace settings', async ({ vscode, activate }) => {
  vscode.context.workspaceState.update('pw.workspace-settings', {
    configs: [
      {
        relativeConfigFile: 'playwright.config.ts',
        selected: true,
        enabled: true,
        projects: [
          { name: 'foo', enabled: true },
          { name: 'bar', enabled: false }
        ]
      }
    ]
  });

  await activate({
    'playwright.config.ts': `
      import { defineConfig } from '@playwright/test';
      export default defineConfig({
        projects: [
          { name: 'foo', testMatch: 'foo.ts' },
          { name: 'bar', testMatch: 'bar.ts' },
          { name: 'baz', testMatch: 'baz.ts' },
        ]
      });
    `,
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await expect(webView.locator('body')).toMatchAriaSnapshot(`
    - text: PROJECTS
    - checkbox "foo" [checked]
    - checkbox "bar" [checked=false]
    - checkbox "baz" [checked=false]
  `);
});
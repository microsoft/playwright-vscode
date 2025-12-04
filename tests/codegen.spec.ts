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

import { connectToSharedBrowser, enableProjects, expect, test, waitForPage } from './utils';
import fs from 'node:fs';

test('should generate code', async ({ activate }) => {
  test.slow();

  const globalSetupFile = test.info().outputPath('globalSetup.txt');
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {
      projects: [
        {
          name: 'default',
        },
        {
          name: 'germany',
          use: {
            locale: 'de-DE',
          },
        },
      ],
      globalSetup: './globalSetup.js',
    }`,
    'globalSetup.js': `
      import fs from 'fs';
      module.exports = async () => {
        fs.writeFileSync(${JSON.stringify(globalSetupFile)}, 'global setup was called');
      }
    `,
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await webView.getByRole('checkbox', { name: 'default' }).setChecked(false);
  await webView.getByRole('checkbox', { name: 'germany' }).setChecked(true);
  await webView.getByText('Record new').click();
  await expect.poll(() => vscode.lastWithProgressData, { timeout: 0 }).toEqual({ message: 'recording\u2026' });

  expect(fs.readFileSync(globalSetupFile, 'utf-8')).toBe('global setup was called');

  const browser = await connectToSharedBrowser(vscode);
  const page = await waitForPage(browser, { locale: 'de-DE' });
  await page.locator('body').click();
  expect(await page.evaluate(() => navigator.language)).toBe('de-DE');
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
  <selection>await page.locator('body').click();</selection>
});`
  }]);
});

test('running test should stop the recording', async ({ activate, showBrowser }) => {
  test.skip(!showBrowser);

  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {}`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', () => {});
    `,
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await webView.getByText('Record new').click();
  await expect.poll(() => vscode.lastWithProgressData, { timeout: 0 }).toEqual({ message: 'recording\u2026' });

  const testRun = await testController.run();
  await expect(testRun).toHaveOutput('passed');

  await expect.poll(() => vscode.lastWithProgressData, { timeout: 0 }).toEqual('finished');
});

test('Record at Cursor should respect custom testId', async ({ activate, showBrowser }) => {
  test.skip(!showBrowser);

  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      projects: [
        { name: 'main', use: { testIdAttribute: 'data-testerid', testDir: 'tests' } },
        { name: 'unused', use: { testIdAttribute: 'unused', testDir: 'nonExistant' } },
      ]
    };`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async ({ page }) => {
        await page.setContent('<button data-testerid="foo">click me</button>');

      });
    `,
  });

  await enableProjects(vscode, ['main']);

  await testController.expandTestItems(/test.spec/);
  await expect(await testController.run()).toHaveOutput('1 passed');

  await vscode.openEditors('**/test.spec.ts');
  const editor = vscode.window.activeTextEditor;
  expect(editor.document.uri.path).toContain('test.spec.ts');
  editor.selection = new vscode.Selection(4, 0, 4, 0);

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await webView.getByText('Record at cursor').click();
  await expect.poll(() => vscode.lastWithProgressData, { timeout: 0 }).toEqual({ message: 'recording\u2026' });

  const browser = await connectToSharedBrowser(vscode);
  const page = await waitForPage(browser);
  await page.getByRole('button', { name: 'click me' }).click();
  await expect.poll(() => editor.edits).toEqual([
    {
      range: '[4:0 - 4:0]',
      from: `
      import { test } from '@playwright/test';
      test('should pass', async ({ page }) => {
        await page.setContent('<button data-testerid="foo">click me</button>');
<selection></selection>
      });
    `,
      to: `
      import { test } from '@playwright/test';
      test('should pass', async ({ page }) => {
        await page.setContent('<button data-testerid="foo">click me</button>');
<selection>await page.getByTestId('foo').click();</selection>
      });
    `,
    }
  ]);

  vscode.lastWithProgressToken!.cancel();
});

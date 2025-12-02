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

import { TestRun } from './mock/vscode';
import { connectToSharedBrowser, expect, test, waitForPage } from './utils';
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
  <selection>await page.goto('about:blank');</selection>
});`
  },
  {
    from: `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  <selection>await page.goto('about:blank');</selection>
});`,
    range: '[3:33 - 3:33]',
    to: `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('about:blank');<selection>
  </selection>
});`
  },
  {
    from: `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('about:blank');
  <selection></selection>
});`,
    range: '[4:2 - 4:2]',
    to: `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('about:blank');
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

test('record at cursor', async ({ activate, showBrowser }) => {
  test.skip(!showBrowser);
  test.slow();

  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {}`,
    'impl.ts': `
import { test } from '@playwright/test';
test('one', async ({ page }) => {
  await page.setContent('<button>one</button>');

});
test('two', async ({ page }) => {});

    `,
    'tests/test.spec.ts': `
import '../impl';
    `,
    'pom.ts': `
export class ButtonPage {
  constructor(private page) {}
  one() {

  }
}
    `,
  });

  await testController.expandTestItems(/.*/);
  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   one [2:0]
        -   two [6:0]
  `);

  const webView = vscode.webViews.get('pw.extension.settingsView')!;

  await test.step('cursor inside of test', async () => {
    await vscode.openEditors('**/impl.ts');
    const editor = vscode.window.activeTextEditor;
    expect(editor.document.uri.path).toContain('impl.ts');
    editor.selection = new vscode.Selection(4, 0, 4, 0);

    const testRunPromise = new Promise<TestRun>(resolve => testController.onDidCreateTestRun(run => run.onDidEnd(() => resolve(run))));
    await webView.getByText('Record at cursor').click();
    await expect.poll(() => vscode.lastWithProgressData, { timeout: 0 }).toEqual({ message: 'recording\u2026' });
    const testRun = await testRunPromise;
    await expect(testRun).toHaveOutput('1 passed');

    const browser = await connectToSharedBrowser(vscode);
    const page = await waitForPage(browser);
    await page.getByRole('button', { name: 'one' }).click();
    await expect.poll(() => editor.edits).toEqual([
      {
        from: `
import { test } from '@playwright/test';
test('one', async ({ page }) => {
  await page.setContent('<button>one</button>');
<selection></selection>
});
test('two', async ({ page }) => {});

    `,
        range: '[4:0 - 4:0]',
        to: `
import { test } from '@playwright/test';
test('one', async ({ page }) => {
  await page.setContent('<button>one</button>');
<selection>await page.getByRole('button', { name: 'one' }).click();</selection>
});
test('two', async ({ page }) => {});

    `,
      },
    ]);

    vscode.lastWithProgressToken!.cancel();
  });

  await test.step('cursor outside of test', async () => {
    const editor = vscode.window.activeTextEditor;
    editor.selection = new vscode.Selection(7, 0, 7, 0);

    const testRuns: TestRun[] = [];
    testController.onDidCreateTestRun(run => testRuns.push(run));

    await webView.getByText('Record at cursor').click();
    await expect.poll(() => vscode.lastWithProgressData, { timeout: 0 }).toEqual({ message: 'recording\u2026' });

    const browser = await connectToSharedBrowser(vscode);
    const page = await waitForPage(browser);
    await expect(page.getByRole('button', { name: 'one' })).toBeVisible();
    expect(testRuns).toHaveLength(0);
    vscode.lastWithProgressToken!.cancel();
  });

  await test.step('cursor in POM file', async () => {
    await vscode.openEditors('**/pom.ts');
    const editor = vscode.window.activeTextEditor;
    expect(editor.document.uri.path).toContain('pom.ts');
    editor.selection = new vscode.Selection(4, 0, 4, 0);

    const testRuns: TestRun[] = [];
    testController.onDidCreateTestRun(run => testRuns.push(run));

    await webView.getByText('Record at cursor').click();
    await expect.poll(() => vscode.lastWithProgressData, { timeout: 0 }).toEqual({ message: 'recording\u2026' });

    const browser = await connectToSharedBrowser(vscode);
    const page = await waitForPage(browser);
    await page.getByRole('button', { name: 'one' }).click();
    await expect.poll(() => editor.edits).toEqual([
      {
        from: `
export class ButtonPage {
  constructor(private page) {}
  one() {
<selection></selection>
  }
}
    `,
        range: '[4:0 - 4:0]',
        to: `
export class ButtonPage {
  constructor(private page) {}
  one() {
<selection>
  </selection>
  }
}
    `,
      },
      {
        from: `
export class ButtonPage {
  constructor(private page) {}
  one() {

  <selection></selection>
  }
}
    `,
        range: '[5:2 - 5:2]',
        to: `
export class ButtonPage {
  constructor(private page) {}
  one() {

  <selection>await page.getByRole('button', { name: 'one' }).click();</selection>
  }
}
    `,
      },
    ]);
    expect(testRuns).toHaveLength(0);

    vscode.lastWithProgressToken!.cancel();
  });

});
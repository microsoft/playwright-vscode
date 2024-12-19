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

import fs from 'fs';
import { expect, test } from './utils';

test.skip(({ overridePlaywrightVersion }) => !!overridePlaywrightVersion, 'old world doesnt have updateSnapshot');

for (const mode of ['3-way', 'overwrite', 'patch'] as const) {
  test('should update missing snapshots ' + mode, async ({ activate }, testInfo) => {
    const { vscode, testController } = await activate({
      'playwright.config.ts': `
        import { defineConfig } from '@playwright/test';
        export default defineConfig({});
      `,
      'test.spec.ts': `
        import { test, expect } from '@playwright/test';
        test('should pass', async ({ page }) => {
          await page.setContent('<button>Click me</button>');
          await expect(page.locator('body')).toMatchAriaSnapshot('');
        });
      `,
    });

    const webView = vscode.webViews.get('pw.extension.settingsView')!;
    await webView.getByRole('combobox', { name: 'Update method' }).selectOption(mode);
    await webView.getByRole('combobox', { name: 'Update snapshots' }).selectOption('missing');

    await testController.run();

    let expectation;
    if (mode === '3-way') {
      expectation = `<<<<<<< HEAD
          await expect(page.locator('body')).toMatchAriaSnapshot('');
=======
          await expect(page.locator('body')).toMatchAriaSnapshot(\`
            - button "Click me"
          \`);
>>>>>>> SNAPSHOT`;
    } else if (mode === 'overwrite') {
      expectation = `
          await page.setContent('<button>Click me</button>');
          await expect(page.locator('body')).toMatchAriaSnapshot(\`
            - button "Click me"
          \`);`;
    } else {
      expectation = `
          await page.setContent('<button>Click me</button>');
          await expect(page.locator('body')).toMatchAriaSnapshot('');`;
    }

    await expect.poll(() => {
      return fs.promises.readFile(testInfo.outputPath('test.spec.ts'), 'utf8');
    }).toContain(expectation);
  });
}

for (const mode of ['3-way' , 'overwrite', 'patch'] as const) {
  test('should update all snapshots ' + mode, async ({ activate }, testInfo) => {
    const { vscode, testController } = await activate({
      'playwright.config.ts': `
        import { defineConfig } from '@playwright/test';
        export default defineConfig({});
      `,
      'test.spec.ts': `
        import { test, expect } from '@playwright/test';
        test('should pass', async ({ page }) => {
          await page.setContent('<button>Click me</button>');
          await expect(page.locator('body')).toMatchAriaSnapshot(\`
            - button
          \`);
        });
      `,
    });

    const webView = vscode.webViews.get('pw.extension.settingsView')!;
    await webView.getByRole('combobox', { name: 'Update method' }).selectOption(mode);
    await webView.getByRole('combobox', { name: 'Update snapshots' }).selectOption('all');

    await testController.run();

    let expectation;
    if (mode === '3-way') {
      expectation = `<<<<<<< HEAD
            - button
=======
            - button "Click me"
>>>>>>> SNAPSHOT`;
    } else if (mode === 'overwrite') {
      expectation = `
          await page.setContent('<button>Click me</button>');
          await expect(page.locator('body')).toMatchAriaSnapshot(\`
            - button "Click me"
          \`);`;
    } else {
      expectation = `
          await expect(page.locator('body')).toMatchAriaSnapshot(\`
            - button
          \`);`;
    }

    await expect.poll(() => {
      return fs.promises.readFile(testInfo.outputPath('test.spec.ts'), 'utf8');
    }).toContain(expectation);
  });
}

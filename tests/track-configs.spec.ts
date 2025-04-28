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

test('should load first config', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({});
  await expect(testController).toHaveTestTree(`
  `);

  await workspaceFolder.addFile('playwright.config.js', `module.exports = { testDir: 'tests' }`);
  await workspaceFolder.addFile('tests/test.spec.ts', `
    import { test } from '@playwright/test';
    test('one', async () => {});
  `);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
  ]);
});

test('should load second config', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright1.config.js': `module.exports = { testDir: 'tests1' }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });
  await expect(testController).toHaveTestTree(`
    -   tests1
      -   test.spec.ts
  `);

  await workspaceFolder.addFile('playwright2.config.js', `module.exports = { testDir: 'tests2' }`);
  await workspaceFolder.addFile('tests2/test.spec.ts', `
    import { test } from '@playwright/test';
    test('one', async () => {});
  `);

  await enableConfigs(vscode, ['playwright1.config.js', 'playwright2.config.js']);
  await expect(testController).toHaveTestTree(`
    -   tests1
      -   test.spec.ts
    -   tests2
      -   test.spec.ts
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright1.config.js
    > playwright list-files -c playwright1.config.js
    > playwright list-files -c playwright2.config.js
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'listFiles', params: {} },
    { method: 'listFiles', params: {} },
  ]);
});

test('should remove model for config', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright1.config.js': `module.exports = { testDir: 'tests1' }`,
    'playwright2.config.js': `module.exports = { testDir: 'tests2' }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests2/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  await enableConfigs(vscode, ['playwright1.config.js', 'playwright2.config.js']);

  await expect(testController).toHaveTestTree(`
    -   tests1
      -   test.spec.ts
    -   tests2
      -   test.spec.ts
  `);

  await workspaceFolder.removeFile('playwright1.config.js');

  await expect(testController).toHaveTestTree(`
    -   tests2
      -   test.spec.ts
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright1.config.js
    > playwright list-files -c playwright2.config.js
    > playwright list-files -c playwright2.config.js
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'listFiles', params: {} },
    { method: 'listFiles', params: {} },
  ]);
});


test('should show config loading errors', async ({ vscode, activate }) => {
  await activate({
    'playwright1.config.js': `
      throw new Error('kaboom');
    `,
    'playwright2.config.js': `
      module.exports = { testDir: 'tests' }
    `,
  });
  await enableConfigs(vscode, ['playwright1.config.js', 'playwright2.config.js']);

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await expect(webView.locator('body')).toMatchAriaSnapshot(`
    - text: CONFIGS
    - combobox "Select Playwright Config":
      - option "playwright1.config.js" [selected]
      - option "playwright2.config.js"
    - text: "Config loading errors:"
    - list:
      - listitem:
        - link "Open playwright1.config.js:2"
  `);
  await webView.getByRole('link', { name: 'Open playwright1.config.js:2' }).click();
  await expect.poll(() => vscode.window.activeTextEditor?.document.uri.toString()).toContain('playwright1.config.js');

  await webView.getByRole('combobox', { name: 'Select Playwright Config' }).selectOption('playwright2.config.js');
  await expect(webView.getByText('Unable to load')).not.toBeVisible();
});

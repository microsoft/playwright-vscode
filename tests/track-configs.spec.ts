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

  workspaceFolder.addFile('playwright.config.js', `module.exports = { testDir: 'tests' }`);
  workspaceFolder.addFile('tests/test.spec.ts', `
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

  workspaceFolder.addFile('playwright2.config.js', `module.exports = { testDir: 'tests2' }`);
  workspaceFolder.addFile('tests2/test.spec.ts', `
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

  workspaceFolder.removeFile('playwright1.config.js');

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

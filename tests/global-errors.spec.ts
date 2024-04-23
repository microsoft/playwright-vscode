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

test('should report duplicate test title', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
      test('two', async () => {});
      test('one', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);
  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
  `);
  await expect.poll(() => vscode.languages.getDiagnostics()).toEqual([
    {
      message: 'Error: duplicate test title \"one\", first declared in test.spec.ts:3',
      range: { start: { line: 4, character: 10 }, end: { line: 5, character: 0 } },
      severity: 'Error',
      source: 'playwright',
    }
  ]);
});

test('should report error in global setup (implicit)', async ({ activate, overridePlaywrightVersion }) => {
  test.skip(!overridePlaywrightVersion);
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      testDir: 'tests',
      globalSetup: 'globalSetup.ts',
    }`,
    'globalSetup.ts': `
      import { expect } from '@playwright/test';
      async function globalSetup(config: FullConfig) {
        expect(true).toBe(false);
      }
      export default globalSetup;`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  const testRun = await testController.run();
  expect(testRun.renderLog({ messages: true })).toContain(`
    tests > test.spec.ts
      started
      failed
        globalSetup.ts:[3:21 - 3:21]
        Error: <span style='color:#666;'>expect(</span>`);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [],
        testIds: undefined
      })
    },
  ]);
});

test('should report error in global setup (explicit)', async ({ activate, overridePlaywrightVersion }) => {
  test.skip(!!overridePlaywrightVersion);
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      testDir: 'tests',
      globalSetup: 'globalSetup.ts',
    }`,
    'globalSetup.ts': `
      import { expect } from '@playwright/test';
      async function globalSetup(config: FullConfig) {
        expect(true).toBe(false);
      }
      export default globalSetup;`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  const testRun = await testController.run();
  await expect(testRun).toHaveOutput(/Error: expect\(received\)\.toBe\(expected\)/);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'runGlobalSetup', params: {} },
  ]);
});

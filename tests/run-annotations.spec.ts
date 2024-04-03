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

test('should mark test as skipped', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('pass', async () => {});
      test('skipped', async () => {
        test.skip(true, 'Test skipped');
      });
      test('fixme', async () => {
        test.fixme(true, 'Test to be fixed');
      });
      test('fails', async () => {
        test.fail(true, 'Test should fail');
        expect(1).toBe(2);
      });
    `,
  });

  const testRun = await testController.run();
  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > pass [2:0]
      enqueued
      started
      passed
    tests > test.spec.ts > skipped [3:0]
      enqueued
      started
      skipped
    tests > test.spec.ts > fixme [6:0]
      enqueued
      started
      skipped
    tests > test.spec.ts > fails [9:0]
      enqueued
      started
      passed
  `);

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

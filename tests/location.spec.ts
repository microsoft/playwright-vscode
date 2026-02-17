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

/**
 * Regression test for https://github.com/microsoft/playwright-vscode/issues/38911
 *
 * I noticed that Playwright counts lines starting at 1, but VS Code's Range API
 * uses 0-based line numbers (line 0 is the first line). The range end was still
 * using the raw 1-based value, so every TestItem range stretched one line too far.
 * These tests make sure both start and end are converted correctly.
 */

import { expect, test } from './utils';

test('test item range start and end should both use 0-based line numbers', async ({ activate }) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('first', async () => {});
      test('second', async () => {});
    `,
  });

  await testController.expandTestItems(/test\.spec\.ts/);
  const [first] = testController.findTestItems(/first/);
  const [second] = testController.findTestItems(/second/);

  expect(first, 'first test item should exist').toBeTruthy();
  expect(second, 'second test item should exist').toBeTruthy();

  // start and end should be on the same line - if end is still 1-based it'll be one too high
  expect(first.range!.start.line).toBe(first.range!.end.line);
  expect(second.range!.start.line).toBe(second.range!.end.line);

  // Playwright says 'first' is on line 3 (1-based), so VS Code should see it at line 2 (0-based)
  expect(first.range!.start.line).toBe(2);
  expect(second.range!.start.line).toBe(3);
});

test('nested describe block items should also use fully 0-based ranges', async ({ activate }) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/auth.spec.ts': `
      import { test } from '@playwright/test';
      test.describe('auth', () => {
        test('login', async () => {});
        test('logout', async () => {});
      });
    `,
  });

  await testController.expandTestItems(/auth\.spec\.ts/);
  await testController.expandTestItems(/auth/);
  const [login] = testController.findTestItems(/login/);
  const [logout] = testController.findTestItems(/logout/);

  expect(login, 'login test item should exist').toBeTruthy();
  expect(logout, 'logout test item should exist').toBeTruthy();

  // same check as above - nested tests should also have matching start and end lines
  expect(login.range!.start.line).toBe(login.range!.end.line);
  expect(logout.range!.start.line).toBe(logout.range!.end.line);
});

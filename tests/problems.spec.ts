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

test('should list tests on expand', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async ({ page }) => {
        const
        await page.goto('http://example.com');
      });
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);
  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
  `);
  expect(vscode.diagnosticsCollections.length).toBe(1);
  expect([...vscode.diagnosticsCollections[0]._entries]).toEqual([
    [
      expect.stringContaining('test.spec.ts'),
      [
        {
          message: expect.stringMatching(/^SyntaxError: tests[/\\]test.spec.ts: Unexpected reserved word 'await'. \(5:8\)$/),
          range: {
            end: { character: 0, line: 5 },
            start: { character: 7, line: 4 }
          },
          severity: 'Error',
          source: 'playwright'
        }
      ]
    ]
  ]);
});

test('should update diagnostics on file change', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async ({ page }) => {
        const
        await page.goto('http://example.com');
      });
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);
  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
  `);
  expect(vscode.diagnosticsCollections.length).toBe(1);
  expect([...vscode.diagnosticsCollections[0]._entries]).toEqual([
    [
      expect.stringContaining('test.spec.ts'),
      [
        expect.objectContaining({
          message: expect.stringContaining('SyntaxError'),
          source: 'playwright',
        })
      ]
    ]
  ]);

  await workspaceFolder.changeFile('tests/test.spec.ts', `
    import { test } from '@playwright/test';
    test('one', async ({ page }) => {
      await page.goto('http://example.com');
    });
  `);
  await expect.poll(() => vscode.diagnosticsCollections[0]._entries.size).toBe(0);
});

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

import { expect, test } from '@playwright/test';
import { activate } from './utils';

test.describe.parallel('test tree', () => {

  test('should list tests on expand', async ({}, testInfo) => {
    const { testController } = await activate(testInfo.outputDir, {
      'playwright.config.js': `module.exports = { testDir: 'tests' }`,
      'tests/test.spec.ts': `
        import { test } from '@playwright/test';
        test('one', async () => {});
      `,
    });

    await testController.expandTestItem(/test.spec.ts/);
    expect(testController.renderTestTree()).toBe(`
      - tests
        - test.spec.ts
          - one [2:0]
    `);
  });

  test('should list tests for active editor', async ({}, testInfo) => {
    const { vscode, testController } = await activate(testInfo.outputDir, {
      'playwright.config.js': `module.exports = { testDir: 'tests' }`,
      'tests/test.spec.ts': `
        import { test } from '@playwright/test';
        test('one', async () => {});
      `,
    });

    await vscode.openEditors('**/test.spec.ts');
    await new Promise(f => testController.onDidChangeTestItem(f));

    expect(testController.renderTestTree()).toBe(`
      - tests
        - test.spec.ts
          - one [2:0]
    `);
  });

  test('should list suits', async ({}, testInfo) => {
    const { testController } = await activate(testInfo.outputDir, {
      'playwright.config.js': `module.exports = { testDir: 'tests' }`,
      'tests/test.spec.ts': `
        import { test } from '@playwright/test';
        test('one', async () => {});
        test('two', async () => {});
        test.describe('group 1', () => {
          test('one', async () => {});
          test('two', async () => {});
        });
        test.describe('group 2', () => {
          test.describe('group 2.1', () => {
            test('one', async () => {});
            test('two', async () => {});
          });
          test('one', async () => {});
          test('two', async () => {});
        });
      `,
    });

    await testController.expandTestItem(/test.spec.ts/);
    expect(testController.renderTestTree()).toBe(`
      - tests
        - test.spec.ts
          - one [2:0]
          - two [3:0]
          - group 1 [4:0]
            - one [5:0]
            - two [6:0]
          - group 2 [8:0]
            - group 2.1 [9:0]
              - one [10:0]
              - two [11:0]
            - one [13:0]
            - two [14:0]
    `);
  });

  test('should discover new tests', async ({}, testInfo) => {
    const { testController, workspaceFolder } = await activate(testInfo.outputDir, {
      'playwright.config.js': `module.exports = { testDir: 'tests' }`,
      'tests/test.spec.ts': `
        import { test } from '@playwright/test';
        test('one', async () => {});
      `,
    });

    await testController.expandTestItem(/test.spec.ts/);

    await Promise.all([
      new Promise(f => testController.onDidChangeTestItem(f)),
      workspaceFolder.changeFile('tests/test.spec.ts', `
        import { test } from '@playwright/test';
        test('one', async () => {});
        test('two', async () => {});
      `)
    ]);

    expect(testController.renderTestTree()).toBe(`
      - tests
        - test.spec.ts
          - one [2:0]
          - two [3:0]
    `);
  });
});

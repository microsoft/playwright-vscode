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
import fs from 'fs';

test('should list tests on expand', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);
  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
        - one [2:0]
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
  `);
});

test('should list tests for visible editors', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test1.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests/test2.spec.ts': `
      import { test } from '@playwright/test';
      test('two', async () => {});
    `,
  });

  await vscode.openEditors('**/test*.spec.ts');
  await new Promise(f => testController.onDidChangeTestItem(f));

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test1.spec.ts
        - one [2:0]
      - test2.spec.ts
        - two [2:0]
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test1.spec.ts tests/test2.spec.ts
  `);
});

test('should list suits', async ({ activate }) => {
  const { testController } = await activate({
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

  await testController.expandTestItems(/test.spec.ts/);
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

test('should discover new tests', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
  `);

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

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
    > playwright test -c playwright.config.js --list tests/test.spec.ts
  `);
});

test('should discover new tests with active editor', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test1.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
  `);

  await Promise.all([
    new Promise<void>(f => {
      testController.onDidChangeTestItem(ti => {
        if (ti.label.includes('test2.spec'))
          f();
      });
    }),
    workspaceFolder.addFile('tests/test2.spec.ts', `
      import { test } from '@playwright/test';
      test('two', async () => {});
    `),
    vscode.openEditors('**/test2.spec.ts'),
  ]);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test1.spec.ts
      - test2.spec.ts
        - two [2:0]
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test2.spec.ts
  `);
});

test('should discover tests on add + change', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: './' }`,
  });

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.addFile('test.spec.ts', ``)
  ]);

  expect(testController.renderTestTree()).toBe(`
    - test.spec.ts
  `);

  await testController.expandTestItems(/test.spec.ts/);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.changeFile('test.spec.ts', `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `)
  ]);

  expect(testController.renderTestTree()).toBe(`
    - test.spec.ts
      - one [2:0]
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list test.spec.ts
    > playwright test -c playwright.config.js --list test.spec.ts
  `);
});

test('should discover new test at existing location', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
  `);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.changeFile('tests/test.spec.ts', `
      import { test } from '@playwright/test';
      test('two', async () => {});
    `)
  ]);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
        - two [2:0]
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
    > playwright test -c playwright.config.js --list tests/test.spec.ts
  `);
});

test('should remove deleted tests', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
      test('two', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
  `);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
        - one [2:0]
        - two [3:0]
  `);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.changeFile('tests/test.spec.ts', `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `)
  ]);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
        - one [2:0]
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
    > playwright test -c playwright.config.js --list tests/test.spec.ts
  `);
});

test('should forget tests after error before first test', async ({ activate }) => {
  const { testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
      test('two', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
        - one [2:0]
        - two [3:0]
  `);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.changeFile('tests/test.spec.ts', `
      import { test } from '@playwright/test';
      test('one', async () => {});
      throw new Error('Uncaught');
      test('two', async () => {});
    `)
  ]);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
        - one [2:0]
  `);
});

test('should regain tests after error is fixed', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      throw new Error('Uncaught');
      test('one', async () => {});
      test('two', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
  `);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
  `);

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

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
    > playwright test -c playwright.config.js --list tests/test.spec.ts
  `);
});

test('should support multiple configs', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'tests1/playwright.config.js': `module.exports = { testDir: '.' }`,
    'tests2/playwright.config.js': `module.exports = { testDir: '.' }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests2/test.spec.ts': `
      import { test } from '@playwright/test';
      test('two', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);

  expect(testController.renderTestTree()).toBe(`
    - tests1
      - test.spec.ts
        - one [2:0]
    - tests2
      - test.spec.ts
        - two [2:0]
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    tests1> playwright list-files -c playwright.config.js
    tests2> playwright list-files -c playwright.config.js
    tests1> playwright test -c playwright.config.js --list test.spec.ts
    tests2> playwright test -c playwright.config.js --list test.spec.ts
  `);
});

test('should support multiple projects', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      testDir: './tests',
      projects: [
        { name: 'project 1', testMatch: /test1.spec/ },
        { name: 'project 2', testMatch: /test2.spec/ },
      ]
    }`,
    'tests/test1.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests/test2.spec.ts': `
      import { test } from '@playwright/test';
      test(two', async () => {});
    `,
  });

  await testController.expandTestItems(/test1.spec/);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test1.spec.ts
        - one [2:0]
      - test2.spec.ts
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test1.spec.ts
  `);
});

test('should list parametrized tests', async ({ activate }) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      for (const name of ['one', 'two', 'three'])
        test(name, async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);
  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
        - one [3:0]
        - three [3:0]
        - two [3:0]
  `);
});

test('should not run config reporters', async ({ activate }, testInfo) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = {
      testDir: 'tests',
      reporter: 'html',
    }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);
  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
        - one [2:0]
  `);

  expect(fs.existsSync(testInfo.outputPath('playwright-report'))).toBeFalsy();
});

test('should list tests in multi-folder workspace', async ({ activate }, testInfo) => {
  const { testController } = await activate({}, {
    workspaceFolders: [
      [testInfo.outputPath('folder1'), {
        'playwright.config.js': `module.exports = { testDir: './' }`,
        'test.spec.ts': `
          import { test } from '@playwright/test';
          test('one', async () => {});
        `,
      }],
      [testInfo.outputPath('folder2'), {
        'playwright.config.js': `module.exports = { testDir: './' }`,
        'test.spec.ts': `
          import { test } from '@playwright/test';
          test('two', async () => {});
        `,
      }]
    ]
  });

  await testController.expandTestItems(/test.spec.ts/);
  expect(testController.renderTestTree()).toBe(`
    - folder1
      - test.spec.ts
        - one [2:0]
    - folder2
      - test.spec.ts
        - two [2:0]
  `);
});

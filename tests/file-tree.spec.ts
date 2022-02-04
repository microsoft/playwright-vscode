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

test.describe.configure({ mode: 'parallel' });

test('should list files', async ({}, testInfo) => {
  const { testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });
  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
  `);
});

test('should list files top level if no testDir', async ({}, testInfo) => {
  const { testController } = await activate(testInfo.outputPath('myWorkspace'), {
    'playwright.config.js': `{}`,
    'test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });
  expect(testController.renderTestTree()).toBe(`
    - test.spec.ts
  `);
});

test('should list only test files', async ({}, testInfo) => {
  const { testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'model.ts': `
      export const a = 1;
    `,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });
  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
  `);
});

test('should list folders', async ({}, testInfo) => {
  const { testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/foo/test-a.spec.ts': ``,
    'tests/foo/test-b.spec.ts': ``,
    'tests/bar/test-a.spec.ts': ``,
    'tests/a/b/c/d/test-c.spec.ts': ``,
  });
  expect(testController.renderTestTree()).toBe(`
    - tests
      - a
        - b
          - c
            - d
              - test-c.spec.ts
      - bar
        - test-a.spec.ts
      - foo
        - test-a.spec.ts
        - test-b.spec.ts
  `);
});

test('should pick new files', async ({}, testInfo) => {
  const { workspaceFolder, testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test-1.spec.ts': ``
  });

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test-1.spec.ts
  `);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.addFile('tests/test-2.spec.ts', '')
  ]);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test-1.spec.ts
      - test-2.spec.ts
  `);
});

test('should not pick non-test files', async ({}, testInfo) => {
  const { workspaceFolder, testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test-1.spec.ts': ``
  });

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test-1.spec.ts
  `);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.addFile('tests/model.ts', ''),
    workspaceFolder.addFile('tests/test-2.spec.ts', ''),
  ]);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test-1.spec.ts
      - test-2.spec.ts
  `);
});

test('should pick first file', async ({}, testInfo) => {
  test.fixme(true, 'Upstream issue, playwright list-tests should work even when testDir does not exist');
  const { workspaceFolder, testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
  });

  expect(testController.renderTestTree()).toBe(`
  `);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.addFile('tests/test.spec.ts', '')
  ]);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
  `);
});

test('should remove deleted files', async ({}, testInfo) => {
  const { workspaceFolder, testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test-1.spec.ts': ``,
    'tests/test-2.spec.ts': ``,
    'tests/test-3.spec.ts': ``,
  });

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test-1.spec.ts
      - test-2.spec.ts
      - test-3.spec.ts
  `);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.removeFile('tests/test-2.spec.ts')
  ]);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test-1.spec.ts
      - test-3.spec.ts
  `);
});

test('should do nothing for not loaded changed file', async ({}, testInfo) => {
  const { workspaceFolder, testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test-1.spec.ts': ``,
    'tests/test-2.spec.ts': ``,
    'tests/test-3.spec.ts': ``,
  });

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test-1.spec.ts
      - test-2.spec.ts
      - test-3.spec.ts
  `);

  let changed = false;
  testController.onDidChangeTestItem(() => changed = true);
  await workspaceFolder.changeFile('tests/test-2.spec.ts', '// new content');
  await new Promise(f => setTimeout(f, 2000));
  expect(changed).toBeFalsy();
});

test('should support multiple configs', async ({}, testInfo) => {
  const { testController } = await activate(testInfo.outputDir, {
    'tests1/playwright.config.js': `module.exports = { testDir: '.' }`,
    'tests2/playwright.config.js': `module.exports = { testDir: '.' }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests2/test.spec.ts': `
      import { test } from '@playwright/test';
      test(two', async () => {});
    `,
  });
  expect(testController.renderTestTree()).toBe(`
    - tests1
      - test.spec.ts
    - tests2
      - test.spec.ts
  `);
});

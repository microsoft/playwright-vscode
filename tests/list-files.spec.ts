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
  const { testController, renderExecLog } = await activate(testInfo.outputDir, {
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
  expect(renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
  `);
});

test('should list files top level if no testDir', async ({}, testInfo) => {
  const { testController, renderExecLog } = await activate(testInfo.outputPath('myWorkspace'), {
    'playwright.config.js': `{}`,
    'test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });
  expect(testController.renderTestTree()).toBe(`
    - test.spec.ts
  `);
  expect(renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
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
  const { testController, renderExecLog } = await activate(testInfo.outputDir, {
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
  expect(renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
  `);
});

test('should pick new files', async ({}, testInfo) => {
  const { workspaceFolder, testController, renderExecLog } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test-1.spec.ts': ``
  });

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test-1.spec.ts
  `);

  expect(renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
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

  expect(renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright list-files -c playwright.config.js
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

test('should tolerate missing testDir', async ({}, testInfo) => {
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
  const { workspaceFolder, testController, renderExecLog } = await activate(testInfo.outputDir, {
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

  expect(renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
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

  expect(renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
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
  const { testController, renderExecLog } = await activate(testInfo.outputDir, {
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

  expect(renderExecLog('  ')).toBe(`
    tests1> playwright list-files -c playwright.config.js
    tests2> playwright list-files -c playwright.config.js
  `);
});

test('should support multiple projects', async ({}, testInfo) => {
  const { testController, renderExecLog } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = {
      testDir: './tests',
      projects: [
        { name: 'project 1' },
        { name: 'project 2' },
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
  expect(testController.renderTestTree()).toBe(`
    - tests
      - test1.spec.ts
      - test2.spec.ts
  `);

  expect(renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
  `);
});

test('should support multiple projects with filter', async ({}, testInfo) => {
  const { testController, renderExecLog } = await activate(testInfo.outputDir, {
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
    'tests/test3.spec.ts': `
      import { test } from '@playwright/test';
      test(three', async () => {});
    `,
  });
  expect(testController.renderTestTree()).toBe(`
    - tests
      - test1.spec.ts
      - test2.spec.ts
  `);

  expect(renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
  `);
});

test('should list files in relative folder', async ({}, testInfo) => {
  const { testController, renderExecLog } = await activate(testInfo.outputDir, {
    'foo/bar/playwright.config.js': `module.exports = { testDir: '../../tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });
  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
  `);
  expect(renderExecLog('  ')).toBe(`
    foo/bar> playwright list-files -c playwright.config.js
  `);
});


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

test('should list files', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'build' }`,
    'tests/test.spec.ts': testSpecTs,
    'build/test.spec.js': testSpecJs('test.spec'),
    'build/test.spec.js.map': testSpecJsMap('test.spec'),
  });
  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
  `);
  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
  `);
});

test('should list tests on expand', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'build' }`,
    'tests/test.spec.ts': testSpecTs,
    'build/test.spec.js': testSpecJs('test.spec'),
    'build/test.spec.js.map': testSpecJsMap('test.spec'),
  });

  await testController.expandTestItems(/test.spec.ts/);
  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
        - one [2:0]
        - two [3:0]
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
  `);
});

test('should list tests for visible editors', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'build' }`,
    'tests/test.spec.ts': testSpecTs,
    'build/test.spec.js': testSpecJs('test.spec'),
    'build/test.spec.js.map': testSpecJsMap('test.spec'),
  });

  await vscode.openEditors('**/test.spec.ts');
  await new Promise(f => testController.onDidChangeTestItem(f));

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
        - one [2:0]
        - two [3:0]
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
  `);
});

test('should pick new files', async ({ activate }) => {
  const { vscode, workspaceFolder, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'build' }`,
    'tests/test-1.spec.ts': testSpecTs,
    'build/test-1.spec.js': testSpecJs('test-1.spec'),
    'build/test-1.spec.js.map': testSpecJsMap('test-1.spec'),
  });

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test-1.spec.ts
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
  `);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.addFile('tests/test-2.spec.ts', testSpecTs),
    workspaceFolder.addFile('build/test-2.spec.js', testSpecJs('test-2.spec')),
    workspaceFolder.addFile('build/test-2.spec.js.map', testSpecJsMap('test-2.spec')),
  ]);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test-1.spec.ts
      - test-2.spec.ts
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright list-files -c playwright.config.js
  `);
});

test('should remove deleted files', async ({ activate }) => {
  const { vscode, workspaceFolder, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'build' }`,
    'tests/test-1.spec.ts': testSpecTs,
    'tests/test-2.spec.ts': testSpecTs,
    'tests/test-3.spec.ts': testSpecTs,
    'build/test-1.spec.js': testSpecJs('test-1.spec'),
    'build/test-2.spec.js': testSpecJs('test-2.spec'),
    'build/test-3.spec.js': testSpecJs('test-3.spec'),
    'build/test-1.spec.js.map': testSpecJsMap('test-1.spec'),
    'build/test-2.spec.js.map': testSpecJsMap('test-2.spec'),
    'build/test-3.spec.js.map': testSpecJsMap('test-3.spec'),
  });

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test-1.spec.ts
      - test-2.spec.ts
      - test-3.spec.ts
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
  `);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.removeFile('tests/test-2.spec.ts'),
    workspaceFolder.removeFile('build/test-2.spec.js'),
    workspaceFolder.removeFile('build/test-2.spec.js.map'),
  ]);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test-1.spec.ts
      - test-3.spec.ts
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
  `);
});

test('should discover new tests', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'build' }`,
    'tests/test.spec.ts': testSpecTs,
    'build/test.spec.js': testSpecJs('test.spec'),
    'build/test.spec.js.map': testSpecJsMap('test.spec'),
  });

  await testController.expandTestItems(/test.spec.ts/);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
  `);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.changeFile('tests/test.spec.ts', testSpecTsAfter),
    workspaceFolder.changeFile('build/test.spec.js', testSpecJsAfter),
    workspaceFolder.changeFile('build/test.spec.js.map', testSpecJsMapAfter),
  ]);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
        - new [2:0]
        - one [3:0]
        - two [4:0]
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
    > playwright test -c playwright.config.js --list tests/test.spec.ts
  `);
});

test('should run all tests', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'build' }`,
    'tests/test.spec.ts': testSpecTs,
    'build/test.spec.js': testSpecJs('test.spec'),
    'build/test.spec.js.map': testSpecJsMap('test.spec'),
  });

  const testRun = await testController.run();
  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > one [2:0]
      enqueued
      started
      passed
    tests > test.spec.ts > two [3:0]
      enqueued
      started
      passed
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js
  `);
});

test('should run one test', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'build' }`,
    'tests/test.spec.ts': testSpecTs,
    'build/test.spec.js': testSpecJs('test.spec'),
    'build/test.spec.js.map': testSpecJsMap('test.spec'),
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/one/);
  const testRun = await testController.run(testItems);

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > one [2:0]
      enqueued
      enqueued
      started
      passed
  `);

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
    > playwright test -c playwright.config.js tests/test.spec.ts:3
  `);
});


const testSpecTs = `import { test } from '@playwright/test';

test('one', async ({}) => {});
test('two', async ({}) => {});`;


const testSpecJs = (name: string) => `var import_test = require("@playwright/test");
(0, import_test.test)("one", async ({}) => {
});
(0, import_test.test)("two", async ({}) => {
});
//# sourceMappingURL=${name}.js.map`;


const testSpecJsMap = (name: string) => `{
  "version": 3,
  "sources": ["../tests/${name}.ts"],
  "mappings": "AAAA,kBAAqB;AAErB,sBAAK,OAAO,OAAO,OAAO;AAAA;AAC1B,sBAAK,OAAO,OAAO,OAAO;AAAA;",
  "names": []
}`;


const testSpecTsAfter = `import { test } from '@playwright/test';

test('new', async ({}) => {});
test('one', async ({}) => {});
test('two', async ({}) => {});`;


const testSpecJsAfter = `var import_test = require("@playwright/test");
(0, import_test.test)("new", async ({}) => {
});
(0, import_test.test)("one", async ({}) => {
});
(0, import_test.test)("two", async ({}) => {
});
//# sourceMappingURL=test.spec.js.map`;


const testSpecJsMapAfter = `{
  "version": 3,
  "sources": ["../tests/test.spec.ts"],
  "mappings": "AAAA,kBAAqB;AAErB,sBAAK,OAAO,OAAO,OAAO;AAAA;AAC1B,sBAAK,OAAO,OAAO,OAAO;AAAA;AAC1B,sBAAK,OAAO,OAAO,OAAO;AAAA;",
  "names": []
}`;

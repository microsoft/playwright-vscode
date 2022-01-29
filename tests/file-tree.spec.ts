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
import path from 'path';
import { activate } from './utils';

test.describe.parallel('file tree', () => {
  test('should activate', async ({}, testInfo) => {
    await activate(testInfo.outputDir, {});
  });

  test('should create run & debug profiles', async ({}, testInfo) => {
    const { vscode, testController } = await activate(testInfo.outputPath('workspace'), {
      'playwright.config.js': `module.exports = {}`
    });
    expect(vscode.testControllers).toHaveLength(1);
    expect(testController.runProfiles).toHaveLength(2);
    expect(testController.runProfiles[0]).toEqual({
      isDefault: true,
      kind: 1,
      label: 'workspace' + path.sep + 'playwright.config.js',
    });
    expect(testController.runProfiles[1]).toEqual({
      isDefault: true,
      kind: 2,
      label: 'workspace' + path.sep + 'playwright.config.js',
    });
  });

  test('should create run & debug profile per project', async ({}, testInfo) => {
    const { testController } = await activate(testInfo.outputPath('workspace'), {
      'playwright.config.js': `module.exports = {
        projects: [
          {
            name: 'projectA'
          },
          {
            name: 'projectB'
          },
        ]
      }`
    });
    const profileTitle = 'workspace' + path.sep + 'playwright.config.js';
    expect(testController.runProfiles).toHaveLength(4);
    expect(testController.runProfiles[0]).toEqual({
      isDefault: true,
      kind: 1,
      label: profileTitle + ' [projectA]',
    });
    expect(testController.runProfiles[1]).toEqual({
      isDefault: true,
      kind: 2,
      label: profileTitle + ' [projectA]',
    });
    expect(testController.runProfiles[2]).toEqual({
      isDefault: true,
      kind: 1,
      label: profileTitle + ' [projectB]',
    });
    expect(testController.runProfiles[3]).toEqual({
      isDefault: true,
      kind: 2,
      label: profileTitle + ' [projectB]',
    });
  });

  test('should use workspace name if no testDir', async ({}, testInfo) => {
    const { testController } = await activate(testInfo.outputPath('myWorkspace'), {
      'playwright.config.js': `{}`,
      'test.spec.ts': `
        import { test } from '@playwright/test';
        test('one', async () => {});
      `,
    });
    expect(testController.renderTestTree()).toBe(`
      - myWorkspace
        - test.spec.ts
    `);
  });

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
});

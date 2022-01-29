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

import { test, expect } from '@playwright/test';
import path from 'path';
import { Extension } from '../out/extension';
import { VSCode } from './mock/vscode';

async function activateInWorkspace(rootDir: string, files: { [key: string]: string }) {
  const vscode = new VSCode();
  await vscode.addWorkspace('workspace', rootDir, files);
  const extension = new Extension(vscode);
  const context = { subscriptions: [] };
  await extension.activate(context);
  return { vscode, extension, testController: vscode.testControllers[0] };
}

test('should activate', async ({}, testInfo) => {
  await activateInWorkspace(testInfo.outputDir, {});
});

test('should create run & debug profiles', async ({}, testInfo) => {
  const { vscode, testController } = await activateInWorkspace(testInfo.outputDir, {
    'playwright.config.js': `module.exports = {}`
  });
  expect(vscode.testControllers).toHaveLength(1);
  expect(testController.runProfiles).toHaveLength(2);
  expect(testController.runProfiles[0]).toEqual({
    isDefault: true,
    kind: 1,
    label: 'basic-should-create-run-debug-profiles' + path.sep + 'playwright.config.js',
  });
  expect(testController.runProfiles[1]).toEqual({
    isDefault: true,
    kind: 2,
    label: 'basic-should-create-run-debug-profiles' + path.sep + 'playwright.config.js',
  });
});

test('should create run & debug profile per project', async ({}, testInfo) => {
  const { testController } = await activateInWorkspace(testInfo.outputDir, {
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
  const profileTitle = 'basic-should-create-run-debug-profile-per-project' + path.sep + 'playwright.config.js';
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

test('should list files', async ({}, testInfo) => {
  const { testController } = await activateInWorkspace(testInfo.outputDir, {
    'playwright.config.js': `module.exports = {}`,
    'test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });
  expect(testController.items.items).toHaveLength(1);
  const root = testController.items.items[0];
  expect(root.label).toBe('test-results' + path.sep + 'basic-should-list-files');
  const fileItems = root.children.items;
  expect(fileItems).toHaveLength(1);
  expect(fileItems[0].label).toBe('test.spec.ts');
});

test('should list only test files', async ({}, testInfo) => {
  const { testController } = await activateInWorkspace(testInfo.outputDir, {
    'playwright.config.js': `module.exports = {}`,
    'model.ts': `
      export const a = 1;
    `,
    'test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });
  expect(testController.items.items).toHaveLength(1);
  const root = testController.items.items[0];
  expect(root.label).toBe('test-results' + path.sep + 'basic-should-list-only-test-files');
  const fileItems = root.children.items;
  expect(fileItems).toHaveLength(1);
  expect(fileItems[0].label).toBe('test.spec.ts');
});

test('should list tests', async ({}, testInfo) => {
  const { testController } = await activateInWorkspace(testInfo.outputDir, {
    'playwright.config.js': `module.exports = {}`,
    'test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });
  const root = testController.items.items[0];
  const fileItem = root.children.items[0];
  expect(fileItem.label).toBe('test.spec.ts');
  await fileItem.resolveChildren();
  const tests = fileItem.children.items;
  expect(tests).toHaveLength(1);
  expect(tests[0].label).toBe('one');
});

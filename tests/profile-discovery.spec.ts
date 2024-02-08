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
import path from 'path';

test('should activate', async ({ activate }) => {
  await activate({});
});

test('should create run & debug profiles', async ({ activate }, testInfo) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {}`
  }, { rootDir: testInfo.outputPath('workspace') });
  expect(vscode.testControllers).toHaveLength(1);

  const runProfiles = testController.runProfiles;
  const profileTitle = 'workspace' + path.sep + 'playwright.config.js';
  expect(runProfiles).toHaveLength(2);

  expect(runProfiles[0].label).toBe(profileTitle);
  expect(runProfiles[0].kind).toBe(vscode.TestRunProfileKind.Run);
  expect(runProfiles[0].isDefault).toBeTruthy();

  expect(runProfiles[1].label).toBe(profileTitle);
  expect(runProfiles[1].kind).toBe(vscode.TestRunProfileKind.Debug);
  expect(runProfiles[1].isDefault).toBeTruthy();

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
  `);
});

test('should create run & debug profile per project', async ({ activate }, testInfo) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      projects: [{ name: 'projectA' }, { name: 'projectB' }]
    }`
  }, { rootDir: testInfo.outputPath('workspace') });

  const runProfiles = testController.runProfiles;
  const configPath = 'workspace' + path.sep + 'playwright.config.js';
  expect(runProfiles).toHaveLength(4);

  expect(runProfiles[0].label).toBe('projectA — ' + configPath);
  expect(runProfiles[0].kind).toBe(vscode.TestRunProfileKind.Run);
  expect(runProfiles[0].isDefault).toBeTruthy();

  expect(runProfiles[1].label).toBe('projectA — ' + configPath);
  expect(runProfiles[1].kind).toBe(vscode.TestRunProfileKind.Debug);
  expect(runProfiles[1].isDefault).toBeTruthy();

  expect(runProfiles[2].label).toBe('projectB — ' + configPath);
  expect(runProfiles[2].kind).toBe(vscode.TestRunProfileKind.Run);
  expect(runProfiles[1].isDefault).toBeTruthy();

  expect(runProfiles[3].label).toBe('projectB — ' + configPath);
  expect(runProfiles[3].kind).toBe(vscode.TestRunProfileKind.Debug);
  expect(runProfiles[1].isDefault).toBeTruthy();

  expect(vscode.renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
  `);
});

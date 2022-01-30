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

test.describe.parallel('profile-discovery', () => {

  test('should activate', async ({}, testInfo) => {
    await activate(testInfo.outputDir, {});
  });

  test('should create run & debug profiles', async ({}, testInfo) => {
    const { vscode, testController } = await activate(testInfo.outputPath('workspace'), {
      'playwright.config.js': `module.exports = {}`
    });
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
  });

  test('should create run & debug profile per project', async ({}, testInfo) => {
    const { testController, vscode } = await activate(testInfo.outputPath('workspace'), {
      'playwright.config.js': `module.exports = {
        projects: [{ name: 'projectA' }, { name: 'projectB' }]
      }`
    });

    const runProfiles = testController.runProfiles;
    const profileTitle = 'workspace' + path.sep + 'playwright.config.js';
    expect(runProfiles).toHaveLength(4);

    expect(runProfiles[0].label).toBe(profileTitle + ' [projectA]');
    expect(runProfiles[0].kind).toBe(vscode.TestRunProfileKind.Run);
    expect(runProfiles[0].isDefault).toBeTruthy();

    expect(runProfiles[1].label).toBe(profileTitle + ' [projectA]');
    expect(runProfiles[1].kind).toBe(vscode.TestRunProfileKind.Debug);
    expect(runProfiles[1].isDefault).toBeTruthy();

    expect(runProfiles[2].label).toBe(profileTitle + ' [projectB]');
    expect(runProfiles[2].kind).toBe(vscode.TestRunProfileKind.Run);
    expect(runProfiles[2].isDefault).toBeFalsy();

    expect(runProfiles[3].label).toBe(profileTitle + ' [projectB]');
    expect(runProfiles[3].kind).toBe(vscode.TestRunProfileKind.Debug);
    expect(runProfiles[3].isDefault).toBeFalsy();
  });
});

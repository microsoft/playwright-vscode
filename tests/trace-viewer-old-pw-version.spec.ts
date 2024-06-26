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

import { test, expect } from './utils';

test.use({ overridePlaywrightVersion: 1.44 });

test('should hide embedded in older @playwright/test projects', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await vscode.commands.executeCommand('pw.extension.toggle.embedTraceViewer');
  const configuration = vscode.workspace.getConfiguration('playwright');

  const settingsView = vscode.webViews.get('pw.extension.settingsView')!;
  expect(configuration.get('showTrace')).toBe(true);
  expect(configuration.get('embedTraceViewer')).toBe(true);
  await expect(settingsView.getByLabel('Show trace viewer')).toBeVisible();
  await expect(settingsView.getByLabel('Embedded')).not.toBeVisible();

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  const [webview] = await vscode.webViewsByPanelType('playwright.traceviewer.view');
  expect(webview).toBeUndefined();
});

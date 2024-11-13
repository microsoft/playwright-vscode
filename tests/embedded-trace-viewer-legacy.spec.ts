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

test.skip(({ overridePlaywrightVersion, showTrace }) => !overridePlaywrightVersion || showTrace !== 'embedded');

test('should fallback to spawn trace viewer on legacy projects', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  // ensure embedded trace viewer is enabled
  const configuration = vscode.workspace.getConfiguration('playwright');
  configuration.update('embeddedTraceViewer', true, true);

  await testController.expandTestItems(/test.spec/);
  await testController.run();
  await expect.poll(() => vscode.warnings).toEqual(['Playwright v1.46+ is required for embedded trace viewer to work, v1.43 found']);
});

test('should show warning message again after refreshing test config', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  // ensure embedded trace viewer is enabled
  const configuration = vscode.workspace.getConfiguration('playwright');
  configuration.update('embeddedTraceViewer', true, true);

  await testController.run();
  await expect.poll(() => vscode.warnings).toEqual([
    'Playwright v1.46+ is required for embedded trace viewer to work, v1.43 found'
  ]);

  await testController.refreshHandler!(null);

  await testController.run();

  // ensure it shows the warning again
  await expect.poll(() => vscode.warnings).toEqual([
    'Playwright v1.46+ is required for embedded trace viewer to work, v1.43 found',
    'Playwright v1.46+ is required for embedded trace viewer to work, v1.43 found',
  ]);
});

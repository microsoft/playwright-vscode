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

import { test, expect, traceViewerInfo } from './utils';

test.beforeEach(({ showBrowser, overridePlaywrightVersion }) => {
  test.skip(!overridePlaywrightVersion || showBrowser);
  // prevents spawn trace viewer process from opening in browser
  process.env.PWTEST_UNDER_TEST = '1';
});

test.use({ showTrace: true, embedTraceViewer: true, envRemoteName: 'ssh-remote' });

test('should fallback to spawn trace viewer in older @playwright/test projects', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.run(testItems);

  await expect.poll(() => vscode.warnings).toContain('Playwright v1.46+ is required for embedded trace viewer to work, v1.43 found');

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({
    type: 'spawn',
    serverUrlPrefix: expect.anything(),
    testConfigFile: expect.stringContaining('playwright.config.js')
  });
});

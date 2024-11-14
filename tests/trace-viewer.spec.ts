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

import { enableConfigs, expect, selectConfig, selectTestItem, test, traceViewerInfo } from './utils';

test.skip(({ showTrace }) => !showTrace);
test.skip(({ overridePlaywrightVersion }) => !!overridePlaywrightVersion);

test('@smoke should open trace viewer', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await testController.run();
  await testController.expandTestItems(/test.spec/);
  selectTestItem(testController.findTestItems(/pass/)[0]);

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({
    traceFile: expect.stringContaining('pass'),
  });
});

test('should change opened file in trace viewer', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
      test('two', async () => {});
    `,
  });

  await testController.run();
  await testController.expandTestItems(/test.spec/);

  selectTestItem(testController.findTestItems(/one/)[0]);

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({
    traceFile: expect.stringContaining('one'),
  });

  selectTestItem(testController.findTestItems(/two/)[0]);

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({
    traceFile: expect.stringContaining('two'),
  });
});

test('should not open trace viewer if test did not run', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  selectTestItem(testController.findTestItems(/pass/)[0]);

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({
    traceFile: undefined,
  });
});

test('should refresh trace viewer while test is running', async ({ activate, createLatch }) => {
  const latch = createLatch();

  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => ${latch.blockingCode});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  selectTestItem(testController.findTestItems(/pass/)[0]);

  const testRunPromise = testController.run();
  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({
    traceFile: expect.stringMatching(/\.json$/),
  });

  latch.open();
  await testRunPromise;

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({
    traceFile: expect.stringMatching(/\.zip$/),
  });
});

test('should close trace viewer if test configs refreshed', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await testController.run();
  await testController.expandTestItems(/test.spec/);
  selectTestItem(testController.findTestItems(/pass/)[0]);

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({
    traceFile: expect.stringContaining('pass'),
  });

  await testController.refreshHandler!(null);

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({
    traceFile: undefined,
    visible: false,
  });
});

test('should open new trace viewer when another test config is selected', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright1.config.js': `module.exports = { testDir: 'tests1' }`,
    'playwright2.config.js': `module.exports = { testDir: 'tests2' }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', () => {});
      `,
    'tests2/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', () => {});
      `,
  });

  await enableConfigs(vscode, ['playwright1.config.js', 'playwright2.config.js']);
  await selectConfig(vscode, 'playwright1.config.js');

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/one/);
  await testController.run(testItems);

  selectTestItem(testItems[0]);

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({
    serverUrlPrefix: expect.stringContaining('http'),
    testConfigFile: expect.stringContaining('playwright1.config.js'),
  });
  const serverUrlPrefix1 = traceViewerInfo(vscode);

  // closes opened trace viewer
  await selectConfig(vscode, 'playwright2.config.js');

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({
    traceFile: undefined,
    visible: false,
  });

  // opens trace viewer from selected test config
  selectTestItem(testItems[0]);

  await expect.poll(() => traceViewerInfo(vscode)).toMatchObject({
    serverUrlPrefix: expect.stringContaining('http'),
    testConfigFile: expect.stringContaining('playwright2.config.js'),
  });
  const serverUrlPrefix2 = traceViewerInfo(vscode);

  expect(serverUrlPrefix2).not.toBe(serverUrlPrefix1);
});

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
import { TestRun } from './mock/vscode';
import { activate } from './utils';

test.describe.configure({ mode: 'parallel' });

test('should debug all tests', async ({}, testInfo) => {
  const { testController, renderExecLog } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test-1.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
    'tests/test-2.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('should fail', async () => { expect(1).toBe(2); });
    `,
  });

  const testRun = await testController.debug();
  expect(testRun.renderLog()).toBe(`
    should fail [2:0]
      enqueued
      started
      failed
    should pass [2:0]
      enqueued
      started
      passed
  `);

  expect(renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > debug -c playwright.config.js
  `);
});

test('should debug one test', async ({}, testInfo) => {
  const { testController, renderExecLog } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  const testRun = await testController.debug(testItems);

  expect(testRun.renderLog()).toBe(`
    should pass [2:0]
      enqueued
      enqueued
      started
      passed
  `);

  expect(renderExecLog('  ')).toBe(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list tests/test.spec.ts
    > debug -c playwright.config.js tests/test.spec.ts:3
  `);
});

test('should debug error', async ({}, testInfo) => {
  const { vscode, testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should fail', async () => {
        // Simulate breakpoint via stalling.
        console.log('READY TO BREAK');
        await new Promise(() => {});
      });
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/fail/);

  const profile = testController.runProfiles.find(p => p.kind === vscode.TestRunProfileKind.Debug);
  profile.run(testItems);
  const testRun = await new Promise<TestRun>(f => testController.onDidCreateTestRun(f));

  while (!vscode.debug.output.includes('READY TO BREAK'))
    await new Promise(f => setTimeout(f, 100));

  vscode.debug.simulateStoppedOnError('Error on line 10', { file: testInfo.outputPath('tests/test.spec.ts'), line: 10 });

  expect(testRun.renderLog({ messages: true })).toBe(`
    should fail [2:0]
      enqueued
      enqueued
      started
      failed
        test.spec.ts:[9:-1 - 9:-1]
        Error on line 10
  `);

  testRun.token.cancel();
});

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
import { activate } from './utils';

test.describe.parallel('run tests', () => {

  test('should run all tests', async ({}, testInfo) => {
    const { testController } = await activate(testInfo.outputDir, {
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

    const testRun = await testController.run();
    expect(testRun.renderLog()).toBe(`
      should pass [2:0]
        started
        passed
      should fail [2:0]
        started
        failed
    `);
  });

  test('should run one test', async ({}, testInfo) => {
    const { testController } = await activate(testInfo.outputDir, {
      'playwright.config.js': `module.exports = { testDir: 'tests' }`,
      'tests/test.spec.ts': `
        import { test } from '@playwright/test';
        test('should pass', async () => {});
      `,
    });

    await testController.expandTestItem(/test.spec/);
    const testItem = testController.findTestItem(/pass/);
    const testRun = await testController.run([testItem]);

    // Test was discovered, hence we should see immediate enqueue.
    expect(testRun.renderLog()).toBe(`
      should pass [2:0]
        enqueued
        started
        passed
    `);
  });

  test('should show error message', async ({}, testInfo) => {
    const { testController } = await activate(testInfo.outputDir, {
      'playwright.config.js': `module.exports = { testDir: 'tests' }`,
      'tests/test.spec.ts': `
        import { test, expect } from '@playwright/test';
        test('should fail', async () => {
          expect(1).toBe(2);
        });
      `,
    });

    await testController.expandTestItem(/test.spec/);
    const testItem = testController.findTestItem(/fail/);
    const testRun = await testController.run([testItem]);

    // Test was discovered, hence we should see immediate enqueue.
    expect(testRun.renderLog({ messages: true })).toBe(`
      should fail [2:0]
        enqueued
        started
        failed
          test.spec.ts:[3:20 - 3:20]
          Error: expect(received).toBe(expected) // Object.is equality
          
          Expected: 2
          Received: 1
    `);
  });

});

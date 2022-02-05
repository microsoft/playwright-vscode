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

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  const testRun = await testController.run(testItems);

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

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/fail/);
  const testRun = await testController.run(testItems);

  // Test was discovered, hence we should see immediate enqueue.
  expect(testRun.renderLog({ messages: true })).toBe(`
    should fail [2:0]
      enqueued
      started
      failed
        test.spec.ts:[3:18 - 3:18]
        Error: expect(received).toBe(expected) // Object.is equality
        
        Expected: 2
        Received: 1
  `);
});

test('should only create test run if file belongs to context', async ({}, testInfo) => {
  const { vscode, testController } = await activate(testInfo.outputDir, {
    'tests1/playwright.config.js': `module.exports = { testDir: '.' }`,
    'tests2/playwright.config.js': `module.exports = { testDir: '.' }`,
    'tests1/test1.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests2/test2.spec.ts': `
      import { test } from '@playwright/test';
      test('two', async () => {});
    `,
  });

  const profiles = testController.runProfiles.filter(p => p.kind === vscode.TestRunProfileKind.Run);
  let testRuns: TestRun[] = [];
  testController.onDidCreateTestRun(run => testRuns.push(run));

  {
    testRuns = [];
    const items = testController.findTestItems(/test1.spec/);
    await Promise.all(profiles.map(p => p.run(items)));
    expect(testRuns).toHaveLength(1);
    expect(testRuns[0].request.profile).toBe(profiles[0]);
  }

  {
    testRuns = [];
    const items = testController.findTestItems(/test2.spec/);
    await Promise.all(profiles.map(p => p.run(items)));
    expect(testRuns).toHaveLength(1);
    expect(testRuns[0].request.profile).toBe(profiles[1]);
  }
});

test('should only create test run if folder belongs to context', async ({}, testInfo) => {
  const { vscode, testController } = await activate(testInfo.outputDir, {
    'tests1/playwright.config.js': `module.exports = { testDir: '.' }`,
    'tests2/playwright.config.js': `module.exports = { testDir: '.' }`,
    'tests1/foo1/bar1/test1.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests2/foo2/bar2/test2.spec.ts': `
      import { test } from '@playwright/test';
      test('two', async () => {});
    `,
  });

  const profiles = testController.runProfiles.filter(p => p.kind === vscode.TestRunProfileKind.Run);
  const testRuns: TestRun[] = [];
  testController.onDidCreateTestRun(run => testRuns.push(run));
  const items = testController.findTestItems(/foo1/);
  await Promise.all(profiles.map(p => p.run(items)));
  expect(testRuns).toHaveLength(1);
  expect(testRuns[0].request.profile).toBe(profiles[0]);
});

test('should only create test run if test belongs to context', async ({}, testInfo) => {
  const { vscode, testController } = await activate(testInfo.outputDir, {
    'tests1/playwright.config.js': `module.exports = { testDir: '.' }`,
    'tests2/playwright.config.js': `module.exports = { testDir: '.' }`,
    'tests1/foo1/bar1/test1.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests2/foo2/bar2/test2.spec.ts': `
      import { test } from '@playwright/test';
      test('two', async () => {});
    `,
  });

  await testController.expandTestItems(/test2.spec.ts/);
  const profiles = testController.runProfiles.filter(p => p.kind === vscode.TestRunProfileKind.Run);
  const testRuns: TestRun[] = [];
  testController.onDidCreateTestRun(run => testRuns.push(run));
  const items = testController.findTestItems(/two/);
  await Promise.all(profiles.map(p => p.run(items)));
  expect(testRuns).toHaveLength(1);
  expect(testRuns[0].request.profile).toBe(profiles[1]);
});

test('should stop', async ({}, testInfo) => {
  const { vscode, testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => { await new Promise(() => {})});
    `,
  });

  const profile = testController.runProfiles.find(p => p.kind === vscode.TestRunProfileKind.Run);
  const testRunPromise = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  const runPromise = profile.run();
  const testRun = await testRunPromise;
  await new Promise(f => setTimeout(f, 1000));
  testRun.request.token.cancel();
  await runPromise;
});

test('should run describe', async ({}, testInfo) => {
  const { testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test.describe('describe', () => {
        test('one', async () => {});
        test('two', async () => {});
      });
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);
  const testItems = testController.findTestItems(/describe/);
  expect(testItems.length).toBe(1);
  const testRun = await testController.run(testItems);

  // Test was discovered, hence we should see immediate enqueue.
  expect(testRun.renderLog()).toBe(`
    describe [2:0]
    one [3:0]
      started
      passed
    two [4:0]
      started
      passed
  `);
});

test('should run file', async ({}, testInfo) => {
  const { testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
      test('two', async () => {});
    `,
  });

  const testItems = testController.findTestItems(/test.spec.ts/);
  expect(testItems.length).toBe(1);
  const testRun = await testController.run(testItems);

  // Test was discovered, hence we should see immediate enqueue.
  expect(testRun.renderLog()).toBe(`
    test.spec.ts
    one [2:0]
      started
      passed
    two [3:0]
      started
      passed
  `);
});

test('should run folder', async ({}, testInfo) => {
  const { testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/folder/test1.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests/folder/test2.spec.ts': `
      import { test } from '@playwright/test';
      test('two', async () => {});
    `,
  });

  const testItems = testController.findTestItems(/folder/);
  expect(testItems.length).toBe(1);
  const testRun = await testController.run(testItems);

  // Test was discovered, hence we should see immediate enqueue.
  expect(testRun.renderLog()).toBe(`
    folder
    one [2:0]
      started
      passed
    two [2:0]
      started
      passed
  `);
});

test('should not remove other tests when running focused test', async ({}, testInfo) => {
  const { testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
      test('two', async () => {});
      test('three', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/two/);
  await testController.run(testItems);

  expect(testController.renderTestTree()).toBe(`
    - tests
      - test.spec.ts
        - one [2:0]
        - two [3:0]
        - three [4:0]
  `);
});

test('should run parametrized tests', async ({}, testInfo) => {
  const { testController } = await activate(testInfo.outputDir, {
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      for (const name of ['test-one', 'test-two', 'test-three'])
        test(name, async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/test-/);
  expect(testItems.length).toBe(3);
  const testRun = await testController.run(testItems);

  // Test was discovered, hence we should see immediate enqueue.
  expect(testRun.renderLog()).toBe(`
    test-one [3:0]
      enqueued
      started
      passed
    test-two [3:0]
      enqueued
      started
      passed
    test-three [3:0]
      enqueued
      started
      passed
  `);
});

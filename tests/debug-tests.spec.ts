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

import { expect, test, escapedPathSep, enableProjects, connectToSharedBrowser, waitForPage } from './utils';
import { TestRun, DebugSession, stripAnsi } from './mock/vscode';

test('should debug multiple passing tests', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test-1.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
    'tests/test-2.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  const testRun = await vscode.testControllers[0].debug();
  expect(testRun.renderLog()).toBe(`
    tests > test-1.spec.ts > should pass [2:0]
      enqueued
      started
      passed
    tests > test-2.spec.ts > should pass [2:0]
      enqueued
      started
      passed
  `);

  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [],
        testIds: undefined
      })
    },
  ]);
});

test('should debug one test and pause at end', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      projects: [
        { name: 'main', use: { testIdAttribute: 'data-testerid', testDir: 'tests' } },
        { name: 'unused', use: { testIdAttribute: 'unused', testDir: 'nonExistant' } },
      ]
    };`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async ({ page }) => {
        await page.setContent('<button data-testerid="foo">click me</button>');
        setInterval(() => console.log('time passed'), 500);

      });
    `,
  });

  await enableProjects(vscode, ['main']);

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  const profile = testController.debugProfile();
  const testRunPromise = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  const runPromise = profile.run(testItems);
  const testRun = await testRunPromise;

  await expect.poll(() => vscode.window.activeTextEditor?.renderDecorations('  '), { timeout: 10000 }).toContain(
      `[6:6 - 6:6]: decorator pausedAtEnd`
  );

  // The test should keep running.
  vscode.debug.output = '';
  await expect.poll(() => vscode.debug.output, { timeout: 10000 }).toContain('time passed');

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > should pass [2:0]
      enqueued
      enqueued
      started
  `);

  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      })
    },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [
          expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`),
        ],
        testIds: [expect.any(String)]
      })
    },
  ]);
  vscode.connectionLog.length = 0;

  await vscode.openEditors('**/test.spec.ts');
  const editor = vscode.window.activeTextEditor;
  expect(editor.document.uri.path).toContain('test.spec.ts');
  editor.selection = new vscode.Selection(5, 0, 5, 0);

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await webView.getByText('Record at cursor').click();
  await expect.poll(() => vscode.lastWithProgressData, { timeout: 0 }).toEqual({ message: 'recording\u2026' });

  const browser = await connectToSharedBrowser(vscode);
  const page = await waitForPage(browser);
  await page.getByRole('button', { name: 'click me' }).click();
  await expect.poll(() => editor.edits).toEqual([
    {
      range: '[5:0 - 5:0]',
      from: `
      import { test } from '@playwright/test';
      test('should pass', async ({ page }) => {
        await page.setContent('<button data-testerid="foo">click me</button>');
        setInterval(() => console.log('time passed'), 500);
<selection></selection>
      });
    `,
      to: `
      import { test } from '@playwright/test';
      test('should pass', async ({ page }) => {
        await page.setContent('<button data-testerid="foo">click me</button>');
        setInterval(() => console.log('time passed'), 500);
<selection>await page.getByTestId('foo').click();</selection>
      });
    `,
    }
  ]);

  vscode.lastWithProgressToken!.cancel();

  testRun.token.source.cancel();
  await runPromise;

  await expect(vscode).toHaveConnectionLog([
    { method: 'stopTests', params: {} },
  ]);

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > should pass [2:0]
      enqueued
      enqueued
      started
  `);
});

test('should debug one test and pause on error', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('should fail', async () => {
        setInterval(() => console.log('time passed'), 500);
        expect(1).toBe(2);
      });
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/should fail/);
  const profile = testController.debugProfile();
  const testRunPromise = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  const runPromise = profile.run(testItems);
  const testRun = await testRunPromise;

  await expect.poll(() => vscode.window.activeTextEditor?.renderDecorations('  '), { timeout: 10000 }).toBe(`
    --------------------------------------------------------------
    [4:18 - 4:18]: decorator pausedOnError
  `);

  // The test should keep running.
  vscode.debug.output = '';
  await expect.poll(() => vscode.debug.output, { timeout: 10000 }).toContain('time passed');

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > should fail [2:0]
      enqueued
      enqueued
      started
      failed
  `);

  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      })
    },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [
          expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`),
        ],
        testIds: [expect.any(String)]
      })
    },
  ]);
  vscode.connectionLog.length = 0;

  testRun.token.source.cancel();
  await runPromise;

  await expect(vscode).toHaveConnectionLog([
    { method: 'stopTests', params: {} },
  ]);
});

test('should debug error', async ({ activate }, testInfo) => {
  const { vscode, testController } = await activate({
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

  const profile = testController.debugProfile();
  const testRunPromise = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  void profile.run(testItems);
  const testRun = await testRunPromise;

  await expect.poll(() => vscode.debug.output, { timeout: 10000 }).toContain('READY TO BREAK');

  vscode.debug.simulateStoppedOnError('Error on line 10', { file: testInfo.outputPath('tests/test.spec.ts'), line: 10 });

  expect(testRun.renderLog({ messages: true }).replace(/\\/g, '/')).toBe(`
    tests > test.spec.ts > should fail [2:0]
      enqueued
      enqueued
      started
      failed
        test.spec.ts:[9:0 - 9:0]
        Error on line 10
        <br>
         at tests/test.spec.ts:10:1 {matcherResult: ...}
  `);

  testRun.token.source.cancel();
});

test('should end test run when stopping the debugging', async ({ activate }, testInfo) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should stall', async () => {
        // Simulate breakpoint via stalling.
        console.log('READY TO BREAK');
        await new Promise(() => {});
      });
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/should stall/);

  const profile = testController.debugProfile();
  const testRunPromise = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  void profile.run(testItems);
  const testRun = await testRunPromise;
  await expect.poll(() => vscode.debug.output, { timeout: 10000 }).toContain('READY TO BREAK');

  const endPromise = new Promise(f => testRun.onDidEnd(f));
  vscode.debug.stopDebugging();
  await endPromise;

  expect(testRun.renderLog({ messages: true })).toBe(`
    tests > test.spec.ts > should stall [2:0]
      enqueued
      enqueued
      started
  `);

  testRun.token.source.cancel();
});

test('should end test run when stopping the debugging during config parsing', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'package.json': JSON.stringify({ type: 'module' }),
    'playwright.config.js': `
      // Simulate breakpoint via stalling.
      async function stall() {
        console.log('READY TO BREAK');
        await new Promise(() => {});
      }

      process.env.STALL_CONFIG === '1' && await stall();
      export default { testDir: 'tests' }
    `,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should fail', async () => {});
    `,
  }, { env: { STALL_CONFIG: '0' } });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/fail/);

  const configuration = vscode.workspace.getConfiguration('playwright');
  configuration.update('env', { STALL_CONFIG: '1' });

  const profile = testController.debugProfile();
  const testRunPromise = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  void profile.run(testItems);
  const testRun = await testRunPromise;
  const endPromise = new Promise(f => testRun.onDidEnd(f));
  await expect.poll(() => vscode.debug.output).toContain('READY TO BREAK');
  vscode.debug.stopDebugging();
  await endPromise;

  expect(testRun.renderLog({ messages: true })).toBe(`
    tests > test.spec.ts > should fail [2:0]
      enqueued
  `);

  testRun.token.source.cancel();
});

test('should pass all args as string[] when debugging', async ({ activate }) => {
  test.info().annotations.push({ type: 'issue', description: 'https://github.com/microsoft/playwright/issues/30829' });
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('pass', () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);

  const profile = testController.debugProfile();
  const onDidStartDebugSession = new Promise<DebugSession>(resolve => vscode.debug.onDidStartDebugSession(resolve));
  const onDidTerminateDebugSession = new Promise(resolve => vscode.debug.onDidTerminateDebugSession(resolve));
  const testRunPromise = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  void profile.run(testItems);
  const testRun = await testRunPromise;
  const session = await onDidStartDebugSession;
  expect(session.configuration.args.filter((arg: any) => typeof arg !== 'string')).toEqual([]);
  testRun.token.source.cancel();
  await onDidTerminateDebugSession;
});

test('should run global setup before debugging', async ({ activate }, testInfo) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      testDir: 'tests',
      globalSetup: 'globalSetup.ts',
    }`,
    'globalSetup.ts': `
      async function globalSetup(config) {
        console.log('RUN GLOBAL SETUP UNDER DEBUG: ' + !!process.env.VSCODE_MOCK_DEBUGGING);
        process.env.MAGIC_NUMBER = '42';
      }
      export default globalSetup;
    `,
    'tests/test.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('should pass', async () => {
        console.log('TEST UNDER DEBUG: ' + !!process.env.VSCODE_MOCK_DEBUGGING);
        console.log('MAGIC NUMBER: ' + process.env.MAGIC_NUMBER);
        expect(process.env.MAGIC_NUMBER).toBe('42');
      });
    `
  });

  const testRunPromise1 = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  await testController.expandTestItems(/test.spec/);
  const runFinishedPromise1 = testController.debugProfile().run(testController.findTestItems(/pass/));
  const testRun1 = await testRunPromise1;
  await expect(testRun1).toHaveOutput(`RUN GLOBAL SETUP UNDER DEBUG: false`);
  await expect.poll(() => stripAnsi(vscode.debug.output)).toContain(`TEST UNDER DEBUG: true`);
  await expect.poll(() => stripAnsi(vscode.debug.output)).toContain(`MAGIC NUMBER: 42`);
  expect(testRun1.renderLog()).toBe(`
    tests > test.spec.ts > should pass [2:0]
      enqueued
      enqueued
      started
  `);
  testRun1.token.source.cancel();
  await runFinishedPromise1;

  // Second time it should reuse the global setup and not run it again.
  const testRunPromise2 = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  await testController.expandTestItems(/test.spec/);
  const runFinishedPromise2 = testController.debugProfile().run(testController.findTestItems(/pass/));
  const testRun2 = await testRunPromise2;
  await expect.poll(() => stripAnsi(vscode.debug.output)).toContain(`TEST UNDER DEBUG: true`);
  await expect.poll(() => stripAnsi(vscode.debug.output)).toContain(`MAGIC NUMBER: 42`);
  expect(testRun2.renderOutput()).not.toContain(`RUN GLOBAL SETUP`);
  testRun2.token.source.cancel();
  await runFinishedPromise2;
});

test('should debug global setup when toggle is enabled', async ({ activate }, testInfo) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      testDir: 'tests',
      globalSetup: 'globalSetup.ts',
    }`,
    'globalSetup.ts': `
      async function globalSetup(config) {
        console.log('RUN GLOBAL SETUP UNDER DEBUG: ' + !!process.env.VSCODE_MOCK_DEBUGGING);
        process.env.MAGIC_NUMBER = '42';
      }
      export default globalSetup;
    `,
    'tests/test.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('should pass', async () => {
        console.log('TEST UNDER DEBUG: ' + !!process.env.VSCODE_MOCK_DEBUGGING);
        console.log('MAGIC NUMBER: ' + process.env.MAGIC_NUMBER);
        expect(process.env.MAGIC_NUMBER).toBe('42');
      });
    `
  }, { runGlobalSetupOnEachRun: true });

  const testRunPromise = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  await testController.expandTestItems(/test.spec/);
  const runFinishedPromise = testController.debugProfile().run(testController.findTestItems(/pass/));
  const testRun = await testRunPromise;
  await expect.poll(() => stripAnsi(vscode.debug.output)).toContain(`RUN GLOBAL SETUP UNDER DEBUG: true`);
  await expect.poll(() => stripAnsi(vscode.debug.output)).toContain(`TEST UNDER DEBUG: true`);
  await expect.poll(() => stripAnsi(vscode.debug.output)).toContain(`MAGIC NUMBER: 42`);
  testRun.token.source.cancel();
  await runFinishedPromise;
});

test('should debug multiple tests and stop on first failure', async ({ activate }) => {
  const { vscode, testController } = await activate({
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

  const profile = testController.debugProfile();
  const testRunPromise = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  const runPromise = profile.run();
  const testRun = await testRunPromise;

  await expect.poll(() => vscode.window.activeTextEditor?.renderDecorations('  '), { timeout: 10000 }).toBe(`
    --------------------------------------------------------------
    [2:50 - 2:50]: decorator pausedOnError
  `);

  expect(testRun.renderLog()).toBe(`
    tests > test-2.spec.ts > should fail [2:0]
      enqueued
      started
      failed
    tests > test-1.spec.ts > should pass [2:0]
      enqueued
      started
      passed
  `);

  testRun.token.source.cancel();
  await runPromise;

  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [],
        testIds: undefined
      })
    },
    { method: 'stopTests', params: {} },
  ]);
});

test('should not pause at the end of a setup test', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      testDir: 'tests',
      projects: [
        { name: 'setup', testMatch: /.*setup.ts/ },
        { name: 'main' },
      ]
    }`,
    'tests/auth.setup.ts': `
      import { test } from '@playwright/test';
      test('should setup', async () => {
      });
    `,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {
        setInterval(() => console.log('time passed'), 500);
      });
    `,
  });
  await enableProjects(vscode, ['setup', 'main']);

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  const profile = testController.debugProfile();
  const testRunPromise = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  const runPromise = profile.run(testItems);
  const testRun = await testRunPromise;

  // The "setup" project should not run when running a single test from "main" project.
  await expect.poll(() => testRun.renderLog()).toBe(`
    tests > test.spec.ts > should pass [2:0]
      enqueued
      enqueued
      started
  `);

  testRun.token.source.cancel();
  await runPromise;

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > should pass [2:0]
      enqueued
      enqueued
      started
  `);
});

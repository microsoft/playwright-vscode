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

import { enableConfigs, enableProjects, escapedPathSep, expect, selectConfig, test } from './utils';
import { TestRun } from './mock/vscode';
import fs from 'fs';
import path from 'path';

test('should run all tests', async ({ activate }) => {
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

  const testRun = await testController.run();

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test-1.spec.ts
        - ✅ should pass [2:0]
      -   test-2.spec.ts
        - ❌ should fail [2:0]
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

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'runGlobalSetup', params: {} },
    { method: 'runTests', params: expect.objectContaining({
      locations: [],
      testIds: undefined,
    }) },
  ]);
});

test('should run one test', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  const testRun = await testController.run(testItems);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        - ✅ should pass [2:0]
  `);

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > should pass [2:0]
      enqueued
      enqueued
      started
      passed
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright test -c playwright.config.js tests/test.spec.ts:3
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: undefined,
        testIds: [expect.any(String)]
      })
    },
  ]);
});

test('should run describe', async ({ activate }) => {
  const { testController } = await activate({
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

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > describe > one [3:0]
      enqueued
      enqueued
      started
      passed
    tests > test.spec.ts > describe > two [4:0]
      enqueued
      enqueued
      started
      passed
  `);
});

test('should run file', async ({ activate }) => {
  const { vscode, testController } = await activate({
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

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > one [2:0]
      enqueued
      started
      passed
    tests > test.spec.ts > two [3:0]
      enqueued
      started
      passed
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js tests/test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)],
        testIds: undefined
      })
    },
  ]);
});

test('should run folder', async ({ activate }) => {
  const { vscode, testController } = await activate({
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

  expect(testRun.renderLog()).toBe(`
    tests > folder > test1.spec.ts > one [2:0]
      enqueued
      started
      passed
    tests > folder > test2.spec.ts > two [2:0]
      enqueued
      started
      passed
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js tests/folder
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}folder`)],
        testIds: undefined
      })
    },
  ]);
});

test('should show error message', async ({ activate }) => {
  const { testController } = await activate({
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

  expect(testRun.renderLog({ messages: true })).toBe(`
    tests > test.spec.ts > should fail [2:0]
      enqueued
      enqueued
      started
      failed
        test.spec.ts:[3:18 - 3:18]
        Error: <span style='color:#666;'>expect(</span><span style='color:#f14c4c;'>received</span><span style='color:#666;'>).</span>toBe<span style='color:#666;'>(</span><span style='color:#73c991;'>expected</span><span style='color:#666;'>) // Object.is equality</span>
        <br>

        <br>
        Expected: <span style='color:#73c991;'>2</span>
        <br>
        Received: <span style='color:#f14c4c;'>1</span>
        <br>
            at tests/test.spec.ts:4:19
        </span></br>
  `);
});

test('should escape error log', async ({ activate }) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('should fail', async () => {
        throw new Error('\\n========== log ==========\\n<div class="foo bar baz"></div>\\n===============\\n');
      });
    `,
  });
  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/fail/);
  const testRun = await testController.run(testItems);

  expect(testRun.renderLog({ messages: true })).toContain(
      `<b>&lt;</b>div class=&quot;foo bar baz&quot;<b>&gt;</b><b>&lt;</b>/div<b>&gt;`);
});

test('should show soft error messages', async ({ activate }) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test, expect } from '@playwright/test';
      test('should fail', async () => {
        expect.soft(1).toBe(2);
        expect.soft(2).toBe(3);
      });
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/fail/);
  const testRun = await testController.run(testItems);

  expect(testRun.renderLog({ messages: true })).toBe(`
    tests > test.spec.ts > should fail [2:0]
      enqueued
      enqueued
      started
      failed
        test.spec.ts:[3:23 - 3:23]
        Error: <span style='color:#666;'>expect(</span><span style='color:#f14c4c;'>received</span><span style='color:#666;'>).</span>toBe<span style='color:#666;'>(</span><span style='color:#73c991;'>expected</span><span style='color:#666;'>) // Object.is equality</span>
        <br>

        <br>
        Expected: <span style='color:#73c991;'>2</span>
        <br>
        Received: <span style='color:#f14c4c;'>1</span>
        <br>
            at tests/test.spec.ts:4:24
        </span></br>
        test.spec.ts:[4:23 - 4:23]
        Error: <span style='color:#666;'>expect(</span><span style='color:#f14c4c;'>received</span><span style='color:#666;'>).</span>toBe<span style='color:#666;'>(</span><span style='color:#73c991;'>expected</span><span style='color:#666;'>) // Object.is equality</span>
        <br>

        <br>
        Expected: <span style='color:#73c991;'>3</span>
        <br>
        Received: <span style='color:#f14c4c;'>2</span>
        <br>
            at tests/test.spec.ts:5:24
        </span></br>
  `);
});

test('should only create test run if file belongs to context', async ({ activate }) => {
  const { vscode, testController } = await activate({
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

  const profile = testController.runProfile();
  await enableConfigs(vscode, [`tests1${path.sep}playwright.config.js`, `tests2${path.sep}playwright.config.js`]);

  let testRuns: TestRun[] = [];
  testController.onDidCreateTestRun(run => testRuns.push(run));

  {
    testRuns = [];
    const items = testController.findTestItems(/test1.spec/);
    await profile.run(items);
    expect(testRuns).toHaveLength(1);
  }

  await expect(vscode).toHaveExecLog(`
    tests1> playwright list-files -c playwright.config.js
    tests2> playwright list-files -c playwright.config.js
    tests1> playwright test -c playwright.config.js test1.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests1${escapedPathSep}test1\\.spec\\.ts`)],
        testIds: undefined
      })
    },
    { method: 'listFiles', params: {} },
  ]);
  vscode.connectionLog.length = 0;

  {
    testRuns = [];
    const items = testController.findTestItems(/test2.spec/);
    await profile.run(items);
    expect(testRuns).toHaveLength(1);
  }

  await expect(vscode).toHaveExecLog(`
    tests1> playwright list-files -c playwright.config.js
    tests2> playwright list-files -c playwright.config.js
    tests1> playwright test -c playwright.config.js test1.spec.ts
    tests2> playwright test -c playwright.config.js test2.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests2${escapedPathSep}test2\\.spec\\.ts`)],
        testIds: undefined
      })
    },
  ]);

});

test('should only create test run if folder belongs to context', async ({ activate }) => {
  const { vscode, testController } = await activate({
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

  await enableConfigs(vscode, [`tests1${path.sep}playwright.config.js`, `tests2${path.sep}playwright.config.js`]);

  await expect(testController).toHaveTestTree(`
    -   tests1
      -   foo1
        -   bar1
          -   test1.spec.ts
    -   tests2
      -   foo2
        -   bar2
          -   test2.spec.ts
  `);

  const profile = testController.runProfile();
  const items = testController.findTestItems(/foo1/);
  await profile.run(items);

  await expect(vscode).toHaveExecLog(`
    tests1> playwright list-files -c playwright.config.js
    tests2> playwright list-files -c playwright.config.js
    tests1> playwright test -c playwright.config.js foo1
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'listFiles', params: {} },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests1${escapedPathSep}foo1`)],
        testIds: undefined
      })
    },
  ]);
});

test('should run all projects at once', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      testDir: './tests',
      projects: [
        { name: 'projectOne' },
        { name: 'projectTwo' },
      ]
    }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  await enableProjects(vscode, ['projectOne', 'projectTwo']);
  const profile = testController.runProfile();
  await profile.run();

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [],
        projects: [],
        testIds: undefined
      })
    },
  ]);
});

test('should group projects by config', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'tests1/playwright.config.js': `module.exports = {
      projects: [
        { name: 'projectOne' },
        { name: 'projectTwo' },
      ]
    }`,
    'tests2/playwright.config.js': `module.exports = {
      projects: [
        { name: 'projectOne' },
        { name: 'projectTwo' },
      ]
    }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests2/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  await enableConfigs(vscode, [`tests1${path.sep}playwright.config.js`, `tests2${path.sep}playwright.config.js`]);
  await enableProjects(vscode, ['projectOne', 'projectTwo']);
  await expect(vscode).toHaveProjectTree(`
    config: tests1/playwright.config.js
    [x] projectOne
    [x] projectTwo
  `);

  await selectConfig(vscode, `tests2${path.sep}playwright.config.js`);
  await expect(vscode).toHaveProjectTree(`
    config: tests2/playwright.config.js
    [x] projectOne
    [ ] projectTwo
  `);

  await enableProjects(vscode, ['projectOne', 'projectTwo']);
  await expect(vscode).toHaveProjectTree(`
    config: tests2/playwright.config.js
    [x] projectOne
    [x] projectTwo
  `);

  await testController.runProfile().run();

  await expect(vscode).toHaveExecLog(`
    tests1> playwright list-files -c playwright.config.js
    tests2> playwright list-files -c playwright.config.js
    tests1> playwright test -c playwright.config.js
    tests2> playwright test -c playwright.config.js
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'listFiles', params: {} },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [],
        testIds: undefined
      })
    },
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

test('should stop', async ({ activate, showBrowser }) => {
  test.fixme(showBrowser, 'Times out');
  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {
        await new Promise(f => process.stdout.write('RUNNING TEST', f));
        await new Promise(() => {});
      });
    `,
  });

  const profile = testController.runProfile();
  const testRunPromise = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  const runPromise = profile.run();
  const testRun = await testRunPromise;
  let output = testRun.renderLog({ output: true });
  while (!output.includes('RUNNING TEST')) {
    output = testRun.renderLog({ output: true });
    await new Promise(f => setTimeout(f, 100));
  }
  testRun.token.source.cancel();
  await runPromise;
});

test('should tear down on stop', async ({ activate, overridePlaywrightVersion }) => {
  test.skip(!overridePlaywrightVersion, 'New world will not teardown on stop');
  const { testController } = await activate({
    'playwright.config.js': `module.exports = {
      testDir: 'tests',
      globalSetup: './globalSetup.js',
    }`,
    'globalSetup.js': `
      process.stdout.write('RUNNING SETUP');
      module.exports = async () => {
        return async () => {
          await new Promise(f => process.stdout.write('RUNNING TEARDOWN', f));
        }
      };
    `,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {
        await new Promise(f => process.stdout.write('RUNNING TEST', f));
        await new Promise(() => {});
      });
    `,
  });

  const profile = testController.runProfile();
  const testRunPromise = new Promise<TestRun>(f => testController.onDidCreateTestRun(f));
  const runPromise = profile.run();
  const testRun = await testRunPromise;

  let output = testRun.renderLog({ output: true });
  while (!output.includes('RUNNING TEST')) {
    output = testRun.renderLog({ output: true });
    await new Promise(f => setTimeout(f, 100));
  }

  testRun.token.source.cancel();
  await runPromise;
  expect(testRun.renderLog({ output: true })).toContain('RUNNING TEARDOWN');
});

test('should not remove other tests when running focused test', async ({ activate }) => {
  const { testController } = await activate({
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

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   one [2:0]
        - ✅ two [3:0]
        -   three [4:0]
  `);
});

test('should run all parametrized tests', async ({ activate }) => {
  const { vscode, testController } = await activate({
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

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > test-one [3:0]
      enqueued
      enqueued
      started
      passed
    tests > test.spec.ts > test-three [3:0]
      enqueued
      enqueued
      started
      passed
    tests > test.spec.ts > test-two [3:0]
      enqueued
      enqueued
      started
      passed
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright test -c playwright.config.js tests/test.spec.ts:4
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)],
      })
    },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: undefined,
        testIds: [
          expect.any(String),
          expect.any(String),
          expect.any(String),
        ]
      })
    },
  ]);
});

test('should run one parametrized test', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      for (const name of ['test one', 'test two', 'test three'])
        test(name, async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/test two/);
  expect(testItems.length).toBe(1);
  const testRun = await testController.run(testItems);

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > test two [3:0]
      enqueued
      enqueued
      started
      passed
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright test -c playwright.config.js --grep=test two tests/test.spec.ts:4
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'listTests', params: {
      locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
    } },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: undefined,
        testIds: [expect.any(String)]
      })
    },
  ]);
});

test('should run one parametrized groups', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      for (const name of ['group one', 'group two', 'group three'])
        test.describe(name, () => {
          test('test one in ' + name, async () => {});
          test('test two in ' + name, async () => {});
        });
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/^group three$/);
  expect(testItems.length).toBe(1);
  const testRun = await testController.run(testItems);

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > group three > test one in group three [4:0]
      enqueued
      enqueued
      started
      passed
    tests > test.spec.ts > group three > test two in group three [5:0]
      enqueued
      enqueued
      started
      passed
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright test -c playwright.config.js --grep=group three tests/test.spec.ts:4
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)],
      })
    },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: undefined,
        testIds: [
          expect.any(String),
          expect.any(String),
        ]
      })
    },
  ]);
});

test('should run tests in parametrized groups', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test, expect } from '@playwright/test';
      for (const foo of [1, 2]) {
        test.describe('level ' + foo, () => {
          test('should work', async () => {
            expect(1).toBe(1);
          });
        });
      }
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems1 = testController.findTestItems(/level 1/);
  expect(testItems1.length).toBe(1);
  const testRun = await testController.run(testItems1);
  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > level 1 > should work [4:0]
      enqueued
      enqueued
      started
      passed
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright test -c playwright.config.js --grep=level 1 tests/test.spec.ts:4
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)],
      })
    },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: undefined,
        testIds: [
          expect.any(String),
        ]
      })
    },
  ]);
  vscode.connectionLog.length = 0;

  const testItems2 = testController.findTestItems(/level 2/);
  expect(testItems2.length).toBe(1);
  const testRun2 = await testController.run(testItems2);
  expect(testRun2.renderLog()).toBe(`
    tests > test.spec.ts > level 2 > should work [4:0]
      enqueued
      enqueued
      started
      passed
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright test -c playwright.config.js --grep=level 1 tests/test.spec.ts:4
    > playwright test -c playwright.config.js --grep=level 2 tests/test.spec.ts:4
  `);
  await expect(vscode).toHaveConnectionLog([
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: undefined,
        testIds: [
          expect.any(String),
        ]
      })
    },
  ]);
});

test('should list tests in relative folder', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'foo/bar/playwright.config.js': `module.exports = { testDir: '../../tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);

  await expect(vscode).toHaveExecLog(`
    foo/bar> playwright list-files -c playwright.config.js
    foo/bar> playwright test -c playwright.config.js --list --reporter=null ../../tests/test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)],
      })
    },
  ]);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   one [2:0]
  `);
});

test('should filter selected project', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      projects: [
        { testDir: './tests1', name: 'project 1' },
        { testDir: './tests2', name: 'project 2' },
      ]
    }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests2/test.spec.ts': `
      import { test } from '@playwright/test';
      test(two', async () => {});
    `,
  });

  const testItems = testController.findTestItems(/test.spec/);
  expect(testItems.length).toBe(1);
  const testRun = await testController.run(testItems);
  expect(testRun.renderLog()).toBe(`
    tests1 > test.spec.ts > one [2:0]
      enqueued
      started
      passed
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --project=project 1 tests1/test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'runGlobalSetup', params: {} },
    {
      method: 'runTests',
      params: expect.objectContaining({
        projects: ['project 1'],
        locations: [expect.stringContaining(`tests1${escapedPathSep}test\\.spec\\.ts`)],
      })
    },
  ]);
});

test('should report project-specific failures', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      testDir: 'tests',
      workers: 1,
      projects: [
        { 'name': 'projectA' },
        { 'name': 'projectB' },
        { 'name': 'projectC' },
      ]
    }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async ({}, testInfo) => {
        throw new Error(testInfo.project.name);
      });
    `,
  });

  await enableProjects(vscode, ['projectA', 'projectB', 'projectC']);
  const profile = testController.runProfile();
  const testRuns: TestRun[] = [];
  testController.onDidCreateTestRun(run => testRuns.push(run));
  await profile.run();

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js
  `);

  expect(testRuns[0].renderLog({ messages: true })).toBe(`
    tests > test.spec.ts > should pass > projectA [2:0]
      enqueued
      started
      failed
        test.spec.ts:[3:14 - 3:14]
        Error: projectA
        <br>
            at tests/test.spec.ts:4:15
    tests > test.spec.ts > should pass > projectB [2:0]
      enqueued
      started
      failed
        test.spec.ts:[3:14 - 3:14]
        Error: projectB
        <br>
            at tests/test.spec.ts:4:15
    tests > test.spec.ts > should pass > projectC [2:0]
      enqueued
      started
      failed
        test.spec.ts:[3:14 - 3:14]
        Error: projectC
        <br>
            at tests/test.spec.ts:4:15
  `);
});

test('should discover tests after running one test', async ({ activate }) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test1.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests/test2.spec.ts': `
      import { test } from '@playwright/test';
      test('two', async () => {});
    `,
  });

  await testController.expandTestItems(/test1.spec.ts/);
  const testItems = testController.findTestItems(/one/);
  const testRun = await testController.run(testItems);

  expect(testRun.renderLog()).toBe(`
    tests > test1.spec.ts > one [2:0]
      enqueued
      enqueued
      started
      passed
  `);

  await testController.expandTestItems(/test2.spec.ts/);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test1.spec.ts
        - ✅ one [2:0]
      -   test2.spec.ts
        -   two [2:0]
  `);
});

test('should provisionally enqueue nested tests', async ({ activate }) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('1', async () => {});
      test('2', async () => {});
      test.describe('group', () => {
        test('3', async () => {});
        test('4', async () => {});
      });
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);
  const testItems = testController.findTestItems(/test.spec.ts/);
  const testRun = await testController.run(testItems);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        - ✅ 1 [2:0]
        - ✅ 2 [3:0]
        -   group [4:0]
          - ✅ 3 [5:0]
          - ✅ 4 [6:0]
  `);

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > 1 [2:0]
      enqueued
      enqueued
      started
      passed
    tests > test.spec.ts > 2 [3:0]
      enqueued
      enqueued
      started
      passed
    tests > test.spec.ts > group > 3 [5:0]
      enqueued
      enqueued
      started
      passed
    tests > test.spec.ts > group > 4 [6:0]
      enqueued
      enqueued
      started
      passed
  `);
});

test('should run tests for folders above root', async ({ activate }) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'builder/playwright/tests' }`,
    'builder/playwright/tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  const testItems = testController.findTestItems(/builder/);
  const testRun = await testController.run(testItems);

  expect(testRun.renderLog()).toBe(`
    builder > playwright > tests > test.spec.ts > one [2:0]
      enqueued
      started
      passed
  `);
});

test('should produce output twice', async ({ activate, overridePlaywrightVersion }) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = {
      testDir: 'tests',
      reporter: 'line',
    }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {
        console.log('some output');
      });
    `,
  });

  const testItems = testController.findTestItems(/test.spec.ts/);
  expect(testItems.length).toBe(1);

  const testRun1 = await testController.run(testItems);
  const runningGlobalSetup = overridePlaywrightVersion ? '' : '\n    Running global setup if any…';
  expect(testRun1.renderLog({ output: true })).toBe(`
    tests > test.spec.ts > one [2:0]
      enqueued
      started
      passed
    Output:${runningGlobalSetup}

    Running 1 test using 1 worker

    [1/1] test.spec.ts:3:11 › one
    test.spec.ts:3:11 › one
    some output

      1 passed (XXms)

  `);

  const testRun2 = await testController.run(testItems);
  expect(testRun2.renderLog({ output: true })).toBe(`
    tests > test.spec.ts > one [2:0]
      enqueued
      enqueued
      started
      passed
    Output:

    Running 1 test using 1 worker

    [1/1] test.spec.ts:3:11 › one
    test.spec.ts:3:11 › one
    some output

      1 passed (XXms)

  `);
});

test('should disable tracing when reusing context', async ({ activate, showBrowser }) => {
  test.skip(!showBrowser);

  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests', use: { trace: 'on' } }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async ({ page }) => {});
    `,
  });

  const testItems = testController.findTestItems(/test.spec.ts/);
  expect(testItems.length).toBe(1);
  await testController.run(testItems);

  expect(fs.existsSync(test.info().outputPath('test-results', 'test-one', 'trace.zip'))).toBe(false);
});

test('should force workers=1 when reusing the browser', async ({ activate, showBrowser }) => {
  test.skip(!showBrowser);

  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests', workers: 2 }`,
    'tests/test1.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async ({ page }) => {});
    `,
    'tests/test2.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async ({ page }) => {});
    `,
    'tests/test3.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async ({ page }) => {});
    `,
  });

  const testRun = await testController.run();
  expect(testRun.renderLog({ output: true })).toContain('Running 3 tests using 1 worker');
});

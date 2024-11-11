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

import { TestRun } from './mock/vscode';
import { enableConfigs, enableProjects, escapedPathSep, expect, selectConfig, test } from './utils';
import path from 'path';
import { writeFile } from 'node:fs/promises';

test.skip(({ overridePlaywrightVersion }) => !!overridePlaywrightVersion);

test('should watch all tests', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
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

  await testController.watch();

  const [testRun] = await Promise.all([
    new Promise<TestRun>(f => testController.onDidCreateTestRun(testRun => {
      testRun.onDidEnd(() => f(testRun));
    })),
    workspaceFolder.changeFile('tests/test-1.spec.ts', `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `),
  ]);

  expect(testRun.renderLog()).toBe(`
    tests > test-1.spec.ts > should pass [2:0]
      enqueued
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
    {
      method: 'watch',
      params: expect.objectContaining({
        fileNames: [
          expect.stringContaining(`tests${path.sep}test-1.spec.ts`),
          expect.stringContaining(`tests${path.sep}test-2.spec.ts`),
        ],
      })
    },
    {
      method: 'listTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test-1\\.spec\\.ts`)],
      })
    },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test-1\\.spec\\.ts`)],
        testIds: undefined
      })
    },
  ]);
});

test('should unwatch all tests', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
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

  const watchRequest = await testController.watch();
  watchRequest.token.source.cancel();

  const testRuns: TestRun[] = [];
  testController.onDidCreateTestRun(testRun => { testRuns.push(testRun); });
  await workspaceFolder.changeFile('tests/test-1.spec.ts', `
    import { test } from '@playwright/test';
    test('should pass', async () => {});
  `);

  await new Promise(f => setTimeout(f, 500));

  expect(testRuns).toHaveLength(0);

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
    {
      method: 'watch',
      params: expect.objectContaining({
        fileNames: [
          expect.stringContaining(`tests${path.sep}test-1.spec.ts`),
          expect.stringContaining(`tests${path.sep}test-2.spec.ts`),
        ],
      })
    },
    {
      method: 'listTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test-1\\.spec\\.ts`)],
      })
    },
  ]);
});

test('should watch test file', async ({ activate }) => {
  const { testController, workspaceFolder } = await activate({
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

  const testItem2 = testController.findTestItems(/test-2/);
  const [testRun] = await Promise.all([
    new Promise<TestRun>(f => testController.onDidCreateTestRun(testRun => {
      testRun.onDidEnd(() => f(testRun));
    })),
    testController.watch(testItem2),
  ]);

  expect(testRun.renderLog()).toBe(`
    tests > test-2.spec.ts > should fail [2:0]
      enqueued
      started
      failed
  `);

  const [watchRun] = await Promise.all([
    new Promise<TestRun>(f => testController.onDidCreateTestRun(testRun => {
      testRun.onDidEnd(() => f(testRun));
    })),
    workspaceFolder.changeFile('tests/test-1.spec.ts', `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `),
    workspaceFolder.changeFile('tests/test-2.spec.ts', `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `),
  ]);

  expect(watchRun.renderLog()).toBe(`
    tests > test-2.spec.ts > should pass [2:0]
      enqueued
      enqueued
      started
      passed
  `);
});

test('should watch tests via helper', async ({ activate }) => {
  // This test requires nightly playwright.
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/helper.ts': `
      export const foo = 42;
    `,
    'tests/test.spec.ts': `
      import { test, expect } from '@playwright/test';
      import { foo } from './helper';
      test('should pass', async () => {
        expect(foo).toBe(42);
      });
    `,
  });

  await testController.watch();

  const [testRun] = await Promise.all([
    new Promise<TestRun>(f => testController.onDidCreateTestRun(testRun => {
      testRun.onDidEnd(() => f(testRun));
    })),
    workspaceFolder.changeFile('tests/helper.ts', `
      export const foo = 43;
    `),
  ]);

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > should pass [3:0]
      enqueued
      enqueued
      started
      failed
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
    {
      method: 'watch',
      params: expect.objectContaining({
        fileNames: [expect.stringContaining(`tests${path.sep}test.spec.ts`)],
      })
    },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)],
        testIds: undefined
      })
    },
  ]);
});

test('should watch one test in a file', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('pass 1', async () => {});
      test('pass 2', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass 1/);
  await testController.watch(testItems);

  const [testRun] = await Promise.all([
    new Promise<TestRun>(f => testController.onDidCreateTestRun(testRun => {
      testRun.onDidEnd(() => f(testRun));
    })),
    workspaceFolder.changeFile('tests/test.spec.ts', `
      import { test } from '@playwright/test';
      test('pass 1', async () => {});
      test('pass 2', async () => {});
      test('pass 3', async () => {});
    `),
  ]);

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > pass 1 [2:0]
      enqueued
      enqueued
      started
      passed
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
          expect.any(String)
        ]
      })
    },
    {
      method: 'watch',
      params: expect.objectContaining({
        fileNames: [expect.stringContaining(`tests${path.sep}test.spec.ts`)],
      })
    },
    {
      method: 'listTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)],
      })
    },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: undefined,
        testIds: [expect.any(String)]
      })
    },
  ]);
});

test('should watch two tests in a file', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('pass 1', async () => {});
      test('pass 2', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass/);
  await testController.watch(testItems);

  const [testRun] = await Promise.all([
    new Promise<TestRun>(f => testController.onDidCreateTestRun(testRun => {
      testRun.onDidEnd(() => f(testRun));
    })),
    workspaceFolder.changeFile('tests/test.spec.ts', `
      import { test } from '@playwright/test';
      test('pass 1', async () => {});
      test('pass 2', async () => {});
      test('pass 3', async () => {});
    `),
  ]);

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > pass 1 [2:0]
      enqueued
      enqueued
      started
      passed
    tests > test.spec.ts > pass 2 [3:0]
      enqueued
      enqueued
      started
      passed
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
    {
      method: 'watch',
      params: expect.objectContaining({
        fileNames: [expect.stringContaining(`tests${path.sep}test.spec.ts`)],
      })
    },
    {
      method: 'listTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)],
      })
    },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: undefined,
        testIds: [expect.any(String), expect.any(String)]
      })
    },
  ]);
});

test('should batch watched tests, not queue', async ({ activate }, testInfo) => {
  if (process.platform === 'win32')
    test.slow();

  const semaphore = testInfo.outputPath('semaphore.txt');
  const { testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/watched.spec.ts': `
      import { test } from '@playwright/test';
      test('foo', async () => {
        console.log('watched content #1');
      });
    `,
    'tests/long-test.spec.ts': `
      import { test } from '@playwright/test';
      import { existsSync } from 'node:fs';
      import { setTimeout } from 'node:timers/promises';
      test('long test', async () => {
        console.log('long test started');
        while (!existsSync('${semaphore}'))
          await setTimeout(10);
      });
    `,
  });

  await testController.expandTestItems(/.*/);
  await testController.watch(testController.findTestItems(/watched/));

  // start blocking run
  const longTestRun = await new Promise<TestRun>(f => {
    testController.onDidCreateTestRun(f);
    testController.run(testController.findTestItems(/long-test/));
  });
  await expect.poll(() => longTestRun.renderOutput()).toContain('long test started');

  // fill up queue
  const queuedTestRuns: TestRun[] = [];
  testController.onDidCreateTestRun(r => queuedTestRuns.push(r));
  await workspaceFolder.changeFile('tests/watched.spec.ts', `
    import { test } from '@playwright/test';
    test('foo', async () => {
      console.log('watched content #2');
    });
  `);
  await workspaceFolder.changeFile('tests/watched.spec.ts', `
    import { test } from '@playwright/test';
    test('foo', async () => {
      console.log('watched content #3');
    });
  `);
  await workspaceFolder.changeFile('tests/watched.spec.ts', `
    import { test } from '@playwright/test';
    test('foo', async () => {
      console.log('watched content #4');
    });
  `);

  // end blocking run to start queued runs
  await new Promise(async f => {
    longTestRun.onDidEnd(f);
    await writeFile(semaphore, '');
  });

  // wait for another run to be done, so we know the queue is empty
  await testController.run(testController.findTestItems(/watched/));

  // one batched run for all changes plus the one above
  expect(queuedTestRuns.length).toBe(2);
});

test('should only watch a test from the enabled project when multiple projects share the same test directory', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright-1.config.js': `module.exports = { testDir: 'tests', projects: [{ name: 'project-from-config1' }] }`,
    'playwright-2.config.js': `module.exports = { testDir: 'tests', projects: [{ name: 'project-from-config2' }] }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('pass 1', async () => {});
      test('pass 2', async () => {});
    `,
  });

  await enableConfigs(vscode, [`playwright-1.config.js`, `playwright-2.config.js`]);

  await selectConfig(vscode, `playwright-2.config.js`);

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  // Wait for the projects to be loaded.
  await expect(webView.getByTestId('projects').locator('div').locator('label')).toHaveCount(1);
  // Disable the project from config 2.
  await enableProjects(vscode, []);
  await expect(vscode).toHaveProjectTree(`
  config: playwright-2.config.js
    [ ] project-from-config2
`);

  await testController.expandTestItems(/test.spec/);
  const testItems = testController.findTestItems(/pass 1/);
  expect(testItems).toHaveLength(1);
  await testController.watch(testItems);
  const [testRun] = await Promise.all([
    new Promise<TestRun>(f => testController.onDidCreateTestRun(testRun => {
      testRun.onDidEnd(() => f(testRun));
    })),
    workspaceFolder.changeFile('tests/test.spec.ts', `
      import { test } from '@playwright/test';
      test('pass 1', async () => {});
      test('pass 2', async () => {});
      test('pass 3', async () => {});
    `),
  ]);

  expect(testRun.renderLog()).toBe(`
    tests > test.spec.ts > pass 1 [2:0]
      enqueued
      enqueued
      started
      passed
  `);

  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
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
          expect.any(String)
        ]
      })
    },
    {
      method: 'watch',
      params: expect.objectContaining({
        fileNames: [expect.stringContaining(`tests${path.sep}test.spec.ts`)],
      })
    },
    {
      method: 'watch',
      params: expect.objectContaining({
        fileNames: [expect.stringContaining(`tests${path.sep}test.spec.ts`)],
      })
    },
    {
      method: 'listTests',
      params: expect.objectContaining({
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)],
      })
    },
    {
      method: 'runTests',
      params: expect.objectContaining({
        locations: undefined,
        testIds: [expect.any(String)]
      })
    },
  ]);
});
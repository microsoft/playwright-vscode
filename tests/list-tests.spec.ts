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

import { enableConfigs, enableProjects, escapedPathSep, expect, test } from './utils';
import fs from 'fs';
import path from 'path';

test('should list tests on expand', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);
  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   one [2:0]
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
  ]);
});

test('should list tests for visible editors', async ({ activate }) => {
  const { vscode, testController } = await activate({
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

  await vscode.openEditors('**/test*.spec.ts');
  await new Promise(f => testController.onDidChangeTestItem(f));

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test1.spec.ts
        -   one [2:0]
      -   test2.spec.ts
        -   two [2:0]
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test1.spec.ts tests/test2.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [
          expect.stringContaining(`tests${escapedPathSep}test1\\.spec\\.ts`),
          expect.stringContaining(`tests${escapedPathSep}test2\\.spec\\.ts`),
        ]
      }
    },
  ]);
});

test('should list suits', async ({ activate }) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
      test('two', async () => {});
      test.describe('group 1', () => {
        test('one', async () => {});
        test('two', async () => {});
      });
      test.describe('group 2', () => {
        test.describe('group 2.1', () => {
          test('one', async () => {});
          test('two', async () => {});
        });
        test('one', async () => {});
        test('two', async () => {});
      });
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);
  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   one [2:0]
        -   two [3:0]
        -   group 1 [4:0]
          -   one [5:0]
          -   two [6:0]
        -   group 2 [8:0]
          -   group 2.1 [9:0]
            -   one [10:0]
            -   two [11:0]
          -   one [13:0]
          -   two [14:0]
  `);
});

test('should discover new tests', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
  ]);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.changeFile('tests/test.spec.ts', `
      import { test } from '@playwright/test';
      test('one', async () => {});
      test('two', async () => {});
    `)
  ]);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   one [2:0]
        -   two [3:0]
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
  ]);
});

test('should discover new tests with active editor', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test1.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
  ]);
  await workspaceFolder.addFile('tests/test2.spec.ts', `
    import { test } from '@playwright/test';
    test('two', async () => {});
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright list-files -c playwright.config.js
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'listFiles', params: {} },
  ]);
  await Promise.all([
    new Promise<void>(f => {
      testController.onDidChangeTestItem(ti => {
        if (ti.label.includes('test2.spec'))
          f();
      });
    }),
    vscode.openEditors('**/test2.spec.ts'),
  ]);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test1.spec.ts
      -   test2.spec.ts
        -   two [2:0]
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test2.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test2\\.spec\\.ts`)]
      }
    },
  ]);
});

test('should discover tests on add + change', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: './' }`,
  });

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.addFile('test.spec.ts', ``)
  ]);

  await expect(testController).toHaveTestTree(`
    -   test.spec.ts
  `);

  await testController.expandTestItems(/test.spec.ts/);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.changeFile('test.spec.ts', `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `)
  ]);

  await expect(testController).toHaveTestTree(`
    -   test.spec.ts
      -   one [2:0]
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null test.spec.ts
    > playwright test -c playwright.config.js --list --reporter=null test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`test\\.spec\\.ts`)]
      }
    },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`test\\.spec\\.ts`)]
      }
    },
  ]);
});

test('should discover new test at existing location', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
  ]);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.changeFile('tests/test.spec.ts', `
      import { test } from '@playwright/test';
      test('two', async () => {});
    `)
  ]);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   two [2:0]
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
  ]);
});

test('should remove deleted tests', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
      test('two', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
  ]);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   one [2:0]
        -   two [3:0]
  `);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.changeFile('tests/test.spec.ts', `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `)
  ]);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   one [2:0]
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
  ]);
});

test('should forget tests after error before first test', async ({ activate }) => {
  const { testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
      test('two', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   one [2:0]
        -   two [3:0]
  `);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.changeFile('tests/test.spec.ts', `
      import { test } from '@playwright/test';
      test('one', async () => {});
      throw new Error('Uncaught');
      test('two', async () => {});
    `)
  ]);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
  `);
});

test('should regain tests after error is fixed', async ({ activate }) => {
  const { vscode, testController, workspaceFolder } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      throw new Error('Uncaught');
      test('one', async () => {});
      test('two', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
  ]);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
  `);

  await Promise.all([
    new Promise(f => testController.onDidChangeTestItem(f)),
    workspaceFolder.changeFile('tests/test.spec.ts', `
      import { test } from '@playwright/test';
      test('one', async () => {});
      test('two', async () => {});
    `)
  ]);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   one [2:0]
        -   two [3:0]
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
    > playwright test -c playwright.config.js --list --reporter=null tests/test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
  ]);
});

test('should support multiple configs', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'tests1/playwright.config.js': `module.exports = { testDir: '.' }`,
    'tests2/playwright.config.js': `module.exports = { testDir: '.' }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests2/test.spec.ts': `
      import { test } from '@playwright/test';
      test('two', async () => {});
    `,
  });

  await enableConfigs(vscode, [`tests1${path.sep}playwright.config.js`, `tests2${path.sep}playwright.config.js`]);

  await expect(testController).toHaveTestTree(`
    -   tests1
      -   test.spec.ts
    -   tests2
      -   test.spec.ts
  `);

  await testController.expandTestItems(/test.spec/);

  await expect(testController).toHaveTestTree(`
    -   tests1
      -   test.spec.ts
        -   one [2:0]
    -   tests2
      -   test.spec.ts
        -   two [2:0]
  `);

  await expect(vscode).toHaveExecLog(`
    tests1> playwright list-files -c playwright.config.js
    tests2> playwright list-files -c playwright.config.js
    tests1> playwright test -c playwright.config.js --list --reporter=null test.spec.ts
    tests2> playwright test -c playwright.config.js --list --reporter=null test.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests1${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests2${escapedPathSep}test\\.spec\\.ts`)]
      }
    },
  ]);
});

test('should support multiple projects', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      testDir: './tests',
      projects: [
        { name: 'project 1', testMatch: /test1.spec/ },
        { name: 'project 2', testMatch: /test2.spec/ },
      ]
    }`,
    'tests/test1.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests/test2.spec.ts': `
      import { test } from '@playwright/test';
      test(two', async () => {});
    `,
  });

  await enableProjects(vscode, ['project 1', 'project 2']);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test1.spec.ts
      -   test2.spec.ts
  `);

  await testController.expandTestItems(/test1.spec/);

  await expect(testController).toHaveTestTree(`
    -   tests
      -   test1.spec.ts
        -   one [2:0]
      -   test2.spec.ts
  `);

  await expect(vscode).toHaveExecLog(`
    > playwright list-files -c playwright.config.js
    > playwright test -c playwright.config.js --list --reporter=null tests/test1.spec.ts
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    {
      method: 'listTests',
      params: {
        locations: [expect.stringContaining(`tests${escapedPathSep}test1\\.spec\\.ts`)]
      }
    },
  ]);
});

test('should list parametrized tests', async ({ activate }) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      for (const name of ['one', 'two', 'three'])
        test(name, async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);
  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   one [3:0]
        -   three [3:0]
        -   two [3:0]
  `);
});

test('should list tests in parametrized groups', async ({ activate }) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      for (const foo of [1, 2]) {
        test.describe('level ' + foo, () => {
          test('should work', async () => {});
        });
      }
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);
  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   level 1 [3:0]
          -   should work [4:0]
        -   level 2 [3:0]
          -   should work [4:0]
  `);
});

test('should not run config reporters', async ({ activate }, testInfo) => {
  const { testController } = await activate({
    'playwright.config.js': `module.exports = {
      testDir: 'tests',
      reporter: 'html',
    }`,
    'tests/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });

  await testController.expandTestItems(/test.spec.ts/);
  await expect(testController).toHaveTestTree(`
    -   tests
      -   test.spec.ts
        -   one [2:0]
  `);

  expect(fs.existsSync(testInfo.outputPath('playwright-report'))).toBeFalsy();
});

test('should list tests in multi-folder workspace', async ({ activate }, testInfo) => {
  const { vscode, testController } = await activate({}, {
    workspaceFolders: [
      [testInfo.outputPath('folder1'), {
        'playwright.config.js': `module.exports = { testDir: './' }`,
        'test.spec.ts': `
          import { test } from '@playwright/test';
          test('one', async () => {});
        `,
      }],
      [testInfo.outputPath('folder2'), {
        'playwright.config.js': `module.exports = { testDir: './' }`,
        'test.spec.ts': `
          import { test } from '@playwright/test';
          test('two', async () => {});
        `,
      }]
    ]
  });

  await enableConfigs(vscode, [`folder1${path.sep}playwright.config.js`, `folder2${path.sep}playwright.config.js`]);

  await expect(testController).toHaveTestTree(`
    -   folder1
      -   test.spec.ts
    -   folder2
      -   test.spec.ts
  `);

  await testController.expandTestItems(/test.spec.ts/);
  await expect(testController).toHaveTestTree(`
    -   folder1
      -   test.spec.ts
        -   one [2:0]
    -   folder2
      -   test.spec.ts
        -   two [2:0]
  `);
});

test('should merge items from different projects', async ({ activate }, testInfo) => {
  const { vscode, testController } = await activate({
    'playwright.config.ts': `module.exports = {
      projects: [
        { name: 'desktop', grepInvert: /mobile|tablet/ },
        { name: 'mobile', grep: /@mobile/ },
        { name: 'tablet', grep: /@tablet/ },
      ]
    }`,
    'test.spec.ts': `
      import { test } from '@playwright/test';
      test.describe('group', () => {
        test('test 1', async () => {});
        test('test 2 [@mobile]', async () => {});
        test('test 3 [@mobile]', async () => {});
        test('test 4', async () => {});
      });`,
  });

  await enableProjects(vscode, ['desktop', 'mobile', 'tablet']);

  await testController.expandTestItems(/test.spec.ts/);
  await testController.expandTestItems(/group/);
  await expect(testController).toHaveTestTree(`
    -   test.spec.ts
      -   group [2:0]
        -   test 1 [3:0]
        -   test 2 [@mobile] [4:0]
        -   test 3 [@mobile] [5:0]
        -   test 4 [6:0]
  `);
});

test('should show project-specific tests', async ({ activate }, testInfo) => {
  const { vscode, testController } = await activate({
    'playwright.config.ts': `module.exports = {
      projects: [
        { name: 'chromium' },
        { name: 'firefox' },
        { name: 'webkit' },
      ]
    }`,
    'test.spec.ts': `
      import { test } from '@playwright/test';
      test('test', async () => {});
    `
  });

  await expect(testController).toHaveTestTree(`
    -   test.spec.ts
  `);

  await testController.expandTestItems(/test.spec.ts/);
  await expect(testController).toHaveTestTree(`
    -   test.spec.ts
      -   test [2:0]
  `);

  await enableProjects(vscode, ['chromium', 'firefox', 'webkit']);
  await expect(testController).toHaveTestTree(`
    -   test.spec.ts
      -   test [2:0]
        -   chromium [2:0]
        -   firefox [2:0]
        -   webkit [2:0]
  `);

  await enableProjects(vscode, ['webkit']);
  await expect(testController).toHaveTestTree(`
    -   test.spec.ts
      -   test [2:0]
  `);
});

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

import { enableProjects, expect, test } from './utils';

const testsWithSetup = {
  'playwright.config.ts': `
    import { defineConfig } from '@playwright/test';
    export default defineConfig({
      projects: [
        { name: 'setup', teardown: 'teardown', testMatch: 'setup.ts' },
        { name: 'test', testMatch: 'test.ts', dependencies: ['setup'] },
        { name: 'teardown', testMatch: 'teardown.ts' },
      ]
    });
  `,
  'setup.ts': `
    import { test, expect } from '@playwright/test';
    test('setup', async ({}) => {
      console.log('from-setup');
    });
  `,
  'test.ts': `
    import { test, expect } from '@playwright/test';
    test('test', async ({}) => {
      console.log('from-test');
    });
  `,
  'teardown.ts': `
    import { test, expect } from '@playwright/test';
    test('teardown', async ({}) => {
      console.log('from-teardown');
    });
  `,
};

test.describe(() => {
  test.skip(({ overridePlaywrightVersion }) => !!overridePlaywrightVersion);
  test('should run setup and teardown projects (1)', async ({ activate }) => {
    const { vscode, testController } = await activate(testsWithSetup);
    await enableProjects(vscode, ['setup', 'teardown', 'test']);
    const testRun = await testController.run();

    await expect(testController).toHaveTestTree(`
    -   setup.ts
      - ✅ setup [2:0]
    -   teardown.ts
      - ✅ teardown [2:0]
    -   test.ts
      - ✅ test [2:0]
  `);

    const output = testRun.renderLog({ output: true });
    expect(output).toContain('from-setup');
    expect(output).toContain('from-test');
    expect(output).toContain('from-teardown');
  });

  test('should run setup and teardown projects (2)', async ({ activate }) => {
    const { vscode, testController } = await activate(testsWithSetup);
    await enableProjects(vscode, ['teardown', 'test']);
    const testRun = await testController.run();

    await expect(testController).toHaveTestTree(`
    -   teardown.ts
      - ✅ teardown [2:0]
    -   test.ts
      - ✅ test [2:0]
  `);

    const output = testRun.renderLog({ output: true });
    expect(output).not.toContain('from-setup');
    expect(output).toContain('from-test');
    expect(output).toContain('from-teardown');
  });

  test('should run setup and teardown projects (3)', async ({ activate }) => {
    const { vscode, testController } = await activate(testsWithSetup);
    await enableProjects(vscode, ['test']);
    const testRun = await testController.run();

    await expect(testController).toHaveTestTree(`
    -   test.ts
      - ✅ test [2:0]
  `);

    const output = testRun.renderLog({ output: true });
    expect(output).not.toContain('from-setup');
    expect(output).toContain('from-test');
    expect(output).not.toContain('from-teardown');
  });

  test('should run part of the setup only', async ({ activate }) => {
    const { vscode, testController } = await activate(testsWithSetup);
    await enableProjects(vscode, ['setup', 'teardown', 'test']);

    await testController.expandTestItems(/setup.ts/);
    const testItems = testController.findTestItems(/setup/);
    await testController.run(testItems);

    await expect(testController).toHaveTestTree(`
    -   setup.ts
      - ✅ setup [2:0]
    -   teardown.ts
      - ✅ teardown [2:0]
    -   test.ts
  `);
  });
});

test('should run setup and teardown for test', async ({ activate }) => {
  const { vscode, testController } = await activate(testsWithSetup);
  await enableProjects(vscode, ['setup', 'teardown', 'test']);

  await testController.expandTestItems(/test.ts/);
  const testItems = testController.findTestItems(/test/);
  await testController.run(testItems);

  await expect(testController).toHaveTestTree(`
    -   setup.ts
      - ✅ setup [2:0]
    -   teardown.ts
      - ✅ teardown [2:0]
    -   test.ts
      - ✅ test [2:0]
  `);
});

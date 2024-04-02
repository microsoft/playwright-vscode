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

import { enableConfigs, enableProjects, expect, test } from './utils';
import path from 'path';

test('should switch between configs', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'tests1/playwright.config.js': `module.exports = { testDir: '.', projects: [{ name: 'projectOne' }, { name: 'projectTwo' }] }`,
    'tests2/playwright.config.js': `module.exports = { testDir: '.', projects: [{ name: 'projectThree' }, { name: 'projectFour' }] }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests2/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
  });
  await expect(testController).toHaveTestTree(`
    -   tests1
      -   test.spec.ts
  `);
  await expect(vscode).toHaveProjectTree(`
    config: tests1/playwright.config.js
    [x] projectOne
    [ ] projectTwo
  `);

  await expect(vscode).toHaveExecLog(`
    tests1> playwright list-files -c playwright.config.js
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
  ]);

  await enableConfigs(vscode, [`tests2${path.sep}playwright.config.js`]);

  await expect(vscode).toHaveProjectTree(`
    config: tests2/playwright.config.js
    [x] projectThree
    [ ] projectFour
  `);

  await expect(testController).toHaveTestTree(`
    -   tests2
      -   test.spec.ts
  `);
  await expect(vscode).toHaveExecLog(`
    tests1> playwright list-files -c playwright.config.js
    tests2> playwright list-files -c playwright.config.js
  `);
  await expect(vscode).toHaveConnectionLog([
    { method: 'listFiles', params: {} },
    { method: 'listFiles', params: {} },
  ]);
});

test('should switch between projects', async ({ activate }) => {
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      projects: [
        { name: 'projectOne', testDir: 'tests1', },
        { name: 'projectTwo', testDir: 'tests2', },
      ]
    }`,
    'tests1/test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async () => {});
    `,
    'tests2/test.spec.ts': `
      import { test } from '@playwright/test';
      test('two', async () => {});
    `,
  });

  await expect(testController).toHaveTestTree(`
    -   tests1
      -   test.spec.ts
  `);

  await expect(vscode).toHaveProjectTree(`
    config: playwright.config.js
    [x] projectOne
    [ ] projectTwo
  `);

  await enableProjects(vscode, ['projectOne', 'projectTwo']);

  await expect(vscode).toHaveProjectTree(`
    config: playwright.config.js
    [x] projectOne
    [x] projectTwo
  `);

  await expect(testController).toHaveTestTree(`
    -   tests1
      -   test.spec.ts
    -   tests2
      -   test.spec.ts
  `);

  await enableProjects(vscode, ['projectTwo']);

  await expect(vscode).toHaveProjectTree(`
    config: playwright.config.js
    [ ] projectOne
    [x] projectTwo
  `);
});

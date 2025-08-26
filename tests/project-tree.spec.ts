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
    -    [tests1${path.sep}playwright.config.js [projectTwo] — disabled]
  `);
  await expect(vscode).toHaveProjectTree(`
    config: tests1/playwright.config.js
    [x] projectOne
    [ ] projectTwo
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
    -    [tests2${path.sep}playwright.config.js [projectFour] — disabled]
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
    -    [playwright.config.js [projectTwo] — disabled]
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

test('should hide unchecked projects', async ({ activate }) => {
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
    -    [playwright.config.js [projectTwo] — disabled]
  `);

  await expect(vscode).toHaveProjectTree(`
    config: playwright.config.js
    [x] projectOne
    [ ] projectTwo
  `);

  await enableProjects(vscode, []);

  await expect(vscode).toHaveProjectTree(`
    config: playwright.config.js
    [ ] projectOne
    [ ] projectTwo
  `);

  await expect(testController).toHaveTestTree(`
    -    [playwright.config.js [projectOne] — disabled]
    -    [playwright.config.js [projectTwo] — disabled]
  `);
});

test('should hide project section when there is just one', async ({ activate }) => {
  const { vscode } = await activate({
    'playwright.config.js': `module.exports = {
      projects: [
        { name: 'projectOne', testDir: 'tests1', },
      ]
    }`,
    'foo/playwright.config.js': `module.exports = { testDir: '.', projects: [{ name: 'projectTwo' }, { name: 'projectThree' }] }`,
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;
  await expect(webView.getByRole('heading', { name: 'PROJECTS' })).not.toBeVisible();

  await enableConfigs(vscode, [`playwright.config.js`, `foo${path.sep}playwright.config.js`]);
  await expect(vscode, 'when two configs are enabled, and the other one has projects multiple, we show it').toHaveProjectTree(`
    config: playwright.config.js
    [x] projectOne
  `);
});

test('should treat project as enabled when UI for it is hidden', async ({ activate }) => {
  const { vscode, workspaceFolder, testController } = await activate({
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
  });

  const webView = vscode.webViews.get('pw.extension.settingsView')!;

  await enableProjects(vscode, ['projectTwo']);
  await expect(vscode).toHaveProjectTree(`
    config: playwright.config.js
    [ ] projectOne
    [x] projectTwo
  `);

  await workspaceFolder.changeFile('playwright.config.js', `module.exports = {
    projects: [
      { name: 'projectOne', testDir: 'tests1', },
    ]
  }`);
  await expect(webView.getByRole('heading', { name: 'PROJECTS' })).not.toBeVisible();
  await expect(testController).toHaveTestTree(`
    -   tests1
      -   test.spec.ts
  `);
});

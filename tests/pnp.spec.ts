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

import { enableConfigs, expect, test } from './utils';
import fs from 'node:fs/promises';
import path from 'node:path';

test('should pick up .pnp.cjs file closest to config', async ({ activate }, testInfo) => {
  const pnpCjsOutfile = testInfo.outputPath('pnp-cjs.txt');
  const esmLoaderInfile = testInfo.outputPath('esm-loader-in.txt');
  const esmLoaderOutfile = testInfo.outputPath('esm-loader-out.txt');
  await fs.writeFile(esmLoaderInfile, 'untouched');

  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    '.pnp.cjs': `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(pnpCjsOutfile)}, "root");
    `,
    '.pnp.loader.mjs': `
      import fs from 'node:fs';
      fs.copyFileSync(${JSON.stringify(esmLoaderInfile)}, ${JSON.stringify(esmLoaderOutfile)});
    `,
    'tests/root.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,

    'foo/playwright.config.js': `module.exports = { testDir: 'tests' }`,
    'foo/.pnp.cjs': `
      const fs = require("node:fs");
      fs.writeFileSync(${JSON.stringify(pnpCjsOutfile)}, "foo");
    `,
    'foo/tests/foo.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });
  await enableConfigs(vscode, ['playwright.config.js', `foo${path.sep}playwright.config.js`]);

  await expect(testController).toHaveTestTree(`
    -   foo
      -   tests
        -   foo.spec.ts
    -   tests
      -   root.spec.ts
  `);

  let testRun = await testController.run(testController.findTestItems(/foo/));
  expect(testRun.renderLog()).toContain('passed');
  expect(await fs.readFile(pnpCjsOutfile, 'utf-8')).toBe('foo');

  await fs.writeFile(esmLoaderInfile, 'root');
  testRun = await testController.run(testController.findTestItems(/root/));
  expect(testRun.renderLog()).toContain('passed');
  expect(await fs.readFile(pnpCjsOutfile, 'utf-8')).toBe('root');
  expect(await fs.readFile(esmLoaderOutfile, 'utf-8')).toBe('root');
});
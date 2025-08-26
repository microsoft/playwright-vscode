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

import { expect, test } from './utils';
import fs from 'node:fs/promises';

test('should pick up .pnp.cjs', async ({ activate }, testInfo) => {
  const outfile = testInfo.outputPath('output.txt');
  const { testController } = await activate({
    'playwright.config.js': `module.exports = { testDir: 'tests' }`,
    '.pnp.cjs': `
      const fs = require("node:fs");
      fs.writeFileSync("${outfile}", "foo");
    `,
    'tests/test-1.spec.ts': `
      import { test } from '@playwright/test';
      test('should pass', async () => {});
    `,
  });

  const testRun = await testController.run();
  expect(testRun.renderLog()).toContain('passed');
  expect(await fs.readFile(outfile, 'utf-8')).toBe('foo');
});
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
import { test, expect } from './baseTest';

test('should be able to execute the first test of the example project', async ({ workbox }) => {
  await workbox.getByRole('treeitem', { name: 'tests', exact: true }).locator('a').click();
  await workbox.getByRole('treeitem', { name: 'example.spec.ts' }).locator('a').click();
  await expect(workbox.locator('.testing-run-glyph'), 'there are two tests in the file').toHaveCount(2);
  await workbox.locator('.testing-run-glyph').first().click();
  const passedLocator = workbox.locator('.monaco-editor').locator('.codicon-testing-passed-icon');
  await expect(passedLocator).toHaveCount(1);
});

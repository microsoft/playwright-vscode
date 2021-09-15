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
import { expect, test } from '@playwright/test';

if (!process.env.FOO)
  throw new Error('no env set');

test('1212me', async ({page}) => {
  expect(await page.evaluate(() => window.navigator.userAgent)).toContain('WebKit');
});

test.describe('should be awesome²', () => {
  test.describe('layer 2', () => {
    test('last-test-name', () => {
      expect(1).toBe(1);
    });
  });
});
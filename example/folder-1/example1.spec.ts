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

test("should be awesome1", () => {
  expect(1).toBe(1);
});

test.describe("should be awesome²", () => {
  test("me", () => {
    expect(2).toBe(1);
  });
  test("you", () => {
    expect(1).toBe(1);
  });
  test("he", () => {
    expect(1).toBe(1);
  });
  test("she123", ({page}) => {
    expect(1).toBe(1);
  });
  test("it", () => {
    expect(1).toBe(1);
  });

  test("but not my cat", () => {
    expect(1).toBe(1);
  });
});

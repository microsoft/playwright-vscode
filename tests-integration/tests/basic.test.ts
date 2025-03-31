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
import { test } from './baseTest';


test.extend({ usePnp: true })(`should be able to execute the first test of the example project for pnp`, async ({ testkit }) => {
  await testkit.enableAllConfigs();
  await testkit.runTestInFile('tests/example.spec.ts');
  await testkit.runTestInFile('other/tests/example.spec.ts');
});

test(`should be able to execute the first test of the example project`, async ({ testkit }) => {
  await testkit.runTestInFile('tests/example.spec.ts');
});



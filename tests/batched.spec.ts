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

import { JSHandle } from '@playwright/test';
import { test as baseTest, expect } from './utils';
import { Batched } from '../src/batched';

const test = baseTest.extend<{ Batched: JSHandle<typeof Batched> }>({
  Batched: async ({ vscode, page }, use) => {
    await page.clock.install();
    await page.clock.pauseAt(Date.now());

    await page.evaluate(`globalThis._events = { EventEmitter: (${vscode.EventEmitter.toString()}) }`);
    await page.evaluate(`globalThis.CancellationTokenSource = (${vscode.CancellationTokenSource.toString()})`);

    const clazz = await page.evaluateHandle<typeof Batched>(`(${Batched.toString()})`);
    await use(clazz);
  }
});


test('coalescing', async ({ page, Batched }) => {
  const batched = await Batched.evaluateHandle(Batched => {
    const start: number[] = [];
    const end: number[] = [];
    const batched = new Batched<void>(globalThis as any, async () => {
      const now = Date.now();
      start.push(now);
      await new Promise(res => setTimeout(res, 2));
      end.push(Date.now());
    }, 1);
    return { start, end, batched };
  });

  // invocations within the batching window are coalesced
  const invocation1 = batched.evaluate(({ batched }) => batched.invoke());
  const invocation2 = batched.evaluate(({ batched }) => batched.invoke());
  await page.clock.runFor(1);
  expect(await batched.evaluate(({ start }) => start.length)).toBe(1);
  await page.clock.runFor(2);
  expect(await invocation1).toBe(await invocation2);
  expect(await batched.evaluate(({ end }) => end.length)).toBe(1);

  // invocations during execution get their own batch
  const invocation3 = batched.evaluate(({ batched }) => batched.invoke());
  await page.clock.runFor(1);
  expect(await batched.evaluate(({ start }) => start.length)).toBe(2);
  expect(await batched.evaluate(({ end }) => end.length)).toBe(1);
  const invocation4 = batched.evaluate(({ batched }) => batched.invoke());
  await page.clock.runFor(2);
  await invocation3;
  expect(await batched.evaluate(({ start }) => start.length)).toBe(2);
  expect(await batched.evaluate(({ end }) => end.length)).toBe(2);

  await page.clock.runFor(1);
  await invocation3;
  await invocation4;
});
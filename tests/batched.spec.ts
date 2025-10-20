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

import { test, expect } from './utils';
import { Batched } from '../src/batched';

test('batched', async ({ page, vscode }) => {
  await page.clock.install();
  await page.clock.pauseAt(Date.now());

  await page.evaluate(`globalThis._events = { EventEmitter: (${vscode.EventEmitter.toString()}) }`);
  await page.evaluate(`globalThis.CancellationTokenSource = (${vscode.CancellationTokenSource.toString()})`);

  const clazz = await page.evaluateHandle<typeof Batched>(`(${Batched.toString()})`);
  const batched = await clazz.evaluateHandle(Batched => {
    const log: string[] = [];
    const batched = new Batched<number>(globalThis as any, async inputs => {
      log.push(`start ${inputs.join(',')}`);
      await new Promise(res => setTimeout(res, 2));
      log.push(`end   ${inputs.join(',')}`);
    }, 1);
    return { batched, log };
  });

  // invocations within the batching window are coalesced
  const invocation1 = batched.evaluate(({ batched }) => batched.invoke(1));
  const invocation2 = batched.evaluate(({ batched }) => batched.invoke(2));
  await page.clock.runFor(1);
  expect(await batched.evaluate(b => b.log)).toEqual([
    'start 1,2'
  ]);
  await page.clock.runFor(2);
  expect(await invocation1).toBe(await invocation2);
  expect(await batched.evaluate(b => b.log)).toEqual([
    'start 1,2',
    'end   1,2'
  ]);

  // invocations during execution get their own batch
  const invocation3 = batched.evaluate(({ batched }) => batched.invoke(3));
  await page.clock.runFor(1);
  expect(await batched.evaluate(b => b.log)).toEqual([
    'start 1,2',
    'end   1,2',
    'start 3'
  ]);

  // invocation during ongoing execution creates a new batch
  const invocation4 = batched.evaluate(({ batched }) => batched.invoke(4));
  await page.clock.runFor(2);
  await invocation3;
  expect(await batched.evaluate(b => b.log)).toEqual([
    'start 1,2',
    'end   1,2',
    'start 3',
    'end   3',
    'start 4'
  ]);

  await page.clock.runFor(2);
  await invocation4;
  expect(await batched.evaluate(b => b.log)).toEqual([
    'start 1,2',
    'end   1,2',
    'start 3',
    'end   3',
    'start 4',
    'end   4'
  ]);
});
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

import { chromium } from '@playwright/test';
import { expect, test } from './utils';

test.beforeEach(({ showBrowser }) => {
  // Locator highlighting is only relevant when the browser stays open.
  test.skip(!showBrowser);
  // the x-pw-highlight element has otherwise a closed shadow root.
  process.env.PWTEST_UNDER_TEST = '1';
  process.env.PW_DEBUG_CONTROLLER_HEADLESS = '1';
});

test('should work', async ({ activate }) => {
  const cdpPort = 9234 + test.info().workerIndex * 2;
  const { vscode, testController } = await activate({
    'playwright.config.js': `module.exports = {
      use: {
        launchOptions: {
          args: ['--remote-debugging-port=${cdpPort}']
        }
      }
    }`,
    'test.spec.ts': `
      import { test } from '@playwright/test';
      test('one', async ({ page }) => {
        await page.goto('https://example.com');
        await page.setContent(\`
          <button>one</button>
          <button>two</button>
        \`);
        await page.getByRole('button', { name: 'one' }).click(); // line 8
        await page.getByRole('button', { name: 'two' }).click(); // line 9
        page.getByRole('button', { name: 'not there!' });        // line 10
      });

      class MyPom {
        constructor(page) {
          this.myElementOne1 = page.getByRole('button', { name: 'one' });       // line 15
          this.myElementTwo1 = this._page.getByRole('button', { name: 'two' }); // line 16
          this.myElementOne2 = this.page.getByRole('button', { name: 'one' });  // line 17
        }

        @step // decorators require a babel plugin
        myMethod() {}
      }

      function step(target: Function, context: ClassMethodDecoratorContext) {
        return function replacementMethod(...args: any) {
          const name = this.constructor.name + '.' + (context.name as string);
          return test.step(name, async () => {
            return await target.call(this, ...args);
          });
        };
      }
    `,
  });

  const testItems = testController.findTestItems(/test.spec.ts/);
  expect(testItems.length).toBe(1);
  await vscode.openEditors('test.spec.ts');
  await testController.run(testItems);
  const browser = await chromium.connectOverCDP(`http://localhost:${cdpPort}`);
  {
    expect(browser.contexts()).toHaveLength(1);
    expect(browser.contexts()[0].pages()).toHaveLength(1);
  }
  const page = browser.contexts()[0].pages()[0];

  for (const language of ['javascript', 'typescript']) {
    for (const [[line, column], expectedLocator] of [
      [[9, 26], page.getByRole('button', { name: 'two' })],
      [[8, 26], page.getByRole('button', { name: 'one' })],
      [[10, 26], null],
      [[15, 30], page.getByRole('button', { name: 'one' })],
      [[16, 30], page.getByRole('button', { name: 'two' })],
      [[17, 30], page.getByRole('button', { name: 'one' })],
    ] as const) {
      await test.step(`should highlight ${language} ${line}:${column}`, async () => {
        vscode.languages.emitHoverEvent(language, vscode.window.activeTextEditor.document, new vscode.Position(line, column));
        await expect(async () => {
          if (!expectedLocator)
            await expect(page.locator('x-pw-highlight')).toBeHidden();
          else
            expect(await page.locator('x-pw-highlight').boundingBox()).toEqual(await expectedLocator.boundingBox());
        }).toPass();
      });
    }
  }
  await browser.close();
});

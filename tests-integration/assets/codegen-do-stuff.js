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

// @ts-check
const { chromium } = require('@playwright/test');

const WS_ADDRESS = process.argv[2];

(async () => {
  const browser = await chromium.connect(WS_ADDRESS, {
    headers: { 'x-playwright-reuse-context': '1' }
  });
  let pages = [];
  while (true) {
    // @ts-ignore
    const context = await browser._newContextForReuse();
    pages = context.pages();
    if (pages.length > 0)
      break;
    console.log('waiting for page...', browser.contexts()[0].pages().length);
    await new Promise(f => setTimeout(f, 100));
  }
  const page = pages[0];
  await page.goto('data:text/html,<input data-testid="my-input"/>');
  await page.getByTestId('my-input').fill('Hello World');
  await browser.close();
})().catch(e => {
  console.error(e);
  process.exit(1);
});

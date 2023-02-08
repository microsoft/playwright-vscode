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
const assert = require('assert');
const path = require('path');

const vscode = require('vscode');
const childProcess = require('child_process');

/** @type {import('../../src/extension').Extension} */
const extension = vscode.extensions.getExtension('ms-playwright.playwright')?.exports;

suite('Extension Test Suite', () => {
  test('Sample test', async () => {
    await vscode.commands.executeCommand('pw.extension.settingsView.focus');
    vscode.commands.executeCommand('pw.extension.command.recordNew');

    while (!extension.browserServerWSForTest())
      await new Promise(f => setTimeout(f, 100));

    await new Promise(f => setTimeout(f, 2000));

    const document = vscode.window.activeTextEditor?.document;

    assert.equal(document?.languageId, 'typescript');
    assert.equal(document?.getText(), `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  // Recording...
});`);

    // We need to perform this out-of-process because Playwright does not work inside Electron for some reason (reports no pages).
    await new Promise(resolve => {
      const child = childProcess.spawn('node', [path.join(__dirname, '../assets/codegen-do-stuff.js'), extension.browserServerWSForTest()], {
        stdio: 'inherit',
      });
      child.on('close', resolve);
    });

    assert.equal(document?.getText(), `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  await page.goto('about:blank');
  await page.goto('data:text/html,<input data-testid="my-input"/>');
  await page.getByTestId('my-input').fill('Hello World');
});`);
  });
});

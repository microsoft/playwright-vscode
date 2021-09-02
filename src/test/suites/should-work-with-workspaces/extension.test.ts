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
import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import * as playwrightTestExtension from '../../../extension';
import { assertTestItemTree, itemCollectionToArray, openFile } from '../utils';

suite('Basic file parsing', () => {
  test('does parse workspace files correctly', async () => {
    const waitForTestResolveHandler = new Promise<void>(resolve => {
      const capturedTests = [];
      playwrightTestExtension.testControllerEvents.on('testItemCreated', (testItem: vscode.TestItem) => {
        capturedTests.push(testItem.label);
        if (capturedTests.length === 2)
          resolve();
      });
    });
    for (const workspaceFolder of vscode.workspace.workspaceFolders!)
      await openFile('example1.spec.ts', workspaceFolder);
    await waitForTestResolveHandler;
    assert.strictEqual(playwrightTestExtension.testControllers.length, 2);

    {
      assert.strictEqual(playwrightTestExtension.testControllers[0].label, 'Playwright Test [a]');
      const items = itemCollectionToArray(playwrightTestExtension.testControllers[0].items);
      assert.strictEqual(items.length, 1);
      assertTestItemTree(items[0], {
        label: 'example1.spec.ts',
        children: [{
          label: 'this is workspace a',
        }]
      });
    }

    {
      assert.strictEqual(playwrightTestExtension.testControllers[1].label, 'Playwright Test [b]');
      const items = itemCollectionToArray(playwrightTestExtension.testControllers[1].items);
      assert.strictEqual(items.length, 1);
      assertTestItemTree(items[0], {
        label: 'example1.spec.ts',
        children: [{
          label: 'this is workspace b',
        }]
      });
    }
  });
});

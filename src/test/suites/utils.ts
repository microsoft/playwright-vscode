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

import * as vscode from 'vscode';

type Node = {
  label: string,
  children?: Node[],
}

export function assertTestItemTree(actual: vscode.TestItem, expected: Node) {
  assert.strictEqual(actual.label, expected.label);
  const actualChildren = itemCollectionToArray(actual.children);
  assert.strictEqual(actualChildren.length, (expected.children || []).length);
  for (const [idx, children] of actualChildren.entries())
    assertTestItemTree(children, expected.children![idx]);
}

export function itemCollectionToArray(collection: vscode.TestItemCollection): vscode.TestItem[] {
  const items: vscode.TestItem[] = [];
  collection.forEach(item => items.push(item));
  return items;
}

export async function openFile(path: string) {
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, path);
  await vscode.commands.executeCommand('vscode.open', uri);
}

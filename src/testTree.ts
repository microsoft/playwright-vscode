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

import path from 'path';
import { vscode } from './embedder';
import * as vscodeTypes from './vscodeTypes';
import { createGuid } from './utils';

export type Config = {
  workspaceFolder: string;
  configFile: string;
  testDir?: string;
  cli: string;
};

type TestItemData = {
  location: string;
  isLoaded?: boolean;
  configs?: Set<Config>;
};

export class TestTree {
  // We don't want tests to persist state between sessions, so we are using unique test id prefixes.
  private _testGeneration = '';

  // Global test item map testItem.id => testItem.
  private _testItems = new Map<string, { testItem: vscodeTypes.TestItem, data: TestItemData }>();

  private _testController: vscodeTypes.TestController;

  constructor(testController: vscodeTypes.TestController) {
    this._testController = testController;
  }

  startedLoading() {
    this._testItems.clear();
    this._testGeneration = createGuid() + ':';
    if (!vscode.workspace.workspaceFolders?.length)
      return;
    this._testController.items.replace([
      this._testController.createTestItem('loading', 'Loading\u2026')
    ]);
  }

  finishedLoading(rootItems: vscodeTypes.TestItem[]) {
    this._testController.items.replace(rootItems);
  }

  location(testItem: vscodeTypes.TestItem): string | undefined {
    return this._testItems.get(testItem.id)?.data.location;
  }

  attributeToConfig(fileItem: vscodeTypes.TestItem, config: Config) {
    const data = this._testItems.get(fileItem.id)!.data;
    if (!data.configs)
      data.configs = new Set();
    data.configs.add(config);
  }

  configs(fileItem: vscodeTypes.TestItem): Config[] {
    const configs = this._testItems.get(fileItem.id)!.data.configs;
    return configs ? [...configs] : [];
  }

  isLoaded(fileItem: vscodeTypes.TestItem): boolean {
    return this._testItems.get(fileItem.id)!.data.isLoaded || false;
  }

  setLoaded(testItem: vscodeTypes.TestItem, loaded: boolean) {
    this._testItems.get(testItem.id)!.data.isLoaded = loaded;
  }

  getForLocation(location: string): vscodeTypes.TestItem | undefined {
    return this._testItems.get(this._id(location))?.testItem;
  }

  delete(testItem: vscodeTypes.TestItem) {
    this.unbindChildren(testItem);
    this._testItems.delete(testItem.id);
    testItem.parent!.children.delete(testItem.id);
  }

  unbindChildren(fileItem: vscodeTypes.TestItem) {
    fileItem.children.forEach(c => {
      this.unbindChildren(c);
      this._testItems.delete(c.id);
    });
  }

  createForLocation(label: string, uri: vscodeTypes.Uri, line?: number): vscodeTypes.TestItem {
    const hasLine = typeof line === 'number';
    const location = hasLine ? uri.fsPath + ':' + line : uri.fsPath;
    const testItem = this._testController.createTestItem(this._id(location), label, uri);
    this._testItems.set(testItem.id, {
      testItem,
      data: {
        location: hasLine ? uri.fsPath + ':' + line : uri.fsPath,
        isLoaded: false
      }
    });
    if (hasLine)
      testItem.range = new vscode.Range(line - 1, 0, line, 0);
    return testItem;
  }

  getOrCreateForFileOrFolder(file: string): vscodeTypes.TestItem | null {
    const result = this.getForLocation(file);
    if (result)
      return result;
    for (const workspaceFolder of vscode.workspace.workspaceFolders || []) {
      const workspacePath = workspaceFolder.uri.fsPath;
      const relative = path.relative(workspaceFolder.uri.fsPath, file);
      if (relative.startsWith('..'))
        continue;
      return this._getOrCreateTestItemForFileOrFolderInWorkspace(workspacePath, file); 
    }
    return null;
  }

  private _getOrCreateTestItemForFileOrFolderInWorkspace(workspacePath: string, fsPath: string): vscodeTypes.TestItem {
    const result = this.getForLocation(fsPath);
    if (result)
      return result;
    const parentFile = path.dirname(fsPath);
    const testItem = this.createForLocation(path.basename(fsPath), vscode.Uri.file(fsPath));
    const parent = this._getOrCreateTestItemForFileOrFolderInWorkspace(workspacePath, parentFile);
    parent.children.add(testItem);  
    return testItem;
  }

  private _id(location: string): string {
    return this._testGeneration + location;
  }
}

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
import vscode from 'vscode';
import { createGuid } from './utils';

export type Config = {
  workspaceFolder: string;
  configFile: string;
  testDir?: string;
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
  private _testItems = new Map<string, { testItem: vscode.TestItem, data: TestItemData }>();

  private _testController: vscode.TestController;

  // Top level test items for workspace folders.
  private _workspaceTestItems: vscode.TestItem[] = [];

  // We are using coalescing update to replace lists of children at once.
  private _pendingChildren: Map<vscode.TestItem, vscode.TestItem[]> | undefined;
  private _coalescingCount = 0;

  constructor(testController: vscode.TestController) {
    this._testController = testController;
  }

  reset() {
    this._testItems.clear();
    this._testGeneration = createGuid() + ':';
    this._workspaceTestItems = (vscode.workspace.workspaceFolders || []).map(wf => this.createForLocation(wf.name, wf.uri));
    this._testController.items.replace([
      this._testController.createTestItem('loading', 'Loading\u2026')
    ]);
  }

  finishedLoading() {
    this._testController.items.replace(this._workspaceTestItems);
  }

  location(testItem: vscode.TestItem): string | undefined {
    return this._testItems.get(testItem.id)?.data.location;
  }

  attributeToConfig(fileItem: vscode.TestItem, config: Config) {
    const data = this._testItems.get(fileItem.id)!.data;
    if (!data.configs)
      data.configs = new Set();
    data.configs.add(config);
  }

  configs(fileItem: vscode.TestItem): Config[] {
    const configs = this._testItems.get(fileItem.id)!.data.configs;
    return configs ? [...configs] : [];
  }

  isLoaded(fileItem: vscode.TestItem): boolean {
    return this._testItems.get(fileItem.id)!.data.isLoaded || false;
  }

  setLoaded(testItem: vscode.TestItem, loaded: boolean) {
    this._testItems.get(testItem.id)!.data.isLoaded = loaded;
  }

  getForLocation(location: string): vscode.TestItem | undefined {
    return this._testItems.get(this._id(location))?.testItem;
  }

  deleteForLocation(location: string) {
    this._testItems.delete(this._id(location));
  }

  delete(testItem: vscode.TestItem) {
    testItem.children.forEach(c => this._testItems.delete(c.id));
    this._testItems.delete(testItem.id);
    testItem.parent!.children.delete(testItem.id);
  }

  unbindChildren(fileItem: vscode.TestItem) {
    fileItem.children.forEach(c => this._testItems.delete(c.id));
  }

  createForLocation(label: string, uri: vscode.Uri, line?: number): vscode.TestItem {
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

  beginCoalescingUpdate() {
    if (++this._coalescingCount === 1)
      this._pendingChildren = new Map<vscode.TestItem, vscode.TestItem[]>();
  }

  addChild(fileItem: vscode.TestItem, testItem: vscode.TestItem) {
    if (!this._pendingChildren) {
      fileItem.children.add(testItem);
      return;
    }

    let children = this._pendingChildren.get(fileItem);
    if (!children) {
      children = [];
      this._pendingChildren.set(fileItem, children);
    }
    children.push(testItem);
  }

  endCoalescingUpdate() {
    if (--this._coalescingCount > 0)
      return;
    for (const [fileItem, children] of this._pendingChildren!)
      fileItem.children.replace(children);
    this._pendingChildren = undefined;
  }

  getOrCreateForFileOrFolder(file: string): vscode.TestItem | null {
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

  private _getOrCreateTestItemForFileOrFolderInWorkspace(workspacePath: string, fsPath: string): vscode.TestItem {
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

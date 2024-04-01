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
import { TestModelCollection } from './testModel';
import { createGuid } from './utils';
import * as vscodeTypes from './vscodeTypes';
import * as reporterTypes from './upstream/reporter';
import * as upstream from './upstream/testTree';
import { TeleSuite } from './upstream/teleReceiver';
import { DisposableBase } from './disposableBase';

/**
 * This class maps a collection of TestModels into the UI terms, it merges
 * multiple logical entities (for example, one per project) into a single UI entity
 * that can be executed at once.
 */
export class TestTree extends DisposableBase {
  private _vscode: vscodeTypes.VSCode;

  // We don't want tests to persist state between sessions, so we are using unique test id prefixes.
  private _testGeneration = '';

  // Global test item map location => fileItem that are files.
  private _rootItems = new Map<string, vscodeTypes.TestItem>();

  private _testController: vscodeTypes.TestController;
  private _models: TestModelCollection;
  private _loadingItem: vscodeTypes.TestItem;
  private _testItemByTestId = new Map<string, vscodeTypes.TestItem>();
  private _testItemByFile = new Map<string, vscodeTypes.TestItem>();

  constructor(vscode: vscodeTypes.VSCode, models: TestModelCollection, testController: vscodeTypes.TestController) {
    super();
    this._vscode = vscode;
    this._models = models;
    this._testController = testController;
    this._loadingItem = this._testController.createTestItem('loading', 'Loading\u2026');
    this._disposables = [
      models.onUpdated(() => this._update()),
    ];
  }

  startedLoading() {
    this._testGeneration = createGuid() + ':';
    this._testController.items.replace([]);
    this._testItemByTestId.clear();
    this._testItemByFile.clear();

    if (!this._vscode.workspace.workspaceFolders?.length)
      return;

    if (this._vscode.workspace.workspaceFolders?.length === 1) {
      const rootItem = this._createInlineRootItem(this._vscode.workspace.workspaceFolders[0].uri);
      rootItem.children.replace([this._loadingItem]);
    } else {
      const rootTreeItems: vscodeTypes.TestItem[] = [];
      for (const workspaceFolder of this._vscode.workspace.workspaceFolders || []) {
        const rootTreeItem = this._createRootFolderItem(workspaceFolder.uri.fsPath);
        rootTreeItems.push(rootTreeItem);
      }
      this._testController.items.replace([this._loadingItem, ...rootTreeItems]);
    }
  }

  finishedLoading() {
    if (this._loadingItem.parent)
      this._loadingItem.parent.children.delete(this._loadingItem.id);
    else if (this._testController.items.get(this._loadingItem.id))
      this._testController.items.delete(this._loadingItem.id);
  }

  collectTestsInside(rootItem: vscodeTypes.TestItem): vscodeTypes.TestItem[] {
    const result: vscodeTypes.TestItem[] = [];
    const visitItem = (testItem: vscodeTypes.TestItem) => {
      const treeItem = (testItem as any)[testTreeItemSymbol] as upstream.TreeItem | undefined;
      if (!testItem)
        return;
      if ((treeItem?.kind === 'case' || treeItem?.kind === 'test') && treeItem.test)
        result.push(testItem);
      else
        testItem.children.forEach(visitItem);
    };
    visitItem(rootItem);
    return result;
  }

  private _update() {
    for (const [workspaceFolder, workspaceRootItem] of this._rootItems) {
      const rootSuite = new TeleSuite('', 'root');
      for (const model of this._models.enabledModels().filter(m => m.config.workspaceFolder === workspaceFolder)) {
        for (const project of model.enabledProjects())
          rootSuite.suites.push(project.suite as TeleSuite);
      }
      const upstreamTree = new upstream.TestTree(workspaceFolder, rootSuite, [], undefined, path.sep);
      upstreamTree.sortAndPropagateStatus();
      upstreamTree.flattenForSingleProject();
      this._syncSuite(upstreamTree.rootItem, workspaceRootItem);
    }
    this._indexTree();
  }

  private _syncSuite(uItem: upstream.TreeItem, vsItem: vscodeTypes.TestItem) {
    const uChildren = uItem.children;
    const vsChildren = vsItem.children;
    const uChildrenById = new Map(uChildren.map(c => [c.id, c]));
    const vsChildrenById = new Map<string, vscodeTypes.TestItem>();
    vsChildren.forEach(c => {
      if (c.id.startsWith(this._testGeneration))
        vsChildrenById.set(c.id.substring(this._testGeneration.length), c);
    });

    // Remove deleted children.
    for (const id of vsChildrenById.keys()) {
      if (!uChildrenById.has(id)) {
        vsChildren.delete(this._idWithGeneration(id));
        vsChildrenById.delete(id);
      }
    }

    // Add new children.
    for (const [id, uChild] of uChildrenById) {
      let vsChild = vsChildrenById.get(id);
      if (!vsChild) {
        vsChild = this._testController.createTestItem(this._idWithGeneration(id), uChild.title, this._vscode.Uri.file(uChild.location.file));
        // Allow lazy-populating file items created via listFiles.
        if (uChild.kind === 'group' && uChild.subKind === 'file' && !uChild.children.length)
          vsChild.canResolveChildren = true;
        vsChildrenById.set(id, vsChild);
        vsChildren.add(vsChild);
      }
      (vsChild as any)[testTreeItemSymbol] = uChild;
      if (uChild.kind === 'case' && !areEqualTags(uChild.tags, vsChild.tags))
        vsChild.tags = uChild.tags.map(tag => new this._vscode.TestTag(tag));
      const hasLocation = uChild.location.line || uChild.location.column;
      if (hasLocation && (!vsChild.range || vsChild.range.start.line + 1 !== uChild.location.line)) {
        const line = uChild.location.line;
        vsChild.range = new this._vscode.Range(Math.max(line - 1, 0), 0, line, 0);
      } else if (hasLocation && !vsChild.range) {
        vsChild.range = undefined;
      }
    }

    // Sync children.
    for (const [id, uChild] of uChildrenById) {
      const vsChild = vsChildrenById.get(id);
      this._syncSuite(uChild, vsChild!);
    }
  }

  private _indexTree() {
    this._testItemByTestId.clear();
    this._testItemByFile.clear();
    const visit = (item: vscodeTypes.TestItem) => {
      const treeItem = (item as any)[testTreeItemSymbol] as upstream.TreeItem | undefined;
      if ((treeItem?.kind === 'case' || treeItem?.kind === 'test') && treeItem.test)
        this._testItemByTestId.set(treeItem.test.id, item);
      for (const [, child] of item.children)
        visit(child);
      if (item.uri && !item.range)
        this._testItemByFile.set(item.uri.fsPath, item);
    };
    for (const item of this._rootItems.values())
      visit(item);
  }

  private _createInlineRootItem(uri: vscodeTypes.Uri): vscodeTypes.TestItem {
    const testItem: vscodeTypes.TestItem = {
      id: this._idWithGeneration(uri.fsPath),
      uri: uri,
      children: this._testController.items,
      parent: undefined,
      tags: [],
      canResolveChildren: false,
      busy: false,
      label: '<root>',
      range: undefined,
      error: undefined,
    };
    this._rootItems.set(uri.fsPath, testItem);
    return testItem;
  }

  private _createRootFolderItem(folder: string): vscodeTypes.TestItem {
    const folderItem = this._testController.createTestItem(this._idWithGeneration(folder), path.basename(folder), this._vscode.Uri.file(folder));
    this._rootItems.set(folder, folderItem);
    return folderItem;
  }

  testItemForTest(test: reporterTypes.TestCase): vscodeTypes.TestItem | undefined {
    return this._testItemByTestId.get(test.id);
  }

  testItemForFile(file: string): vscodeTypes.TestItem | undefined {
    return this._testItemByFile.get(file);
  }

  private _idWithGeneration(id: string): string {
    return this._testGeneration + id;
  }
}

function areEqualTags(uTags: readonly string[], vsTags: readonly vscodeTypes.TestTag[]): boolean {
  if (uTags.length !== vsTags.length)
    return false;
  const uTagsSet = new Set(uTags);
  for (const tag of vsTags) {
    if (!uTagsSet.has(tag.id))
      return false;
  }
  return true;
}

export function upstreamTreeItem(treeItem: vscodeTypes.TreeItem): upstream.TreeItem {
  return (treeItem as any)[testTreeItemSymbol] as upstream.TreeItem;
}

const testTreeItemSymbol = Symbol('testTreeItemSymbol');

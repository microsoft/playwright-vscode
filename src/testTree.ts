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
import { MultiMap } from './multimap';
import { Entry, EntryType } from './oopReporter';
import { Location } from './reporter';
import { TestModel, TestProject } from './testModel';
import { createGuid } from './utils';
import * as vscodeTypes from './vscodeTypes';

type EntriesByTitle = MultiMap<string, { entry: Entry, projectTag: vscodeTypes.TestTag }>;

/**
 * This class maps a collection of TestModels into the UI terms, it merges
 * multiple logical entities (for example, one per project) into a single UI entity
 * that can be executed at once.
 */
export class TestTree {
  private _vscode: vscodeTypes.VSCode;

  // We don't want tests to persist state between sessions, so we are using unique test id prefixes.
  private _testGeneration = '';

  // Global test item map location => fileItem that are files.
  private _folderItems = new Map<string, vscodeTypes.TestItem>();
  private _fileItems = new Map<string, vscodeTypes.TestItem>();

  private _testController: vscodeTypes.TestController;
  private _models: TestModel[] = [];
  private _disposables: vscodeTypes.Disposable[] = [];
  private _loadingItem: vscodeTypes.TestItem;

  constructor(vscode: vscodeTypes.VSCode, testController: vscodeTypes.TestController) {
    this._vscode = vscode;
    this._testController = testController;
    this._loadingItem = this._testController.createTestItem('loading', 'Loading\u2026');
  }

  startedLoading() {
    this._disposables.forEach(d => d.dispose());
    this._disposables = [];
    this._models = [];
    this._testGeneration = createGuid() + ':';
    this._fileItems.clear();
    this._folderItems.clear();
    this._testController.items.replace([]);

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

  addModel(model: TestModel) {
    this._models.push(model);
    this._disposables.push(model.onUpdated(() => this._update()));
  }

  collectTestsInside(rootItem: vscodeTypes.TestItem): vscodeTypes.TestItem[] {
    const result: vscodeTypes.TestItem[] = [];
    const visitItem = (testItem: vscodeTypes.TestItem) => {
      const entryType = (testItem as any)[itemTypeSymbol] as EntryType;
      if (entryType === 'test')
        result.push(testItem);
      else
        testItem.children.forEach(visitItem);
    };
    visitItem(rootItem);
    return result;
  }

  private _update() {
    const allFiles = new Set<string>();
    for (const model of this._models)
      model.allFiles.forEach(f => allFiles.add(f));

    for (const file of allFiles) {
      if (!this._belongsToWorkspace(file))
        continue;
      const fileItem = this.getOrCreateFileItem(file);
      const signature: string[] = [];
      const entriesByTitle: EntriesByTitle = new MultiMap();
      for (const model of this._models) {
        for (const testProject of model.projects.values()) {
          const testFile = testProject.files.get(file);
          if (!testFile || !testFile.entries())
            continue;
          const projectTag = this.projectTag(testProject);
          this._tagFileItem(fileItem, projectTag);
          signature.push(testProject.testDir + ':' + testProject.name + ':' + testFile.revision());
          for (const entry of testFile.entries() || [])
            entriesByTitle.set(entry.title, { entry, projectTag });
        }
      }

      const signatureText = signature.join('|');
      if ((fileItem as any)[signatureSymbol] !== signatureText) {
        (fileItem as any)[signatureSymbol] = signatureText;
        this._updateTestItems(fileItem.children, entriesByTitle);
      }
    }

    for (const [location, fileItem] of this._fileItems) {
      if (!allFiles.has(location)) {
        this._fileItems.delete(location);
        fileItem.parent?.children.delete(fileItem.id);
      }
    }
  }

  private _belongsToWorkspace(file: string) {
    for (const workspaceFolder of this._vscode.workspace.workspaceFolders || []) {
      if (file.startsWith(workspaceFolder.uri.fsPath))
        return true;
    }
    return false;
  }

  private _updateTestItems(collection: vscodeTypes.TestItemCollection, entriesByTitle: EntriesByTitle) {
    const existingItems = new Map<string, vscodeTypes.TestItem>();
    collection.forEach(test => existingItems.set(test.label, test));
    const itemsToDelete = new Set<vscodeTypes.TestItem>(existingItems.values());

    for (const [title, entriesWithTag] of entriesByTitle) {
      // Process each testItem exactly once.
      let testItem = existingItems.get(title);
      const firstEntry = entriesWithTag[0].entry;
      if (!testItem) {
        // We sort by id in tests, so start with location.
        testItem = this._testController.createTestItem(this._id(firstEntry.location.file + ':' + firstEntry.location.line + '|' + firstEntry.titlePath.join('|')), firstEntry.title, this._vscode.Uri.file(firstEntry.location.file));
        (testItem as any)[itemTypeSymbol] = firstEntry.type;
        collection.add(testItem);
      }
      if (!testItem.range || testItem.range.start.line + 1 !== firstEntry.location.line) {
        const line = firstEntry.location.line;
        testItem.range = new this._vscode.Range(line - 1, 0, line, 0);
      }

      const childEntries: EntriesByTitle = new MultiMap();
      for (const { projectTag, entry } of entriesWithTag) {
        if (!testItem.tags.includes(projectTag))
          testItem.tags = [...testItem.tags, projectTag];
        if (entry.testId)
          addTestIdToTreeItem(testItem, entry.testId);
        for (const child of entry.children || [])
          childEntries.set(child.title, { entry: child, projectTag });
      }
      itemsToDelete.delete(testItem);
      this._updateTestItems(testItem.children, childEntries);
    }

    for (const testItem of itemsToDelete)
      collection.delete(testItem.id);
  }

  testIdsForTreeItem(treeItem: vscodeTypes.TreeItem) {
    const set = (treeItem as any)[testIdsSymbol];
    return set ? [...set] : [];
  }

  private _createInlineRootItem(uri: vscodeTypes.Uri): vscodeTypes.TestItem {
    const testItem: vscodeTypes.TestItem = {
      id: this._id(uri.fsPath),
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
    this._folderItems.set(uri.fsPath, testItem);
    return testItem;
  }

  private _createRootFolderItem(folder: string): vscodeTypes.TestItem {
    const folderItem = this._testController.createTestItem(this._id(folder), path.basename(folder), this._vscode.Uri.file(folder));
    this._folderItems.set(folder, folderItem);
    return folderItem;
  }

  testItemForLocation(location: Location, titlePath: string[]): vscodeTypes.TestItem | undefined {
    const fileItem = this._fileItems.get(location.file);
    if (!fileItem)
      return;
    let result: vscodeTypes.TestItem | undefined;
    const visitItem = (testItem: vscodeTypes.TestItem) => {
      if (result)
        return;
      if (titleMatches(testItem, titlePath) && testItem.range?.start.line === location.line - 1) {
        result = testItem;
        return;
      }
      testItem.children.forEach(visitItem);
    };
    fileItem.children.forEach(visitItem);
    return result || fileItem;
  }

  private _tagFileItem(fileItem: vscodeTypes.TestItem, projectTag: vscodeTypes.TestTag) {
    for (let item: vscodeTypes.TestItem | undefined = fileItem; item; item = item.parent) {
      if (!item.tags.includes(projectTag))
        item.tags = [...item.tags, projectTag];
    }
  }

  getOrCreateFileItem(file: string): vscodeTypes.TestItem {
    const result = this._fileItems.get(file);
    if (result)
      return result;

    const parentFile = path.dirname(file);
    const parentItem = this.getOrCreateFolderItem(parentFile);
    const fileItem = this._testController.createTestItem(this._id(file), path.basename(file), this._vscode.Uri.file(file));
    fileItem.canResolveChildren = true;
    this._fileItems.set(file, fileItem);

    parentItem.children.add(fileItem);
    return fileItem;
  }

  getOrCreateFolderItem(folder: string): vscodeTypes.TestItem {
    const result = this._folderItems.get(folder);
    if (result)
      return result;

    const parentFolder = path.dirname(folder);
    const parentItem = this.getOrCreateFolderItem(parentFolder);
    const folderItem = this._testController.createTestItem(this._id(folder), path.basename(folder), this._vscode.Uri.file(folder));
    this._folderItems.set(folder, folderItem);
    parentItem.children.add(folderItem);
    return folderItem;
  }

  private _id(location: string): string {
    return this._testGeneration + location;
  }

  projectTag(project: TestProject): vscodeTypes.TestTag {
    let tag = (project as any)[tagSymbol];
    if (!tag) {
      tag = new this._vscode.TestTag(project.model.config.configFile + ':' + project.name);
      (project as any)[tagSymbol] = tag;
    }
    return tag;
  }
}

function titleMatches(testItem: vscodeTypes.TestItem, titlePath: string[]) {
  const left: vscodeTypes.TestItem['label'][] = [];
  while (testItem) {
    left.unshift(testItem.label);
    testItem = testItem.parent!;
  }
  const right = titlePath.slice();
  while (right.length) {
    const leftPart = left.pop();
    const rightPart = right.pop();
    if (leftPart !== rightPart)
      return false;
  }
  return true;
}

function addTestIdToTreeItem(testItem: vscodeTypes.TestItem, testId: string) {
  const testIds = (testItem as any)[testIdsSymbol] || new Set<string>();
  testIds.add(testId);
  (testItem as any)[testIdsSymbol] = testIds;
}

const signatureSymbol = Symbol('signatureSymbol');
const itemTypeSymbol = Symbol('itemTypeSymbol');
const testIdsSymbol = Symbol('testIdsSymbol');
const tagSymbol = Symbol('tagSymbol');

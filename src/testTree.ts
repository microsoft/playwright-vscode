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
import { Entry } from './oopReporter';
import { Location } from './reporter';
import { TestModel } from './testModel';
import { createGuid } from './utils';
import * as vscodeTypes from './vscodeTypes';

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

  constructor(vscode: vscodeTypes.VSCode, testController: vscodeTypes.TestController) {
    this._vscode = vscode;
    this._testController = testController;
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
      this._createRootItem(this._vscode.workspace.workspaceFolders[0].uri);
    } else {
      const rootTreeItems = [];
      for (const workspaceFolder of this._vscode.workspace.workspaceFolders || []) {
        const rootTreeItem = this.getOrCreateFileItem(workspaceFolder.uri.fsPath);
        rootTreeItems.push(rootTreeItem);
      }
      this._testController.items.replace(rootTreeItems);
    }
  }

  addModel(model: TestModel) {
    this._models.push(model);
    this._disposables.push(model.onUpdated(() => this._update()));
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
      let entries: Entry[] | undefined;
      for (const model of this._models) {
        for (const testProject of model.projects.values()) {
          const testFile = testProject.files.get(file);
          if (!testFile || !testFile.entries())
            continue;
          signature.push(testProject.testDir + ':' + testProject.name + ':' + testFile.revision());
          entries = entries || [];
          if (testFile.entries())
            entries.push(...testFile.entries()!);
        }
      }
      if (entries) {
        const signatureText = signature.join('|');
        if ((fileItem as any)[signatureSymbol] !== signatureText) {
          (fileItem as any)[signatureSymbol] = signatureText;
          this._updateTestItems(fileItem.children, entries);
        }
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

  private _updateTestItems(collection: vscodeTypes.TestItemCollection, entries: Entry[]) {
    const existingItems = new Map<string, vscodeTypes.TestItem>();
    collection.forEach(test => existingItems.set(test.label, test));
    const itemsToDelete = new Map<string, vscodeTypes.TestItem>(existingItems);

    for (const entry of entries) {
      let testItem = existingItems.get(entry.title);
      if (!testItem) {
        // We sort by id in tests, so start with location.
        testItem = this._testController.createTestItem(this._id(entry.location.file + ':' + entry.location.line + '|' + entry.title), entry.title, this._vscode.Uri.file(entry.location.file));
        collection.add(testItem);
      }
      if (!testItem.range || testItem.range.start.line + 1 !== entry.location.line) {
        const line = entry.location.line;
        testItem.range = new this._vscode.Range(line - 1, 0, line, 0);
      }
      this._updateTestItems(testItem.children, entry.children || []);
      itemsToDelete.delete(entry.title);
    }

    for (const testItem of itemsToDelete.values())
      collection.delete(testItem.id);
  }

  private _createRootItem(uri: vscodeTypes.Uri): vscodeTypes.TestItem {
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

  testItemForLocation(location: Location, title: string): vscodeTypes.TestItem | undefined {
    const fileItem = this._fileItems.get(location.file);
    if (!fileItem)
      return;
    let result: vscodeTypes.TestItem | undefined;
    const visitItem = (testItem: vscodeTypes.TestItem) => {
      if (result)
        return;
      if (testItem.label === title && testItem.range?.start.line === location.line - 1) {
        result = testItem;
        return;
      }
      testItem.children.forEach(visitItem);
    };
    fileItem.children.forEach(visitItem);
    return result || fileItem;
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
}

const signatureSymbol = Symbol('signatureSymbol');

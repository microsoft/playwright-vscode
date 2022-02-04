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
import * as vscodeTypes from './vscodeTypes';
import { createGuid } from './utils';

export type Config = {
  workspaceFolder: string;
  configFile: string;
  cli: string;
};

type TestItemData = {
  location: string;
  isLoaded?: boolean;
  projects?: { config: Config, project: string }[];
};

const dataSymbol = Symbol('testItemData');

export class TestTree {
  private _vscode: vscodeTypes.VSCode;

  // We don't want tests to persist state between sessions, so we are using unique test id prefixes.
  private _testGeneration = '';

  // Global test item map testItem.id => testItem.
  private _testItems = new Map<string, vscodeTypes.TestItem>();

  private _testController: vscodeTypes.TestController;

  constructor(vscode: vscodeTypes.VSCode, testController: vscodeTypes.TestController) {
    this._vscode = vscode;
    this._testController = testController;
  }

  private _data(testItem: vscodeTypes.TestItem): TestItemData {
    return (testItem as any)[dataSymbol];
  }

  startedLoading() {
    this._testItems.clear();
    this._testGeneration = createGuid() + ':';
    if (!this._vscode.workspace.workspaceFolders?.length)
      return;

    if (this._vscode.workspace.workspaceFolders?.length === 1) {
      this._createRootItem(this._vscode.workspace.workspaceFolders[0].uri);
    } else {
      const rootTreeItems = [];
      for (const workspaceFolder of this._vscode.workspace.workspaceFolders || []) {
        const rootName = workspaceFolder.name;
        const rootTreeItem = this.createForLocation(rootName, this._vscode.Uri.file(workspaceFolder.uri.fsPath));
        rootTreeItems.push(rootTreeItem);
      }
      this._testController.items.replace(rootTreeItems);
    }
  }

  location(testItem: vscodeTypes.TestItem): string {
    return this._data(testItem).location;
  }

  attributeToProject(fileItem: vscodeTypes.TestItem, config: Config, project: string) {
    const data = this._data(fileItem);
    if (!data.projects)
      data.projects = [];
    data.projects.push({ config, project });
  }

  configs(fileItem: vscodeTypes.TestItem): Config[] {
    const projects = this._data(fileItem).projects;
    if (!projects?.length)
      return [];
    const configs = new Set<Config>();
    for (const project of projects)
      configs.add(project.config);
    return [...configs];
  }

  belongsToProject(testItem: vscodeTypes.TestItem, config: Config, projectName: string): boolean {
    let item: vscodeTypes.TestItem | undefined = testItem;
    // Climb to reach the file.
    while (item && item.range)
      item = item.parent;

    if (!item)
      return false;

    const result = this._fileBelongsToProject(item, config, projectName);
    if (result === undefined) {
      // This is a folder.
      let finalResult: boolean | undefined;
      const visit = (item: vscodeTypes.TestItem) => {
        if (finalResult !== undefined)
          return;
        const result = this._fileBelongsToProject(item, config, projectName);
        if (result !== undefined)
          finalResult = result;
        else
          item.children.forEach(visit);
      };
      item.children.forEach(visit);
      return finalResult || false;
    } else {
      return this._fileBelongsToProject(item, config, projectName) || false;
    }
  }

  private _fileBelongsToProject(fileItem: vscodeTypes.TestItem, config: Config, projectName: string): boolean | undefined {
    const projects = this._data(fileItem).projects;
    if (!projects)
      return;

    for (const project of projects) {
      if (project.config === config && project.project === projectName)
        return true;
    }
    return false;
  }

  isLoaded(fileItem: vscodeTypes.TestItem): boolean {
    return this._data(fileItem).isLoaded || false;
  }

  setLoaded(testItem: vscodeTypes.TestItem, loaded: boolean) {
    return this._data(testItem).isLoaded = loaded;
  }

  getForLocation(location: string): vscodeTypes.TestItem | undefined {
    return this._testItems.get(this._id(location));
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
    this._testItems.set(testItem.id, testItem);
    return testItem;
  }

  createForLocation(label: string, uri: vscodeTypes.Uri, line?: number): vscodeTypes.TestItem {
    const hasLine = typeof line === 'number';
    const location = hasLine ? uri.fsPath + ':' + line : uri.fsPath;
    const testItem = this._testController.createTestItem(this._id(location), label, uri);
    this._testItems.set(testItem.id, testItem);
    (testItem as any)[dataSymbol] = {
      location: hasLine ? uri.fsPath + ':' + line : uri.fsPath,
      isLoaded: false
    };
    if (hasLine)
      testItem.range = new this._vscode.Range(line - 1, 0, line, 0);
    return testItem;
  }

  getOrCreateForFileOrFolder(file: string): vscodeTypes.TestItem | null {
    const result = this.getForLocation(file);
    if (result)
      return result;
    for (const workspaceFolder of this._vscode.workspace.workspaceFolders || []) {
      const workspacePath = workspaceFolder.uri.fsPath;
      // We deliberately check against workspace folder, not testDir for the case
      // of compiled tests.
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
    const testItem = this.createForLocation(path.basename(fsPath), this._vscode.Uri.file(fsPath));
    const parent = this._getOrCreateTestItemForFileOrFolderInWorkspace(workspacePath, parentFile);
    parent.children.add(testItem);
    return testItem;
  }

  private _id(location: string): string {
    return this._testGeneration + location;
  }
}

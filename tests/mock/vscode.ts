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

import fs from 'fs';
import glob from 'glob';
import path from 'path';
import { EventEmitter } from './events';

class Uri {
  fsPath!: string;

  static file(fsPath: string): Uri {
    const uri = new Uri();
    uri.fsPath = fsPath;
    return uri;
  }
}

class Position {
  constructor(readonly line: number, readonly character: number) {}
}

class Location {
  range: Range;
  constructor(readonly uri: Uri, rangeOrPosition: Range | Position) {
    if ('line' in rangeOrPosition)
      this.range = new Range(rangeOrPosition.line, rangeOrPosition.character, rangeOrPosition.line, rangeOrPosition.character);
    else
      this.range = rangeOrPosition;
  }
}

class Range {
  start: Position;
  end: Position;
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
}

class WorkspaceFolder {
  name: string;
  uri: Uri;

  constructor(name: string, uri: Uri) {
    this.name = name;
    this.uri = uri;
  }
}

class TestItem {
  readonly children = new TestCollection();

  constructor(
      readonly testController: TestController,
      readonly id: string,
      readonly label: string,
      readonly uri?: Uri) {
  }

  async resolveChildren() {
    await this.testController.resolveHandler(this);
  }
}

class TestCollection {
  items: TestItem[] = [];

  add(item: TestItem) {
    this.items.push(item);
  }

  delete(id: string) {
    this.items = this.items.filter(i => i.id !== id);
  }

  replace(items: TestItem[]) {
    this.items = items;
  }

  forEach(visitor: (item: TestItem) => void) {
    this.items.forEach(visitor);
  }
}

type TestRunProfile = {
  label: string;
  kind: TestRunProfileKind;
  isDefault?: boolean;
};

type TestRunRequest = {};

class CancellationToken {
}

class TestController {
  readonly items: TestCollection;
  readonly runProfiles: TestRunProfile[] = [];
  resolveHandler: (item: TestItem | null) => Promise<void>;

  constructor(private id: string, private label: string) {
    this.items = new TestCollection();
  }

  createTestItem(id: string, label: string, uri?: Uri): TestItem {
    return new TestItem(this, id, label, uri);
  }

  createRunProfile(label: string, kind: TestRunProfileKind, runHandler: (request: TestRunRequest, token: CancellationToken) => Promise<void>, isDefault?: boolean): TestRunProfile {
    const profile = {
      label,
      kind,
      isDefault
    };
    this.runProfiles.push(profile);
    return profile;
  }
}

class FileSystemWatcher {
  private _onDidCreate = new EventEmitter();
  private _onDidChange = new EventEmitter();
  private _onDidDelete = new EventEmitter();
  readonly onDidCreate = this._onDidCreate.event;
  readonly onDidChange = this._onDidChange.event;
  readonly onDidDelete = this._onDidDelete.event;
}

export enum TestRunProfileKind {
  Run = 1,
  Debug = 2,
  Coverage = 3,
}

export class VSCode {
  EventEmitter = EventEmitter;
  Location = Location;
  Position = Position;
  Range = Range;
  Uri = Uri;
  TestRunProfileKind = TestRunProfileKind;
  commands: any = {};
  debug: any = {};
  languages: any = {};
  tests: any = {};
  window: any = {};
  workspace: any = {};

  private _didStartDebugSession = new EventEmitter();
  private _didTerminateDebugSession = new EventEmitter();
  private _didChangeActiveTextEditor = new EventEmitter();
  private _didChangeTextEditorSelection = new EventEmitter();
  private _didChangeWorkspaceFolders = new EventEmitter();
  private _didChangeTextDocument = new EventEmitter();

  readonly onDidStartDebugSession = this._didStartDebugSession.event;
  readonly onDidTerminateDebugSession = this._didTerminateDebugSession.event;
  readonly onDidChangeActiveTextEditor = this._didChangeActiveTextEditor.event;
  readonly onDidChangeTextEditorSelection = this._didChangeTextEditorSelection.event;
  readonly onDidChangeWorkspaceFolders = this._didChangeWorkspaceFolders.event;
  readonly onDidChangeTextDocument = this._didChangeTextDocument.event;
  readonly testControllers: TestController[] = [];

  constructor() {
    this.commands.registerCommand = () => {};
    this.debug.onDidStartDebugSession = this.onDidStartDebugSession;
    this.debug.onDidTerminateDebugSession = this.onDidTerminateDebugSession;
    this.debug.registerDebugAdapterTrackerFactory = () => {};

    this.languages.registerHoverProvider = () => {};
    this.tests.createTestController = this._createTestController.bind(this);

    this.window.onDidChangeActiveTextEditor = this.onDidChangeActiveTextEditor;
    this.window.onDidChangeTextEditorSelection = this.onDidChangeTextEditorSelection;
    this.window.createTextEditorDecorationType = () => ({});
    this.window.showWarningMessage = () => {};

    this.workspace.onDidChangeWorkspaceFolders = this.onDidChangeWorkspaceFolders;
    this.workspace.onDidChangeTextDocument = this.onDidChangeTextDocument;
    this.workspace.createFileSystemWatcher = () => { return new FileSystemWatcher(); };
    this.workspace.workspaceFolders = [];

    this.workspace.findFiles = async pattern => {
      const uris: Uri[] = [];
      for (const workspaceFolder of this.workspace.workspaceFolders) {
        await new Promise<void>(f => {
          const cwd = workspaceFolder.uri.fsPath;
          glob(pattern, { cwd }, (err, files) => {
            uris.push(...files.map(f => Uri.file(path.join(cwd, f))));
            f();
          });
        });
      }
      return uris;
    };

    this.workspace.getWorkspaceFolder = (uri: Uri): WorkspaceFolder | undefined => {
      for (const workspaceFolder of this.workspace.workspaceFolders) {
        if (uri.fsPath.startsWith(workspaceFolder.uri.fsPath))
          return workspaceFolder;
      }
    };
  }

  private _createTestController(id: string, label: string): TestController {
    const testController = new TestController(id, label);
    this.testControllers.push(testController);
    return testController;
  }

  async addWorkspace(name: string, rootFolder: string, files: { [key: string]: string }) {
    const workspaceFolder = new WorkspaceFolder(name, Uri.file(rootFolder));
    this.workspace.workspaceFolders.push(workspaceFolder);
    await fs.promises.mkdir(rootFolder, { recursive: true });
    for (const [fsPath, content] of Object.entries(files))
      await fs.promises.writeFile(path.join(rootFolder, fsPath), content);
    this._didChangeWorkspaceFolders.fire(undefined);
  }
}

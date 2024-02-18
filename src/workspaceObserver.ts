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

export type WorkspaceChange = {
  created: Set<string>;
  changed: Set<string>;
  deleted: Set<string>;
};

export class WorkspaceObserver {
  private _vscode: vscodeTypes.VSCode;
  private _fileSystemWatchers: vscodeTypes.FileSystemWatcher[] = [];
  private _handler: (change: WorkspaceChange) => void;
  private _pendingChange: WorkspaceChange | undefined;
  private _timeout: NodeJS.Timeout | undefined;

  constructor(vscode: vscodeTypes.VSCode, handler: (change: WorkspaceChange) => void) {
    this._vscode = vscode;
    this._handler = handler;
  }

  addWatchFolder(folder: string) {
    const fileSystemWatcher = this._vscode.workspace.createFileSystemWatcher(folder + path.sep + '**');
    fileSystemWatcher.onDidCreate(uri => {
      if (uri.scheme === 'file')
        this._change().created.add(uri.fsPath);
    });
    fileSystemWatcher.onDidChange(uri => {
      if (uri.scheme === 'file')
        this._change().changed.add(uri.fsPath);
    });
    fileSystemWatcher.onDidDelete(uri => {
      if (uri.scheme === 'file')
        this._change().deleted.add(uri.fsPath);
    });
    this._fileSystemWatchers.push(fileSystemWatcher);
  }

  private _change(): WorkspaceChange {
    if (!this._pendingChange) {
      this._pendingChange = {
        created: new Set(),
        changed: new Set(),
        deleted: new Set()
      };
    }
    if (this._timeout)
      clearTimeout(this._timeout);
    this._timeout = setTimeout(() => this._reportChange(), 50);
    return this._pendingChange;
  }

  private _reportChange() {
    delete this._timeout;
    this._handler(this._pendingChange!);
    this._pendingChange = undefined;
  }

  dispose() {
    this.reset();
  }

  reset() {
    if (this._timeout)
      clearTimeout(this._timeout);
    this._fileSystemWatchers.forEach(f => f.dispose());
    this._fileSystemWatchers = [];
  }
}

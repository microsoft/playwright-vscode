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
import { uriToPath } from './utils';

export type WorkspaceChange = {
  created: Set<string>;
  changed: Set<string>;
  deleted: Set<string>;
};

export class WorkspaceObserver {
  private _vscode: vscodeTypes.VSCode;
  private _handler: (change: WorkspaceChange) => void;
  private _pendingChange: WorkspaceChange | undefined;
  private _timeout: NodeJS.Timeout | undefined;
  private _folderWatchers = new Map<string, vscodeTypes.Disposable[]>();

  constructor(vscode: vscodeTypes.VSCode, handler: (change: WorkspaceChange) => void) {
    this._vscode = vscode;
    this._handler = handler;
  }

  setWatchFolders(folders: Set<string>) {
    for (const folder of folders) {
      if (this._folderWatchers.has(folder))
        continue;

      // Make sure to use lowercase drive letter in the pattern.
      // eslint-disable-next-line no-restricted-properties
      const watcher = this._vscode.workspace.createFileSystemWatcher(this._vscode.Uri.file(folder).fsPath.replaceAll(path.sep, '/') + '/**');
      const disposables: vscodeTypes.Disposable[] = [
        watcher.onDidCreate(uri => {
          if (uri.scheme === 'file')
            this._change().created.add(uriToPath(uri));
        }),
        watcher.onDidChange(uri => {
          if (uri.scheme === 'file')
            this._change().changed.add(uriToPath(uri));
        }),
        watcher.onDidDelete(uri => {
          if (uri.scheme === 'file')
            this._change().deleted.add(uriToPath(uri));
        }),
        watcher,
      ];
      this._folderWatchers.set(folder, disposables);
    }

    for (const [folder, disposables] of this._folderWatchers) {
      if (!folders.has(folder)) {
        disposables.forEach(d => d.dispose());
        this._folderWatchers.delete(folder);
      }
    }
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
    if (this._timeout)
      clearTimeout(this._timeout);
    for (const disposables of this._folderWatchers.values())
      disposables.forEach(d => d.dispose());
    this._folderWatchers.clear();
  }
}

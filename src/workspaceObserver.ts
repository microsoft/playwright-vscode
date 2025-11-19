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
  private _watchers = new Map<string, vscodeTypes.Disposable[]>();
  private _isUnderTest: boolean;

  constructor(vscode: vscodeTypes.VSCode, handler: (change: WorkspaceChange) => void, isUnderTest: boolean) {
    this._vscode = vscode;
    this._handler = handler;
    this._isUnderTest = isUnderTest;
  }

  setPatterns(patterns: Set<string>) {
    for (const pattern of patterns) {
      if (this._watchers.has(pattern))
        continue;

      const watcher = this._vscode.workspace.createFileSystemWatcher(pattern);
      const disposables: vscodeTypes.Disposable[] = [
        watcher.onDidCreate(uri => {
          if (uri.scheme === 'file' && this._isRelevant(uri))
            this._change().created.add(uriToPath(uri));
        }),
        watcher.onDidChange(uri => {
          if (uri.scheme === 'file' && this._isRelevant(uri))
            this._change().changed.add(uriToPath(uri));
        }),
        watcher.onDidDelete(uri => {
          if (uri.scheme === 'file' && this._isRelevant(uri))
            this._change().deleted.add(uriToPath(uri));
        }),
        watcher,
      ];
      this._watchers.set(pattern, disposables);
    }

    for (const [pattern, disposables] of this._watchers) {
      if (!patterns.has(pattern)) {
        disposables.forEach(d => d.dispose());
        this._watchers.delete(pattern);
      }
    }
  }

  private _isRelevant(uri: vscodeTypes.Uri): boolean {
    const path = uriToPath(uri);
    // TODO: parse .gitignore
    if (path.includes('node_modules'))
      return false;
    if (!this._isUnderTest && path.includes('test-results'))
      return false;
    return true;
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
    for (const disposables of this._watchers.values())
      disposables.forEach(d => d.dispose());
    this._watchers.clear();
  }
}

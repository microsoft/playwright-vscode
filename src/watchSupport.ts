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

import type { WorkspaceChange } from './workspaceObserver';
import type { TestModel } from './testModel';
import type { TestConfig } from './playwrightTest';
import * as vscodeTypes from './vscodeTypes';
import { MultiMap } from './multimap';
import { TestTree } from './testTree';

export type Watch = {
  testDirFsPath: string;
  model: TestModel;
  include: readonly vscodeTypes.TestItem[] | undefined;
  mode: 'watch';
};

export class WatchSupport {
  private _watches = new Set<Watch>();

  constructor(private vscode: vscodeTypes.VSCode, private testTree: TestTree, public onWatchesTriggered: (watches: Watch[]) => void) {}

  addToWatch(model: TestModel, include: readonly vscodeTypes.TestItem[] | undefined, cancellationToken: vscodeTypes.CancellationToken) {
    for (const project of model.enabledProjects().values()) {
      const watch: Watch = {
        testDirFsPath: this.vscode.Uri.file(project.project.testDir).fsPath,
        model,
        include,
        mode: 'watch',
      };
      this._watches.add(watch);
      cancellationToken.onCancellationRequested(() => this._watches.delete(watch));
    }

    // Watch contract has a bug in 1.86 - when outer non-global watch is disabled, it assumes that inner watches are
    // discarded as well without issuing the token cancelation.
    for (const ri of include || []) {
      for (const watch of this._watches) {
        for (const wi of watch.include || []) {
          if (isAncestorOf(ri, wi)) {
            this._watches.delete(watch);
            break;
          }
        }
      }
    }
  }

  async workspaceChanged(change: WorkspaceChange) {
    // Collapse watches in the same project to the outermost
    const matchingWatches = new MultiMap<Watch, vscodeTypes.TestItem>();
    const models = new Set<TestModel>();
    for (const watch of this._watches)
      models.add(watch.model);

    const relatedByConfig = new Map<TestConfig, string[]>();
    for (const model of models) {
      const { testFiles } = await model.findRelatedTestFiles([...change.changed, ...change.deleted]);
      relatedByConfig.set(model.config, testFiles.map(f => this.vscode.Uri.file(f).fsPath));
    }

    for (const watch of this._watches || []) {
      const testFiles = relatedByConfig.get(watch.model.config);
      if (!testFiles || !testFiles.length)
        continue;

      for (const testFile of testFiles) {
        if (!watch.include) {
          // Everything is watched => add file.
          const item = this.testTree.testItemForFile(testFile);
          if (item)
            matchingWatches.set(watch, item);
          continue;
        }
        for (const include of watch.include) {
          if (!include.uri)
            continue;
          // Folder is watched => add file.
          if (testFile.startsWith(include.uri.fsPath + '/')) {
            const item = this.testTree.testItemForFile(testFile);
            if (item)
              matchingWatches.set(watch, item);
            continue;
          }
          // File or a test is watched, use that include as it might be more specific (test)
          if (testFile === include.uri.fsPath) {
            matchingWatches.set(watch, include);
            continue;
          }
        }
      }
    }
    if (matchingWatches.size) {
      const watchesToRun: Watch[] = [];
      for (const [watch, include] of matchingWatches)
        watchesToRun.push({ ...watch, include });
      this.onWatchesTriggered(watchesToRun);
    }
  }
}

function isAncestorOf(root: vscodeTypes.TestItem, descendent: vscodeTypes.TestItem) {
  while (descendent.parent) {
    if (descendent.parent === root)
      return true;
    descendent = descendent.parent;
  }
  return false;
}

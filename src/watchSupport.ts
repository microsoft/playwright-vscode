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
import type { TestProject } from './testModel';
import type { PlaywrightTest, TestConfig } from './playwrightTest';
import * as vscodeTypes from './vscodeTypes';
import { MultiMap } from './multimap';
import { TestTree } from './testTree';

export type Watch = {
  testDirFsPath: string;
  project: TestProject;
  include: readonly vscodeTypes.TestItem[] | undefined;
};

export class WatchSupport {
  private _watches = new Set<Watch>();

  constructor(private vscode: vscodeTypes.VSCode, private playwrightTest: PlaywrightTest, private testTree: TestTree, public onWatchesTriggered: (watches: Watch[]) => void) {}

  addToWatch(project: TestProject, include: readonly vscodeTypes.TestItem[] | undefined, cancellationToken: vscodeTypes.CancellationToken) {
    const watch: Watch = {
      testDirFsPath: this.vscode.Uri.file(project.project.testDir).fsPath,
      project,
      include,
    };
    this._watches.add(watch);

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

    cancellationToken.onCancellationRequested(() => this._watches.delete(watch));
  }

  async workspaceChanged(change: WorkspaceChange) {
    // Collapse watches in the same project to the outermost
    const matchingWatches = new MultiMap<Watch, vscodeTypes.TestItem>();
    const configs = new Set<TestConfig>();
    for (const watch of this._watches)
      configs.add(watch.project.model.config);

    const relatedByConfig = new Map<TestConfig, string[]>();
    for (const config of configs) {
      const { testFiles } = await this.playwrightTest.findRelatedTestFiles(config, [...change.changed, ...change.deleted]);
      relatedByConfig.set(config, testFiles.map(f => this.vscode.Uri.file(f).fsPath));
    }

    for (const watch of this._watches || []) {
      const testFiles = relatedByConfig.get(watch.project.model.config);
      if (!testFiles || !testFiles.length)
        continue;

      for (const testFile of testFiles) {
        if (!watch.include) {
          // Everything is watched => add file.
          matchingWatches.set(watch, this.testTree.getOrCreateFileItem(testFile));
          continue;
        }
        for (const include of watch.include) {
          if (!include.uri)
            continue;
          // Folder is watched => add file.
          if (testFile.startsWith(include.uri.fsPath + '/')) {
            matchingWatches.set(watch, this.testTree.getOrCreateFileItem(testFile));
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

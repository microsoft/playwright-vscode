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
import StackUtils from 'stack-utils';
import vscode from 'vscode';
import { Entry } from './oopReporter';
import { ListFilesReport, PlaywrightTest } from './playwrightTest';
import { TestError } from './reporter';
import { Config, TestTree } from './testTree';
import { WorkspaceObserver } from './workspaceObserver';

const stackUtils = new StackUtils();
export type DebuggerLocation = { path: string, line: number, column: number };

type StepInfo = {
  location: vscode.Location;
  activeCount: number;
  duration: number;
};

export class TestModel {
  // Global test item map.
  private _testTree: TestTree;

  // Each run profile is a config + project pair.
  private _runProfiles: vscode.TestRunProfile[] = [];

  private _testController: vscode.TestController;
  private _workspaceObserver: WorkspaceObserver;
  private _playwrightTest: PlaywrightTest;
  private _disposables: vscode.Disposable[];
  private _testItemUnderDebug: vscode.TestItem | undefined;

  private _executionLinesChanged = new vscode.EventEmitter<{ active: StepInfo[], completed: StepInfo[] }>();
  readonly onExecutionLinesChanged = this._executionLinesChanged.event;
  private _activeSteps = new Map<string, StepInfo>();
  private _completedSteps = new Map<string, StepInfo>();

  constructor() {
    this._testController = vscode.tests.createTestController('pw.extension.testController', 'Playwright');
    this._testController.resolveHandler = item => this._resolveChildren(item);
    this._testTree = new TestTree(this._testController);
    this._playwrightTest = new PlaywrightTest();

    this._rebuildModel().catch(() => {});

    this._workspaceObserver = new WorkspaceObserver(change => {
      for (const deleted of new Set(change.deleted))
        this._onDidDeleteFile(deleted.uri.fsPath);

      const filesByConfig = new Map<Config, Set<string>>();
      for (const entry of [...change.changed, ...change.created]) {
        let files = filesByConfig.get(entry.watcher);
        if (!files) {
          files = new Set();
          filesByConfig.set(entry.watcher, files);
        }
        files.add(entry.uri.fsPath);
      }
      this._onDidChangeFiles(filesByConfig);
    });

    this._disposables = [
      vscode.workspace.onDidChangeConfiguration((_) => {
        this._rebuildModel().catch(() => {});
      }),
      vscode.workspace.onDidChangeWorkspaceFolders((_) => {
        this._rebuildModel().catch(() => {});
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this._updateActiveEditorItems();
      }),
      vscode.commands.registerCommand('pw.extension.refreshTests', () => {
        this._rebuildModel().catch(() => {});
      }),
      this._testController,
      this._workspaceObserver,
    ];
  }

  dispose() {
    this._disposables.forEach(d => d.dispose());
  }

  private async _rebuildModel() {
    await this._playwrightTest.reconsiderDogFood();
    this._testTree.startedLoading();
    this._workspaceObserver.reset();
    for (const profile of this._runProfiles)
      profile.dispose();
    this._runProfiles = [];

    // Give UI a chance to update.
    await new Promise(f => setTimeout(f, 500));

    const rootTreeItems: vscode.TestItem[] = [];
    const configFiles = await vscode.workspace.findFiles('**/*playwright*.config.[tj]s');
    for (const configFileUri of configFiles) {
      if (configFileUri.fsPath.includes('node_modules'))
        continue;
      // Dogfood support
      if (configFileUri.fsPath.includes('test-results'))
        continue;
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(configFileUri)!.uri.fsPath;
      const config: Config = {
        workspaceFolder,
        configFile: configFileUri.fsPath,
      };

      const report = await this._playwrightTest.listFiles(config);
      if (!report)
        continue;
      const configDir = path.dirname(config.configFile);
      config.testDir = report.testDir ? path.resolve(configDir, report.testDir) : configDir;
      const rootName = path.basename(path.dirname(config.testDir)) + path.sep + path.basename(config.testDir);
      const rootTreeItem = this._testTree.createForLocation(rootName, vscode.Uri.file(config.testDir))
      rootTreeItems.push(rootTreeItem);
      this._workspaceObserver.addWatchFolder(config.testDir, config);
      await this._createRunProfiles(config, report);
      await this._createTestItemsForFiles(config, report);
    }

    this._testTree.finishedLoading(rootTreeItems);
    await this._updateActiveEditorItems();
  }

  private async _createRunProfiles(config: Config, report: ListFilesReport) {
    const configName = path.basename(config.configFile);
    const folderName = path.basename(path.dirname(config.configFile));

    for (const project of report.projects) {
      const projectSuffix = project.name ? ` [${project.name}]` : '';
      this._runProfiles.push(this._testController.createRunProfile(`${folderName}${path.sep}${configName}${projectSuffix}`, vscode.TestRunProfileKind.Run, async (request, token) => {
        if (!request.include) {
          await this._runTest(request, config, project.name, null, token);
          return;
        }
        for (const testItem of request.include) {
          const location = this._testTree.location(testItem);
          await this._runTest(request, config, project.name, location!, token);
        }
      }, true));
      this._runProfiles.push(this._testController.createRunProfile(`${folderName}${path.sep}${configName}${projectSuffix}`, vscode.TestRunProfileKind.Debug, async (request, token) => {
        for (const testItem of request.include || []) {
          this._testItemUnderDebug = testItem;
          await this._playwrightTest.debugTest(config, project.name, this._testTree.location(testItem)!);
        }
      }, true));
    }
  }

  private async _createTestItemsForFiles(config: Config, report: ListFilesReport) {
    for (const project of report.projects) {
      for (const file of project.files) {
        const item = this._testTree.getOrCreateForFileOrFolder(file);
        if (!item)
          continue;
        item.canResolveChildren = true;
        this._testTree.attributeToConfig(item, config);
      }
    }
  }

  private async _resolveChildren(fileItem: vscode.TestItem | undefined): Promise<void> {
    await this._populateFileItemIfNeeded(fileItem);
  }

  private _createTestItemForEntry(entry: Entry): vscode.TestItem {
    return this._testTree.createForLocation(entry.title, vscode.Uri.file(entry.file), entry.line);
  }

  private _onDidDeleteFile(file: string) {
    const testItem = this._testTree.getForLocation(file);
    if (testItem)
      this._testTree.delete(testItem);
  }

  private async _onDidChangeFiles(configs: Map<Config, Set<string>>) {
    const loadedFilesByConfig = new Map<Config, vscode.TestItem[]>();

    // Ensure all test items are created for all created and changed files.
    for (const [config, files] of configs) {
      const testItems = [...files].map(file => this._testTree.getOrCreateForFileOrFolder(file)) as vscode.TestItem[];
      // Erase all loaded test items in loaded files.
      const loadedFileItems = testItems.filter(testItem => this._testTree.isLoaded(testItem));
      for (const fileItem of loadedFileItems) {
        this._testTree.setLoaded(fileItem, true);
        this._testTree.unbindChildren(fileItem);
      }
      loadedFilesByConfig.set(config, loadedFileItems);
    }

    // Request updated information for changed and created files.
    this._testTree.beginCoalescingUpdate();
    try {
      for (const [config, fileItems] of loadedFilesByConfig)
        await this._populateFileItems(config, fileItems);
    } finally {
      this._testTree.endCoalescingUpdate();
    }
  }

  private async _populateFileItemIfNeeded(fileItem: vscode.TestItem | undefined): Promise<void> {
    if (!fileItem || this._testTree.isLoaded(fileItem))
      return;
    this._testTree.setLoaded(fileItem, true);
    this._testTree.unbindChildren(fileItem);

    this._testTree.beginCoalescingUpdate();
    try {
      for (const config of this._testTree.configs(fileItem))
        await this._populateFileItems(config, [fileItem]);
    } finally {
      this._testTree.endCoalescingUpdate();
    }
  }

  private async _populateFileItems(config: Config, fileItems: vscode.TestItem[]) {
    const files = await this._playwrightTest.listTests(config, fileItems.map(i => i.uri!.fsPath));
    this._updateTestTreeFromEntries(files);
  }

  private async _runTest(request: vscode.TestRunRequest, config: Config, projectName: string, location: string | null, token: vscode.CancellationToken) {
    const testRun = this._testController.createTestRun(request);

    // Provide immediate feedback on action target.
    for (const testItem of request.include || [])
      testRun.enqueued(testItem);
      testRun.appendOutput('\x1b[H\x1b[2J');

    const fireExecutionLinesChanged = () => {
      const active = [...this._activeSteps.values()];
      const completed = [...this._completedSteps.values()];
      this._executionLinesChanged.fire({ active, completed });
    };

    this._completedSteps.clear();
    fireExecutionLinesChanged();

    await this._playwrightTest.runTests(config, projectName, location, {
      onBegin: ({ files }) => {
        const items = new Set<vscode.TestItem>();
        this._updateTestTreeFromEntries(files, items);
        for (const item of items)
          testRun.enqueued(item);
        return false;
      },

      onTestBegin: params => {
        const testItem = this._testTree.getForLocation(params.testId);
        if (testItem)
          testRun.started(testItem);
      },

      onTestEnd: params => {
        this._activeSteps.clear();
        fireExecutionLinesChanged();

        const testItem = this._testTree.getForLocation(params.testId);
        if (!testItem)
          return;
        if (params.ok) {
          testRun.passed(testItem, params.duration);
          return;
        }
        testRun.failed(testItem, testMessageForTestError(testItem, params.error!), params.duration);
      },

      onStepBegin: params => {
        if (!params.location)
          return;
        let step = this._activeSteps.get(params.stepId);
        if (!step) {
          step = {
            location: new vscode.Location(
              vscode.Uri.file(params.location.file),
              new vscode.Position(params.location.line - 1, params.location.column - 1)),
            activeCount: 0,
            duration: 0,
          };
          this._activeSteps.set(params.stepId, step);
        }
        ++step.activeCount;
        fireExecutionLinesChanged();
      },

      onStepEnd: params => {
        if (!params.stepId)
          return;
        let step = this._activeSteps.get(params.stepId)!;
        --step.activeCount;
        step.duration = params.duration;
        this._completedSteps.set(params.stepId, step);
        if (step.activeCount === 0)
          this._activeSteps.delete(params.stepId);
        fireExecutionLinesChanged();
      },

      onStdOut: data => {
        testRun.appendOutput(data.toString().replace(/\n/g, '\r\n'));
      },

      onStdErr: data => {
        testRun.appendOutput(data.toString().replace(/\n/g, '\r\n'));
      },
    }, token);
    this._activeSteps.clear();
    fireExecutionLinesChanged();
    testRun.end();
  }
 
  private _updateTestTreeFromEntries(files: Entry[], collector?: Set<vscode.TestItem>) {
    const map = (parentEntry: Entry, parentItem: vscode.TestItem) => {
      for (const entry of parentEntry.children || []) {
        // Tolerate clashing configs that are adding dupe tests in common files.
        let testItem = this._testTree.getForLocation(entry.id);
        if (!testItem) {
          testItem = this._createTestItemForEntry(entry);
          this._testTree.addChild(parentItem, testItem);
        }
        collector?.add(testItem);
        map(entry, testItem);
      }
    };

    for (const fileEntry of files) {
      const fileItem = this._testTree.getOrCreateForFileOrFolder(fileEntry.file);
      // Sometimes files are going to be outside of the workspace, ignore those.
      if (!fileItem)
        continue;
      map(fileEntry, fileItem);
    }
  }

  private async _updateActiveEditorItems() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
      return;
    const fsPath = editor.document.uri.fsPath;
    const fileItem = this._testTree.getForLocation(fsPath);
    this._populateFileItemIfNeeded(fileItem);
  }

  errorInDebugger(errorStack: string, location: DebuggerLocation) {
    if (!this._testItemUnderDebug)
      return;
    const testRun = this._testController.createTestRun({
      include: undefined,
      exclude: undefined,
      profile: undefined,
    });
    testRun.started(this._testItemUnderDebug);

    const testMessage = new vscode.TestMessage(errorStack);
    const position = new vscode.Position(location.line - 1, location.column - 1);
    testMessage.location = new vscode.Location(vscode.Uri.file(location.path), position);
    testRun.failed(this._testItemUnderDebug, testMessage);
    this._testItemUnderDebug = undefined;

    testRun.end();
  }
}

function testMessageForTestError(testItem: vscode.TestItem, error: TestError): vscode.TestMessage {
  const message = new vscode.TestMessage(error.stack || error.message || error.value!);
  const location = parseLocationFromStack(testItem, error.stack);
  if (location) {
    const position = new vscode.Position(location.line - 1, location.column - 1);
    message.location = new vscode.Location(vscode.Uri.file(location.path), position);
  }
  return message;
}

function parseLocationFromStack(testItem: vscode.TestItem, stack: string | undefined): DebuggerLocation | undefined {
  const lines = stack?.split('\n') || [];
  for (const line of lines) {
    const frame = stackUtils.parseLine(line);
    if (!frame || !frame.file || !frame.line || !frame.column)
      continue;

    if (testItem.uri!.fsPath === frame.file) {
      return {
        path: frame.file,
        line: frame.line,
        column: frame.column,
      };
    }
  }
}

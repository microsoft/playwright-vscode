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
import { Entry } from './oopReporter';
import { ListFilesReport, PlaywrightTest, TestListener } from './playwrightTest';
import type { TestError } from './reporter';
import { Config, TestTree } from './testTree';
import * as vscodeTypes from './vscodeTypes';
import { WorkspaceObserver } from './workspaceObserver';

const stackUtils = new StackUtils({
  cwd: '/ensure_absolute_paths'
});
export type DebuggerLocation = { path: string, line: number, column: number };

type StepInfo = {
  location: vscodeTypes.Location;
  activeCount: number;
  duration: number;
};

export class TestModel {
  private _vscode: vscodeTypes.VSCode;

  // Global test item map.
  private _testTree: TestTree;

  // Each run profile is a config + project pair.
  private _runProfiles: vscodeTypes.TestRunProfile[] = [];

  private _testController: vscodeTypes.TestController;
  private _workspaceObserver: WorkspaceObserver;
  private _playwrightTest: PlaywrightTest;
  private _disposables: vscodeTypes.Disposable[];
  private _testItemUnderDebug: vscodeTypes.TestItem | undefined;

  private _executionLinesChanged: vscodeTypes.EventEmitter<{ active: StepInfo[], completed: StepInfo[] }>;
  readonly onExecutionLinesChanged: vscodeTypes.Event<{ active: StepInfo[], completed: StepInfo[] }>;
  private _activeSteps = new Map<string, StepInfo>();
  private _completedSteps = new Map<string, StepInfo>();
  private _testRun: vscodeTypes.TestRun | undefined;

  constructor(vscode: vscodeTypes.VSCode) {
    this._vscode = vscode;
    this._executionLinesChanged = new vscode.EventEmitter<{ active: StepInfo[], completed: StepInfo[] }>();
    this.onExecutionLinesChanged = this._executionLinesChanged.event;
    this._testController = vscode.tests.createTestController('pw.extension.testController', 'Playwright');
    this._testController.resolveHandler = item => this._resolveChildren(item);
    this._testTree = new TestTree(vscode, this._testController);
    this._playwrightTest = new PlaywrightTest();

    this._workspaceObserver = new WorkspaceObserver(this._vscode, change => {
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
      vscode.workspace.onDidChangeWorkspaceFolders((_) => {
        this._rebuildModel(true);
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this._updateActiveEditorItems();
      }),
      vscode.commands.registerCommand('pw.extension.refreshTests', () => {
        this._rebuildModel(true);
      }),
      vscode.workspace.onDidChangeTextDocument(() => {
        if (this._completedSteps.size) {
          this._completedSteps.clear();
          this._fireExecutionLinesChanged();
        }
      }),
      this._testController,
      this._workspaceObserver,
    ];
  }

  async init() {
    await this._rebuildModel(false);
  }

  dispose() {
    this._disposables.forEach(d => d.dispose());
  }

  private async _rebuildModel(refresh: boolean) {
    this._testTree.startedLoading();
    this._workspaceObserver.reset();
    for (const profile of this._runProfiles)
      profile.dispose();
    this._runProfiles = [];

    // Give UI a chance to update.
    if (refresh)
      await new Promise(f => setTimeout(f, 200));

    // Check Playwright version.
    const rootTreeItems: vscodeTypes.TestItem[] = [];
    const configFiles = await this._vscode.workspace.findFiles('**/*playwright*.config.[tj]s');
    for (const configFileUri of configFiles) {
      const configFilePath = configFileUri.fsPath;
      if (configFilePath.includes('node_modules'))
        continue;
      // Dogfood support
      if (configFilePath.includes(path.join('playwright', 'test-results')))
        continue;
      const workspaceFolder = this._vscode.workspace.getWorkspaceFolder(configFileUri)!.uri.fsPath;
      const playwrightInfo = this._playwrightTest.getPlaywrightInfo(workspaceFolder, configFilePath);
      if (!playwrightInfo) {
        this._vscode.window.showWarningMessage('Please install Playwright Test via running `npm i @playwright/test`');
        continue;
      }

      if (playwrightInfo.version < 1.19) {
        this._vscode.window.showWarningMessage('Playwright Test v1.19 or newer is required');
        continue;
      }

      const config: Config = {
        workspaceFolder,
        configFile: configFileUri.fsPath,
        cli: playwrightInfo.cli,
      };

      const report = await this._playwrightTest.listFiles(config);
      if (!report)
        continue;
      const configDir = path.dirname(config.configFile);
      config.testDir = report.testDir ? path.resolve(configDir, report.testDir) : configDir;
      const rootName = path.basename(path.dirname(config.testDir)) + path.sep + path.basename(config.testDir);
      const rootTreeItem = this._testTree.createForLocation(rootName, this._vscode.Uri.file(config.testDir))
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
      const handler = async (isDebug: boolean, request: vscodeTypes.TestRunRequest, token: vscodeTypes.CancellationToken) => {
        if (!request.include) {
          await this._runTest(isDebug, request, config, project.name, null, token);
          return;
        }
        for (const testItem of request.include) {
          const location = this._testTree.location(testItem);
          await this._runTest(isDebug, request, config, project.name, location!, token);
        }
      };
      this._runProfiles.push(this._testController.createRunProfile(`${folderName}${path.sep}${configName}${projectSuffix}`, this._vscode.TestRunProfileKind.Run, handler.bind(null, false), true));
      this._runProfiles.push(this._testController.createRunProfile(`${folderName}${path.sep}${configName}${projectSuffix}`, this._vscode.TestRunProfileKind.Debug, handler.bind(null, true), true));
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

  private async _resolveChildren(fileItem: vscodeTypes.TestItem | undefined): Promise<void> {
    await this._populateFileItemIfNeeded(fileItem);
  }

  private _createTestItemForEntry(entry: Entry): vscodeTypes.TestItem {
    return this._testTree.createForLocation(entry.title, this._vscode.Uri.file(entry.file), entry.line);
  }

  private _onDidDeleteFile(file: string) {
    const testItem = this._testTree.getForLocation(file);
    if (testItem)
      this._testTree.delete(testItem);
  }

  private async _onDidChangeFiles(configs: Map<Config, Set<string>>) {
    const loadedFilesByConfig = new Map<Config, vscodeTypes.TestItem[]>();

    // Ensure all test items are created for all created and changed files.
    for (const [config, files] of configs) {
      const testItems = [...files].map(file => this._testTree.getOrCreateForFileOrFolder(file)) as vscodeTypes.TestItem[];
      // Erase all loaded test items in loaded files.
      const loadedFileItems = testItems.filter(testItem => this._testTree.isLoaded(testItem));
      for (const fileItem of loadedFileItems) {
        this._testTree.setLoaded(fileItem, true);
        this._testTree.unbindChildren(fileItem);
      }
      loadedFilesByConfig.set(config, loadedFileItems);
    }

    // Request updated information for changed and created files.
    for (const [config, fileItems] of loadedFilesByConfig)
      await this._populateFileItems(config, fileItems);
  }

  private async _populateFileItemIfNeeded(fileItem: vscodeTypes.TestItem | undefined): Promise<void> {
    if (!fileItem || this._testTree.isLoaded(fileItem))
      return;
    this._testTree.setLoaded(fileItem, true);
    this._testTree.unbindChildren(fileItem);

    for (const config of this._testTree.configs(fileItem))
      await this._populateFileItems(config, [fileItem]);
  }

  private async _populateFileItems(config: Config, fileItems: vscodeTypes.TestItem[]) {
    const files = await this._playwrightTest.listTests(config, fileItems.map(i => i.uri!.fsPath));
    this._updateTestTreeFromEntries(files);
  }

  private async _runTest(isDebug: boolean, request: vscodeTypes.TestRunRequest, config: Config, projectName: string, location: string | null, token: vscodeTypes.CancellationToken) {
    const testRun = this._testController.createTestRun(request);

    // Provide immediate feedback on action target.
    for (const testItem of request.include || [])
      testRun.enqueued(testItem);
      testRun.appendOutput('\x1b[H\x1b[2J');

    this._completedSteps.clear();
    this._fireExecutionLinesChanged();

    const testListener: TestListener = {
      onBegin: ({ files }) => {
        const items = new Set<vscodeTypes.TestItem>();
        this._updateTestTreeFromEntries(files, items);
        for (const item of items)
          testRun.enqueued(item);
        return false;
      },

      onTestBegin: params => {
        const testItem = this._testTree.getForLocation(params.testId);
        if (testItem)
          testRun.started(testItem);
        if (isDebug) {
          // Debugging is always single-workers.
          this._testItemUnderDebug = testItem;
        }
      },

      onTestEnd: params => {
        this._testItemUnderDebug = undefined;
        this._activeSteps.clear();
        this._fireExecutionLinesChanged();

        const testItem = this._testTree.getForLocation(params.testId);
        if (!testItem)
          return;
        if (params.ok) {
          testRun.passed(testItem, params.duration);
          return;
        }
        testRun.failed(testItem, this._testMessageForTestError(testItem, params.error!), params.duration);
      },

      onStepBegin: params => {
        if (!params.location)
          return;
        let step = this._activeSteps.get(params.stepId);
        if (!step) {
          step = {
            location: new this._vscode.Location(
              this._vscode.Uri.file(params.location.file),
              new this._vscode.Position(params.location.line - 1, params.location.column - 1)),
            activeCount: 0,
            duration: 0,
          };
          this._activeSteps.set(params.stepId, step);
        }
        ++step.activeCount;
        this._fireExecutionLinesChanged();
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
          this._fireExecutionLinesChanged();
      },

      onStdOut: data => {
        testRun.appendOutput(data.toString().replace(/\n/g, '\r\n'));
      },

      onStdErr: data => {
        testRun.appendOutput(data.toString().replace(/\n/g, '\r\n'));
      },
    };

    this._testRun = testRun;
    try {
      if (isDebug)
      await this._playwrightTest.debugTests(this._vscode, config, projectName, location, testListener, token);
    else
      await this._playwrightTest.runTests(config, projectName, location, testListener, token);
    } finally {
      this._activeSteps.clear();
      this._fireExecutionLinesChanged();
      testRun.end();
      this._testRun = undefined;
    }
  }

  private _updateTestTreeFromEntries(files: Entry[], collector?: Set<vscodeTypes.TestItem>) {
    const lazyChildren = new Map<vscodeTypes.TestItem, vscodeTypes.TestItem[]>();

    const map = (parentEntry: Entry, parentItem: vscodeTypes.TestItem) => {
      for (const entry of parentEntry.children || []) {
        // Tolerate clashing configs that are adding dupe tests in common files.
        let testItem = this._testTree.getForLocation(entry.id);
        if (!testItem) {
          testItem = this._createTestItemForEntry(entry);

          let children = lazyChildren.get(parentItem);
          if (!children) {
            children = [];
            lazyChildren.set(parentItem, children);
          }
          children.push(testItem);

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

    for (const [fileItem, children] of lazyChildren)
      fileItem.children.replace(children);
  }

  private async _updateActiveEditorItems() {
    const editor = this._vscode.window.activeTextEditor;
    if (!editor)
      return;
    const fsPath = editor.document.uri.fsPath;
    const fileItem = this._testTree.getForLocation(fsPath);
    this._populateFileItemIfNeeded(fileItem);
  }

  errorInDebugger(errorStack: string, location: DebuggerLocation) {
    if (!this._testRun || !this._testItemUnderDebug)
      return;
    const testMessage = new this._vscode.TestMessage(errorStack);
    const position = new this._vscode.Position(location.line - 1, location.column - 1);
    testMessage.location = new this._vscode.Location(this._vscode.Uri.file(location.path), position);
    this._testRun.failed(this._testItemUnderDebug, testMessage);
    this._testItemUnderDebug = undefined;
  }

  private _fireExecutionLinesChanged() {
    const active = [...this._activeSteps.values()];
    const completed = [...this._completedSteps.values()];
    this._executionLinesChanged.fire({ active, completed });
  }

  private _testMessageForTestError(testItem: vscodeTypes.TestItem, error: TestError): vscodeTypes.TestMessage {
    const message = new this._vscode.TestMessage(error.stack || error.message || error.value!);
    const location = parseLocationFromStack(testItem, error.stack);
    if (location) {
      const position = new this._vscode.Position(location.line - 1, location.column - 1);
      message.location = new this._vscode.Location(this._vscode.Uri.file(location.path), position);
    }
    return message;
  }  
}

function parseLocationFromStack(testItem: vscodeTypes.TestItem, stack: string | undefined): DebuggerLocation | undefined {
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

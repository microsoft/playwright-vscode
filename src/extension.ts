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
import { DebugHighlight } from './debugHighlight';
import { installPlaywright } from './installer';
import { Entry } from './oopReporter';
import { PlaywrightTest, TestListener } from './playwrightTest';
import { Recorder } from './recorder';
import type { TestError } from './reporter';
import { TestModel, TestProject } from './testModel';
import { TestTree } from './testTree';
import { ansiToHtml } from './utils';
import * as vscodeTypes from './vscodeTypes';
import { WorkspaceChange, WorkspaceObserver } from './workspaceObserver';

const stackUtils = new StackUtils({
  cwd: '/ensure_absolute_paths'
});
export type DebuggerLocation = { path: string, line: number, column: number };

type StepInfo = {
  location: vscodeTypes.Location;
  activeCount: number;
  duration: number;
};

type TestRunInfo = {
  selectedProjects: TestProject[];
  isDebug: boolean;
  request: vscodeTypes.TestRunRequest;
};

export async function activate(context: vscodeTypes.ExtensionContext) {
  // Do not await, quickly run the extension, schedule work.
  new Extension(require('vscode')).activate(context);
}

export class Extension {
  private _vscode: vscodeTypes.VSCode;

  // Global test item map.
  private _testTree: TestTree;

  // Each run profile is a config + project pair.
  private _runProfiles = new Map<string, vscodeTypes.TestRunProfile>();

  private _testController: vscodeTypes.TestController;
  private _workspaceObserver: WorkspaceObserver;
  private _testItemUnderDebug: vscodeTypes.TestItem | undefined;

  private _activeSteps = new Map<string, StepInfo>();
  private _completedSteps = new Map<string, StepInfo>();
  private _testRun: vscodeTypes.TestRun | undefined;
  private _models: TestModel[] = [];
  private _activeStepDecorationType: vscodeTypes.TextEditorDecorationType;
  private _completedStepDecorationType: vscodeTypes.TextEditorDecorationType;
  private _playwrightTest: PlaywrightTest;
  private _projectsScheduledToRun: TestProject[] | undefined;
  private _debugHighlight: DebugHighlight;
  private _isUnderTest: boolean;
  private _recorder: Recorder;

  constructor(vscode: vscodeTypes.VSCode) {
    this._vscode = vscode;
    this._isUnderTest = !!(this._vscode as any).isUnderTest;
    this._activeStepDecorationType = this._vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: { id: 'editor.wordHighlightStrongBackground' },
      borderColor: { id: 'editor.wordHighlightStrongBorder' },
      after: {
        color: { id: 'editorCodeLens.foreground' },
        contentText: ' \u2014 ⌛waiting\u2026',
      },
    });

    this._completedStepDecorationType = this._vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      after: {
        color: { id: 'editorCodeLens.foreground' },
      },
    });

    this._playwrightTest = new PlaywrightTest(this._isUnderTest);
    this._recorder = new Recorder(this._vscode, this._playwrightTest);
    this._testController = vscode.tests.createTestController('pw.extension.testController', 'Playwright');
    this._testController.resolveHandler = item => this._resolveChildren(item);
    this._testController.refreshHandler = () => {
      this._rebuildModel(true).then(configs => {
        if (!configs.length) {
          vscode.window.showWarningMessage('No Playwright Test config files found.');
          return;
        }
      }).catch();
    };
    this._testTree = new TestTree(vscode, this._testController);
    this._debugHighlight = new DebugHighlight(vscode);
    this._debugHighlight.onErrorInDebugger(e => this._errorInDebugger(e.error, e.location));
    this._workspaceObserver = new WorkspaceObserver(this._vscode, changes => this._workspaceChanged(changes));
  }

  async activate(context: vscodeTypes.ExtensionContext) {
    const vscode = this._vscode;
    const disposables = [
      vscode.workspace.onDidChangeWorkspaceFolders(_ => {
        this._rebuildModel(false);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this._updateVisibleEditorItems();
      }),
      vscode.commands.registerCommand('pw.extension.recordTest', async () => {
        if (!this._models.length) {
          vscode.window.showWarningMessage('No Playwright tests found.');
          return;
        }
        this._recorder.record(this._models);
      }),
      vscode.commands.registerCommand('pw.extension.install', () => {
        installPlaywright(this._vscode);
      }),
      vscode.workspace.onDidChangeTextDocument(() => {
        if (this._completedSteps.size) {
          this._completedSteps.clear();
          this._executionLinesChanged();
        }
      }),
      this._testController,
      this._workspaceObserver,
      this._recorder,
    ];
    this._debugHighlight.activate(context);
    await this._rebuildModel(false);

    const fileSystemWatcher = this._vscode.workspace.createFileSystemWatcher('**/*playwright*.config.{ts,js,mjs}');
    disposables.push(fileSystemWatcher);
    const rebuildModelForConfig = (uri: vscodeTypes.Uri) => {
      // TODO: parse .gitignore
      if (uri.fsPath.includes('node_modules'))
        return;
      if (!this._isUnderTest && uri.fsPath.includes('test-results'))
        return;
      this._rebuildModel(false);
    };
    fileSystemWatcher.onDidChange(rebuildModelForConfig);
    fileSystemWatcher.onDidCreate(rebuildModelForConfig);
    fileSystemWatcher.onDidDelete(rebuildModelForConfig);
    context.subscriptions.push(...disposables);
  }

  private async _rebuildModel(showWarnings: boolean): Promise<vscodeTypes.Uri[]> {
    this._testTree.startedLoading();
    this._workspaceObserver.reset();
    this._models = [];

    const configFiles = await this._vscode.workspace.findFiles('**/*playwright*.config.{ts,js,mjs}');

    // Reuse already created run profiles in order to retain their 'selected' status.
    const usedProfiles = new Set<vscodeTypes.TestRunProfile>();

    for (const configFileUri of configFiles) {
      const configFilePath = configFileUri.fsPath;
      // TODO: parse .gitignore
      if (configFilePath.includes('node_modules'))
        continue;
      if (!this._isUnderTest && configFilePath.includes('test-results'))
        continue;
      // Dogfood support
      const workspaceFolder = this._vscode.workspace.getWorkspaceFolder(configFileUri)!;
      const workspaceFolderPath = workspaceFolder.uri.fsPath;
      if (configFilePath.includes('test-results') && !workspaceFolderPath.includes('test-results'))
        continue;
      const playwrightInfo = await this._playwrightTest.getPlaywrightInfo(workspaceFolderPath, configFilePath);
      if (!playwrightInfo) {
        if (showWarnings)
          this._vscode.window.showWarningMessage('Please install Playwright Test via running `npm i --save-dev @playwright/test`');
        continue;
      }

      if (playwrightInfo.version < 1.19) {
        if (showWarnings)
          this._vscode.window.showWarningMessage('Playwright Test v1.19 or newer is required');
        continue;
      }

      const model = new TestModel(this._vscode, this._playwrightTest, workspaceFolderPath, configFileUri.fsPath, playwrightInfo.cli);
      this._models.push(model);
      this._testTree.addModel(model);
      await model.listFiles();

      for (const project of model.projects.values()) {
        await this._createRunProfile(project, usedProfiles);
        this._workspaceObserver.addWatchFolder(project.testDir);
      }
    }

    // Clean up unused run profiles.
    for (const [key, profile] of this._runProfiles) {
      if (!usedProfiles.has(profile)) {
        this._runProfiles.delete(key);
        profile.dispose();
      }
    }

    this._testTree.finishedLoading();
    await this._updateVisibleEditorItems();
    return configFiles;
  }

  private async _createRunProfile(project: TestProject, usedProfiles: Set<vscodeTypes.TestRunProfile>) {
    const configFile = project.model.config.configFile;
    const configName = path.basename(configFile);
    const folderName = path.basename(path.dirname(configFile));
    const projectPrefix = project.name ? `${project.name} — ` : '';
    const keyPrefix = configFile + ':' + project.name;
    let runProfile = this._runProfiles.get(keyPrefix + ':run');
    if (!runProfile) {
      runProfile = this._testController.createRunProfile(`${projectPrefix}${folderName}${path.sep}${configName}`, this._vscode.TestRunProfileKind.Run, this._scheduleTestRunRequest.bind(this, configFile, project.name, false), true);
      this._runProfiles.set(keyPrefix + ':run', runProfile);
    }
    let debugProfile = this._runProfiles.get(keyPrefix + ':debug');
    if (!debugProfile) {
      debugProfile = this._testController.createRunProfile(`${projectPrefix}${folderName}${path.sep}${configName}`, this._vscode.TestRunProfileKind.Debug, this._scheduleTestRunRequest.bind(this, configFile, project.name, true), true);
      this._runProfiles.set(keyPrefix + ':debug', debugProfile);
    }
    usedProfiles.add(runProfile);
    usedProfiles.add(debugProfile);
  }

  private async _scheduleTestRunRequest(configFile: string, projectName: string, isDebug: boolean, request: vscodeTypes.TestRunRequest) {
    // Never run tests concurrently.
    if (this._testRun)
      return;

    // We can't dispose projects (and bind them to TestProject instances) because otherwise VS Code would forget its selection state.
    // So bind run profiles to config file + project name pair, dynamically resolve the project.
    const model = this._models.find(m => m.config.configFile === configFile);
    if (!model)
      return;
    const project = model.projects.get(projectName);
    if (!project)
      return;

    // VSCode will issue several test run requests (one per enabled run profile). Sometimes
    // these profiles belong to the same config and we only want to run tests once per config.
    // So we collect all requests and sort them out in the microtask.
    if (!this._projectsScheduledToRun) {
      this._projectsScheduledToRun = [];
      this._projectsScheduledToRun.push(project);
      await Promise.resolve().then(async () => {
        const selectedProjects = this._projectsScheduledToRun!;
        this._projectsScheduledToRun = undefined;
        await this._runMatchingTests({ selectedProjects, isDebug, request });
      });
    } else {
      // Subsequent requests will return right away.
      this._projectsScheduledToRun.push(project);
    }
  }

  private async _runMatchingTests(testRunInfo: TestRunInfo) {
    const { selectedProjects, isDebug, request } = testRunInfo;

    this._completedSteps.clear();
    this._executionLinesChanged();
    this._testRun = this._testController.createTestRun(request);

    // Provisionally mark tests (not files and not suits) as enqueued to provide immediate feedback.
    for (const item of request.include || []) {
      for (const test of this._testTree.collectTestsInside(item))
        this._testRun.enqueued(test);
    }

    // Run tests with different configs sequentially, group by config.
    const projectsToRunByModel = new Map<TestModel, TestProject[]>();
    for (const project of selectedProjects) {
      const projects = projectsToRunByModel.get(project.model) || [];
      projects.push(project);
      projectsToRunByModel.set(project.model, projects);
    }

    let ranSomeTests = false;
    try {
      for (const [model, projectsToRun] of projectsToRunByModel) {
        const { projects, locations, parametrizedTestTitle } = this._narrowDownProjectsAndLocations(projectsToRun, request.include);
        // Run if:
        //   !locations => run all tests
        //   locations.length => has matching items in project.
        if (locations && !locations.length)
          continue;
        ranSomeTests = true;
        await this._runTest(this._testRun, new Set(), model, isDebug, projects, locations, parametrizedTestTitle);
      }
    } finally {
      this._activeSteps.clear();
      this._executionLinesChanged();
      this._testRun.end();
      this._testRun = undefined;
    }

    if (!ranSomeTests) {
      this._vscode.window.showWarningMessage(`Selected test is outside of the Default Profile (config).
Please make sure you select relevant Playwright projects in the "Select Configuration\u2026" drop down
located next to Run / Debug Tests toolbar buttons.`);
    }
  }

  private _narrowDownProjectsAndLocations(projects: TestProject[], items: readonly vscodeTypes.TestItem[] | undefined): { projects: TestProject[], locations: string[] | null, parametrizedTestTitle: string | undefined } {
    if (!items)
      return { projects, locations: null, parametrizedTestTitle: undefined };

    let parametrizedTestTitle: string | undefined;
    // When we are given one item, check if it is parametrized (more than 1 item on that line).
    // If it is parametrized, use label when running test.
    if (items.length === 1) {
      const test = items[0];
      if (test.uri && test.range) {
        let testsAtLocation = 0;
        test.parent?.children.forEach(t => {
          if (t.uri?.fsPath === test.uri?.fsPath && t.range?.start.line === test.range?.start.line)
            ++testsAtLocation;
        });
        if (testsAtLocation > 1)
          parametrizedTestTitle = test.label;
      }
    }

    // Only pick projects that have tests matching test run request.
    const locations = new Set<string>();
    const projectsWithFiles: TestProject[] = [];
    for (const item of items) {
      const itemFsPath = item.uri!.fsPath;
      const projectsWithFile = projects.filter(project => {
        for (const file of project.files.keys()) {
          if (file.startsWith(itemFsPath))
            return true;
        }
        return false;
      });
      if (!projectsWithFile.length)
        continue;
      const line = item.range ? ':' + (item.range.start.line + 1) : '';
      locations.add(item.uri!.fsPath + line);
      projectsWithFiles.push(...projectsWithFile);
    }
    return { projects: projectsWithFiles, locations: [...locations], parametrizedTestTitle };
  }

  private async _resolveChildren(fileItem: vscodeTypes.TestItem | undefined): Promise<void> {
    if (!fileItem)
      return;
    for (const model of this._models)
      await model.listTests([fileItem!.uri!.fsPath]);
  }

  private async _workspaceChanged(change: WorkspaceChange) {
    for (const model of this._models)
      await model.workspaceChanged(change);
    // Workspace change can be deferred, make sure editors are
    // decorated.
    this._updateVisibleEditorItems();
  }

  private async _runTest(
    testRun: vscodeTypes.TestRun,
    testFailures: Set<vscodeTypes.TestItem>,
    model: TestModel,
    isDebug: boolean,
    projects: TestProject[],
    locations: string[] | null,
    parametrizedTestTitle: string | undefined) {
    const testListener: TestListener = {
      onBegin: ({ projects }) => {
        model.updateFromRunningProjects(projects);
        const visit = (entry: Entry) => {
          if (entry.type === 'test') {
            const testItem = this._testTree.testItemForLocation(entry.location, entry.title);
            if (testItem)
              testRun.enqueued(testItem);
          }
          (entry.children || []).forEach(visit);
        };
        projects.forEach(visit);
      },

      onTestBegin: params => {
        const testItem = this._testTree.testItemForLocation(params.location, params.title);
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
        this._executionLinesChanged();

        const testItem = this._testTree.testItemForLocation(params.location, params.title);
        if (!testItem)
          return;
        if (params.status === params.expectedStatus) {
          if (!testFailures.has(testItem)) {
            if (params.status === 'skipped')
              testRun.skipped(testItem);
            else
              testRun.passed(testItem, params.duration);
          }
          return;
        }
        testFailures.add(testItem);
        testRun.failed(testItem, params.errors.map(error => this._testMessageForTestError(testItem, error)), params.duration);
      },

      onStepBegin: params => {
        const stepId = params.location.file + ':' + params.location.line;
        let step = this._activeSteps.get(stepId);
        if (!step) {
          step = {
            location: new this._vscode.Location(
                this._vscode.Uri.file(params.location.file),
                new this._vscode.Position(params.location.line - 1, params.location.column - 1)),
            activeCount: 0,
            duration: 0,
          };
          this._activeSteps.set(stepId, step);
        }
        ++step.activeCount;
        this._executionLinesChanged();
      },

      onStepEnd: params => {
        const stepId = params.location.file + ':' + params.location.line;
        const step = this._activeSteps.get(stepId)!;
        if (!step)
          return;
        --step.activeCount;
        step.duration = params.duration;
        this._completedSteps.set(stepId, step);
        if (step.activeCount === 0)
          this._activeSteps.delete(stepId);
        this._executionLinesChanged();
      },

      onStdOut: data => {
        testRun.appendOutput(data.toString().replace(/\n/g, '\r\n'));
      },

      onStdErr: data => {
        testRun.appendOutput(data.toString().replace(/\n/g, '\r\n'));
      },
    };

    if (isDebug)
      await model.debugTests(projects, locations, testListener, parametrizedTestTitle, testRun.token);
    else
      await model.runTests(projects, locations, testListener, parametrizedTestTitle, testRun.token);
  }

  private async _updateVisibleEditorItems() {
    const files = this._vscode.window.visibleTextEditors.map(e => e.document.uri.fsPath);
    if (files.length) {
      for (const model of this._models)
        await model.listTests(files);
    }
  }

  private _errorInDebugger(errorStack: string, location: DebuggerLocation) {
    if (!this._testRun || !this._testItemUnderDebug)
      return;
    const testMessage = this._testMessageFromText(errorStack);
    const position = new this._vscode.Position(location.line - 1, location.column - 1);
    testMessage.location = new this._vscode.Location(this._vscode.Uri.file(location.path), position);
    this._testRun.failed(this._testItemUnderDebug, testMessage);
    this._testItemUnderDebug = undefined;
  }

  private _executionLinesChanged() {
    const active = [...this._activeSteps.values()];
    const completed = [...this._completedSteps.values()];

    for (const editor of this._vscode.window.visibleTextEditors) {
      const activeDecorations: vscodeTypes.DecorationOptions[] = [];
      for (const { location } of active) {
        if (location.uri.fsPath === editor.document.uri.fsPath)
          activeDecorations.push({ range: location.range });
      }

      const completedDecorations: vscodeTypes.DecorationOptions[] = [];
      for (const { location, duration } of completed) {
        if (location.uri.fsPath === editor.document.uri.fsPath) {
          completedDecorations.push({
            range: location.range,
            renderOptions: {
              after: {
                contentText: ` \u2014 ${duration}ms`
              }
            }
          });
        }
      }

      editor.setDecorations(this._activeStepDecorationType, activeDecorations);
      editor.setDecorations(this._completedStepDecorationType, completedDecorations);
    }

  }

  private _testMessageFromText(text: string): vscodeTypes.TestMessage {
    let isLog = false;
    const md: string[] = [];
    const logMd: string[] = [];
    for (let line of text.split('\n')) {
      if (line.startsWith('    at ')) {
        // Render relative stack.
        for (const workspaceFolder of this._vscode.workspace.workspaceFolders || []) {
          const prefix = '    at ' + workspaceFolder.uri.fsPath;
          if (line.startsWith(prefix)) {
            line = '    at ' + line.substring(prefix.length + 1);
            break;
          }
        }
      }
      if (line.includes('=====') && line.includes('log')) {
        isLog = true;
        logMd.push('\n\n**Execution log**');
        continue;
      }
      if (line.includes('=====')) {
        isLog = false;
        continue;
      }
      if (isLog) {
        const [, indent, body] = line.match(/(\s*)(.*)/)!;
        logMd.push(indent + ' - ' + body);
      } else {
        md.push(line);
      }
    }
    const markdownString = new this._vscode.MarkdownString();
    markdownString.isTrusted = true;
    markdownString.supportHtml = true;
    markdownString.appendMarkdown(ansiToHtml(md.join('\n')));
    if (logMd.length)
      markdownString.appendMarkdown(logMd.join('\n'));
    return new this._vscode.TestMessage(markdownString);
  }

  private _testMessageForTestError(testItem: vscodeTypes.TestItem, error: TestError): vscodeTypes.TestMessage {
    const text = error.stack || error.message || error.value!;
    const testMessage = this._testMessageFromText(text);
    const location = parseLocationFromStack(testItem, error.stack);
    if (location) {
      const position = new this._vscode.Position(location.line - 1, location.column - 1);
      testMessage.location = new this._vscode.Location(this._vscode.Uri.file(location.path), position);
    }
    return testMessage;
  }

  playwrightTestLog(): string[] {
    return this._playwrightTest.testLog();
  }
}

function parseLocationFromStack(testItem: vscodeTypes.TestItem, stack: string | undefined): DebuggerLocation | undefined {
  const lines = stack?.split('\n') || [];
  for (const line of lines) {
    const frame = stackUtils.parseLine(line);
    if (!frame || !frame.file || !frame.line || !frame.column)
      continue;
    frame.file = frame.file.replace(/\//g, path.sep);
    if (testItem.uri!.fsPath === frame.file) {
      return {
        path: frame.file,
        line: frame.line,
        column: frame.column,
      };
    }
  }
}

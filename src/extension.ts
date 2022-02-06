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
import { discardHighlightCaches, hideHighlight, highlightLocator } from './highlighter';
import { Entry } from './oopReporter';
import { PlaywrightTest, TestListener } from './playwrightTest';
import type { TestError } from './reporter';
import { TestModel, TestProject } from './testModel';
import { TestTree } from './testTree';
import { stripAnsi } from './utils';
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

const debugSessions = new Map<string, vscodeTypes.DebugSession>();

export async function activate(context: vscodeTypes.ExtensionContext) {
  // Do not await, quickly run the extension, schedule work.
  new Extension(require('vscode')).activate(context);
}

export class Extension {
  private _vscode: vscodeTypes.VSCode;

  // Global test item map.
  private _testTree: TestTree;

  // Each run profile is a config + project pair.
  private _runProfiles: vscodeTypes.TestRunProfile[] = [];

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

  constructor(vscode: vscodeTypes.VSCode) {
    this._vscode = vscode;
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

    this._playwrightTest = new PlaywrightTest(!!(this._vscode as any).isUnderTest);
    this._testController = vscode.tests.createTestController('pw.extension.testController', 'Playwright');
    this._testController.resolveHandler = item => this._resolveChildren(item);
    this._testTree = new TestTree(vscode, this._testController);

    this._workspaceObserver = new WorkspaceObserver(this._vscode, changes => this._workspaceChanged(changes));
  }

  async activate(context: vscodeTypes.ExtensionContext) {
    const vscode = this._vscode;
    const self = this;
    const disposables = [
      vscode.debug.onDidStartDebugSession(session => {
        if (session.type === 'node-terminal' || session.type === 'pwa-node')
          debugSessions.set(session.id, session);
      }),
      vscode.debug.onDidTerminateDebugSession(session => {
        debugSessions.delete(session.id);
        hideHighlight();
        discardHighlightCaches();
      }),
      vscode.languages.registerHoverProvider('typescript', {
        provideHover(document, position, token) {
          highlightLocator(debugSessions, document, position, token).catch();
          return null;
        }
      }),
      vscode.window.onDidChangeTextEditorSelection(event => {
        highlightLocator(debugSessions, event.textEditor.document, event.selections[0].start).catch();
      }),
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker(session: vscodeTypes.DebugSession) {
          let lastCatchLocation: DebuggerLocation | undefined;
          return {
            onDidSendMessage: async message => {
              if (message.type !== 'response' || !message.success)
                return;
              if (message.command === 'scopes') {
                const catchBlock = message.body.scopes.find((scope: any) => scope.name === 'Catch Block');
                if (catchBlock) {
                  lastCatchLocation = {
                    path: catchBlock.source.path,
                    line: catchBlock.line,
                    column: catchBlock.column
                  };
                }
              }

              if (message.command === 'variables') {
                const errorVariable = message.body.variables.find((v: any) => v.name === 'playwrightError' && v.type === 'error');
                if (errorVariable && lastCatchLocation) {
                  const error = errorVariable.value;
                  self._errorInDebugger(error.replaceAll('\\n', '\n'), lastCatchLocation);
                }
              }
            }
          };
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(_ => {
        this._rebuildModel();
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this._updateVisibleEditorItems();
      }),
      vscode.commands.registerCommand('pw.extension.refreshTests', () => {
        this._rebuildModel();
      }),
      vscode.workspace.onDidChangeTextDocument(() => {
        if (this._completedSteps.size) {
          this._completedSteps.clear();
          this._executionLinesChanged();
        }
      }),
      this._testController,
      this._workspaceObserver,
    ];
    context.subscriptions.push(...disposables);
    await this._rebuildModel();
  }

  private async _rebuildModel() {
    this._testTree.startedLoading();
    this._workspaceObserver.reset();
    this._models = [];
    for (const profile of this._runProfiles)
      profile.dispose();
    this._runProfiles = [];

    const configFiles = await this._vscode.workspace.findFiles('**/*playwright*.config.{ts,js,mjs}');

    for (const configFileUri of configFiles) {
      const configFilePath = configFileUri.fsPath;
      if (configFilePath.includes('node_modules'))
        continue;
      // Dogfood support
      const workspaceFolder = this._vscode.workspace.getWorkspaceFolder(configFileUri)!;
      const workspaceFolderPath = workspaceFolder.uri.fsPath;
      if (configFilePath.includes('test-results') && !workspaceFolderPath.includes('test-results'))
        continue;
      const playwrightInfo = this._playwrightTest.getPlaywrightInfo(workspaceFolderPath, configFilePath);
      if (!playwrightInfo) {
        this._vscode.window.showWarningMessage('Please install Playwright Test via running `npm i @playwright/test`');
        continue;
      }

      if (playwrightInfo.version < 1.19) {
        this._vscode.window.showWarningMessage('Playwright Test v1.19 or newer is required');
        continue;
      }

      const model = new TestModel(this._vscode, this._playwrightTest, workspaceFolderPath, configFileUri.fsPath, playwrightInfo.cli);
      this._models.push(model);
      this._testTree.addModel(model);
      model.listFiles();

      for (const project of model.projects.values()) {
        await this._createRunProfile(project);
        this._workspaceObserver.addWatchFolder(project.testDir);
      }
    }

    await this._updateVisibleEditorItems();
  }

  private async _createRunProfile(project: TestProject) {
    const configName = path.basename(project.model.config.configFile);
    const folderName = path.basename(path.dirname(project.model.config.configFile));
    const projectPrefix = project.name ? `${project.name} — ` : '';

    this._runProfiles.push(this._testController.createRunProfile(`${projectPrefix}${folderName}${path.sep}${configName}`, this._vscode.TestRunProfileKind.Run, this._scheduleTestRunRequest.bind(this, project, false), project.isFirst));
    this._runProfiles.push(this._testController.createRunProfile(`${projectPrefix}${folderName}${path.sep}${configName}`, this._vscode.TestRunProfileKind.Debug, this._scheduleTestRunRequest.bind(this, project, true), project.isFirst));
  }

  private async _scheduleTestRunRequest(project: TestProject, isDebug: boolean, request: vscodeTypes.TestRunRequest, token: vscodeTypes.CancellationToken) {
    // Never run tests concurrently.
    if (this._testRun)
      return;

    // VSCode will issue several test run requests (one per enabled run profile). Sometimes
    // these profiles belong to the same config and we only want to run tests once per config.
    // So we collect all requests and sort them out in the microtask.
    if (!this._projectsScheduledToRun) {
      this._projectsScheduledToRun = [];
      this._projectsScheduledToRun.push(project);
      await Promise.resolve().then(async () => {
        const collector = this._projectsScheduledToRun!;
        this._projectsScheduledToRun = undefined;
        await this._runMatchingTests(collector, isDebug, request, token);
      });
    } else {
      // Subsequent requests will return right away.
      this._projectsScheduledToRun.push(project);
    }
  }

  private async _runMatchingTests(collector: TestProject[], isDebug: boolean, request: vscodeTypes.TestRunRequest, token: vscodeTypes.CancellationToken) {
    this._completedSteps.clear();
    this._executionLinesChanged();
    this._testRun = this._testController.createTestRun(request);

    // Run tests with different configs sequentially, group by config.
    const projectsToRunByModel = new Map<TestModel, TestProject[]>();
    for (const project of collector) {
      const projects = projectsToRunByModel.get(project.model) || [];
      projects.push(project);
      projectsToRunByModel.set(project.model, projects);
    }

    try {
      for (const [model, projectsToRun] of projectsToRunByModel) {
        const { projects, locations, parametrizedTestTitle } = this._narrowDownProjectsAndLocations(projectsToRun, request.include);
        // Run if:
        //   !locations => run all tests
        //   locations.length => has matching items in project.
        if (locations && !locations.length)
          continue;
        await this._runTest(this._testRun, model, isDebug, projects, locations, parametrizedTestTitle, token);
      }
    } finally {
      this._activeSteps.clear();
      this._executionLinesChanged();
      this._testRun.end();
      this._testRun = undefined;
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
      const projectsWithFile = projects.filter(project => item.uri!.fsPath.startsWith(project.testDir));
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
      model.workspaceChanged(change);
  }

  private async _runTest(testRun: vscodeTypes.TestRun, model: TestModel, isDebug: boolean, projects: TestProject[], locations: string[] | null, parametrizedTestTitle: string | undefined, token: vscodeTypes.CancellationToken) {
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
        if (params.ok) {
          testRun.passed(testItem, params.duration);
          return;
        }
        testRun.failed(testItem, this._testMessageForTestError(testItem, params.error!), params.duration);
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
      await this._playwrightTest.debugTests(this._vscode, model.config, projects.map(p => p.name), locations, testListener, parametrizedTestTitle, token);
    else
      await this._playwrightTest.runTests(model.config, projects.map(p => p.name), locations, testListener, parametrizedTestTitle, token);
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
    const testMessage = new this._vscode.TestMessage(stripAnsi(errorStack));
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

  private _testMessageForTestError(testItem: vscodeTypes.TestItem, error: TestError): vscodeTypes.TestMessage {
    const sanitized = stripAnsi(error.stack || error.message || error.value!);
    const message = new this._vscode.TestMessage(sanitized);
    const location = parseLocationFromStack(testItem, error.stack);
    if (location) {
      const position = new this._vscode.Position(location.line - 1, location.column - 1);
      message.location = new this._vscode.Location(this._vscode.Uri.file(location.path), position);
    }
    return message;
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

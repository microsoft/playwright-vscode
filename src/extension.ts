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
import { playwrightTest, TestListener } from './playwrightTest';
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
      const playwrightInfo = playwrightTest.getPlaywrightInfo(workspaceFolderPath, configFilePath);
      if (!playwrightInfo) {
        this._vscode.window.showWarningMessage('Please install Playwright Test via running `npm i @playwright/test`');
        continue;
      }

      if (playwrightInfo.version < 1.19) {
        this._vscode.window.showWarningMessage('Playwright Test v1.19 or newer is required');
        continue;
      }

      const model = new TestModel(this._vscode, workspaceFolderPath, configFileUri.fsPath, playwrightInfo.cli);
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
    const handler = async (isDebug: boolean, request: vscodeTypes.TestRunRequest, token: vscodeTypes.CancellationToken) => {
      if (!request.include) {
        await this._runTest(isDebug, request, project, null, token);
        return;
      }

      const locations: string[] = [];
      for (const item of request.include) {
        if (item.uri!.fsPath.startsWith(project.testDir)) {
          const line = item.range ? ':' + (item.range.start.line + 1) : '';
          locations.push(item.uri!.fsPath + line);
        }
      }
      if (locations.length)
        await this._runTest(isDebug, request, project, locations, token);
    };

    const configName = path.basename(project.model.config.configFile);
    const folderName = path.basename(path.dirname(project.model.config.configFile));
    const projectSuffix = project.name ? ` [${project.name}]` : '';

    this._runProfiles.push(this._testController.createRunProfile(`${folderName}${path.sep}${configName}${projectSuffix}`, this._vscode.TestRunProfileKind.Run, handler.bind(null, false), project.isFirst));
    this._runProfiles.push(this._testController.createRunProfile(`${folderName}${path.sep}${configName}${projectSuffix}`, this._vscode.TestRunProfileKind.Debug, handler.bind(null, true), project.isFirst));
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

  private async _runTest(isDebug: boolean, request: vscodeTypes.TestRunRequest, project: TestProject, locations: string[] | null, token: vscodeTypes.CancellationToken) {
    const testRun = this._testController.createTestRun(request);

    // Provide immediate feedback on action target.
    for (const testItem of request.include || [])
      testRun.enqueued(testItem);
    testRun.appendOutput('\x1b[H\x1b[2J');

    this._completedSteps.clear();
    this._executionLinesChanged();

    const testListener: TestListener = {
      onBegin: ({ projects }) => {
        project.model.updateFromRunningProject(project, projects);
        for (const location of project.model.testLocations(project)) {
          const testItem = this._testTree.testItemForLocation(location);
          if (testItem)
            testRun.enqueued(testItem);
        }
      },

      onTestBegin: params => {
        const testItem = this._testTree.testItemForLocation(params.location);
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

        const testItem = this._testTree.testItemForLocation(params.location);
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

    this._testRun = testRun;
    try {
      if (isDebug)
        await playwrightTest.debugTests(this._vscode, project.model.config, project.name, locations, testListener, token);
      else
        await playwrightTest.runTests(project.model.config, project.name, locations, testListener, token);
    } finally {
      this._activeSteps.clear();
      this._executionLinesChanged();
      testRun.end();
      this._testRun = undefined;
    }
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

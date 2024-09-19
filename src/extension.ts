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
import { installBrowsers, installPlaywright } from './installer';
import * as reporterTypes from './upstream/reporter';
import { ReusedBrowser } from './reusedBrowser';
import { SettingsModel } from './settingsModel';
import { SettingsView } from './settingsView';
import { TestModel, TestModelCollection } from './testModel';
import { TestTree } from './testTree';
import { NodeJSNotFoundError, ansiToHtml, getPlaywrightInfo } from './utils';
import * as vscodeTypes from './vscodeTypes';
import { WorkspaceChange, WorkspaceObserver } from './workspaceObserver';
import { registerTerminalLinkProvider } from './terminalLinkProvider';
import { RunHooks, TestConfig } from './playwrightTestTypes';

const stackUtils = new StackUtils({
  cwd: '/ensure_absolute_paths'
});

type StepInfo = {
  location: vscodeTypes.Location;
  activeCount: number;
  duration: number;
};

export async function activate(context: vscodeTypes.ExtensionContext) {
  // Do not await, quickly run the extension, schedule work.
  new Extension(require('vscode'), context).activate();
}

export class Extension implements RunHooks {
  private _vscode: vscodeTypes.VSCode;
  private _context: vscodeTypes.ExtensionContext;
  private _disposables: vscodeTypes.Disposable[] = [];

  // Global test item map.
  private _testTree: TestTree;

  private _testController: vscodeTypes.TestController;
  private _workspaceObserver: WorkspaceObserver;
  private _testItemUnderDebug: vscodeTypes.TestItem | undefined;

  private _activeSteps = new Map<reporterTypes.TestStep, StepInfo>();
  private _completedSteps = new Map<reporterTypes.TestStep, StepInfo>();
  private _testRun: vscodeTypes.TestRun | undefined;
  private _models: TestModelCollection;
  private _activeStepDecorationType: vscodeTypes.TextEditorDecorationType;
  private _completedStepDecorationType: vscodeTypes.TextEditorDecorationType;
  private _debugHighlight: DebugHighlight;
  private _isUnderTest: boolean;
  private _reusedBrowser: ReusedBrowser;
  private _settingsModel: SettingsModel;
  private _settingsView!: SettingsView;
  private _diagnostics: vscodeTypes.DiagnosticCollection;
  private _treeItemObserver: TreeItemObserver;
  private _runProfile: vscodeTypes.TestRunProfile;
  private _debugProfile: vscodeTypes.TestRunProfile;
  private _playwrightTestLog: string[] = [];
  private _commandQueue = Promise.resolve();
  overridePlaywrightVersion: number | null = null;

  constructor(vscode: vscodeTypes.VSCode, context: vscodeTypes.ExtensionContext) {
    this._vscode = vscode;
    this._context = context;
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

    this._settingsModel = new SettingsModel(vscode, this._isUnderTest, context);
    this._reusedBrowser = new ReusedBrowser(this._vscode, this._settingsModel, this._envProvider.bind(this));
    this._debugHighlight = new DebugHighlight(vscode, this._reusedBrowser);
    this._models = new TestModelCollection(vscode, {
      context,
      playwrightTestLog: this._playwrightTestLog,
      settingsModel: this._settingsModel,
      runHooks: this,
      isUnderTest: this._isUnderTest,
      envProvider: this._envProvider.bind(this),
      onStdOut: this._debugHighlight.onStdOut.bind(this._debugHighlight),
      requestWatchRun: this._runWatchedTests.bind(this),
    });
    this._testController = vscode.tests.createTestController('playwright', 'Playwright');
    this._testController.resolveHandler = item => this._resolveChildren(item);
    this._testController.refreshHandler = () => this._rebuildModels(true).then(() => {});
    const supportsContinuousRun = true;
    this._runProfile = this._testController.createRunProfile('playwright-run', this._vscode.TestRunProfileKind.Run, this._handleTestRun.bind(this, false), true, undefined, supportsContinuousRun);
    this._debugProfile = this._testController.createRunProfile('playwright-debug', this._vscode.TestRunProfileKind.Debug, this._handleTestRun.bind(this, true), true, undefined, supportsContinuousRun);
    this._testTree = new TestTree(vscode, this._models, this._testController);
    this._debugHighlight.onErrorInDebugger(e => this._errorInDebugger(e.error, e.location));
    this._workspaceObserver = new WorkspaceObserver(this._vscode, changes => this._workspaceChanged(changes));
    this._diagnostics = this._vscode.languages.createDiagnosticCollection('pw.testErrors.diagnostic');
    this._treeItemObserver = new TreeItemObserver(this._vscode);
  }

  async onWillRunTests(config: TestConfig, debug: boolean) {
    await this._reusedBrowser.onWillRunTests(config, debug);
    return {
      connectWsEndpoint: this._reusedBrowser.browserServerWSEndpoint(),
    };
  }

  async onDidRunTests(debug: boolean) {
    await this._reusedBrowser.onDidRunTests(debug);
  }

  reusedBrowserForTest(): ReusedBrowser {
    return this._reusedBrowser;
  }

  dispose() {
    for (const d of this._disposables)
      d?.dispose?.();
  }

  async activate() {
    const vscode = this._vscode;
    this._settingsView = new SettingsView(vscode, this._settingsModel, this._models, this._reusedBrowser, this._context.extensionUri);
    const messageNoPlaywrightTestsFound = this._vscode.l10n.t('No Playwright tests found.');
    this._disposables = [
      this._debugHighlight,
      this._settingsModel,
      vscode.workspace.onDidChangeWorkspaceFolders(_ => {
        this._rebuildModels(false);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this._updateVisibleEditorItems();
      }),
      vscode.commands.registerCommand('pw.extension.install', async () => {
        await installPlaywright(this._vscode);
      }),
      vscode.commands.registerCommand('pw.extension.installBrowsers', async () => {
        if (!this._models.hasEnabledModels()) {
          vscode.window.showWarningMessage(messageNoPlaywrightTestsFound);
          return;
        }
        const versions = this._models.versions();
        for (const model of versions.values())
          await installBrowsers(this._vscode, model);
      }),
      vscode.commands.registerCommand('pw.extension.command.inspect', async () => {
        if (!this._models.hasEnabledModels()) {
          vscode.window.showWarningMessage(messageNoPlaywrightTestsFound);
          return;
        }
        await this._reusedBrowser.inspect(this._models);
      }),
      vscode.commands.registerCommand('pw.extension.command.closeBrowsers', () => {
        this._reusedBrowser.closeAllBrowsers();
      }),
      vscode.commands.registerCommand('pw.extension.command.recordNew', async () => {
        if (!this._models.hasEnabledModels()) {
          vscode.window.showWarningMessage(messageNoPlaywrightTestsFound);
          return;
        }
        await this._reusedBrowser.record(this._models, true);
      }),
      vscode.commands.registerCommand('pw.extension.command.recordAtCursor', async () => {
        if (!this._models.hasEnabledModels()) {
          vscode.window.showWarningMessage(messageNoPlaywrightTestsFound);
          return;
        }
        await this._reusedBrowser.record(this._models, false);
      }),
      vscode.commands.registerCommand('pw.extension.command.toggleModels', async () => {
        this._settingsView.toggleModels();
      }),
      vscode.commands.registerCommand('pw.extension.command.runGlobalSetup', async () => {
        await this._queueGlobalHooks('setup');
        this._settingsView.updateActions();
      }),
      vscode.commands.registerCommand('pw.extension.command.runGlobalTeardown', async () => {
        await this._queueGlobalHooks('teardown');
        this._settingsView.updateActions();
      }),
      vscode.commands.registerCommand('pw.extension.command.startDevServer', async () => {
        await this._models.selectedModel()?.startDevServer();
        this._settingsView.updateActions();
      }),
      vscode.commands.registerCommand('pw.extension.command.stopDevServer', async () => {
        await this._models.selectedModel()?.stopDevServer();
        this._settingsView.updateActions();
      }),
      vscode.commands.registerCommand('pw.extension.command.clearCache', async () => {
        await this._models.selectedModel()?.clearCache();
      }),
      vscode.workspace.onDidChangeTextDocument(() => {
        if (this._completedSteps.size) {
          this._completedSteps.clear();
          this._executionLinesChanged();
        }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('playwright.env'))
          this._rebuildModels(false);
      }),
      this._testTree,
      this._models,
      this._models.onUpdated(() => this._modelsUpdated()),
      this._treeItemObserver.onTreeItemSelected(item => this._treeItemSelected(item)),
      this._settingsView,
      this._testController,
      this._runProfile,
      this._debugProfile,
      this._workspaceObserver,
      this._reusedBrowser,
      this._diagnostics,
      this._treeItemObserver,
      registerTerminalLinkProvider(this._vscode),
    ];
    const fileSystemWatchers = [
      // Glob parser does not supported nested group, hence multiple watchers.
      this._vscode.workspace.createFileSystemWatcher('**/*playwright*.config.{ts,js,mts,mjs}'),
      this._vscode.workspace.createFileSystemWatcher('**/*.env*'),
    ];
    this._disposables.push(...fileSystemWatchers);

    const rebuildModelForConfig = (uri: vscodeTypes.Uri) => {
      // TODO: parse .gitignore
      if (uri.fsPath.includes('node_modules'))
        return;
      if (!this._isUnderTest && uri.fsPath.includes('test-results'))
        return;
      this._rebuildModels(false);
    };

    await this._rebuildModels(false);
    fileSystemWatchers.map(w => w.onDidChange(rebuildModelForConfig));
    fileSystemWatchers.map(w => w.onDidCreate(rebuildModelForConfig));
    fileSystemWatchers.map(w => w.onDidDelete(rebuildModelForConfig));
    this._context.subscriptions.push(this);
  }

  private async _rebuildModels(userGesture: boolean): Promise<vscodeTypes.Uri[]> {
    this._commandQueue = Promise.resolve();
    this._models.clear();
    this._testTree.startedLoading();

    const configFiles = await this._vscode.workspace.findFiles('**/*playwright*.config.{ts,js,mts,mjs}', '**/node_modules/**');
    for (const configFileUri of configFiles) {
      const configFilePath = configFileUri.fsPath;
      // TODO: parse .gitignore
      if (!this._isUnderTest && configFilePath.includes('test-results'))
        continue;

      // Dog-food support
      const workspaceFolder = this._vscode.workspace.getWorkspaceFolder(configFileUri)!;
      const workspaceFolderPath = workspaceFolder.uri.fsPath;
      if (configFilePath.includes('test-results') && !workspaceFolderPath.includes('test-results'))
        continue;

      let playwrightInfo = null;
      try {
        playwrightInfo = await getPlaywrightInfo(this._vscode, workspaceFolderPath, configFilePath, this._envProvider());
      } catch (error) {
        if (userGesture) {
          this._vscode.window.showWarningMessage(
              error instanceof NodeJSNotFoundError ? error.message : this._vscode.l10n.t('Please install Playwright Test via running `npm i --save-dev @playwright/test`')
          );
        }
        console.error('[Playwright Test]:', (error as any)?.message);
        continue;
      }

      const minimumPlaywrightVersion = 1.38;
      if (playwrightInfo.version < minimumPlaywrightVersion) {
        if (userGesture) {
          this._vscode.window.showWarningMessage(
              this._vscode.l10n.t('Playwright Test v{0} or newer is required', minimumPlaywrightVersion)
          );
        }
        continue;
      }

      if (this.overridePlaywrightVersion)
        playwrightInfo.version = this.overridePlaywrightVersion;
      await this._models.createModel(workspaceFolderPath, configFileUri.fsPath, playwrightInfo);
    }

    await this._models.ensureHasEnabledModels();
    this._testTree.finishedLoading();
    return configFiles;
  }

  private _modelsUpdated() {
    this._updateVisibleEditorItems();
    this._updateDiagnostics();
    this._workspaceObserver.setWatchFolders(this._models.testDirs());
  }

  private _envProvider(): NodeJS.ProcessEnv {
    const env = this._vscode.workspace.getConfiguration('playwright').get('env', {});
    return Object.fromEntries(Object.entries(env).map(entry => {
      return typeof entry[1] === 'string' ? entry : [entry[0], JSON.stringify(entry[1])];
    })) as NodeJS.ProcessEnv;
  }

  private async _handleTestRun(isDebug: boolean, request: vscodeTypes.TestRunRequest, cancellationToken?: vscodeTypes.CancellationToken) {
    // Never run tests concurrently.
    if (this._testRun && !request.continuous)
      return;

    await this._queueTestRun(request.include, isDebug ? 'debug' : 'run');

    if (request.continuous) {
      for (const model of this._models.enabledModels())
        model.addToWatch(request.include, cancellationToken!);
    }
  }

  private async _queueTestRun(include: readonly vscodeTypes.TestItem[] | undefined, mode: 'run' | 'debug' | 'watch') {
    await this._queueCommand(() => this._runTests(include, mode), undefined);
  }

  private async _queueGlobalHooks(type: 'setup' | 'teardown'): Promise<reporterTypes.FullResult['status']> {
    return await this._queueCommand(() => this._runGlobalHooks(type), 'failed');
  }

  private async _runGlobalHooks(type: 'setup' | 'teardown') {
    if (!this._models.selectedModel()?.needsGlobalHooks(type))
      return 'passed';
    const request = new this._vscode.TestRunRequest();
    const testRun = this._testController.createTestRun(request);
    const testListener = this._errorReportingListener(testRun);
    try {
      const status = (await this._models.selectedModel()?.runGlobalHooks(type, testListener)) || 'failed';
      return status;
    } finally {
      testRun.end();
    }
  }

  private async _runTests(include: readonly vscodeTypes.TestItem[] | undefined, mode: 'run' | 'debug' | 'watch') {
    this._completedSteps.clear();
    this._executionLinesChanged();

    // Create a test run that potentially includes all the test items.
    // This allows running setup tests that are outside of the scope of the
    // selected test items.
    const rootItems: vscodeTypes.TestItem[] = [];
    this._testController.items.forEach(item => rootItems.push(item));
    const requestWithDeps = new this._vscode.TestRunRequest(rootItems, [], undefined, mode === 'watch');

    // Global errors are attributed to the first test item in the request.
    // If the request is global, find the first root test item (folder, file) that has
    // children. It will be reveal with an error.
    let testItemForGlobalErrors = include?.[0];
    if (!testItemForGlobalErrors) {
      for (const rootItem of rootItems) {
        if (!rootItem.children.size)
          continue;
        rootItem.children.forEach(c => {
          if (!testItemForGlobalErrors)
            testItemForGlobalErrors = c;
        });
        if (testItemForGlobalErrors)
          break;
      }
    }

    this._testRun = this._testController.createTestRun(requestWithDeps);
    const enqueuedTests: vscodeTypes.TestItem[] = [];
    // Provisionally mark tests (not files and not suits) as enqueued to provide immediate feedback.
    const toEnqueue = include?.length ? include : rootItems;
    for (const item of toEnqueue) {
      for (const test of this._testTree.collectTestsInside(item)) {
        this._testRun.enqueued(test);
        enqueuedTests.push(test);
      }
    }

    const items: vscodeTypes.TestItem[] = include ? [...include] : [];
    try {
      for (const model of this._models.enabledModels()) {
        const result = model.narrowDownLocations(items);
        if (!result.testIds && !result.locations)
          continue;
        if (!model.enabledProjects().length)
          continue;
        await this._runTest(this._testRun, items, testItemForGlobalErrors, new Set(), model, mode, enqueuedTests.length === 1);
      }
    } finally {
      this._activeSteps.clear();
      this._executionLinesChanged();
      this._testRun.end();
      this._testRun = undefined;
    }
  }

  private async _resolveChildren(fileItem: vscodeTypes.TestItem | undefined): Promise<void> {
    if (!fileItem)
      return;
    await this._ensureTestsInAllModels([fileItem!.uri!.fsPath]);
  }

  private async _workspaceChanged(change: WorkspaceChange) {
    await this._queueCommand(async () => {
      for (const model of this._models.enabledModels())
        await model.handleWorkspaceChange(change);
    }, undefined);

    // Workspace change can be deferred, make sure editors are
    // decorated.
    await this._updateVisibleEditorItems();
  }

  private async _runTest(
    testRun: vscodeTypes.TestRun,
    items: vscodeTypes.TestItem[],
    testItemForGlobalErrors: vscodeTypes.TestItem | undefined,
    testFailures: Set<vscodeTypes.TestItem>,
    model: TestModel,
    mode: 'run' | 'debug' | 'watch',
    enqueuedSingleTest: boolean) {
    const testListener: reporterTypes.ReporterV2 = {
      ...this._errorReportingListener(testRun, testItemForGlobalErrors),

      onBegin: (rootSuite: reporterTypes.Suite) => {
        model.updateFromRunningProjects(rootSuite.suites);
        for (const test of rootSuite.allTests()) {
          const testItem = this._testTree.testItemForTest(test);
          if (testItem)
            testRun.enqueued(testItem);
        }
      },

      onTestBegin: (test: reporterTypes.TestCase, result: reporterTypes.TestResult) => {
        const testItem = this._testTree.testItemForTest(test);
        if (testItem) {
          testRun.started(testItem);
          const fullProject = ancestorProject(test);
          const traceUrl = `${fullProject.outputDir}/.playwright-artifacts-${result.workerIndex}/traces/${test.id}.json`;
          (testItem as any)[traceUrlSymbol] = traceUrl;
        }

        if (testItem && enqueuedSingleTest)
          this._showTraceOnTestProgress(testItem);
        if (mode === 'debug') {
          // Debugging is always single-workers.
          this._testItemUnderDebug = testItem;
        }
      },

      onTestEnd: (test: reporterTypes.TestCase, result: reporterTypes.TestResult) => {
        this._testItemUnderDebug = undefined;
        this._activeSteps.clear();
        this._executionLinesChanged();

        const testItem = this._testTree.testItemForTest(test);
        if (!testItem)
          return;

        const trace = result.attachments.find(a => a.name === 'trace')?.path || '';
        // if trace viewer is currently displaying the trace file about to be replaced, it needs to be refreshed
        const prevTrace = (testItem as any)[traceUrlSymbol];
        (testItem as any)[traceUrlSymbol] = trace;
        if (enqueuedSingleTest || prevTrace === this._models.selectedModel()?.traceViewer()?.currentFile())
          this._showTraceOnTestProgress(testItem);

        if (result.status === test.expectedStatus) {
          if (!testFailures.has(testItem)) {
            if (result.status === 'skipped')
              testRun.skipped(testItem);
            else
              testRun.passed(testItem, result.duration);
          }
          return;
        }
        testFailures.add(testItem);
        testRun.failed(testItem, result.errors.map(error => this._testMessageForTestError(error, testItem)), result.duration);
      },

      onStepBegin: (test: reporterTypes.TestCase, result: reporterTypes.TestResult, testStep: reporterTypes.TestStep) => {
        if (!testStep.location)
          return;
        let step = this._activeSteps.get(testStep);
        if (!step) {
          step = {
            location: new this._vscode.Location(
                this._vscode.Uri.file(testStep.location.file),
                new this._vscode.Position(testStep.location.line - 1, testStep.location?.column - 1)),
            activeCount: 0,
            duration: 0,
          };
          this._activeSteps.set(testStep, step);
        }
        ++step.activeCount;
        this._executionLinesChanged();
      },

      onStepEnd: (test: reporterTypes.TestCase, result: reporterTypes.TestResult, testStep: reporterTypes.TestStep) => {
        if (!testStep.location)
          return;
        const step = this._activeSteps.get(testStep);
        if (!step)
          return;
        --step.activeCount;
        step.duration = testStep.duration;
        this._completedSteps.set(testStep, step);
        if (step.activeCount === 0)
          this._activeSteps.delete(testStep);
        this._executionLinesChanged();
      },
    };

    if (mode === 'debug') {
      await model.debugTests(items, testListener, testRun.token);
    } else {
      // Force trace viewer update to surface check version errors.
      await this._models.selectedModel()?.updateTraceViewer(mode === 'run')?.willRunTests();
      await model.runTests(items, testListener, testRun.token);
    }
  }

  private _errorReportingListener(testRun: vscodeTypes.TestRun, testItemForGlobalErrors?: vscodeTypes.TestItem) {
    const testListener: reporterTypes.ReporterV2 = {
      onStdOut: data => {
        testRun.appendOutput(data.toString().replace(/\n/g, '\r\n'));
      },

      onStdErr: data => {
        testRun.appendOutput(data.toString().replace(/\n/g, '\r\n'));
      },

      onError: (error: reporterTypes.TestError) => {
        // Global errors don't have associated tests, so we'll be allocating them
        // to the first item / current.
        if (testItemForGlobalErrors) {
          // Force UI to reveal the item if that is a file that has never been started.
          testRun.started(testItemForGlobalErrors);
          testRun.failed(testItemForGlobalErrors, this._testMessageForTestError(error), 0);
        } else if (error.location) {
          testRun.appendOutput(error.message || error.value || '', new this._vscode.Location(this._vscode.Uri.file(error.location.file), new this._vscode.Position(error.location.line - 1, error.location.column - 1)));
        } else {
          testRun.appendOutput(error.message || error.value || '');
        }
      }
    };
    return testListener;
  }

  private async _runWatchedTests(files: string[], testItems: vscodeTypes.TestItem[]) {
    // Run either locations or test ids to always be compatible with the test server (it can run either or).
    if (files.length) {
      const fileItems = files.map(f => this._testTree.testItemForFile(f)).filter(Boolean) as vscodeTypes.TestItem[];
      await this._queueTestRun(fileItems, 'watch');
    }
    if (testItems.length)
      await this._queueTestRun(testItems, 'watch');
  }

  private async _updateVisibleEditorItems() {
    const files = this._vscode.window.visibleTextEditors.map(e => e.document.uri.fsPath);
    await this._ensureTestsInAllModels(files);
  }

  private async _ensureTestsInAllModels(inputFiles: string[]): Promise<void> {
    await this._queueCommand(async () => {
      for (const model of this._models.enabledModels())
        await model.ensureTests(inputFiles);
    }, undefined);
  }

  private _updateDiagnostics() {
    this._diagnostics.clear();
    const diagnosticsByFile = new Map<string, Map<string, vscodeTypes.Diagnostic>>();

    const addError = (error: reporterTypes.TestError) => {
      if (!error.location)
        return;
      let diagnostics = diagnosticsByFile.get(error.location.file);
      if (!diagnostics) {
        diagnostics = new Map();
        diagnosticsByFile.set(error.location.file, diagnostics);
      }
      const key = `${error.location?.line}:${error.location?.column}:${error.message}`;
      if (!diagnostics.has(key)) {
        diagnostics.set(key, {
          severity: this._vscode.DiagnosticSeverity.Error,
          source: 'playwright',
          range: new this._vscode.Range(Math.max(error.location!.line - 1, 0), Math.max(error.location!.column - 1, 0), error.location!.line, 0),
          message: error.message!,
        });
      }
    };

    for (const model of this._models.enabledModels()) {
      for (const error of model.errors().values())
        addError(error);
    }
    for (const [file, diagnostics] of diagnosticsByFile)
      this._diagnostics.set(this._vscode.Uri.file(file), [...diagnostics.values()]);
  }

  private _errorInDebugger(errorStack: string, location: reporterTypes.Location) {
    if (!this._testRun || !this._testItemUnderDebug)
      return;
    const testMessage = this._testMessageFromText(errorStack);
    const position = new this._vscode.Position(location.line - 1, location.column - 1);
    testMessage.location = new this._vscode.Location(this._vscode.Uri.file(location.file), position);
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
          const prefix1 = ('    at ' + workspaceFolder.uri.fsPath + path.sep).toLowerCase();
          const prefix2 = ('    at fn (' + workspaceFolder.uri.fsPath + path.sep).toLowerCase();
          const lowerLine = line.toLowerCase();
          if (lowerLine.startsWith(prefix1)) {
            line = '    at ' + line.substring(prefix1.length);
            break;
          }
          if (lowerLine.startsWith(prefix2)) {
            line = '    at ' + line.substring(prefix2.length, line.length - 1);
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
        logMd.push(indent + ' - ' + ansiToHtml(body));
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

  private _testMessageFromHtml(html: string): vscodeTypes.TestMessage {
    // We need to trim each line on the left side so that Markdown will render it as HTML.
    const trimmedLeft = html.split('\n').join('').trimStart();
    const markdownString = new this._vscode.MarkdownString(trimmedLeft);
    markdownString.isTrusted = true;
    markdownString.supportHtml = true;
    return new this._vscode.TestMessage(markdownString);
  }

  private _testMessageForTestError(error: reporterTypes.TestError, testItem?: vscodeTypes.TestItem): vscodeTypes.TestMessage {
    const text = error.stack || error.message || error.value!;
    let testMessage: vscodeTypes.TestMessage;
    if (text.includes('Looks like Playwright Test or Playwright')) {
      testMessage = this._testMessageFromHtml(`
        <p>Playwright browser are not installed.</p>
        <p>
          Press
          ${process.platform === 'darwin' ? '<kbd>Shift</kbd>+<kbd>Command</kbd>+<kbd>P</kbd>' : ''}
          ${process.platform !== 'darwin' ? '<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>' : ''}
          to open the Command Palette in VSCode, type 'Playwright' and select 'Install Playwright Browsers'.
        </p>
      `);
    } else {
      testMessage = this._testMessageFromText(text);
    }
    const location = error.location || parseLocationFromStack(error.stack, testItem);
    if (location) {
      const position = new this._vscode.Position(location.line - 1, location.column - 1);
      testMessage.location = new this._vscode.Location(this._vscode.Uri.file(location.file), position);
    }
    return testMessage;
  }

  playwrightTestLog(): string[] {
    return this._playwrightTestLog;
  }

  browserServerWSForTest() {
    return this._reusedBrowser.browserServerWSEndpoint();
  }

  fireTreeItemSelectedForTest(testItem: vscodeTypes.TestItem | null) {
    this._treeItemSelected(testItem);
  }

  async traceViewerInfoForTest() {
    return await this._models.selectedModel()?.traceViewer()?.infoForTest();
  }

  private _showTraceOnTestProgress(testItem: vscodeTypes.TestItem) {
    const traceUrl = (testItem as any)[traceUrlSymbol];
    this._models.selectedModel()?.traceViewer()?.open(traceUrl);
  }

  private _treeItemSelected(treeItem: vscodeTypes.TreeItem | null) {
    if (!treeItem)
      return;
    const traceUrl = (treeItem as any)[traceUrlSymbol];
    this._models.selectedModel()?.traceViewer()?.open(traceUrl);
  }

  private _queueCommand<T>(callback: () => Promise<T>, defaultValue: T): Promise<T> {
    const result = this._commandQueue.then(callback).catch(e => { console.error(e); return defaultValue; });
    this._commandQueue = result.then(() => {});
    return result;
  }
}

function parseLocationFromStack(stack: string | undefined, testItem?: vscodeTypes.TestItem): reporterTypes.Location | undefined {
  const lines = stack?.split('\n') || [];
  for (const line of lines) {
    const frame = stackUtils.parseLine(line);
    if (!frame || !frame.file || !frame.line || !frame.column)
      continue;
    frame.file = frame.file.replace(/\//g, path.sep);
    if (!testItem || testItem.uri!.fsPath === frame.file) {
      return {
        file: frame.file,
        line: frame.line,
        column: frame.column,
      };
    }
  }
}

class TreeItemObserver implements vscodeTypes.Disposable{
  private _vscode: vscodeTypes.VSCode;
  private _treeItemSelected: vscodeTypes.EventEmitter<vscodeTypes.TreeItem | null>;
  readonly onTreeItemSelected: vscodeTypes.Event<vscodeTypes.TreeItem | null>;
  private _selectedTreeItem: vscodeTypes.TreeItem | null = null;
  private _timeout: NodeJS.Timeout | undefined;

  constructor(vscode: vscodeTypes.VSCode) {
    this._vscode = vscode;
    this._treeItemSelected = new vscode.EventEmitter();
    this.onTreeItemSelected = this._treeItemSelected.event;
    this._poll().catch(() => {});
  }

  dispose() {
    clearTimeout(this._timeout);
    this._treeItemSelected.dispose();
  }

  selectedTreeItem(): vscodeTypes.TreeItem | null {
    return this._selectedTreeItem;
  }

  private async _poll() {
    clearTimeout(this._timeout);
    const result = await this._vscode.commands.executeCommand('testing.getExplorerSelection') as { include: vscodeTypes.TreeItem[] };
    const item = result.include.length === 1 ? result.include[0] : null;
    if (item !== this._selectedTreeItem) {
      this._selectedTreeItem = item;
      this._treeItemSelected.fire(item);
    }
    this._timeout = setTimeout(() => this._poll().catch(() => {}), 250);
  }
}

function ancestorProject(test: reporterTypes.TestCase): reporterTypes.FullProject {
  let suite: reporterTypes.Suite = test.parent;
  while (!suite.project())
    suite = suite.parent!;
  return suite.project()!;
}

const traceUrlSymbol = Symbol('traceUrl');

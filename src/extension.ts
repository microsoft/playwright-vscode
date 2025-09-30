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

import fs from 'fs';
import path from 'path';
import StackUtils from 'stack-utils';
import { DebugHighlight } from './debugHighlight';
import { installBrowsers, installPlaywright } from './installer';
import * as reporterTypes from './upstream/reporter';
import { ReusedBrowser } from './reusedBrowser';
import { SettingsModel } from './settingsModel';
import { SettingsView } from './settingsView';
import { RunHooks, TestModel, TestModelCollection, TestProject } from './testModel';
import { configError, disabledProjectName as disabledProject, TestTree } from './testTree';
import { NodeJSNotFoundError, getPlaywrightInfo, stripAnsi, stripBabelFrame, uriToPath } from './utils';
import * as vscodeTypes from './vscodeTypes';
import { WorkspaceChange, WorkspaceObserver } from './workspaceObserver';
import { registerTerminalLinkProvider } from './terminalLinkProvider';
import { ansi2html } from './ansi2html';
import { LocatorsView } from './locatorsView';
import { McpConnection } from './mcpConnection';
import { pathToFileURL } from 'url';

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
  void new Extension(require('vscode'), context).activate();
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
  private _mcpConnection: McpConnection;
  private _settingsModel: SettingsModel;
  private _settingsView!: SettingsView;
  private _locatorsView!: LocatorsView;
  private _diagnostics: vscodeTypes.DiagnosticCollection;
  private _treeItemObserver: TreeItemObserver;
  private _runProfile: vscodeTypes.TestRunProfile;
  private _debugProfile: vscodeTypes.TestRunProfile;
  private _commandQueue = Promise.resolve();
  private _watchFilesBatch?: vscodeTypes.TestItem[];
  private _watchItemsBatch?: vscodeTypes.TestItem[];

  private _pnpFiles = new Map<string, { pnpCJS?: string, pnpLoader?: string }>();

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

    this._settingsModel = new SettingsModel(vscode, context);
    this._reusedBrowser = new ReusedBrowser(this._vscode, this._settingsModel, this._envProvider.bind(this));
    this._mcpConnection = new McpConnection(this._vscode, this._reusedBrowser);
    this._debugHighlight = new DebugHighlight(vscode, this._reusedBrowser);
    this._models = new TestModelCollection(vscode, {
      context,
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

  async onWillRunTests(model: TestModel, debug: boolean) {
    await this._reusedBrowser.onWillRunTests(model, debug);
    return {
      connectWsEndpoint: this._reusedBrowser.browserServerWSEndpoint(),
    };
  }

  async onDidRunTests() {
    await this._reusedBrowser.onDidRunTests();
  }

  private async _showProjectQuickPick(): Promise<any> {
    const items: vscodeTypes.QuickPickItem[] = [];
    const itemToProjectMap = new Map<vscodeTypes.QuickPickItem, { model: TestModel, projectName: string }>();

    const models = this._models.models();
    for (const model of models) {
      for (const project of model.projects()) {
        const item: vscodeTypes.QuickPickItem = {
          label: project.name,
          detail: models.length > 1 ? model.configLabel() : undefined,
          picked: model.isProjectEnabled(project),
        };
        items.push(item);
        itemToProjectMap.set(item, { model, projectName: project.name });
      }
    }

    if (items.length < 2)
      return;

    const result = await this._vscode.window.showQuickPick(items, {
      title: this._vscode.l10n.t('Select Projects'),
      canPickMany: true,
      placeHolder: this._vscode.l10n.t('Choose which projects to run')
    });

    if (!result)
      return;

    for (const [item, { model, projectName }] of itemToProjectMap) {
      const shouldBeEnabled = result.includes(item);
      this._models.setProjectEnabled(model.config.configFile, projectName, shouldBeEnabled);
    }
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
    this._locatorsView = new LocatorsView(vscode, this._settingsModel, this._reusedBrowser, this._context.extensionUri);
    const messageNoPlaywrightTestsFound = this._vscode.l10n.t('No Playwright tests found.');
    this._disposables = [
      this._debugHighlight,
      this._settingsModel,
      vscode.workspace.onDidChangeWorkspaceFolders(_ => {
        void this._rebuildModels(false);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        void this._updateVisibleEditorItems();
      }),
      vscode.commands.registerCommand('pw.extension.install', async () => {
        await installPlaywright(this._vscode);
      }),
      vscode.commands.registerCommand('pw.extension.installBrowsers', async () => {
        if (!this._models.hasEnabledModels()) {
          await vscode.window.showWarningMessage(messageNoPlaywrightTestsFound);
          return;
        }
        const versions = this._models.versions();
        for (const model of versions.values())
          await installBrowsers(this._vscode, model);
      }),
      vscode.commands.registerCommand('pw.extension.command.inspect', async (browserId?: string) => {
        if (!this._models.hasEnabledModels()) {
          await vscode.window.showWarningMessage(messageNoPlaywrightTestsFound);
          return;
        }

        await this._reusedBrowser.inspect(this._models, browserId);
      }),
      vscode.commands.registerCommand('pw.extension.command.closeBrowsers', async (browserId?: string) => {
        if (browserId)
          await this._reusedBrowser.closeBrowser(browserId, 'User requested close from VS Code Extension');
        else
          this._reusedBrowser.closeAllBrowsers();
      }),
      vscode.commands.registerCommand('pw.extension.command.recordNew', async () => {
        const model = this._models.selectedModel();
        if (!model)
          return vscode.window.showWarningMessage(messageNoPlaywrightTestsFound);

        const project = model.enabledProjects()[0];
        if (!project)
          return vscode.window.showWarningMessage(this._vscode.l10n.t(`Project is disabled in the Playwright sidebar.`));

        const file = await this._createFileForNewTest(model, project);
        if (!file)
          return;

        const showBrowser = this._settingsModel.showBrowser.get() ?? false;
        try {
          await this._settingsModel.showBrowser.set(true);
          await this._showBrowserForRecording(file, project);
          await this._reusedBrowser.record(model, project);
        } finally {
          await this._settingsModel.showBrowser.set(showBrowser);
        }
      }),
      vscode.commands.registerCommand('pw.extension.command.recordAtCursor', async () => {
        const model = this._models.selectedModel();
        if (!model)
          return vscode.window.showWarningMessage(messageNoPlaywrightTestsFound);
        await this._reusedBrowser.record(model);
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
          void this._rebuildModels(false);
      }),
      this._testTree,
      this._models,
      this._models.onUpdated(() => {
        void this._modelsUpdated();
      }),
      this._treeItemObserver.onTreeItemSelected(item => this._treeItemSelected(item)),
      this._settingsView,
      this._locatorsView,
      this._testController,
      this._runProfile,
      this._debugProfile,
      this._workspaceObserver,
      this._reusedBrowser,
      this._diagnostics,
      this._treeItemObserver,
      registerTerminalLinkProvider(this._vscode),
      this._mcpConnection.startScanning(),
    ];
    const fileSystemWatchers = [
      // Glob parser does not supported nested group, hence multiple watchers.
      this._vscode.workspace.createFileSystemWatcher('**/*playwright*.config.{ts,js,mts,mjs}'),
      this._vscode.workspace.createFileSystemWatcher('**/*.env*'),
    ];
    this._disposables.push(...fileSystemWatchers);

    const rebuildModelForConfig = (uri: vscodeTypes.Uri) => {
      // TODO: parse .gitignore
      if (uriToPath(uri).includes('node_modules'))
        return;
      if (!this._isUnderTest && uriToPath(uri).includes('test-results'))
        return;
      void this._rebuildModels(false);
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
    // findFiles returns results in a non-deterministic order - sort them to ensure consistent order when we enable the first model by default.
    configFiles.sort((a, b) => sortPaths(uriToPath(a), uriToPath(b)));
    for (const configFileUri of configFiles) {
      const configFilePath = uriToPath(configFileUri);
      // TODO: parse .gitignore
      if (!this._isUnderTest && configFilePath.includes('test-results'))
        continue;

      // Dog-food support
      const workspaceFolder = this._vscode.workspace.getWorkspaceFolder(configFileUri)!;
      const workspaceFolderPath = uriToPath(workspaceFolder.uri);
      if (configFilePath.includes('test-results') && !workspaceFolderPath.includes('test-results'))
        continue;

      await this._detectPnp(configFilePath, workspaceFolderPath);

      let playwrightInfo = null;
      try {
        playwrightInfo = await getPlaywrightInfo(this._vscode, workspaceFolderPath, configFilePath, this._envProvider(configFilePath));
      } catch (error) {
        if (userGesture) {
          void this._vscode.window.showWarningMessage(
              error instanceof NodeJSNotFoundError ? error.message : this._vscode.l10n.t('Please install Playwright Test via running `npm i --save-dev @playwright/test`')
          );
        }
        console.error('[Playwright Test]:', (error as any)?.message);
        continue;
      }

      const minimumPlaywrightVersion = 1.38;
      if (playwrightInfo.version < minimumPlaywrightVersion) {
        if (userGesture) {
          void this._vscode.window.showWarningMessage(
              this._vscode.l10n.t('Playwright Test v{0} or newer is required', minimumPlaywrightVersion)
          );
        }
        continue;
      }

      await this._models.createModel(workspaceFolderPath, configFilePath, playwrightInfo);
    }

    this._models.ensureHasEnabledModels();
    this._testTree.finishedLoading();
    return configFiles;
  }

  private async _modelsUpdated() {
    await this._updateVisibleEditorItems();
    this._updateDiagnostics();
    this._workspaceObserver.setWatchFolders(this._models.testDirs());
  }

  private _envProvider(configFile: string) {
    const config = this._vscode.workspace.getConfiguration('playwright').get('env', {});
    const env = Object.fromEntries(Object.entries(config).map(entry => {
      return typeof entry[1] === 'string' ? entry : [entry[0], JSON.stringify(entry[1])];
    })) as NodeJS.ProcessEnv;

    if (env.NODE_OPTIONS?.includes('.pnp.cjs') || env.NODE_OPTIONS?.includes('.pnp.loader.mjs'))
      return env;

    if (!this._pnpFiles.has(configFile))
      return env;

    env.NODE_OPTIONS ??= '';
    const { pnpCJS, pnpLoader } = this._pnpFiles.get(configFile)!;
    if (pnpCJS)
      env.NODE_OPTIONS += ` --require ${pnpCJS}`;
    if (pnpLoader)
      env.NODE_OPTIONS += ` --experimental-loader ${pathToFileURL(pnpLoader)}`;

    return env;
  }

  private async _detectPnp(configFileUri: string, root: string) {
    let dir = configFileUri;
    while (dir !== root) {
      dir = path.resolve(dir, '..');
      const pnpCjs = path.join(dir, '.pnp.cjs');
      const pnpLoader = path.join(dir, '.pnp.loader.mjs');
      const [pnpCjsExists, pnpLoaderExists] = await Promise.all([
        this._fileExists(pnpCjs),
        this._fileExists(pnpLoader)
      ]);
      if (pnpCjsExists || pnpLoaderExists) {
        this._pnpFiles.set(
            configFileUri,
            {
              pnpCJS: pnpCjsExists ? pnpCjs : undefined,
              pnpLoader: pnpLoaderExists ? pnpLoader : undefined
            }
        );
        return;
      }
    }
  }

  private async _fileExists(path: string) {
    try {
      const stat = await fs.promises.stat(path);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  private async _handleTestRun(isDebug: boolean, request: vscodeTypes.TestRunRequest, cancellationToken?: vscodeTypes.CancellationToken) {
    // Never run tests concurrently.
    if (this._testRun && !request.continuous)
      return;

    if (request.include?.[0]) {
      const project = disabledProject(request.include[0]);
      if (project) {
        const enableProjectTitle = this._vscode.l10n.t('Enable project');
        void this._vscode.window.showInformationMessage(this._vscode.l10n.t(`Project is disabled in the Playwright sidebar.`), enableProjectTitle, this._vscode.l10n.t('Cancel')).then(result => {
          if (result === enableProjectTitle) {
            this._models.setModelEnabled(project.model.config.configFile, true, true);
            this._models.setProjectEnabled(project.model.config.configFile, project.name, true);
          }
        });
        return;
      }

      const error = configError(request.include[0]);
      if (error) {
        if (error.location) {
          const document = await this._vscode.workspace.openTextDocument(error.location.file);
          const position = new this._vscode.Position(Math.max(0, error.location.line - 1), error.location.column - 1);
          await this._vscode.window.showTextDocument(document, {
            selection: new this._vscode.Range(position, position)
          });
        }
        return;
      }
    }

    await this._queueTestRun(request, isDebug ? 'debug' : 'run');

    if (request.continuous) {
      for (const model of this._models.enabledModels())
        await model.addToWatch(request.include, cancellationToken!);
    }
  }

  private async _queueTestRun(request: vscodeTypes.TestRunRequest, mode: 'run' | 'debug') {
    await this._queueCommand(() => this._runTests(request, mode), undefined);
  }

  private async _queueWatchRun(request: vscodeTypes.TestRunRequest, type: 'files' | 'items') {
    const batch = type === 'files' ? this._watchFilesBatch : this._watchItemsBatch;
    const include = request.include || [];
    if (batch) {
      batch.push(...include); // `narrowDownLocations` dedupes before sending to the testserver, no need to dedupe here
      return;
    }

    if (type === 'files')
      this._watchFilesBatch = [...include];
    else
      this._watchItemsBatch = [...include];

    await this._queueCommand(() => {
      const items = type === 'files' ? this._watchFilesBatch : this._watchItemsBatch;
      if (typeof items === 'undefined')
        throw new Error(`_watchRunBatches['${type}'] is undefined, expected array`);

      if (type === 'files')
        this._watchFilesBatch = undefined;
      else
        this._watchItemsBatch = undefined;

      return this._runTests(request, 'watch');
    }, undefined);
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
      const status = (await this._models.selectedModel()?.runGlobalHooks(type, testListener, testRun.token)) || 'failed';
      return status;
    } finally {
      testRun.end();
    }
  }

  private async _runTests(request: vscodeTypes.TestRunRequest, mode: 'run' | 'debug' | 'watch') {
    this._completedSteps.clear();
    this._executionLinesChanged();
    const include = request.include;

    if (true || this._models.isFreshOpen() && mode !== 'watch') {
      await this._showProjectQuickPick();

      // update request in case user enabled/disabled some models/projects
      // filter include / exclude to only enabled tests
    }


    const rootItems: vscodeTypes.TestItem[] = [];
    this._testController.items.forEach(item => rootItems.push(item));

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

    this._testRun = this._testController.createTestRun(request);
    const enqueuedTests: vscodeTypes.TestItem[] = [];
    // Provisionally mark tests (not files and not suits) as enqueued to provide immediate feedback.
    const toEnqueue = include?.length ? include : rootItems;
    for (const item of toEnqueue) {
      for (const test of this._testTree.collectTestsInside(item)) {
        this._testRun.enqueued(test);
        enqueuedTests.push(test);
      }
    }

    try {
      for (const model of this._models.enabledModels()) {
        const result = model.narrowDownLocations(request);
        if (!result.testIds && !result.locations)
          continue;
        if (!model.enabledProjects().length)
          continue;
        await this._runTest(this._testRun, request, testItemForGlobalErrors, new Set(), model, mode, enqueuedTests.length === 1);
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
    await this._ensureTestsInAllModels([uriToPath(fileItem!.uri!)]);
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
    request: vscodeTypes.TestRunRequest,
    testItemForGlobalErrors: vscodeTypes.TestItem | undefined,
    testFailures: Set<vscodeTypes.TestItem>,
    model: TestModel,
    mode: 'run' | 'debug' | 'watch',
    enqueuedSingleTest: boolean) {

    let browserDoesNotExist = false;

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
        if (result.errors.find(e => e.message?.includes(`Error: browserType.launch: Executable doesn't exist`)))
          browserDoesNotExist = true;

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

        const aiContext = this._extractAIContext(result);
        testRun.failed(testItem, result.errors.map(error => this._testMessageForTestError(error, aiContext)), result.duration);
      },

      onStepBegin: (test: reporterTypes.TestCase, result: reporterTypes.TestResult, testStep: reporterTypes.TestStep) => {
        if (!testStep.location)
          return;
        let step = this._activeSteps.get(testStep);
        if (!step) {
          step = {
            location: new this._vscode.Location(
                this._vscode.Uri.file(testStep.location.file),
                new this._vscode.Position(Math.max(testStep.location.line - 1, 0), testStep.location?.column - 1)),
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
      await model.debugTests(request, testListener, testRun.token);
    } else {
      // Force trace viewer update to surface check version errors.
      await this._models.selectedModel()?.updateTraceViewer(mode === 'run')?.willRunTests();
      await model.runTests(request, testListener, testRun.token);
    }

    if (browserDoesNotExist)
      await installBrowsers(this._vscode, model);
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

  private _extractAIContext(result: reporterTypes.TestResult): string | undefined {
    const attachment = result.attachments.find(a => ['_error-context', 'error-context'].includes(a.name));
    if (!attachment)
      return;

    // 1.52
    if (attachment.contentType === 'application/json' && attachment.body) {
      try {
        const errorContext: { pageSnapshot?: string } = JSON.parse(attachment.body.toString());
        if (errorContext.pageSnapshot)
          return `### Page Snapshot at Failure\n\n${errorContext.pageSnapshot}`; // cannot use ``` codeblocks, vscode markdown does not support it
      } catch {}
    }

    // 1.53+
    if (attachment.contentType === 'text/markdown') {
      try {
        if (attachment.path)
          return fs.readFileSync(attachment.path, 'utf-8');

        return attachment.body?.toString();
      } catch {}
    }
  }

  private async _runWatchedTests(files: string[], testItems: vscodeTypes.TestItem[]) {
    // Run either locations or test ids to always be compatible with the test server (it can run either or).
    if (files.length) {
      const fileItems = files.map(f => this._testTree.testItemForFile(f)).filter(Boolean) as vscodeTypes.TestItem[];
      await this._queueWatchRun(new this._vscode.TestRunRequest(fileItems), 'files');
    }
    if (testItems.length)
      await this._queueWatchRun(new this._vscode.TestRunRequest(testItems), 'items');
  }

  private async _createFileForNewTest(model: TestModel, project: TestProject) {
    let file;
    for (let i = 1; i < 100; ++i) {
      file = path.join(project.project.testDir, `test-${i}.spec.ts`);
      if (fs.existsSync(file))
        continue;
      break;
    }
    if (!file)
      return;

    await fs.promises.writeFile(file, `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
  // Recording...
});`);

    await model.handleWorkspaceChange({ created: new Set([file]), changed: new Set(), deleted: new Set() });
    await model.ensureTests([file]);

    const document = await this._vscode.workspace.openTextDocument(file);
    const editor = await this._vscode.window.showTextDocument(document);
    editor.selection = new this._vscode.Selection(new this._vscode.Position(3, 2), new this._vscode.Position(3, 2 + '// Recording...'.length));

    return file;
  }

  private async _showBrowserForRecording(file: string, project: TestProject) {
    const fileItem = this._testTree.testItemForFile(file);
    if (!fileItem)
      return;
    if (fileItem.children.size !== 1)
      return;

    const testItems = this._testTree.collectTestsInside(fileItem);
    const testForProject = testItems.length === 1 ? testItems[0] : testItems.find(t => t.label === project.name);
    if (!testForProject)
      return;

    const request = new this._vscode.TestRunRequest([testForProject], undefined, undefined, false, true);
    await this._queueTestRun(request, 'run');
  }

  private async _updateVisibleEditorItems() {
    const files = this._vscode.window.visibleTextEditors.map(e => uriToPath(e.document.uri));
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
          message: this._abbreviateStack(stripBabelFrame(stripAnsi(error.message!))),
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
    const position = new this._vscode.Position(Math.max(location.line - 1, 0), location.column - 1);
    testMessage.location = new this._vscode.Location(this._vscode.Uri.file(location.file), position);
    this._testRun.failed(this._testItemUnderDebug, testMessage);
    this._testItemUnderDebug = undefined;
  }

  private _executionLinesChanged() {
    const active = [...this._activeSteps.values()];
    const completed = [...this._completedSteps.values()];

    for (const editor of this._vscode.window.visibleTextEditors) {
      const editorPath = uriToPath(editor.document.uri);
      const activeDecorations: vscodeTypes.DecorationOptions[] = [];
      for (const { location } of active) {
        if (uriToPath(location.uri) === editorPath)
          activeDecorations.push({ range: location.range });
      }

      const decorationCount: Record<number, number> = {};
      const completedDecorations: Record<number, vscodeTypes.DecorationOptions> = {};
      for (const { location, duration } of completed) {
        if (uriToPath(location.uri) === editorPath) {
          const line = location.range.start.line;
          decorationCount[line] ??= 0;
          const count = ++decorationCount[line];
          completedDecorations[line] = {
            range: location.range,
            renderOptions: {
              after: {
                contentText: ` \u2014 ${duration}ms${count > 1 ? ` (ran ${count}×)` : ''}`,
              }
            }
          };
        }
      }

      editor.setDecorations(this._activeStepDecorationType, activeDecorations);
      editor.setDecorations(this._completedStepDecorationType, Object.values(completedDecorations));
    }

  }

  private _abbreviateStack(text: string): string {
    const result: string[] = [];
    const prefixes = (this._vscode.workspace.workspaceFolders || []).map(f => uriToPath(f.uri).toLowerCase() + path.sep);
    for (let line of text.split('\n')) {
      const lowerLine = line.toLowerCase();
      for (const prefix of prefixes) {
        const index = lowerLine.indexOf(prefix);
        if (index !== -1) {
          line = line.substring(0, index) + line.substring(index + prefix.length);
          break;
        }
      }
      result.push(line);
    }
    return result.join('\n');
  }

  private _testMessageFromText(text: string, aiContext?: string): vscodeTypes.TestMessage {
    const markdownString = new this._vscode.MarkdownString();
    markdownString.isTrusted = true;
    markdownString.supportHtml = true;
    markdownString.appendMarkdown(ansi2html(this._abbreviateStack(text)));

    if (aiContext)
      markdownString.appendMarkdown(`<br><br><details><summary>Context for AI</summary>\n${aiContext}\n</details>`);

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

  private _testMessageForTestError(error: reporterTypes.TestError, aiContext?: string): vscodeTypes.TestMessage {
    const text = this._formatError(error);
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
      testMessage = this._testMessageFromText(text, aiContext);
    }
    const stackTrace = error.stack ? parseStack(this._vscode, error.stack) : [];
    const location = error.location ? parseLocation(this._vscode, error.location) : topStackFrame(this._vscode, stackTrace);
    if (location)
      testMessage.location = location;
    return testMessage;
  }

  private _formatError(error: reporterTypes.TestError): string {
    const tokens = [error.stack || error.message || error.value || ''];
    if (error.cause)
      tokens.push('[cause]: ' + this._formatError(error.cause));
    return tokens.join('\n');
  }

  browserServerWSForTest() {
    return this._reusedBrowser.browserServerWSEndpoint();
  }

  recorderModeForTest() {
    return this._reusedBrowser.recorderModeForTest();
  }

  fireTreeItemSelectedForTest(testItem: vscodeTypes.TestItem | null) {
    this._treeItemSelected(testItem);
  }

  async traceViewerInfoForTest() {
    return await this._models.selectedModel()?.traceViewer()?.infoForTest();
  }

  private _showTraceOnTestProgress(testItem: vscodeTypes.TestItem) {
    const traceUrl = (testItem as any)[traceUrlSymbol];
    void this._models.selectedModel()?.traceViewer()?.open(traceUrl);
  }

  private _treeItemSelected(treeItem: vscodeTypes.TreeItem | null) {
    if (!treeItem)
      return;
    const traceUrl = (treeItem as any)[traceUrlSymbol];
    void this._models.selectedModel()?.traceViewer()?.open(traceUrl);
  }

  private _queueCommand<T>(callback: () => Promise<T>, defaultValue: T): Promise<T> {
    const result = this._commandQueue.then(callback).catch(e => { console.error(e); return defaultValue; });
    this._commandQueue = result.then(() => {});
    return result;
  }
}

function parseLocation(vscode: vscodeTypes.VSCode, location: reporterTypes.Location): vscodeTypes.Location {
  return new vscode.Location(
      vscode.Uri.file(location.file),
      new vscode.Position(Math.max(location.line - 1, 0), location.column - 1));
}

function topStackFrame(vscode: vscodeTypes.VSCode, stackTrace: vscodeTypes.TestMessageStackFrame[]): vscodeTypes.Location | undefined {
  return stackTrace.length ? new vscode.Location(stackTrace[0].uri!, stackTrace[0].position!) : undefined;
}

function parseStack(vscode: vscodeTypes.VSCode, stack: string): vscodeTypes.TestMessageStackFrame[] {
  const lines = stack?.split('\n') || [];
  const result: vscodeTypes.TestMessageStackFrame[] = [];
  for (const line of lines) {
    const frame = stackUtils.parseLine(line);
    if (!frame || !frame.file || !frame.line || !frame.column)
      continue;
    result.push(new vscode.TestMessageStackFrame(
        frame.method || '',
        vscode.Uri.file(frame.file),
        new vscode.Position(Math.max(frame.line - 1, 0), frame.column - 1)));
  }
  return result;
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

/**
 * sort paths intuitively.
 * [/foo/bar, /foo, /foo/baz] -> [/foo, /foo/bar, /foo/baz]
 * prefers playwright.config.ts over playwright.bail.config.ts
 */
export function sortPaths(a: string, b: string): number {
  const depth = a.split(path.sep).length - b.split(path.sep).length;
  if (depth !== 0)
    return depth;

  const length = path.basename(a).length - path.basename(b).length;
  if (length !== 0)
    return length;

  return a.localeCompare(b);
}

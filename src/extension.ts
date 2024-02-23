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
import { MultiMap } from './multimap';
import { PlaywrightTest, RunHooks, TestConfig, TestListener } from './playwrightTest';
import type { Location, TestError, Entry } from './oopReporter';
import { ReusedBrowser } from './reusedBrowser';
import { SettingsModel } from './settingsModel';
import { SettingsView } from './settingsView';
import { TestModel, TestProject } from './testModel';
import { TestTree } from './testTree';
import { NodeJSNotFoundError, ansiToHtml } from './utils';
import * as vscodeTypes from './vscodeTypes';
import { WorkspaceChange, WorkspaceObserver } from './workspaceObserver';
import { TraceViewer } from './traceViewer';
import { TestServerController } from './testServerController';
import { type Watch, WatchSupport } from './watchSupport';

const stackUtils = new StackUtils({
  cwd: '/ensure_absolute_paths'
});

type StepInfo = {
  location: vscodeTypes.Location;
  activeCount: number;
  duration: number;
};

type TestRunInfo = {
  project: TestProject;
  include: readonly vscodeTypes.TestItem[] | undefined;
};

export async function activate(context: vscodeTypes.ExtensionContext) {
  // Do not await, quickly run the extension, schedule work.
  new Extension(require('vscode')).activate(context);
}

export class Extension implements RunHooks {
  private _vscode: vscodeTypes.VSCode;
  private _disposables: vscodeTypes.Disposable[] = [];

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
  private _itemsScheduledToRun: TestRunInfo[] | undefined;
  private _debugHighlight: DebugHighlight;
  private _isUnderTest: boolean;
  private _reusedBrowser: ReusedBrowser;
  private _traceViewer: TraceViewer;
  private _settingsModel: SettingsModel;
  private _settingsView!: SettingsView;
  private _watchSupport: WatchSupport;
  private _filesPendingListTests: {
    files: Set<string>,
    timer: NodeJS.Timeout,
    promise: Promise<void>,
    finishedCallback: () => void
  } | undefined;
  private _diagnostics: Record<'configErrors' | 'testErrors', vscodeTypes.DiagnosticCollection>;
  private _treeItemObserver: TreeItemObserver;
  private _testServerController: TestServerController;
  private _watchQueue = Promise.resolve();

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

    this._settingsModel = new SettingsModel(vscode);
    this._reusedBrowser = new ReusedBrowser(this._vscode, this._settingsModel, this._envProvider.bind(this));
    this._traceViewer = new TraceViewer(this._vscode, this._settingsModel, this._envProvider.bind(this));
    this._testServerController = new TestServerController(this._vscode, this._envProvider.bind(this));
    this._playwrightTest = new PlaywrightTest(this._vscode, this._settingsModel, this, this._isUnderTest, this._testServerController, this._envProvider.bind(this));
    this._testController = vscode.tests.createTestController('pw.extension.testController', 'Playwright');
    this._testController.resolveHandler = item => this._resolveChildren(item);
    this._testController.refreshHandler = () => this._rebuildModel(true).then(() => {});
    this._testTree = new TestTree(vscode, this._testController);
    this._debugHighlight = new DebugHighlight(vscode, this._reusedBrowser);
    this._debugHighlight.onErrorInDebugger(e => this._errorInDebugger(e.error, e.location));
    this._workspaceObserver = new WorkspaceObserver(this._vscode, changes => this._workspaceChanged(changes));
    this._diagnostics = {
      testErrors: this._vscode.languages.createDiagnosticCollection('pw.testErrors.diagnostic'),
      configErrors: this._vscode.languages.createDiagnosticCollection('pw.configErrors.diagnostic'),
    };
    this._treeItemObserver = new TreeItemObserver(this._vscode);
    this._watchSupport = new WatchSupport(this._vscode, this._playwrightTest, this._testTree, watchData => this._watchesTriggered(watchData));
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
    clearTimeout(this._filesPendingListTests?.timer);
    this._filesPendingListTests?.finishedCallback();
    delete this._filesPendingListTests;
    for (const d of this._disposables)
      d?.dispose?.();
  }

  async activate(context: vscodeTypes.ExtensionContext) {
    const vscode = this._vscode;
    this._settingsView = new SettingsView(vscode, this._settingsModel, this._reusedBrowser, context.extensionUri);
    const messageNoPlaywrightTestsFound = this._vscode.l10n.t('No Playwright tests found.');
    this._disposables = [
      this._debugHighlight,
      this._settingsModel,
      vscode.workspace.onDidChangeWorkspaceFolders(_ => {
        this._rebuildModel(false);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this._updateVisibleEditorItems();
      }),
      vscode.commands.registerCommand('pw.extension.install', async () => {
        await installPlaywright(this._vscode);
      }),
      vscode.commands.registerCommand('pw.extension.installBrowsers', async () => {
        if (!this._models.length) {
          vscode.window.showWarningMessage(messageNoPlaywrightTestsFound);
          return;
        }
        // Install each version only once.
        const versions = new Map<number, TestModel>();
        for (const model of this._models)
          versions.set(model.config.version, model);
        for (const model of versions.values())
          await installBrowsers(this._vscode, model);
      }),
      vscode.commands.registerCommand('pw.extension.command.inspect', async () => {
        if (!this._models.length) {
          vscode.window.showWarningMessage(messageNoPlaywrightTestsFound);
          return;
        }
        await this._reusedBrowser.inspect(this._models);
      }),
      vscode.commands.registerCommand('pw.extension.command.closeBrowsers', () => {
        this._reusedBrowser.closeAllBrowsers();
      }),
      vscode.commands.registerCommand('pw.extension.command.recordNew', async () => {
        if (!this._models.length) {
          vscode.window.showWarningMessage(messageNoPlaywrightTestsFound);
          return;
        }
        await this._reusedBrowser.record(this._models, true);
      }),
      vscode.commands.registerCommand('pw.extension.command.recordAtCursor', async () => {
        if (!this._models.length) {
          vscode.window.showWarningMessage(messageNoPlaywrightTestsFound);
          return;
        }
        await this._reusedBrowser.record(this._models, false);
      }),
      vscode.workspace.onDidChangeTextDocument(() => {
        if (this._completedSteps.size) {
          this._completedSteps.clear();
          this._executionLinesChanged();
        }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('playwright.env'))
          this._rebuildModel(false);
      }),
      this._treeItemObserver.onTreeItemSelected(item => this._treeItemSelected(item)),
      this._settingsView,
      this._testController,
      this._workspaceObserver,
      this._reusedBrowser,
      ...Object.values(this._diagnostics),
      this._treeItemObserver,
      this._testServerController,
    ];
    await this._rebuildModel(false);

    const fileSystemWatchers = [
      // Glob parser does not supported nested group, hence multiple watchers.
      this._vscode.workspace.createFileSystemWatcher('**/*playwright*.config.{ts,js,mjs}'),
      this._vscode.workspace.createFileSystemWatcher('**/*.env*'),
    ];
    this._disposables.push(...fileSystemWatchers);
    const rebuildModelForConfig = (uri: vscodeTypes.Uri) => {
      // TODO: parse .gitignore
      if (uri.fsPath.includes('node_modules'))
        return;
      if (!this._isUnderTest && uri.fsPath.includes('test-results'))
        return;
      this._rebuildModel(false);
    };
    fileSystemWatchers.map(w => w.onDidChange(rebuildModelForConfig));
    fileSystemWatchers.map(w => w.onDidCreate(rebuildModelForConfig));
    fileSystemWatchers.map(w => w.onDidDelete(rebuildModelForConfig));
    context.subscriptions.push(this);
  }

  private async _rebuildModel(showWarnings: boolean): Promise<vscodeTypes.Uri[]> {
    this._testTree.startedLoading();
    this._workspaceObserver.reset();
    this._testServerController.reset();
    this._models = [];

    const configFiles = await this._vscode.workspace.findFiles('**/*playwright*.config.{ts,js,mjs}', '**/node_modules/**');

    const configErrors = new MultiMap<string, TestError>();
    for (const configFileUri of configFiles) {
      const configFilePath = configFileUri.fsPath;
      // TODO: parse .gitignore
      if (!this._isUnderTest && configFilePath.includes('test-results'))
        continue;
      // Dogfood support
      const workspaceFolder = this._vscode.workspace.getWorkspaceFolder(configFileUri)!;
      const workspaceFolderPath = workspaceFolder.uri.fsPath;
      if (configFilePath.includes('test-results') && !workspaceFolderPath.includes('test-results'))
        continue;
      let playwrightInfo = null;
      try {
        playwrightInfo = await this._playwrightTest.getPlaywrightInfo(workspaceFolderPath, configFilePath);
      } catch (error) {
        if (showWarnings) {
          this._vscode.window.showWarningMessage(
              error instanceof NodeJSNotFoundError ? error.message : this._vscode.l10n.t('Please install Playwright Test via running `npm i --save-dev @playwright/test`')
          );
        }
        console.error('[Playwright Test]:', (error as any)?.message);
        continue;
      }

      const minimumPlaywrightVersion = 1.28;
      if (playwrightInfo.version < minimumPlaywrightVersion) {
        if (showWarnings) {
          this._vscode.window.showWarningMessage(
              this._vscode.l10n.t('Playwright Test v{0} or newer is required', minimumPlaywrightVersion)
          );
        }
        continue;
      }

      const model = new TestModel(this._vscode, this._playwrightTest, workspaceFolderPath, configFileUri.fsPath, playwrightInfo, this._envProvider.bind(this));
      this._models.push(model);
      this._testTree.addModel(model);
      const configError = await model.listFiles();
      if (configError) {
        configErrors.set(configError.location?.file ?? configFilePath, configError);
        continue;
      }

      for (const project of model.projects.values()) {
        await this._createRunProfile(project);
        this._workspaceObserver.addWatchFolder(project.testDir);
      }
    }

    this._settingsView.updateActions();

    this._testTree.finishedLoading();
    await this._updateVisibleEditorItems();

    this._reportConfigErrorsToUser(configErrors);

    return configFiles;
  }

  private _reportConfigErrorsToUser(configErrors: MultiMap<string, TestError>) {
    this._updateDiagnostics('configErrors', configErrors);
    if (!configErrors.size)
      return;
    (async () => {
      const showDetails = this._vscode.l10n.t('Show details');
      const choice = await this._vscode.window.showErrorMessage(this._vscode.l10n.t('There are errors in Playwright configuration files.'), showDetails);
      if (choice === showDetails) {
        // Show the document to the user.
        const document = await this._vscode.workspace.openTextDocument([...configErrors.keys()][0]);
        await this._vscode.window.showTextDocument(document);
        const error = [...configErrors.values()][0];
        // Reveal the error line.
        if (error?.location) {
          const range = new this._vscode.Range(
              new this._vscode.Position(Math.max(error.location.line - 4, 0), 0),
              new this._vscode.Position(error.location.line - 1, error.location.column - 1),
          );
          this._vscode.window.activeTextEditor?.revealRange(range);
        }
        // Focus problems view.
        await this._vscode.commands.executeCommand('workbench.action.problems.focus');
      }
    })();
  }

  private _envProvider(): NodeJS.ProcessEnv {
    const env = this._vscode.workspace.getConfiguration('playwright').get('env', {});
    return Object.fromEntries(Object.entries(env).map(entry => {
      return typeof entry[1] === 'string' ? entry : [entry[0], JSON.stringify(entry[1])];
    })) as NodeJS.ProcessEnv;
  }

  private async _createRunProfile(project: TestProject) {
    const configFile = project.model.config.configFile;
    const configName = path.basename(configFile);
    const folderName = path.basename(path.dirname(configFile));
    const projectPrefix = project.name ? `${project.name} — ` : '';
    const keyPrefix = configFile + ':' + project.name;
    let runProfile = this._runProfiles.get(keyPrefix + ':run');
    const projectTag = this._testTree.projectTag(project);
    const isDefault = false;
    const supportsContinuousRun = this._settingsModel.allowWatchingFiles.get();
    if (!runProfile) {
      runProfile = this._testController.createRunProfile(`${projectPrefix}${folderName}${path.sep}${configName}`, this._vscode.TestRunProfileKind.Run, this._scheduleTestRunRequest.bind(this, configFile, project.name, false), isDefault, projectTag, supportsContinuousRun);
      this._runProfiles.set(keyPrefix + ':run', runProfile);
    }
    let debugProfile = this._runProfiles.get(keyPrefix + ':debug');
    if (!debugProfile) {
      debugProfile = this._testController.createRunProfile(`${projectPrefix}${folderName}${path.sep}${configName}`, this._vscode.TestRunProfileKind.Debug, this._scheduleTestRunRequest.bind(this, configFile, project.name, true), isDefault, projectTag, supportsContinuousRun);
      this._runProfiles.set(keyPrefix + ':debug', debugProfile);
    }
  }

  private _scheduleTestRunRequest(configFile: string, projectName: string, isDebug: boolean, request: vscodeTypes.TestRunRequest, cancellationToken?: vscodeTypes.CancellationToken) {
    // Never run tests concurrently.
    if (this._testRun && !request.continuous)
      return;

    // We can't dispose projects (and bind them to TestProject instances) because otherwise VS Code would forget its selection state.
    // So bind run profiles to config file + project name pair, dynamically resolve the project.
    const model = this._models.find(m => m.config.configFile === configFile);
    if (!model)
      return;
    const project = model.projects.get(projectName);
    if (!project)
      return;

    if (request.continuous) {
      this._watchSupport.addToWatch(project, request.include, cancellationToken!);
      return;
    }

    // VSCode will issue several test run requests (one per enabled run profile). Sometimes
    // these profiles belong to the same config and we only want to run tests once per config.
    // So we collect all requests and sort them out in the microtask.
    if (!this._itemsScheduledToRun) {
      this._itemsScheduledToRun = [];
      this._itemsScheduledToRun.push({ project, include: request.include });
      // Make sure to run tests outside of this function's control flow
      // so that we can create a new TestRunRequest and see its output.
      // TODO: remove once this is fixed in VSCode (1.78?) and we
      // can see test output without this hack.
      setTimeout(async () => {
        const selectedItems = this._itemsScheduledToRun;
        this._itemsScheduledToRun = undefined;
        if (selectedItems)
          await this._runMatchingTests(selectedItems, isDebug ? 'debug' : 'run');
      }, 520);
    } else {
      // Subsequent requests will return right away.
      this._itemsScheduledToRun.push({ project, include: request.include });
    }
  }

  private async _runMatchingTests(testRunInfos: TestRunInfo[], mode: 'run' | 'debug' | 'watch') {
    this._completedSteps.clear();
    this._executionLinesChanged();

    const projects = testRunInfos.map(info => info.project);
    const include = testRunInfos.map(info => info.include || []).flat();

    // Create a test run that potentially includes all the test items.
    // This allows running setup tests that are outside of the scope of the
    // selected test items.
    const rootItems: vscodeTypes.TestItem[] = [];
    this._testController.items.forEach(item => rootItems.push(item));
    const requestWithDeps = new this._vscode.TestRunRequest(rootItems, [], undefined, mode === 'watch');

    // Global errors are attributed to the first test item in the request.
    // If the request is global, find the first root test item (folder, file) that has
    // children. It will be reveal with an error.
    let testItemForGlobalErrors = include[0];
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
    for (const item of include) {
      for (const test of this._testTree.collectTestsInside(item)) {
        this._testRun.enqueued(test);
        enqueuedTests.push(test);
      }
    }

    // Run tests with different configs sequentially, group by config.
    const projectsToRunByModel = new Map<TestModel, TestProject[]>();
    for (const project of projects) {
      const projects = projectsToRunByModel.get(project.model) || [];
      projects.push(project);
      projectsToRunByModel.set(project.model, projects);
    }

    let ranSomeTests = false;
    try {
      for (const [model, projectsToRun] of projectsToRunByModel) {
        const { projects, locations, parametrizedTestTitle } = this._narrowDownProjectsAndLocations(projectsToRun, include);
        // Run if:
        //   !locations => run all tests
        //   locations.length => has matching items in project.
        if (locations && !locations.length)
          continue;
        ranSomeTests = true;
        await this._runTest(this._testRun, testItemForGlobalErrors, new Set(), model, mode === 'debug', projects, locations, parametrizedTestTitle, enqueuedTests.length === 1);
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

  private _narrowDownProjectsAndLocations(projects: TestProject[], items: readonly vscodeTypes.TestItem[]): { projects: TestProject[], locations: string[] | null, parametrizedTestTitle: string | undefined } {
    if (!items.length)
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
    await this._listTestsInAllModels([fileItem!.uri!.fsPath]);
  }

  private async _workspaceChanged(change: WorkspaceChange) {
    for (const model of this._models)
      await model.workspaceChanged(change);
    // Workspace change can be deferred, make sure editors are
    // decorated.
    await this._updateVisibleEditorItems();
    await this._watchSupport.workspaceChanged(change);
  }

  private _watchesTriggered(watches: Watch[]) {
    this._watchQueue = this._watchQueue.then(() => this._runMatchingTests(watches, 'watch'));
  }

  private async _runTest(
    testRun: vscodeTypes.TestRun,
    testItemForGlobalErrors: vscodeTypes.TestItem | undefined,
    testFailures: Set<vscodeTypes.TestItem>,
    model: TestModel,
    isDebug: boolean,
    projects: TestProject[],
    locations: string[] | null,
    parametrizedTestTitle: string | undefined,
    enqueuedSingleTest: boolean) {
    const testListener: TestListener = {
      onBegin: ({ projects }) => {
        model.updateFromRunningProjects(projects);
        const visit = (entry: Entry) => {
          if (entry.type === 'test') {
            const testItem = this._testTree.testItemForLocation(entry.location, entry.titlePath);
            if (testItem)
              testRun.enqueued(testItem);
          }
          (entry.children || []).forEach(visit);
        };
        projects.forEach(visit);
      },

      onTestBegin: params => {
        const testItem = this._testTree.testItemForLocation(params.location, params.titlePath);
        if (testItem) {
          testRun.started(testItem);
          const traceUrl = `${params.outputDir}/.playwright-artifacts-${params.workerIndex}/traces/${params.testId}.json`;
          (testItem as any)[traceUrlSymbol] = traceUrl;
        }

        if (testItem && enqueuedSingleTest)
          this._showTrace(testItem);
        if (isDebug) {
          // Debugging is always single-workers.
          this._testItemUnderDebug = testItem;
        }
      },

      onTestEnd: params => {
        this._testItemUnderDebug = undefined;
        this._activeSteps.clear();
        this._executionLinesChanged();

        const testItem = this._testTree.testItemForLocation(params.location, params.titlePath);
        if (!testItem)
          return;

        (testItem as any)[traceUrlSymbol] = params.trace || '';
        if (enqueuedSingleTest)
          this._showTrace(testItem);

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
        testRun.failed(testItem, params.errors.map(error => this._testMessageForTestError(error, testItem)), params.duration);
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

      onError: data => {
        // Global errors don't have associated tests, so we'll be allocating them
        // to the first item / current.
        if (testItemForGlobalErrors) {
          // Force UI to reveal the item if that is a file that has never been started.
          testRun.started(testItemForGlobalErrors);
          testRun.failed(testItemForGlobalErrors, this._testMessageForTestError(data.error), 0);
        }
      }
    };

    if (isDebug) {
      await model.debugTests(projects, locations, testListener, parametrizedTestTitle, testRun.token);
    } else {
      await this._traceViewer.willRunTests(model.config);
      await model.runTests(projects, locations, testListener, parametrizedTestTitle, testRun.token);
    }
  }

  private async _updateVisibleEditorItems() {
    const files = this._vscode.window.visibleTextEditors.map(e => e.document.uri.fsPath);
    await this._listTestsInAllModels(files);
  }

  private _listTestsInAllModels(inputFiles: string[]): Promise<void> {
    // Perform coalescing listTests calls to avoid multiple
    // 'list tests' processes running at the same time.
    if (!inputFiles.length)
      return Promise.resolve();

    if (!this._filesPendingListTests) {
      let finishedCallback!: () => void;
      const promise = new Promise<void>(f => finishedCallback = f);
      const files = new Set<string>();

      const timer = setTimeout(async () => {
        delete this._filesPendingListTests;
        const allErrors = new Set<string>();
        const errorsByFile = new MultiMap<string, TestError>();
        for (const model of this._models.slice()) {
          const errors = await model.listTests([...files]).catch(e => console.log(e)) || [];
          for (const error of errors) {
            if (!error.location || !error.message)
              continue;
            const key = error.location.file + ':' + error.location.line + ':' + error.message;
            if (allErrors.has(key))
              continue;
            allErrors.add(key);
            errorsByFile.set(error.location?.file, error);
          }
        }
        this._updateDiagnostics('testErrors', errorsByFile);
        finishedCallback();
      }, 0);

      this._filesPendingListTests = {
        files,
        finishedCallback,
        promise,
        timer,
      };
    }

    for (const file of inputFiles)
      this._filesPendingListTests.files.add(file);

    return this._filesPendingListTests.promise;
  }

  private _updateDiagnostics(diagnosticsType: 'configErrors' | 'testErrors' , errorsByFile: MultiMap<string, TestError>) {
    const diagnosticsCollection = this._diagnostics[diagnosticsType]!;
    diagnosticsCollection.clear();
    for (const [file, errors] of errorsByFile) {
      const diagnostics: vscodeTypes.Diagnostic[] = [];
      for (const error of errors) {
        diagnostics.push({
          severity: this._vscode.DiagnosticSeverity.Error,
          source: 'playwright',
          range: new this._vscode.Range(error.location!.line - 1, error.location!.column - 1, error.location!.line, 0),
          message: error.message!,
        });
      }
      diagnosticsCollection.set(this._vscode.Uri.file(file), diagnostics);
    }
  }

  private _errorInDebugger(errorStack: string, location: Location) {
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

  private _testMessageForTestError(error: TestError, testItem?: vscodeTypes.TestItem): vscodeTypes.TestMessage {
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
    return this._playwrightTest.testLog();
  }

  browserServerWSForTest() {
    return this._reusedBrowser.browserServerWSEndpoint();
  }

  private _showTrace(testItem: vscodeTypes.TestItem) {
    const traceUrl = (testItem as any)[traceUrlSymbol];
    const testModel = this._models[0];
    this._traceViewer.open(traceUrl, testModel.config);
  }

  private _treeItemSelected(treeItem: vscodeTypes.TreeItem | null) {
    if (!treeItem)
      return;
    const traceUrl = (treeItem as any)[traceUrlSymbol] || '';
    const testModel = this._models[0];
    this._traceViewer.open(traceUrl, testModel.config);
  }
}

function parseLocationFromStack(stack: string | undefined, testItem?: vscodeTypes.TestItem): Location | undefined {
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

const traceUrlSymbol = Symbol('traceUrl');

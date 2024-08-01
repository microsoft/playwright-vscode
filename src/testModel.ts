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

import { WorkspaceChange } from './workspaceObserver';
import * as vscodeTypes from './vscodeTypes';
import { resolveSourceMap } from './utils';
import { ConfigListFilesReport, ProjectConfigWithFiles } from './listTests';
import * as reporterTypes from './upstream/reporter';
import { TeleSuite } from './upstream/teleReceiver';
import { workspaceStateKey } from './settingsModel';
import type { ConfigSettings, SettingsModel, WorkspaceSettings } from './settingsModel';
import path from 'path';
import { DisposableBase } from './disposableBase';
import { MultiMap } from './multimap';
import { PlaywrightTestServer } from './playwrightTestServer';
import type { PlaywrightTestRunOptions, RunHooks, TestConfig } from './playwrightTestTypes';
import { PlaywrightTestCLI } from './playwrightTestCLI';
import { upstreamTreeItem } from './testTree';
import { collectTestIds } from './upstream/testTree';

export type TestEntry = reporterTypes.TestCase | reporterTypes.Suite;

export type TestProject = {
  model: TestModel;
  name: string;
  suite: reporterTypes.Suite;
  project: reporterTypes.FullProject;
  isEnabled: boolean;
};

export type TestModelEmbedder = {
  context: vscodeTypes.ExtensionContext;
  settingsModel: SettingsModel;
  runHooks: RunHooks;
  isUnderTest: boolean;
  playwrightTestLog: string[];
  envProvider: () => NodeJS.ProcessEnv;
  onStdOut: vscodeTypes.Event<string>;
  requestWatchRun: (files: string[], testItems: vscodeTypes.TestItem[]) => void;
};

type Watch = {
  include: readonly vscodeTypes.TestItem[] | undefined;
};

export class TestModel extends DisposableBase {
  private _vscode: vscodeTypes.VSCode;
  readonly config: TestConfig;
  private _projects = new Map<string, TestProject>();
  private _playwrightTest: PlaywrightTestCLI | PlaywrightTestServer;
  private _watches = new Set<Watch>();
  private _fileToSources: Map<string, string[]> = new Map();
  private _sourceToFile: Map<string, string> = new Map();
  isEnabled = false;
  readonly tag: vscodeTypes.TestTag;
  private _errorByFile = new MultiMap<string, reporterTypes.TestError>();
  private _embedder: TestModelEmbedder;
  private _filesWithListedTests = new Set<string>();
  private _filesPendingListTests: {
    files: Set<string>,
    timer: NodeJS.Timeout,
    promise: Promise<void>,
    finishedCallback: () => void
  } | undefined;
  private _ranGlobalSetup = false;
  private _startedDevServer = false;
  private _useLegacyCLIDriver: boolean;
  private _collection: TestModelCollection;

  constructor(collection: TestModelCollection, workspaceFolder: string, configFile: string, playwrightInfo: { cli: string, version: number }) {
    super();
    this._vscode = collection.vscode;
    this._embedder = collection.embedder;
    this._collection = collection;
    this.config = { ...playwrightInfo, workspaceFolder, configFile };
    this._useLegacyCLIDriver = playwrightInfo.version < 1.44;
    this._playwrightTest =  this._useLegacyCLIDriver ? new PlaywrightTestCLI(this._vscode, this, collection.embedder) : new PlaywrightTestServer(this._vscode, this, collection.embedder);
    this.tag = new this._vscode.TestTag(this.config.configFile);
  }

  async _loadModelIfNeeded(configSettings: ConfigSettings | undefined) {
    if (!this.isEnabled)
      return;
    await this._listFiles();
    if (configSettings) {
      let firstProject = true;
      for (const project of this.projects()) {
        const projectSettings = configSettings.projects.find(p => p.name === project.name);
        if (projectSettings)
          project.isEnabled = projectSettings.enabled;
        else if (firstProject)
          project.isEnabled = true;
        firstProject = false;
      }
    } else {
      if (this.projects().length)
        this.projects()[0].isEnabled = true;
    }
  }

  dispose() {
    this.reset();
    super.dispose();
  }

  reset() {
    clearTimeout(this._filesPendingListTests?.timer);
    this._filesPendingListTests?.finishedCallback();
    delete this._filesPendingListTests;
    this._projects.clear();
    this._fileToSources.clear();
    this._sourceToFile.clear();
    this._errorByFile.clear();
    this._playwrightTest.reset();
    this._watches.clear();
    this._ranGlobalSetup = false;
  }

  projects(): TestProject[] {
    return [...this._projects.values()];
  }

  errors(): MultiMap<string, reporterTypes.TestError> {
    return this._errorByFile;
  }

  projectMap(): Map<string, TestProject> {
    return this._projects;
  }

  testDirs(): string[] {
    return [...new Set([...this._projects.values()].map(p => p.project.testDir))];
  }

  enabledProjects(): TestProject[] {
    return [...this._projects.values()].filter(p => p.isEnabled);
  }

  enabledProjectsFilter(): string[] {
    const allEnabled = !([...this._projects.values()].some(p => !p.isEnabled));
    if (allEnabled)
      return [];
    return this.enabledProjects().map(p => p.name);
  }

  enabledFiles(): Set<string> {
    const result = new Set<string>();
    for (const project of this.enabledProjects()) {
      const files = projectFiles(project);
      for (const file of files.keys())
        result.add(file);
    }
    return result;
  }

  async _listFiles() {
    this._filesWithListedTests.clear();
    let report: ConfigListFilesReport;
    try {
      report = await this._playwrightTest.listFiles();
      for (const project of report.projects)
        project.files = project.files.map(f => this._vscode.Uri.file(f).fsPath);
      if (report.error?.location)
        report.error.location.file = this._vscode.Uri.file(report.error.location.file).fsPath;
    } catch (error: any) {
      report = {
        error: {
          location: { file: this.config.configFile, line: 0, column: 0 },
          message: error.message,
        },
        projects: [],
      };
    }

    if (report.error?.location) {
      this._errorByFile.set(report.error?.location.file, report.error);
      this._collection._modelUpdated(this);
      return;
    }

    // Resolve files to sources when using source maps.
    for (const project of report.projects) {
      const files: string[] = [];
      for (const file of project.files)
        files.push(...await resolveSourceMap(file, this._fileToSources, this._sourceToFile));
      project.files = files;
      this.config.testIdAttributeName = project.use?.testIdAttribute;
    }

    const projectsToKeep = new Set<string>();
    for (const projectReport of report.projects) {
      projectsToKeep.add(projectReport.name);
      let project = this._projects.get(projectReport.name);
      if (!project)
        project = this._createProject(projectReport);
      this._updateProjectFiles(project, projectReport);
    }

    for (const projectName of this._projects.keys()) {
      if (!projectsToKeep.has(projectName))
        this._projects.delete(projectName);
    }

    this._collection._modelUpdated(this);
  }

  private _createProject(projectReport: ProjectConfigWithFiles): TestProject {
    const projectSuite = new TeleSuite(projectReport.name, 'project');
    projectSuite._project = {
      dependencies: [],
      grep: '.*',
      grepInvert: null,
      metadata: {},
      name: projectReport.name,
      outputDir: '',
      repeatEach: 0,
      retries: 0,
      snapshotDir: '',
      testDir: projectReport.testDir,
      testIgnore: [],
      testMatch: '.*',
      timeout: 0,
      use: projectReport.use,
    };
    const project: TestProject = {
      model: this,
      name: projectReport.name,
      suite: projectSuite,
      project: projectSuite._project,
      isEnabled: false,
    };
    this._projects.set(project.name, project);
    return project;
  }

  private _updateProjectFiles(project: TestProject, projectReport: ProjectConfigWithFiles) {
    const filesToKeep = new Set<string>();
    const files = projectFiles(project);
    for (const file of projectReport.files) {
      filesToKeep.add(file);
      const testFile = files.get(file);
      if (!testFile) {
        const testFile = new TeleSuite(file, 'file');
        testFile.location = { file, line: 0, column: 0 };
        (testFile as any)[listFilesFlag] = true;
        files.set(file, testFile);
      }
    }

    for (const file of files.keys()) {
      if (!filesToKeep.has(file))
        files.delete(file);
    }
    project.suite.suites = [...files.values()];
  }

  async handleWorkspaceChange(change: WorkspaceChange) {
    const testDirs = [...new Set([...this._projects.values()].map(p => p.project.testDir))];

    const changed = this._mapFilesToSources(testDirs, change.changed);
    const created = this._mapFilesToSources(testDirs, change.created);
    const deleted = this._mapFilesToSources(testDirs, change.deleted);

    if (created.length || deleted.length)
      await this._listFiles();
    if (changed.length) {
      const changedWithListedTests = changed.filter(f => this._filesWithListedTests.has(f));
      for (const c of changedWithListedTests)
        this._filesWithListedTests.delete(c);
      await this.ensureTests(changedWithListedTests);
    }
  }

  testFilesChanged(testFiles: string[]) {
    if (!this._watches.size)
      return;
    if (!testFiles.length)
      return;

    const enabledFiles = this.enabledFiles();
    const files: string[] = [];
    const items: vscodeTypes.TestItem[] = [];
    for (const watch of this._watches || []) {
      for (const testFile of testFiles) {
        if (!watch.include) {
          // Everything is watched => add file.
          files.push(testFile);
          continue;
        }

        for (const include of watch.include) {
          if (!include.uri)
            continue;
          if (!enabledFiles.has(include.uri.fsPath))
            continue;
          // Folder is watched => add file.
          if (testFile.startsWith(include.uri.fsPath + path.sep)) {
            files.push(testFile);
            continue;
          }
          // File is watched => add file.
          if (testFile === include.uri.fsPath && !include.range) {
            items.push(include);
            continue;
          }
          // Test is watched, use that include as it might be more specific (test).
          if (testFile === include.uri.fsPath && include.range) {
            items.push(include);
            continue;
          }
        }
      }
    }

    this._embedder.requestWatchRun(files, items);
  }

  async ensureTests(inputFiles: string[]): Promise<void> {
    const enabledFiles = this.enabledFiles();
    const filesToListTests = inputFiles.filter(f => enabledFiles.has(f) && !this._filesWithListedTests.has(f));
    if (!filesToListTests.length)
      return;

    for (const file of filesToListTests)
      this._filesWithListedTests.add(file);

    if (!this._filesPendingListTests) {
      let finishedCallback!: () => void;
      const promise = new Promise<void>(f => finishedCallback = f);
      const files = new Set<string>();

      const timer = setTimeout(async () => {
        delete this._filesPendingListTests;
        await this._listTests([...files]).catch(e => console.log(e));
        finishedCallback();
      }, 100);

      this._filesPendingListTests = {
        files,
        finishedCallback,
        promise,
        timer,
      };
    }

    for (const file of filesToListTests)
      this._filesPendingListTests.files.add(file);

    return this._filesPendingListTests.promise;
  }

  private async _listTests(files: string[]) {
    const errors: reporterTypes.TestError[] = [];
    let rootSuite: reporterTypes.Suite | undefined;
    await this._playwrightTest.listTests(files, {
      onBegin: (suite: reporterTypes.Suite) => {
        rootSuite = suite;
      },
      onError: (error: reporterTypes.TestError) => {
        errors.push(error);
      },
    }, new this._vscode.CancellationTokenSource().token);
    this._updateProjects(rootSuite!.suites, files, errors);
  }

  private _updateProjects(newProjectSuites: reporterTypes.Suite[], requestedFiles: string[], errors: reporterTypes.TestError[]) {
    for (const requestedFile of requestedFiles)
      this._errorByFile.deleteAll(requestedFile);
    for (const error of errors) {
      if (error.location)
        this._errorByFile.set(error.location.file, error);
    }

    for (const [projectName, project] of this._projects) {
      const files = projectFiles(project);
      const newProjectSuite = newProjectSuites.find(e => e.project()!.name === projectName);
      const filesToClear = new Set(requestedFiles);
      for (const fileSuite of newProjectSuite?.suites || []) {
        // Do not show partial results in suites with errors.
        if (this._errorByFile.has(fileSuite.location!.file))
          continue;
        filesToClear.delete(fileSuite.location!.file);
        files.set(fileSuite.location!.file, fileSuite);
      }

      for (const file of filesToClear) {
        const fileSuite = files.get(file);
        if (fileSuite) {
          fileSuite.suites = [];
          fileSuite.tests = [];
        }
      }
      project.suite.suites = [...files.values()];
    }
    this._collection._modelUpdated(this);
  }

  updateFromRunningProjects(projectSuites: reporterTypes.Suite[]) {
    for (const projectSuite of projectSuites) {
      const project = this._projects.get(projectSuite.project()!.name);
      if (project)
        this._updateFromRunningProject(project, projectSuite);
    }
  }

  private _updateFromRunningProject(project: TestProject, projectSuite: reporterTypes.Suite) {
    // When running tests, don't remove existing entries.
    const files = projectFiles(project);
    for (const fileSuite of projectSuite.suites) {
      if (!fileSuite.allTests().length)
        continue;
      this._filesWithListedTests.add(fileSuite.location!.file);
      const existingFileSuite = files.get(fileSuite.location!.file);
      if (!existingFileSuite || !existingFileSuite.allTests().length)
        files.set(fileSuite.location!.file, fileSuite);
    }
    project.suite.suites = [...files.values()];
    this._collection._modelUpdated(this);
  }

  canRunGlobalHooks(type: 'setup' | 'teardown') {
    if (type === 'setup')
      return !this._useLegacyCLIDriver && !this._ranGlobalSetup;
    return this._ranGlobalSetup;
  }

  needsGlobalHooks(type: 'setup' | 'teardown'): boolean {
    if (type === 'setup' && !this._ranGlobalSetup)
      return true;
    if (type === 'teardown' && this._ranGlobalSetup)
      return true;
    return false;
  }

  async runGlobalHooks(type: 'setup' | 'teardown', testListener: reporterTypes.ReporterV2): Promise<reporterTypes.FullResult['status']> {
    if (!this.canRunGlobalHooks(type))
      return 'passed';
    if (type === 'setup') {
      if (this._ranGlobalSetup)
        return 'passed';
      const status = await this._playwrightTest.runGlobalHooks('setup', testListener);
      if (status === 'passed')
        this._ranGlobalSetup = true;
      return status;
    }

    if (!this._ranGlobalSetup)
      return 'passed';
    const status = await this._playwrightTest.runGlobalHooks('teardown', testListener);
    this._ranGlobalSetup = false;
    return status;
  }

  canStartDevServer(): boolean {
    return !this._useLegacyCLIDriver && !this._startedDevServer;
  }

  canStopDevServer(): boolean {
    return this._startedDevServer;
  }

  async startDevServer() {
    if (this._startedDevServer)
      return;
    const result = await this._playwrightTest.startDevServer();
    if (result === 'passed')
      this._startedDevServer = true;
  }

  async stopDevServer() {
    if (!this._startedDevServer)
      return;
    const result = await this._playwrightTest.stopDevServer();
    if (result === 'passed')
      this._startedDevServer = false;
  }

  async clearCache() {
    await this._playwrightTest.clearCache();
  }

  async runTests(items: vscodeTypes.TestItem[], reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken) {
    if (token?.isCancellationRequested)
      return;

    // Run global setup with the first test.
    let globalSetupResult: reporterTypes.FullResult['status'] = 'passed';
    if (this.canRunGlobalHooks('setup'))
      globalSetupResult = await this.runGlobalHooks('setup', reporter);
    if (globalSetupResult !== 'passed')
      return;

    const externalOptions = await this._embedder.runHooks.onWillRunTests(this.config, false);
    const showBrowser = this._embedder.settingsModel.showBrowser.get() && !!externalOptions.connectWsEndpoint;

    let trace: 'on' | 'off' | undefined;
    let video: 'on' | 'off' | undefined;

    if (this._embedder.settingsModel.showTrace.get())
      trace = 'on';
    // "Show browser" mode forces context reuse that survives over multiple test runs.
    // Playwright Test sets up `tracesDir` inside the `test-results` folder, so it will be removed between runs.
    // When context is reused, its ongoing tracing will fail with ENOENT because trace files
    // were suddenly removed. So we disable tracing in this case.
    if (this._embedder.settingsModel.showBrowser.get()) {
      trace = 'off';
      video = 'off';
    }

    const options: PlaywrightTestRunOptions = {
      headed: showBrowser && !this._embedder.isUnderTest,
      workers: showBrowser ? 1 : undefined,
      trace,
      video,
      reuseContext: showBrowser,
      connectWsEndpoint: showBrowser ? externalOptions.connectWsEndpoint : undefined,
    };

    try {
      if (token?.isCancellationRequested)
        return;
      await this._playwrightTest.runTests(items, options, reporter, token);
    } finally {
      await this._embedder.runHooks.onDidRunTests(false);
    }
  }

  async debugTests(items: vscodeTypes.TestItem[], reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken) {
    if (token?.isCancellationRequested)
      return;

    // Underlying debugTest implementation will run the global setup.
    await this.runGlobalHooks('teardown', reporter);
    if (token?.isCancellationRequested)
      return;

    const externalOptions = await this._embedder.runHooks.onWillRunTests(this.config, true);
    const options: PlaywrightTestRunOptions = {
      headed: !this._embedder.isUnderTest,
      workers: 1,
      video: 'off',
      trace: 'off',
      reuseContext: false,
      connectWsEndpoint: externalOptions.connectWsEndpoint,
    };
    try {
      if (token?.isCancellationRequested)
        return;
      await this._playwrightTest.debugTests(items, options, reporter, token);
    } finally {
      await this._embedder.runHooks.onDidRunTests(false);
    }
  }

  private _mapFilesToSources(testDirs: string[], files: Set<string>): string[] {
    const result = new Set<string>();
    for (const file of files) {
      if (!testDirs.some(t => file.startsWith(t + path.sep)))
        continue;
      const sources = this._fileToSources.get(file);
      if (sources)
        sources.forEach(f => result.add(f));
      else
        result.add(file);
    }
    return [...result];
  }

  async addToWatch(include: readonly vscodeTypes.TestItem[] | undefined, cancellationToken: vscodeTypes.CancellationToken) {
    const watch: Watch = { include };
    this._watches.add(watch);
    cancellationToken.onCancellationRequested(() => this._watches.delete(watch));

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

    const filesToWatch = new Set<string>();
    for (const watch of this._watches) {
      if (!watch.include) {
        for (const file of this.enabledFiles())
          filesToWatch.add(file);
        continue;
      }
      for (const include of watch.include) {
        if (!include.uri)
          continue;
        filesToWatch.add(include.uri.fsPath);
      }
    }
    await this._playwrightTest.watchFiles([...filesToWatch]);
  }

  narrowDownLocations(items: vscodeTypes.TestItem[]): { locations: string[] | null, testIds?: string[] } {
    if (!items.length)
      return { locations: [] };
    const locations = new Set<string>();
    const testIds: string[] = [];
    for (const item of items) {
      const treeItem = upstreamTreeItem(item);
      if (treeItem.kind === 'group' && (treeItem.subKind === 'folder' || treeItem.subKind === 'file')) {
        for (const file of this.enabledFiles()) {
          if (file === treeItem.location.file || file.startsWith(treeItem.location.file))
            locations.add(treeItem.location.file);
        }
      } else {
        testIds.push(...collectTestIds(treeItem));
      }
    }

    return { locations: locations.size ? [...locations] : null, testIds: testIds.length ? testIds : undefined };
  }
}

export class TestModelCollection extends DisposableBase {
  private _models: TestModel[] = [];
  private _selectedConfigFile: string | undefined;
  private _didUpdate: vscodeTypes.EventEmitter<void>;
  readonly onUpdated: vscodeTypes.Event<void>;
  readonly vscode: vscodeTypes.VSCode;
  readonly embedder: TestModelEmbedder;

  constructor(vscode: vscodeTypes.VSCode, embedder: TestModelEmbedder) {
    super();
    this.vscode = vscode;
    this.embedder = embedder;
    this._didUpdate = new vscode.EventEmitter();
    this.onUpdated = this._didUpdate.event;
  }

  setModelEnabled(configFile: string, enabled: boolean, userGesture?: boolean) {
    const model = this._models.find(m => m.config.configFile === configFile);
    if (!model)
      return;
    if (model.isEnabled === enabled)
      return;
    model.isEnabled = enabled;
    if (userGesture)
      this._saveSettings();
    model.reset();
    const configSettings = this._configSettings(model.config);
    model._loadModelIfNeeded(configSettings).then(() => this._didUpdate.fire());
  }

  setProjectEnabled(configFile: string, name: string, enabled: boolean) {
    const model = this._models.find(m => m.config.configFile === configFile);
    if (!model)
      return;
    const project = model.projectMap().get(name);
    if (!project)
      return;
    if (project.isEnabled === enabled)
      return;
    project.isEnabled = enabled;
    this._saveSettings();
    this._didUpdate.fire();
  }

  testDirs(): Set<string> {
    const result = new Set<string>();
    for (const model of this._models) {
      for (const dir of model.testDirs())
        result.add(dir);
    }
    return result;
  }

  async createModel(workspaceFolder: string, configFile: string, playwrightInfo: { cli: string, version: number }) {
    const model = new TestModel(this, workspaceFolder, configFile, playwrightInfo);
    this._models.push(model);
    const configSettings = this._configSettings(model.config);
    model.isEnabled = configSettings?.enabled || (this._models.length === 1 && !configSettings);
    await model._loadModelIfNeeded(configSettings);
    this._didUpdate.fire();
  }

  _modelUpdated(model: TestModel) {
    this._didUpdate.fire();
  }

  private _configSettings(config: TestConfig) {
    const workspaceSettings = this.embedder.context.workspaceState.get(workspaceStateKey) as WorkspaceSettings || {};
    return (workspaceSettings.configs || []).find(c => c.relativeConfigFile === path.relative(config.workspaceFolder, config.configFile));
  }

  async ensureHasEnabledModels() {
    if (this._models.length && !this.hasEnabledModels())
      this.setModelEnabled(this._models[0].config.configFile, false);
  }

  hasEnabledModels() {
    return !!this.enabledModels().length;
  }

  versions(): Map<number, TestModel>{
    const versions = new Map<number, TestModel>();
    for (const model of this._models)
      versions.set(model.config.version, model);
    return versions;
  }

  clear() {
    for (const model of this._models)
      model.dispose();
    this._models = [];
    this._didUpdate.fire();
  }

  dispose() {
    for (const model of this._models)
      model.dispose();
    super.dispose();
  }

  enabledModels(): TestModel[] {
    return this._models.filter(m => m.isEnabled);
  }

  models(): TestModel[] {
    return this._models;
  }

  selectedModel(): TestModel | undefined {
    const enabledModels = this.enabledModels();
    if (!enabledModels.length) {
      this._selectedConfigFile = undefined;
      return undefined;
    }

    const model = enabledModels.find(m => m.config.configFile === this._selectedConfigFile);
    if (model)
      return model;
    this._selectedConfigFile = enabledModels[0].config.configFile;
    return enabledModels[0];
  }

  selectModel(configFile: string) {
    this._selectedConfigFile = configFile;
    this._saveSettings();
    this._didUpdate.fire();
  }

  private _saveSettings() {
    const workspaceSettings: WorkspaceSettings = { configs: [] };
    for (const model of this._models) {
      workspaceSettings.configs!.push({
        relativeConfigFile: path.relative(model.config.workspaceFolder, model.config.configFile),
        selected: model.config.configFile === this._selectedConfigFile,
        enabled: model.isEnabled,
        projects: model.projects().map(p => ({ name: p.name, enabled: p.isEnabled })),
      });
    }
    this.embedder.context.workspaceState.update(workspaceStateKey, workspaceSettings);
  }
}

export function projectFiles(project: TestProject): Map<string, reporterTypes.Suite> {
  const files = new Map<string, reporterTypes.Suite>();
  for (const fileSuite of project.suite.suites)
    files.set(fileSuite.location!.file, fileSuite);
  return files;
}

const listFilesFlag = Symbol('listFilesFlag');

function isAncestorOf(root: vscodeTypes.TestItem, descendent: vscodeTypes.TestItem) {
  while (descendent.parent) {
    if (descendent.parent === root)
      return true;
    descendent = descendent.parent;
  }
  return false;
}

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

import { PlaywrightTest, TestConfig } from './playwrightTest';
import { WorkspaceChange } from './workspaceObserver';
import * as vscodeTypes from './vscodeTypes';
import { resolveSourceMap } from './utils';
import { ProjectConfigWithFiles } from './listTests';
import * as reporterTypes from './reporter';
import { TeleSuite } from './upstream/teleReceiver';

export type TestEntry = reporterTypes.TestCase | reporterTypes.Suite;

export type TestProject = {
  model: TestModel;
  name: string;
  suite: reporterTypes.Suite;
  project: reporterTypes.FullProject;
  isEnabled: boolean;
};

export class TestModel {
  private _vscode: vscodeTypes.VSCode;
  readonly config: TestConfig;
  private _projects = new Map<string, TestProject>();
  private _didUpdate: vscodeTypes.EventEmitter<void>;
  readonly onUpdated: vscodeTypes.Event<void>;
  private _playwrightTest: PlaywrightTest;
  private _fileToSources: Map<string, string[]> = new Map();
  private _sourceToFile: Map<string, string> = new Map();
  private _envProvider: () => NodeJS.ProcessEnv;

  constructor(vscode: vscodeTypes.VSCode, playwrightTest: PlaywrightTest, workspaceFolder: string, configFile: string, playwrightInfo: { cli: string, version: number }, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._playwrightTest = playwrightTest;
    this.config = { ...playwrightInfo, workspaceFolder, configFile };
    this._didUpdate = new vscode.EventEmitter();
    this._envProvider = envProvider;
    this.onUpdated = this._didUpdate.event;
  }

  setProjectEnabled(project: TestProject, enabled: boolean) {
    project.isEnabled = enabled;
    this._didUpdate.fire();
  }

  allProjects(): Map<string, TestProject> {
    return this._projects;
  }

  enabledProjects(): TestProject[] {
    return [...this._projects.values()].filter(p => p.isEnabled);
  }

  enabledFiles(): string[] {
    const result: string[] = [];
    for (const project of this.enabledProjects()) {
      const files = projectFiles(project);
      for (const file of files.keys())
        result.push(file);
    }
    return result;
  }

  async listFiles(): Promise<reporterTypes.TestError | undefined> {
    const report = await this._playwrightTest.listFiles(this.config);
    if (report.error)
      return report.error;

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
      this._updateProject(project, projectReport);
    }

    for (const projectName of this._projects.keys()) {
      if (!projectsToKeep.has(projectName))
        this._projects.delete(projectName);
    }

    this._didUpdate.fire();
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

  private _updateProject(project: TestProject, projectReport: ProjectConfigWithFiles) {
    const filesToKeep = new Set<string>();
    const files = projectFiles(project);
    for (const file of projectReport.files) {
      filesToKeep.add(file);
      const testFile = files.get(file);
      if (!testFile) {
        const testFile = new TeleSuite(file, 'file');
        testFile.location = { file, line: 0, column: 0 };
        files.set(file, testFile);
      }
    }

    for (const file of files.keys()) {
      if (!filesToKeep.has(file))
        files.delete(file);
    }
    project.suite.suites = [...files.values()];
  }

  async workspaceChanged(change: WorkspaceChange) {
    const testDirs = [...new Set([...this._projects.values()].map(p => p.project.testDir))];

    const changed = this._mapFilesToSources(testDirs, change.changed);
    const created = this._mapFilesToSources(testDirs, change.created);
    const deleted = this._mapFilesToSources(testDirs, change.deleted);

    if (created.length || deleted.length)
      await this.listFiles();
    if (changed.length)
      await this.listTests(changed);
  }

  async listTests(files: string[]): Promise<reporterTypes.TestError[]> {
    const { rootSuite, errors } = await this._playwrightTest.listTests(this.config, files);
    this._updateProjects(rootSuite.suites, files);
    return errors;
  }

  private _updateProjects(newProjectSuites: reporterTypes.Suite[], requestedFiles: string[]) {
    for (const [projectName, project] of this._projects) {
      const files = projectFiles(project);
      const newProjectSuite = newProjectSuites.find(e => e.project()!.name === projectName);
      const filesToClear = new Set(requestedFiles);
      for (const fileSuite of newProjectSuite?.suites || []) {
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
    this._didUpdate.fire();
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
      const existingFileSuite = files.get(fileSuite.location!.file);
      if (!existingFileSuite || !existingFileSuite.allTests().length)
        files.set(fileSuite.location!.file, fileSuite);
    }
    project.suite.suites = [...files.values()];
    this._didUpdate.fire();
  }

  async runTests(projects: TestProject[], locations: string[] | null, reporter: reporterTypes.ReporterV2, parametrizedTestTitle: string | undefined, token: vscodeTypes.CancellationToken) {
    locations = locations || [];
    await this._playwrightTest.runTests(this.config, projects.map(p => p.name), locations, reporter, parametrizedTestTitle, token);
  }

  async debugTests(projects: TestProject[], locations: string[] | null, reporter: reporterTypes.ReporterV2, parametrizedTestTitle: string | undefined, token: vscodeTypes.CancellationToken) {
    locations = locations || [];
    const testDirs = projects.map(p => p.project.testDir);
    await this._playwrightTest.debugTests(this._vscode, this.config, projects.map(p => p.name), testDirs, this._envProvider(), locations, reporter, parametrizedTestTitle, token);
  }

  private _mapFilesToSources(testDirs: string[], files: Set<string>): string[] {
    const result = new Set<string>();
    for (const file of files) {
      if (!testDirs.some(t => file.startsWith(t + '/')))
        continue;
      const sources = this._fileToSources.get(file);
      if (sources)
        sources.forEach(f => result.add(f));
      else
        result.add(file);
    }
    return [...result];
  }

  narrowDownFilesToEnabledProjects(fileNames: Set<string>) {
    const result = new Set<string>();
    for (const project of this.enabledProjects()) {
      const files = projectFiles(project);
      for (const fileName of fileNames) {
        if (files.has(fileName))
          result.add(fileName);
      }
    }
    return result;
  }
}

export function projectFiles(project: TestProject): Map<string, reporterTypes.Suite> {
  const files = new Map<string, reporterTypes.Suite>();
  for (const fileSuite of project.suite.suites)
    files.set(fileSuite.location!.file, fileSuite);
  return files;
}

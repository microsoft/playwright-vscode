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

import { Entry } from './oopReporter';
import { PlaywrightTest, TestConfig, TestListener } from './playwrightTest';
import { WorkspaceChange } from './workspaceObserver';
import * as vscodeTypes from './vscodeTypes';
import { resolveSourceMap } from './utils';
import { ProjectConfigWithFiles } from './listTests';

/**
 * This class builds the Playwright Test model in Playwright terms.
 * - TestModel maps to the Playwright config
 * - TestProject maps to the Playwright project
 * - TestFiles belong to projects and contain test entries.
 *
 * A single test in the source code, and a single test in VS Code UI can correspond to multiple entries
 * in different configs / projects. TestTree will perform model -> UI mapping and will represent
 * them as a single entity.
 */
export class TestFile {
  readonly project: TestProject;
  readonly file: string;
  private _entries: Entry[] | undefined;
  private _revision = 0;

  constructor(project: TestProject, file: string) {
    this.project = project;
    this.file = file;
  }

  entries(): Entry[] | undefined {
    return this._entries;
  }

  setEntries(entries: Entry[]) {
    ++this._revision;
    this._entries = entries;
  }

  revision(): number {
    return this._revision;
  }
}

export type TestProject = {
  name: string;
  testDir: string;
  model: TestModel;
  isFirst: boolean;
  files: Map<string, TestFile>;
};

export class TestModel {
  private _vscode: vscodeTypes.VSCode;
  readonly config: TestConfig;
  readonly projects = new Map<string, TestProject>();
  private _didUpdate: vscodeTypes.EventEmitter<void>;
  readonly onUpdated: vscodeTypes.Event<void>;
  readonly allFiles = new Set<string>();
  private _playwrightTest: PlaywrightTest;
  private _fileToSources: Map<string, string[]> = new Map();
  private _sourceToFile: Map<string, string> = new Map();
  private _envProvider: () => NodeJS.ProcessEnv;

  constructor(vscode: vscodeTypes.VSCode, playwrightTest: PlaywrightTest, workspaceFolder: string, configFile: string, playwrightInfo: { command: string, version: number }, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._playwrightTest = playwrightTest;
    this.config = { ...playwrightInfo, workspaceFolder, configFile };
    this._didUpdate = new vscode.EventEmitter();
    this._envProvider = envProvider;
    this.onUpdated = this._didUpdate.event;
  }

  async listFiles() {
    const report = await this._playwrightTest.listFiles(this.config);
    if (!report)
      return;

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
      let project = this.projects.get(projectReport.name);
      if (!project)
        project = this._createProject(projectReport, projectReport === report.projects[0]);
      this._updateProject(project, projectReport);
    }

    for (const projectName of this.projects.keys()) {
      if (!projectsToKeep.has(projectName))
        this.projects.delete(projectName);
    }

    this._recalculateAllFiles();
    this._didUpdate.fire();
  }

  private _createProject(projectReport: ProjectConfigWithFiles, isFirst: boolean): TestProject {
    const project: TestProject = {
      model: this,
      ...projectReport,
      isFirst,
      files: new Map(),
    };
    this.projects.set(project.name, project);
    return project;
  }

  private _updateProject(project: TestProject, projectReport: ProjectConfigWithFiles) {
    const filesToKeep = new Set<string>();
    for (const file of projectReport.files) {
      filesToKeep.add(file);
      const testFile = project.files.get(file);
      if (!testFile)
        this._createFile(project, file);
    }

    for (const file of project.files.keys()) {
      if (!filesToKeep.has(file))
        project.files.delete(file);
    }
  }

  private _createFile(project: TestProject, file: string): TestFile {
    const testFile = new TestFile(project, file);
    project.files.set(file, testFile);
    return testFile;
  }

  async workspaceChanged(change: WorkspaceChange) {
    let modelChanged = false;
    // Translate source maps from files to sources.
    change.changed = this._mapFilesToSources(change.changed);
    change.created = this._mapFilesToSources(change.created);
    change.deleted = this._mapFilesToSources(change.deleted);

    if (change.deleted.size) {
      for (const project of this.projects.values()) {
        for (const file of change.deleted) {
          if (project.files.has(file)) {
            project.files.delete(file);
            modelChanged = true;
          }
        }
      }
    }

    if (change.created.size) {
      let hasMatchingFiles = false;
      for (const project of this.projects.values()) {
        for (const file of change.created) {
          if (file.startsWith(project.testDir))
            hasMatchingFiles = true;
        }
      }
      if (hasMatchingFiles)
        await this.listFiles();
    }

    if (change.created.size || change.deleted.size)
      this._recalculateAllFiles();

    if (change.changed.size) {
      const filesToLoad = new Set<string>();
      for (const project of this.projects.values()) {
        for (const file of change.changed) {
          const testFile = project.files.get(file);
          if (!testFile || !testFile.entries())
            continue;
          filesToLoad.add(file);
        }
      }
      if (filesToLoad.size)
        await this.listTests([...filesToLoad]);
    }
    if (modelChanged)
      this._didUpdate.fire();
  }

  async listTests(files: string[]) {
    const sourcesToLoad = files.filter(f => this.allFiles.has(f));
    if (!sourcesToLoad.length)
      return;

    const projectEntries = await this._playwrightTest.listTests(this.config, this._mapSourcesToFiles(sourcesToLoad), this._envProvider());
    this._updateProjects(projectEntries, sourcesToLoad);
  }

  private _updateProjects(projectEntries: Entry[], requestedFiles: string[]) {
    for (const projectEntry of projectEntries) {
      const project = this.projects.get(projectEntry.title);
      if (!project)
        continue;
      const filesToDelete = new Set(requestedFiles);
      for (const fileEntry of projectEntry.children || []) {
        filesToDelete.delete(fileEntry.location.file);
        const file = project.files.get(fileEntry.location.file);
        if (!file)
          continue;
        file.setEntries(fileEntry.children || []);
      }
      // We requested update for those, but got no entries.
      for (const file of filesToDelete) {
        const testFile = project.files.get(file);
        if (testFile)
          testFile.setEntries([]);
      }
    }
    this._didUpdate.fire();
  }

  updateFromRunningProjects(projectEntries: Entry[]) {
    for (const projectEntry of projectEntries) {
      const project = this.projects.get(projectEntry.title);
      if (project)
        this._updateFromRunningProject(project, projectEntry);
    }
  }

  private _updateFromRunningProject(project: TestProject, projectEntry: Entry) {
    // When running tests, don't remove existing entries.
    for (const fileEntry of projectEntry.children || []) {
      if (!fileEntry.children)
        continue;
      let file = project.files.get(fileEntry.location.file);
      if (!file)
        file = this._createFile(project, fileEntry.location.file);
      if (!file.entries())
        file.setEntries(fileEntry.children);
    }
    this._didUpdate.fire();
  }

  private _recalculateAllFiles() {
    this.allFiles.clear();
    for (const project of this.projects.values()) {
      for (const file of project.files.values())
        this.allFiles.add(file.file);
    }
  }

  async runTests(projects: TestProject[], locations: string[] | null, testListener: TestListener, parametrizedTestTitle: string | undefined, token?: vscodeTypes.CancellationToken) {
    locations = locations ? this._mapSourcesToFiles(locations) : [];
    await this._playwrightTest.runTests(this.config, projects.map(p => p.name), this._envProvider(), locations, testListener, parametrizedTestTitle, token);
  }

  async debugTests(projects: TestProject[], locations: string[] | null, testListener: TestListener, parametrizedTestTitle: string | undefined, token?: vscodeTypes.CancellationToken) {
    locations = locations ? this._mapSourcesToFiles(locations) : [];
    await this._playwrightTest.debugTests(this._vscode, this.config, projects.map(p => p.name), projects.map(p => p.testDir), this._envProvider(), locations, testListener, parametrizedTestTitle, token);
  }

  private _mapSourcesToFiles(sources: string[]): string[] {
    const result: string[] = [];

    // When we see
    //   src/foo.ts in the source,
    // we want to pass
    //   out/bundle.js:0 src/foo.ts
    // This way we'll parse bundle.js and filter source-mapped tests by src/foo.ts

    // When we see
    //   src/foo.ts:14 in the source,
    // we want to pass
    //   out/bundle.js:0 src/foo.ts:14
    // Same idea here, we'll parse bundle and filter by source-mapped location.
    // It looks wrong, but it actually achieves the right result.

    for (const source of sources) {
      const match = source.match(/^(.*)([:]\d+)$/);
      const sourceFile = match ? match[1] : source;
      const bundleFile = this._sourceToFile.get(sourceFile);
      if (bundleFile)
        result.push(bundleFile + ':0');
      result.push(source);
    }
    return result;
  }

  private _mapFilesToSources(files: Set<string>): Set<string> {
    const result = new Set<string>();
    for (const file of files) {
      const sources = this._fileToSources.get(file);
      if (sources)
        sources.forEach(f => result.add(f));
      else
        result.add(file);
    }
    return result;
  }
}

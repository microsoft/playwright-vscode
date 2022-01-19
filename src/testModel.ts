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

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import vscode from 'vscode';
import { Entry, FileReport } from './oopListReporter';
import { findInPath } from './pathUtils';
import { PipeTransport } from './transport';

export type ListTestsReport = {
  projects: {
    name: string;
    files: string[];
  }[];
};

export type Config = {
  workspaceFolder: string;
  configFile: string;
};

type FileData = {
  entries: Entry[] | null;
  configs: Config[];
};

export class TestModel {
  private _files = new Map<string, FileData>();
  private _isDogFood = false;
  private _testController: vscode.TestController;
  private _editorsItem: vscode.TestItem | undefined;
  private _runProfiles: vscode.TestRunProfile[] = [];

  constructor() {
    this._testController = vscode.tests.createTestController('pw.extension.testController', 'Playwright');
  }

  initialize(): vscode.Disposable[] {
    this._rebuildModel().catch(() => {});
    return [
      vscode.workspace.onDidChangeConfiguration((_) => {
        this._rebuildModel().catch(() => {});
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this._updateActiveEditorItems();
      }),
      vscode.workspace.onDidSaveTextDocument(textEditor => {
        this._discardEntries(textEditor.uri.fsPath);
        this._updateActiveEditorItems();
      }),  
    ];
  }

  private async _rebuildModel() {
    let isDogFood = false;
    try {
      const packages = await vscode.workspace.findFiles('package.json');
      if (packages.length === 1) {
        const content = await fs.promises.readFile(packages[0].fsPath, 'utf-8');
        if (JSON.parse(content).name === 'playwright-internal')
          isDogFood = true;
      }
    } catch {
    }

    this._files.clear();
    this._isDogFood = isDogFood;

    const files = await vscode.workspace.findFiles('**/*playwright*.config.[tj]s', 'node_modules/**');

    for (const profile of this._runProfiles)
      profile.dispose();
    for (const file of files)
      await this._createRunProfiles(vscode.workspace.getWorkspaceFolder(file)!.uri.fsPath, file);

    this._editorsItem = this._testController.createTestItem('active-editor', `\u3164Active editor`);
    this._updateActiveEditorItems();
    this._testController.items.replace([this._editorsItem]);
  }

  private async _createRunProfiles(workspaceFolder: string, configUri: vscode.Uri) {
    const config: Config = {
      workspaceFolder,
      configFile: configUri.fsPath,
    };
    const configName = path.basename(configUri.fsPath);
    const folderName = path.basename(path.dirname(configUri.fsPath));

    const report = await this._playwrightListTests(config);
    for (const project of report.projects) {
      const projectSuffix = project.name ? ` [${project.name}]` : '';
      this._runProfiles.push(this._testController.createRunProfile(`${folderName}${path.sep}${configName}${projectSuffix}`, vscode.TestRunProfileKind.Run, async (request, token) => {
        for (const testItem of request.include || []) {
          const testInfo = (testItem as any)[testInfoSymbol] as { fsPath: string, entry: Entry };
          await this._runTest(config, project.name, { file: testInfo.fsPath, line: testInfo.entry.line });
        }
      }, true));
      this._runProfiles.push(this._testController.createRunProfile(`${folderName}${path.sep}${configName}${projectSuffix}`, vscode.TestRunProfileKind.Debug, async (request, token) => {
        for (const testItem of request.include || []) {
          const testInfo = (testItem as any)[testInfoSymbol] as { fsPath: string, entry: Entry };
          await this._debugTest(config, project.name, { file: testInfo.fsPath, line: testInfo.entry.line });
        }
      }, true));
      for (const file of project.files) {
        const fileData = this._ensureFileData(file);
        if (!fileData.configs.includes(config))
          fileData.configs.push(config);
      }
    }
  }

  private async _loadEntries(file: string): Promise<Entry[]> {
    const fileInfo = this._files.get(file);
    if (!fileInfo)
      return [];
    if (fileInfo.entries)
      return fileInfo.entries;
    const entries: { [key: string]: Entry } = {};
    for (const config of fileInfo.configs) {
      const files: FileReport[] = await this._playwrightTest(config, [file, '--list', '--reporter', path.join(__dirname, 'oopListReporter.js')]);
      if (!files)
        continue;
      for (const file of files || []) {
        for (const [id, entry] of Object.entries(file.entries))
          entries[id] = entry;
      }
    }
    fileInfo.entries = Object.values(entries);
    return fileInfo.entries;
  }

  private _discardEntries(file: string) {
    if (this._files.has(file))
      this._files.get(file)!.entries = null;
  }

  private async _debugTest(config: Config, projectName: string, location: { file: string; line: number; }) {
    const filter = location.file + ':' + location.line;
    const args = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'test', '-c', config.configFile, filter, '--project', projectName, '--headed', '--timeout', '0'];
    vscode.debug.startDebugging(undefined, {
      type: 'pwa-node',
      name: 'Playwright Test',
      request: 'launch',
      cwd: config.workspaceFolder,
      env: { ...process.env, PW_OUT_OF_PROCESS: '1' },
      args,
      resolveSourceMapLocations: [],
      outFiles: [],
    });
  }

  private async _runTest(config: Config, projectName: string, location: { file: string; line: number; }) {
    const filter = location.file + ':' + location.line;
    const args = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'test', '-c', config.configFile, filter, '--project', projectName];
    await this._playwrightTest(config, [filter, '--project', projectName]);
  }

  private async _playwrightTest(config: Config, args: string[]): Promise<any> {
    const node = this._findNode();
    const allArgs = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'test', '-c', config.configFile, ...args];
    const childProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: 'pipe',
      env: { ...process.env }
    });
  
    const stdio = childProcess.stdio;
    const transport = new PipeTransport(stdio[0]!, stdio[1]!);
    let result: any;
    transport.onmessage = message => {
      result = message.params;
    };
    return new Promise(f => {
      transport.onclose = () => {
        f(result);
      };
    });
  }

  private async _playwrightListTests(config: Config): Promise<ListTestsReport> {
    const node = this._findNode();
    const allArgs = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'list-tests', '-c', config.configFile];
    const childProcess = spawnSync(node, allArgs, {
      cwd: config.workspaceFolder,
      env: { ...process.env }
    });
    const output = childProcess.stdout.toString();
    if (!output)
      return { projects: [] };
    try {
      const report = JSON.parse(output);
      return report as ListTestsReport;
    } catch (e) {
      console.error(e);
    }
    return { projects: [] };
  }

  private _nodeModules(config: Config) {
    if (!this._isDogFood)
      return 'node_modules';

    if (config.configFile.includes('playwright-test'))
      return 'tests/playwright-test/stable-test-runner/node_modules';
    return 'packages';
  }

  private _findNode(): string {
    const node = findInPath('node', process.env);
    if (!node)
      throw new Error('Unable to launch `node`, make sure it is in your PATH');
    return node;
  }

  private async _updateActiveEditorItems() {
    if (!this._editorsItem)
      return;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._editorsItem.children.replace([]);
      return;
    }

    const uri = editor.document.uri;
    const fsPath = uri.fsPath;
    const editorItem = this._testController.createTestItem(fsPath, path.basename(fsPath), uri);
    editorItem.children.add(this._testController.createTestItem('loading', 'Loading\u2026'));
    this._editorsItem.children.replace([editorItem]);

    const entries = await this._loadEntries(fsPath);
    const testItems: vscode.TestItem[] = [];
    for (const entry of entries) {
      const title = entry.titlePath.join(' › ');
      const testItem = this._testController.createTestItem(`${fsPath}|${title}`, `${title}`, uri);
      testItem.range = new vscode.Range(entry.line - 1, entry.column - 1, entry.line, 0);
      testItems.push(testItem);
      (testItem as any)[testInfoSymbol] = { fsPath, entry };
    }
    editorItem.children.replace(testItems);
  }

  private _ensureFileData(file: string): FileData {
    let fileData = this._files.get(file);
    if (!fileData) {
      fileData = { entries: null, configs: [] };
      this._files.set(file, fileData);
    }
    return fileData;
  }
}

const testInfoSymbol = Symbol('testInfoSymbol');

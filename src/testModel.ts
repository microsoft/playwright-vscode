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
import { Entry } from './oopReporter';
import { findInPath } from './pathUtils';
import { PipeTransport, ProtocolResponse } from './transport';

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

type Reporter = {
  onmessage(message: ProtocolResponse): void;
};

type FileData = {
  entries: Entry[] | null;
  configs: Config[];
};

export class TestModel {
  private _files = new Map<string, FileData>();
  private _testItems = new Map<string, vscode.TestItem>();
  private _isDogFood = false;
  private _testController: vscode.TestController;
  private _runProfiles: vscode.TestRunProfile[] = [];

  constructor() {
    this._testController = vscode.tests.createTestController('pw.extension.testController', 'Playwright');
    this._testController.resolveHandler = item => this._resolveChildren(item);
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

    this._testItems.clear();
    this._files.clear();
    this._isDogFood = isDogFood;
    this._testController.items.replace([]);

    const configFiles = await vscode.workspace.findFiles('**/*playwright*.config.[tj]s', 'node_modules/**');

    for (const profile of this._runProfiles)
      profile.dispose();

    for (const configFileUri of configFiles) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(configFileUri)!.uri.fsPath;
      const config: Config = {
        workspaceFolder,
        configFile: configFileUri.fsPath,
      };
      const report = await this._playwrightListTests(config);
      await this._createRunProfiles(config, report);
      await this._createTestItemsForFiles(config.workspaceFolder, report);
    }

    await this._updateActiveEditorItems();
  }

  private async _createRunProfiles(config: Config, report: ListTestsReport) {
    const configName = path.basename(config.configFile);
    const folderName = path.basename(path.dirname(config.configFile));

    for (const project of report.projects) {
      const projectSuffix = project.name ? ` [${project.name}]` : '';
      this._runProfiles.push(this._testController.createRunProfile(`${folderName}${path.sep}${configName}${projectSuffix}`, vscode.TestRunProfileKind.Run, async (request, token) => {
        for (const testItem of request.include || []) {
          await this._runTest(request, config, project.name, testItem.id);
        }
      }, true));
      this._runProfiles.push(this._testController.createRunProfile(`${folderName}${path.sep}${configName}${projectSuffix}`, vscode.TestRunProfileKind.Debug, async (request, token) => {
        for (const testItem of request.include || []) {
          await this._debugTest(config, project.name, testItem.id);
        }
      }, true));
      for (const file of project.files) {
        const fileData = this._ensureFileData(file);
        if (!fileData.configs.includes(config))
          fileData.configs.push(config);
      }
    }
  }

  private async _createTestItemsForFiles(workspaceFolder: string, report: ListTestsReport) {
    for (const project of report.projects) {
      for (const file of project.files) {
        const item = this._getOrCreateTestItemForFileOrFolder(workspaceFolder, file);
        if (item)
          item.canResolveChildren = true;
      }
    }
  }

  private async _resolveChildren(item: vscode.TestItem | undefined): Promise<void> {
    if (item)
      await this._loadTestItemsForFile(item.id);
  }

  private _getOrCreateTestItemForFileOrFolder(workspaceFolder: string, fsPath: string): vscode.TestItem | null {
    const result = this._testItems.get(fsPath);
    if (result)
      return result;
    const relative = path.relative(workspaceFolder, fsPath);
    if (relative.startsWith('..'))
      return null;
    const parentFile = path.dirname(fsPath);
    const testItem = this._testController.createTestItem(fsPath, path.basename(fsPath), vscode.Uri.file(fsPath));
    this._testItems.set(testItem.id, testItem);
    if (parentFile === workspaceFolder) {
      this._testController.items.add(testItem);
    } else {
      const parent = this._getOrCreateTestItemForFileOrFolder(workspaceFolder, path.dirname(fsPath))!;
      parent.children.add(testItem);  
    }
    return testItem;
  }

  private async _loadTestItemsForFile(fsPath: string): Promise<void> {
    const fileInfo = this._files.get(fsPath);
    if (!fileInfo)
      return;
    if (fileInfo.entries)
      return;

    for (const config of fileInfo.configs) {
      const parent = this._getOrCreateTestItemForFileOrFolder(config.workspaceFolder, fsPath);
      if (!parent)
        continue;
      await this._playwrightTest(config, [fsPath, '--list', '--reporter', path.join(__dirname, 'oopReporter.js')], message => {
        if (message.method !== 'onBegin')
          return;
        const entries = message.params.entries as Entry[];
        for (const entry of entries) {
          let testItem = this._testItems.get(entry.id);
          if (!testItem) {
            testItem = this._createTestItemForEntry(entry);
            parent.children.add(testItem);
          }
        }
      });
    }
  }

  private _createTestItemForEntry(entry: Entry): vscode.TestItem {
    const title = entry.titlePath.join(' › ');
    const testItem = this._testController.createTestItem(entry.id, title, vscode.Uri.file(entry.file));
    testItem.range = new vscode.Range(entry.line - 1, entry.column - 1, entry.line, 0);
    this._testItems.set(testItem.id, testItem);
    return testItem;
  }

  private _discardEntries(file: string) {
    if (this._files.has(file))
      this._files.get(file)!.entries = null;
  }

  private async _runTest(request: vscode.TestRunRequest, config: Config, projectName: string, location: string) {
    const testRun = this._testController.createTestRun(request);
    await this._playwrightTest(config, [location, '--project', projectName, '--reporter', path.join(__dirname, 'oopReporter.js')], message => {
      if (message.method === 'onBegin') {
        const entries = message.params.entries as Entry[];
        for (const entry of entries) {
          let testItem = this._testItems.get(entry.id);
          if (!testItem) {
            const parent = this._getOrCreateTestItemForFileOrFolder(config.workspaceFolder, entry.file);
            if (parent) {
              testItem = this._createTestItemForEntry(entry);
              parent.children.add(testItem);
            }
          }
          if (testItem)
            testRun.enqueued(testItem);
        }
        return;
      }
      const testItem = this._testItems.get(message.params.testId);
      if (!testItem)
        return;
      if (message.method === 'onTestBegin') {
        testRun.started(testItem);
        return;
      }
      if (message.method === 'onTestEnd') {
        if (message.params.ok) {
          testRun.passed(testItem, message.params.duration);
          return;
        }
        testRun.failed(testItem, new vscode.TestMessage(message.params.error), message.params.duration);
      }
    });
    testRun.end();
  }

  private async _debugTest(config: Config, projectName: string, location: string) {
    const args = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'test', '-c', config.configFile, location, '--project', projectName, '--headed', '--timeout', '0'];
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

  private async _playwrightTest(config: Config, args: string[], onMessage: (message: ProtocolResponse) => void): Promise<void> {
    const node = this._findNode();
    const allArgs = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'test', '-c', config.configFile, ...args];
    const childProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: 'pipe',
      env: { ...process.env }
    });
  
    const stdio = childProcess.stdio;
    const transport = new PipeTransport(stdio[0]!, stdio[1]!);
    transport.onmessage = onMessage;
    return new Promise(f => {
      transport.onclose = () => {
        f();
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
    const editor = vscode.window.activeTextEditor;
    if (!editor)
      return;
    const fsPath = editor.document.uri.fsPath;
    this._loadTestItemsForFile(fsPath);
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

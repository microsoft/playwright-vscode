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
import StackUtils from 'stack-utils';
import { TestError } from './reporter';

const stackUtils = new StackUtils();

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

export class TestModel {
  // Each file can be included in several config files.
  private _configsForFile = new Map<string, Config[]>();

  // Entries that were loaded for given file using list reporter.
  private _entriesInFile = new Map<string, vscode.TestItem[]>();

  // Global test item map testItem.id => testItem.
  private _testItems = new Map<string, vscode.TestItem>();

  // Each run profile is a config + project pair.
  private _runProfiles: vscode.TestRunProfile[] = [];

  // We write into terminal using this event sink.
  private _terminalSink!: vscode.EventEmitter<string>;

  // Top level test items for workspace folders.
  private _workspaceTestItems: vscode.TestItem[] = [];

  // Config files loaded after last rebuild.
  private _configFiles: vscode.Uri[] = [];

  private _testController: vscode.TestController;
  private _isDogFood = false;
  private _pathToNodeJS: string | undefined;

  constructor() {
    this._testController = vscode.tests.createTestController('pw.extension.testController', 'Playwright');
    this._testController.resolveHandler = item => this._resolveChildren(item);
  }

  initialize(): vscode.Disposable[] {
    this._terminalSink = new vscode.EventEmitter<string>();
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this._terminalSink.event,
      open: () => {},
      close: () => {},
    };
    const terminal = vscode.window.createTerminal({ name: 'Playwright Test', pty });
    this._rebuildModel().catch(() => {});

    return [
      vscode.workspace.onDidChangeConfiguration((_) => {
        this._rebuildModel().catch(() => {});
      }),
      vscode.workspace.onDidChangeWorkspaceFolders((_) => {
        this._rebuildModel().catch(() => {});
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this._updateActiveEditorItems();
      }),
      vscode.workspace.onDidSaveTextDocument(textEditor => {
        this._discardEntries(textEditor.uri.fsPath);
        this._updateActiveEditorItems();
      }),
      vscode.workspace.onDidDeleteFiles(event => {
        for (const uri of event.files)
          this._onDidDeleteFile(uri.fsPath);
      }),
      vscode.workspace.onDidRenameFiles(event => {
        for (const file of event.files) {
          this._onDidDeleteFile(file.oldUri.fsPath);
          this._createMissingFiles(file.newUri.fsPath).catch(() => {});
        }
      }),
      vscode.workspace.onDidCreateFiles(event => {
        for (const uri of event.files)
          this._createMissingFiles(uri.fsPath).catch(() => {});
      }),
      terminal,
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
    this._configsForFile.clear();
    this._entriesInFile.clear();
    this._isDogFood = isDogFood;
    this._testController.items.replace([]);

    this._configFiles = await vscode.workspace.findFiles('**/*playwright*.config.[tj]s', 'node_modules/**');

    this._workspaceTestItems = (vscode.workspace.workspaceFolders || []).map(wf => {
      const testItem = this._testController.createTestItem(wf.uri.fsPath, wf.name);
      this._testItems.set(testItem.id, testItem);
      return testItem;
    });
    for (const profile of this._runProfiles)
      profile.dispose();

    for (const configFileUri of this._configFiles) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(configFileUri)!.uri.fsPath;
      const config: Config = {
        workspaceFolder,
        configFile: configFileUri.fsPath,
      };
      const report = await this._playwrightListTests(config);
      await this._createRunProfiles(config, report);
      await this._createTestItemsForFiles(report);
    }

    this._testController.items.replace(this._workspaceTestItems);
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
      this._mapFilesToConfigs(config, project.files);
    }
  }

  private async _createMissingFiles(fileOrFolder: string) {
    for (const configFileUri of this._configFiles) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(configFileUri)!.uri.fsPath;
      const config: Config = {
        workspaceFolder,
        configFile: configFileUri.fsPath,
      };
      const report = await this._playwrightListTests(config, fileOrFolder);
      await this._createTestItemsForFiles(report);
      for (const project of report.projects)
        this._mapFilesToConfigs(config, project.files);
    }
  }

  private async _mapFilesToConfigs(config: Config, files: string[]) {
    for (const file of files) {
      let configs = this._configsForFile.get(file);
      if (!configs) {
        configs = [];
        this._configsForFile.set(file, configs);
      }
      configs.push(config);
    }
  }

  private async _createTestItemsForFiles(report: ListTestsReport) {
    for (const project of report.projects) {
      for (const file of project.files) {
        const item = this._getOrCreateTestItemForFileOrFolder(file);
        if (item)
          item.canResolveChildren = true;
      }
    }
  }

  private async _resolveChildren(item: vscode.TestItem | undefined): Promise<void> {
    if (item)
      await this._ensureTestItemsInFile(item.id);
  }

  private _getOrCreateTestItemForFileOrFolder(fsPath: string): vscode.TestItem | null {
    const result = this._testItems.get(fsPath);
    if (result)
      return result;
    for (const workspaceFolder of vscode.workspace.workspaceFolders || []) {
      const workspacePath = workspaceFolder.uri.fsPath;
      const relative = path.relative(workspaceFolder.uri.fsPath, fsPath);
      if (relative.startsWith('..'))
        continue;
      return this._getOrCreateTestItemForFileOrFolderInWorkspace(workspacePath, fsPath); 
    }
    return null;
  }

  private _getOrCreateTestItemForFileOrFolderInWorkspace(workspacePath: string, fsPath: string): vscode.TestItem {
    const result = this._testItems.get(fsPath);
    if (result)
      return result;
    const parentFile = path.dirname(fsPath);
    const testItem = this._testController.createTestItem(fsPath, path.basename(fsPath), vscode.Uri.file(fsPath));
    this._testItems.set(testItem.id, testItem);
    const parent = this._getOrCreateTestItemForFileOrFolderInWorkspace(workspacePath, parentFile);
    parent.children.add(testItem);  
    return testItem;
  }

  private async _ensureTestItemsInFile(file: string): Promise<void> {
    const entries = this._entriesInFile.get(file);
    // Information is up-to-date - bail out.
    if (entries)
      return;

    // Test outside workspace - bail out.
    const parent = this._getOrCreateTestItemForFileOrFolder(file);
    if (!parent)
      return;

    // Delete old test from map, we'll swap children array below.
    parent.children.forEach(child => this._testItems.delete(child.id));

    // Collect test items from all configs that include this file.
    const testItems: vscode.TestItem[] = [];
    for (const config of this._configsForFile.get(file) || []) {
      await this._playwrightTest(null, config, [file, '--list', '--reporter', path.join(__dirname, 'oopReporter.js')], (transport, message) => {
        if (message.method !== 'onBegin')
          return;
        const entries = message.params.entries as Entry[];
        for (const entry of entries) {
          let testItem = this._testItems.get(entry.id);
          if (!testItem) {
            testItem = this._createTestItemForEntry(entry);
            testItems.push(testItem);
          }
        }
        transport.close();
      });
    }
    parent.children.replace(testItems);
    this._entriesInFile.set(file, testItems);
  }

  private _createTestItemForEntry(entry: Entry): vscode.TestItem {
    const title = entry.titlePath.join(' › ');
    const testItem = this._testController.createTestItem(entry.id, title, vscode.Uri.file(entry.file));
    testItem.range = new vscode.Range(entry.line - 1, entry.column - 1, entry.line, 0);
    this._testItems.set(testItem.id, testItem);
    return testItem;
  }

  private _discardEntries(file: string) {
    this._entriesInFile.delete(file);
  }

  private _onDidDeleteFile(file: string) {
    const testItem = this._testItems.get(file);
    if (!testItem)
      return;
    // Discard cached entries.
    this._discardEntries(file);

    // Erase from map.
    testItem.children.forEach(c => this._testItems.delete(c.id));
    this._testItems.delete(file);

    // Detach.
    testItem.parent!.children.delete(testItem.id);
  }

  private async _runTest(request: vscode.TestRunRequest, config: Config, projectName: string, location: string) {
    const testRun = this._testController.createTestRun(request);
    this._terminalSink.fire('\x1b[H\x1b[2J');
    await this._playwrightTest(this._terminalSink, config, [location, '--project', projectName, '--reporter', path.join(__dirname, 'oopReporter.js') + ',line'], (transport, message) => {
      if (message.method === 'onEnd') {
        transport.close();
        return;
      }
      if (message.method === 'onBegin') {
        const entries = message.params.entries as Entry[];
        for (const entry of entries) {
          let testItem = this._testItems.get(entry.id);
          if (!testItem) {
            const parent = this._getOrCreateTestItemForFileOrFolder(entry.file);
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
        testRun.failed(testItem, testMessageForError(testItem, message.params.error), message.params.duration);
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

  private async _playwrightTest(terminal: vscode.EventEmitter<string> | null, config: Config, args: string[], onMessage: (transport: PipeTransport, message: ProtocolResponse) => void): Promise<PipeTransport> {
    const node = this._findNode();
    const allArgs = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'test', '-c', config.configFile, ...args];
    const childProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });
  
    const stdio = childProcess.stdio;
    stdio[1].on('data', data => {
      if (terminal)
        terminal.fire(data.toString().replace(/\n/g, '\r\n'));
    });
    stdio[2].on('data', data => {
      if (terminal)
        terminal.fire(data.toString().replace(/\n/g, '\r\n'));
    });
    const transport = new PipeTransport((stdio as any)[3]!, (stdio as any)[4]!);
    transport.onmessage = message => onMessage(transport, message);
    return new Promise(f => {
      transport.onclose = () => {
        f(transport);
      };
    });
  }

  private async _playwrightListTests(config: Config, folder?: string): Promise<ListTestsReport> {
    const node = this._findNode();
    const allArgs = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'list-tests', '-c', config.configFile];
    if (folder)
      allArgs.push(folder);
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
    if (this._pathToNodeJS)
      return this._pathToNodeJS;
    const node = findInPath('node', process.env);
    if (!node)
      throw new Error('Unable to launch `node`, make sure it is in your PATH');
    this._pathToNodeJS = node;
    return node;
  }

  private async _updateActiveEditorItems() {
    const editor = vscode.window.activeTextEditor;
    if (!editor)
      return;
    const fsPath = editor.document.uri.fsPath;
    this._ensureTestItemsInFile(fsPath);
  }
}

function testMessageForError(item: vscode.TestItem, error: TestError): vscode.TestMessage {
  const lines = error.stack ? error.stack.split('\n').reverse() : [];
  for (const line of lines) {
    const frame = stackUtils.parseLine(line);
    if (!frame || !frame.file || !frame.line || !frame.column)
      continue;
    if (frame.file === item.uri!.path) {
      const message = new vscode.TestMessage(error.stack!);
      const position = new vscode.Position(frame.line - 1, frame.column - 1);
      message.location = new vscode.Location(item.uri!, position);
      return message;
    }
  }
  return new vscode.TestMessage(error.message! || error.value!);
}

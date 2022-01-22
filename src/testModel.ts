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
import StackUtils from 'stack-utils';
import vscode from 'vscode';
import { Entry } from './oopReporter';
import { TestError } from './reporter';
import { Config, TestTree } from './testTree';
import { PipeTransport, ProtocolResponse } from './transport';
import { findInPath } from './utils';
import { WorkspaceObserver } from './workspaceObserver';

const stackUtils = new StackUtils();

export type ListTestsReport = {
  testDir?: string;
  projects: {
    name: string;
    files: string[];
  }[];
};

export class TestModel {
  // Global test item map.
  private _testTree: TestTree;

  // Each run profile is a config + project pair.
  private _runProfiles: vscode.TestRunProfile[] = [];

  // We write into terminal using this event sink.
  private _terminalSink!: vscode.EventEmitter<string>;

  // Top level test items for workspace folders.
  private _workspaceTestItems: vscode.TestItem[] = [];

  // Config files loaded after last rebuild.
  private _configFiles: vscode.Uri[] = [];

  private _testController!: vscode.TestController;
  private _workspaceObserver: WorkspaceObserver;
  private _isDogFood = false;
  private _pathToNodeJS: string | undefined;
  private _disposables: vscode.Disposable[];

  constructor() {
    this._testController = vscode.tests.createTestController('pw.extension.testController', 'Playwright');
    this._testController.resolveHandler = item => this._resolveChildren(item);
    this._testTree = new TestTree(this._testController);

    this._terminalSink = new vscode.EventEmitter<string>();
    const pty: vscode.Pseudoterminal = {
      onDidWrite: this._terminalSink.event,
      open: () => {},
      close: () => {},
    };
    const terminal = vscode.window.createTerminal({ name: 'Playwright Test', pty });
    this._rebuildModel().catch(() => {});

    this._workspaceObserver = new WorkspaceObserver(change => {
      for (const deleted of new Set(change.deleted))
        this._onDidDeleteFile(deleted.uri.fsPath);

      const filesByConfig = new Map<Config, Set<string>>();
      for (const entry of [...change.changed, ...change.created]) {
        let files = filesByConfig.get(entry.watcher);
        if (!files) {
          files = new Set();
          filesByConfig.set(entry.watcher, files);
        }
        files.add(entry.uri.fsPath);
      }
      this._onDidChangeFiles(filesByConfig);
    });

    this._disposables = [
      vscode.workspace.onDidChangeConfiguration((_) => {
        this._rebuildModel().catch(() => {});
      }),
      vscode.workspace.onDidChangeWorkspaceFolders((_) => {
        this._rebuildModel().catch(() => {});
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this._updateActiveEditorItems();
      }),
      vscode.commands.registerCommand('pw.extension.refreshTests', () => {
        this._rebuildModel().catch(() => {});
      }),
      terminal,
      this._testController,
      this._workspaceObserver,
    ];
  }

  dispose() {
    this._disposables.forEach(d => d.dispose());
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

    this._testTree.newGeneration();
    this._workspaceObserver.reset();
    this._isDogFood = isDogFood;
    this._testController.items.replace([
      this._testController.createTestItem('loading', 'Loading\u2026')
    ]);

    // Give UI a chance to update.
    await new Promise(f => setTimeout(f, 500));

    this._configFiles = await vscode.workspace.findFiles('**/*playwright*.config.[tj]s', 'node_modules/**');

    this._workspaceTestItems = (vscode.workspace.workspaceFolders || []).map(wf => this._testTree.createForLocation(wf.name, wf.uri));
    for (const profile of this._runProfiles)
      profile.dispose();

    for (const configFileUri of this._configFiles) {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(configFileUri)!.uri.fsPath;
      const config: Config = {
        workspaceFolder,
        configFile: configFileUri.fsPath,
      };
      const report = await this._playwrightListTests(config);
      config.testDir = report.testDir;
      const configDir = path.dirname(config.configFile);
      this._workspaceObserver.addWatchFolder(config.testDir ? path.resolve(configDir, config.testDir) : configDir, config);
      await this._createRunProfiles(config, report);
      await this._createTestItemsForFiles(config, report);
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
          const location = this._testTree.location(testItem);
          await this._runTest(request, config, project.name, location!, token);
        }
      }, true));
      this._runProfiles.push(this._testController.createRunProfile(`${folderName}${path.sep}${configName}${projectSuffix}`, vscode.TestRunProfileKind.Debug, async (request, token) => {
        for (const testItem of request.include || []) {
          await this._debugTest(config, project.name, testItem);
        }
      }, true));
    }
  }

  private async _createTestItemsForFiles(config: Config, report: ListTestsReport) {
    for (const project of report.projects) {
      for (const file of project.files) {
        const item = this._testTree.getOrCreateForFileOrFolder(file);
        if (!item)
          continue;
        item.canResolveChildren = true;
        this._testTree.attributeToConfig(item, config);
      }
    }
  }

  private async _resolveChildren(fileItem: vscode.TestItem | undefined): Promise<void> {
    await this._populateFileItemIfNeeded(fileItem);
  }

  private _createTestItemForEntry(entry: Entry): vscode.TestItem {
    const title = entry.titlePath.join(' › ');
    const testItem = this._testTree.createForLocation(title, vscode.Uri.file(entry.file), entry.line);
    return testItem;
  }

  private _onDidDeleteFile(file: string) {
    const testItem = this._testTree.getForLocation(file);
    if (testItem)
      this._testTree.delete(testItem);
  }

  private async _onDidChangeFiles(configs: Map<Config, Set<string>>) {
    const loadedFilesByConfig = new Map<Config, vscode.TestItem[]>();

    // Ensure all test items are created for all created and changed files.
    for (const [config, files] of configs) {
      const testItems = [...files].map(file => this._testTree.getOrCreateForFileOrFolder(file)) as vscode.TestItem[];
      // Erase all loaded test items in loaded files.
      const loadedFileItems = testItems.filter(testItem => this._testTree.isLoaded(testItem));
      for (const fileItem of loadedFileItems) {
        this._testTree.setLoaded(fileItem, true);
        this._testTree.unbindChildren(fileItem);
      }
      loadedFilesByConfig.set(config, loadedFileItems);
    }

    // Request updated information for changed and created files.
    this._testTree.beginCoalescingUpdate();
    try {
      for (const [config, fileItems] of loadedFilesByConfig)
        await this._populateFileItems(config, fileItems);
    } finally {
      this._testTree.endCoalescingUpdate();
    }
  }

  private async _populateFileItemIfNeeded(fileItem: vscode.TestItem | undefined): Promise<void> {
    if (!fileItem || this._testTree.isLoaded(fileItem))
      return;
    this._testTree.setLoaded(fileItem, true);
    this._testTree.unbindChildren(fileItem);

    this._testTree.beginCoalescingUpdate();
    try {
      for (const config of this._testTree.configs(fileItem))
        await this._populateFileItems(config, [fileItem]);
    } finally {
      this._testTree.endCoalescingUpdate();
    }
  }

  private async _populateFileItems(config: Config, fileItems: vscode.TestItem[]) {
    await this._playwrightTest(null, config, [...fileItems.map(i => i.uri!.fsPath), '--list', '--reporter', path.join(__dirname, 'oopReporter.js')], (transport, message) => {
      if (message.method !== 'onBegin')
        return;
      const entries = message.params.entries as Entry[];
      this._updateTestTreeFromEntries(entries);
      transport.close();
    });
  }

  private async _runTest(request: vscode.TestRunRequest, config: Config, projectName: string, location: string, token: vscode.CancellationToken) {
    const testRun = this._testController.createTestRun({
      ...request,
      // Our suites are flat and vscode won't report on tests outside the test item.
      include: undefined,
      exclude: undefined,
    });
    this._terminalSink.fire('\x1b[H\x1b[2J');
    await this._playwrightTest(this._terminalSink, config, [location, '--project', projectName, '--reporter', path.join(__dirname, 'oopReporter.js') + ',line'], (transport, message) => {
      if (token.isCancellationRequested)
        return;
      if (message.method === 'onEnd') {
        transport.close();
        return;
      }
      if (message.method === 'onBegin') {
        const entries = message.params.entries as Entry[];
        this._updateTestTreeFromEntries(entries);
        for (const entry of entries) {
          const testItem = this._testTree.getForLocation(entry.id)!;
          testRun.enqueued(testItem);
        }
        return;
      }
      const testItem = this._testTree.getForLocation(message.params.testId);
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
    }, token);
    testRun.end();
  }
 
  private _updateTestTreeFromEntries(entries: Entry[]) {
    for (const entry of entries) {
      // Tolerate clashing configs that are adding dupe tests in common files.
      if (this._testTree.getForLocation(entry.id))
        continue;

      const fileItem = this._testTree.getOrCreateForFileOrFolder(entry.file);

      // Sometimes files are going to be outside of the workspace, ignore those.
      if (!fileItem)
        continue;

      this._testTree.addChild(fileItem, this._createTestItemForEntry(entry));
    }
  }

  private async _debugTest(config: Config, projectName: string, testItem: vscode.TestItem) {
    const location = this._testTree.location(testItem);
    const args = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'test', '-c', config.configFile, location!, '--project', projectName, '--headed', '--timeout', '0'];
    // Put a breakpoint on the next line.
    const breakpointPosition = new vscode.Position(testItem.range!.start.line + 1, 0);
    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(testItem.uri!, breakpointPosition));
    vscode.debug.addBreakpoints([breakpoint]);
    vscode.debug.startDebugging(undefined, {
      type: 'pwa-node',
      name: 'Playwright Test',
      request: 'launch',
      cwd: config.workspaceFolder,
      env: { ...process.env, PW_OUT_OF_PROCESS: '1', PW_IGNORE_COMPILE_CACHE: '1' },
      args,
      resolveSourceMapLocations: [],
      outFiles: [],
    });
  }

  private async _playwrightTest(terminal: vscode.EventEmitter<string> | null, config: Config, args: string[], onMessage: (transport: PipeTransport, message: ProtocolResponse) => void, token?: vscode.CancellationToken): Promise<PipeTransport> {
    const node = this._findNode();
    const allArgs = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'test', '-c', config.configFile, ...args];
    const childProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });
  
    if (token) {
      token.onCancellationRequested(() => {
        childProcess.kill('SIGINT');
      });
    }

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
    const fileItem = this._testTree.getForLocation(fsPath);
    this._populateFileItemIfNeeded(fileItem);
  }
}

function testMessageForError(testItem: vscode.TestItem, error: TestError): vscode.TestMessage {
  const lines = error.stack ? error.stack.split('\n').reverse() : [];
  for (const line of lines) {
    const frame = stackUtils.parseLine(line);
    if (!frame || !frame.file || !frame.line || !frame.column)
      continue;
    if (frame.file === testItem.uri!.path) {
      const message = new vscode.TestMessage(error.stack!);
      const position = new vscode.Position(frame.line - 1, frame.column - 1);
      message.location = new vscode.Location(testItem.uri!, position);
      return message;
    }
  }
  return new vscode.TestMessage(error.message! || error.value!);
}

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
import glob from 'glob';
import path from 'path';
import { EventEmitter } from './events';
import minimatch from 'minimatch';
import { spawn } from 'child_process';
import which from 'which';
import { Browser, Page } from '@playwright/test';

export class Uri {
  scheme = 'file';
  fsPath!: string;

  static file(fsPath: string): Uri {
    const uri = new Uri();
    uri.fsPath = fsPath;
    return uri;
  }

  static joinPath(base: Uri, ...args: string[]): Uri {
    return Uri.file(path.join(base.fsPath, ...args));
  }
}

class Position {
  constructor(readonly line: number, readonly character: number) {}

  toString() {
    return `${this.line}:${this.character}`;
  }
}

class Location {
  range: Range;
  constructor(readonly uri: Uri, rangeOrPosition: Range | Position) {
    if ('line' in rangeOrPosition)
      this.range = new Range(rangeOrPosition.line, rangeOrPosition.character, rangeOrPosition.line, rangeOrPosition.character);
    else
      this.range = rangeOrPosition;
  }
}

class Range {
  start: Position;
  end: Position;
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }

  toString() {
    return `[${this.start.toString()} - ${this.start.toString()}]`;
  }
}

class Selection {
}

class CancellationToken {
  isCancellationRequested: boolean;
  readonly didCancel = new EventEmitter<void>();
  onCancellationRequested = this.didCancel.event;

  cancel() {
    this.isCancellationRequested = true;
    this.didCancel.fire();
  }
}

export class WorkspaceFolder {
  name: string;
  uri: Uri;

  constructor(readonly vscode: VSCode, name: string, uri: Uri) {
    this.name = name;
    this.uri = uri;
  }

  async addFile(file: string, content: string, isNewWorkspace?: boolean) {
    const fsPath = path.join(this.uri.fsPath, file);
    await fs.promises.mkdir(path.dirname(fsPath), { recursive: true });
    await fs.promises.writeFile(fsPath, content);
    if (!isNewWorkspace) {
      for (const watcher of this.vscode.fsWatchers) {
        if (minimatch(fsPath, watcher.glob))
          watcher.didCreate.fire(Uri.file(fsPath));
      }
    }
  }

  async removeFile(file: string) {
    const fsPath = path.join(this.uri.fsPath, file);
    await fs.promises.unlink(fsPath);
    for (const watcher of this.vscode.fsWatchers) {
      if (minimatch(fsPath, watcher.glob))
        watcher.didDelete.fire(Uri.file(fsPath));
    }
  }

  async changeFile(file: string, content: string) {
    const fsPath = path.join(this.uri.fsPath, file);
    await fs.promises.writeFile(fsPath, content);
    for (const watcher of this.vscode.fsWatchers) {
      if (minimatch(fsPath, watcher.glob))
        watcher.didChange.fire(Uri.file(fsPath));
    }
  }
}

class TestItem {
  readonly children = this;
  readonly map = new Map<string, TestItem>();
  range: Range | undefined;
  parent: TestItem | undefined;
  tags = [];
  canResolveChildren = false;

  constructor(
      readonly testController: TestController,
      readonly id: string,
      readonly label: string,
      readonly uri?: Uri) {
  }

  async expand() {
    if (this.canResolveChildren)
      await this.testController.resolveHandler(this);
  }

  add(item: TestItem) {
    this._innerAdd(item);
    this.testController.didChangeTestItem.fire(this);
  }

  private _innerAdd(item: TestItem) {
    this.map.set(item.id, item);
    item.parent = this;
    this.testController.allTestItems.set(item.id, item);
  }

  delete(id: string) {
    this._innerDelete(id);
    this.testController.didChangeTestItem.fire(this);
  }

  private _innerDelete(id: string) {
    this.map.delete(id);
    this.testController.allTestItems.delete(id);
  }

  replace(items: TestItem[]) {
    for (const itemId of this.map.keys())
      this._innerDelete(itemId);
    for (const item of items)
      this._innerAdd(item);
    this.testController.didChangeTestItem.fire(this);
  }

  forEach(visitor: (item: TestItem) => void) {
    this.map.forEach(visitor);
  }

  toString(): string {
    const result: string[] = [];
    this.innerToString('', result);
    return result.join('\n');
  }

  innerToString(indent: string, result: string[]) {
    result.push(`${indent}- ${this.treeTitle()}`);
    for (const id of [...this.children.map.keys()].sort())
      this.children.map.get(id)!.innerToString(indent + '  ', result);
  }

  treeTitle(): string {
    let location = '';
    if (this.range)
      location = ` [${this.range.start.toString()}]`;
    return `${this.label}${location}`;
  }
}

class TestRunProfile {
  constructor(
    readonly label: string,
    readonly kind: TestRunProfileKind,
    readonly runHandler: (request: TestRunRequest, token: CancellationToken) => Promise<void>,
    readonly isDefault: boolean,
    private runProfiles: TestRunProfile[]) {
    runProfiles.push(this);
  }

  async run(include?: TestItem[], exclude?: TestItem[]) {
    const request = new TestRunRequest(include, exclude, this);
    await this.runHandler(request, request.token);
  }

  dispose() {
    this.runProfiles.splice(this.runProfiles.indexOf(this), 1);
  }
}

class TestRunRequest {
  readonly token = new CancellationToken();

  constructor(
    readonly include?: TestItem[],
    readonly exclude?: TestItem[],
    readonly profile?: TestRunProfile) {}
}

export class TestMessage {
  constructor(
    readonly message: MarkdownString,
    readonly expectedOutput?: string,
    readonly actualOutput?: string,
    readonly location?: Location) {}

  render(indent: string, result: string[]) {
    if (this.location)
      result.push(`${indent}${path.basename(this.location.uri.fsPath)}:${this.location.range.toString()}`);
    const message = this.message.render();
    for (let line of message.split('\n')) {
      if (this.location && line.includes('    at'))
        line = line.replace(/\\/g, '/');
      if (this.location && line.includes('&nbsp;&nbsp;&nbsp;&nbsp;at'))
        line = line.replace(/\\/g, '/');
      result.push(indent + line);
    }
  }
}

type LogEntry = { status: string, duration?: number, messages?: TestMessage | TestMessage[] };

const disposable = { dispose: () => {} };

export class TestRun {
  private _didChange = new EventEmitter<void>();
  readonly onDidChange = this._didChange.event;
  readonly _didEnd = new EventEmitter<void>();
  readonly onDidEnd = this._didEnd.event;
  readonly entries = new Map<TestItem, LogEntry[]>();
  readonly token = new CancellationToken();
  private _output: { output: string, location?: Location, test?: TestItem }[] = [];

  constructor(
    readonly request: TestRunRequest,
    readonly name?: string,
    readonly persist?: boolean) {
  }

  enqueued(test: TestItem) {
    this._log(test, { status: 'enqueued' });
  }

  started(test: TestItem) {
    this._log(test, { status: 'started' });
  }

  skipped(test: TestItem) {
    this._log(test, { status: 'skipped' });
  }

  failed(test: TestItem, messages: TestMessage[], duration?: number) {
    this._log(test, { status: 'failed', duration, messages });
  }

  passed(test: TestItem, duration?: number) {
    this._log(test, { status: 'passed', duration });
  }

  private _log(test: TestItem, entry: LogEntry) {
    let entries = this.entries.get(test);
    if (!entries) {
      entries = [];
      this.entries.set(test, entries);
    }
    entries.push(entry);
    this._didChange.fire();
  }

  appendOutput(output: string, location?: Location, test?: TestItem) {
    this._output.push({ output, location, test });
  }

  end() {
    this._didEnd.fire();
  }

  renderLog(options: { messages?: boolean, output?: boolean } = {}): string {
    const indent = '  ';
    const result: string[] = [''];
    const tests = [...this.entries.keys()];
    tests.sort((a, b) => a.label.localeCompare(b.label));
    for (const test of tests) {
      const entries = this.entries.get(test)!;
      result.push(`  ${test.treeTitle()}`);
      for (const entry of entries) {
        result.push(`    ${entry.status}`);
        if (options.messages && entry.messages) {
          const messages = Array.isArray(entry.messages) ? entry.messages : [entry.messages];
          for (const message of messages)
            message.render('      ', result);
        }
      }
    }
    if (options.output) {
      result.push('  Output:');
      if (this._output.length) {
        for (const output of this._output) {
          const lines = output.output.split('\n');
          result.push(...lines.map(l => '  ' + l));
        }
      }
    }
    result.push('');
    return result.join(`\n${indent}`);
  }
}

export class TestController {
  readonly items: TestItem;
  readonly runProfiles: TestRunProfile[] = [];
  readonly allTestItems = new Map<string, TestItem>();

  readonly didChangeTestItem = new EventEmitter<TestItem>();
  readonly onDidChangeTestItem = this.didChangeTestItem.event;

  private _didCreateTestRun = new EventEmitter<TestRun>();
  readonly onDidCreateTestRun = this._didCreateTestRun.event;

  resolveHandler: (item: TestItem | null) => Promise<void>;

  constructor(readonly vscode: VSCode, id: string, label: string) {
    this.items = new TestItem(this, id, label);
  }

  createTestItem(id: string, label: string, uri?: Uri): TestItem {
    return new TestItem(this, id, label, uri);
  }

  createRunProfile(label: string, kind: TestRunProfileKind, runHandler: (request: TestRunRequest, token: CancellationToken) => Promise<void>, isDefault?: boolean): TestRunProfile {
    return new TestRunProfile(label, kind, runHandler, !!isDefault, this.runProfiles);
  }

  createTestRun(request: TestRunRequest, name?: string, persist?: boolean): TestRun {
    const testRun = new TestRun(request, name, persist);
    this._didCreateTestRun.fire(testRun);
    return testRun;
  }

  renderTestTree() {
    const result: string[] = [''];
    for (const item of this.items.map.values())
      item.innerToString('    ', result);
    result.push('  ');
    return result.join('\n');
  }

  async expandTestItems(label: RegExp) {
    await Promise.all(this.findTestItems(label).map(t => t.expand()));
  }

  findTestItems(label: RegExp): TestItem[] {
    return [...this.allTestItems.values()].filter(t => label.exec(t.label));
  }

  async run(include?: TestItem[], exclude?: TestItem[]): Promise<TestRun> {
    const profile = this.runProfiles.find(p => p.kind === this.vscode.TestRunProfileKind.Run)!;
    const [testRun] = await Promise.all([
      new Promise<TestRun>(f => this.onDidCreateTestRun(f)),
      profile.run(include, exclude),
    ]);
    return testRun;
  }

  async debug(include?: TestItem[], exclude?: TestItem[]): Promise<TestRun> {
    const profile = this.runProfiles.find(p => p.kind === this.vscode.TestRunProfileKind.Debug)!;
    const [testRun] = await Promise.all([
      new Promise<TestRun>(f => this.onDidCreateTestRun(f)),
      profile.run(include, exclude),
    ]);
    return testRun;
  }
}

type Decoration = { type?: number, range: Range, renderOptions?: any };

class TextDocument {
  uri: Uri;
  constructor(uri: Uri) {
    this.uri = uri;
  }

  validateRange(range) {
    return range;
  }
}

class TextEditor {
  readonly document: { uri: Uri; };
  private _log: string[] = [];
  private _state = new Map<number, Decoration[]>();
  text: string = '';

  constructor(document: TextDocument) {
    this.document = document;
  }

  setDecorations(type: number, decorations: Decoration[]) {
    this._state.set(type, decorations);

    const lines: string[] = [];
    for (const [type, decorations] of this._state) {
      for (const decoration of decorations) {
        let options = decoration.renderOptions ? ' ' + JSON.stringify(decoration.renderOptions) : '';
        options = options.replace(/\d+ms/g, 'Xms');
        lines.push(`${decoration.range.toString()}: decorator #${type}${options}`);
      }
    }
    const state = lines.sort().join('\n');
    if (this._log[this._log.length - 1] !== state)
      this._log.push(state);
  }

  renderDecorations(indent: string): string {
    const result = [''];
    for (const state of this._log) {
      result.push('  --------------------------------------------------------------');
      result.push(...state.split('\n').map(s => '  ' + s));
    }
    result.push('');
    return result.join(`\n${indent}`);
  }

  edit(editCallback) {
    editCallback({
      replace: (range, text) => {
        this.text = text;
      }
    });
  }
}

class FileSystemWatcher {
  readonly didCreate = new EventEmitter<Uri>();
  readonly didChange = new EventEmitter<Uri>();
  readonly didDelete = new EventEmitter<Uri>();
  readonly onDidCreate = this.didCreate.event;
  readonly onDidChange = this.didChange.event;
  readonly onDidDelete = this.didDelete.event;
  constructor(readonly vscode: VSCode, readonly glob: string) { }

  dispose() {
    this.vscode.fsWatchers.delete(this);
  }
}

type DebugConfiguration  = {
  type: string;
  name: string;
  request: string;
  [key: string]: any;
};

class Debug {
  private _didStartDebugSession = new EventEmitter();
  private _didTerminateDebugSession = new EventEmitter();
  readonly onDidStartDebugSession = this._didStartDebugSession.event;
  readonly onDidTerminateDebugSession = this._didTerminateDebugSession.event;
  output = '';
  dapFactories: any[] = [];
  private _dapSniffer: any;

  constructor() {
  }

  registerDebugAdapterTrackerFactory(type: string, factory: any) {
    this.dapFactories.push(factory);
  }

  async startDebugging(folder: WorkspaceFolder | undefined, configuration: DebugConfiguration, parentSession?: DebugSession): Promise<boolean> {
    const session = new DebugSession('<extension-id>', configuration.type, configuration.name, folder, configuration, parentSession);
    for (const factory of this.dapFactories)
      this._dapSniffer = factory.createDebugAdapterTracker(session);
    this._didStartDebugSession.fire(session);
    const node = await which('node');
    const subprocess = spawn(node, [configuration.program, ...configuration.args], {
      cwd: configuration.cwd,
      stdio: 'pipe',
      env: configuration.env,
    });

    subprocess.stdout.on('data', data => this.output += data.toString());
    subprocess.stderr.on('data', data => this.output += data.toString());
    return true;
  }

  simulateStoppedOnError(error: string, location: { file: string; line: number; }) {
    this._dapSniffer.onDidSendMessage({
      success: true,
      type: 'response',
      command: 'scopes',
      body: {
        scopes: [
          {
            name: 'Catch Block',
            source: {
              path: location.file,
            },
            line: location.line,
            column: 0,
          },
        ],
      }
    });

    this._dapSniffer.onDidSendMessage({
      success: true,
      type: 'response',
      command: 'variables',
      body: {
        variables: [
          {
            type: 'error',
            name: 'playwrightError',
            value: error,
          },
        ],
      }
    });
  }
}

class DebugSession {
  constructor(
    readonly id: string,
    readonly type: string,
    readonly name: string,
    readonly workspaceFolder: WorkspaceFolder | undefined,
    readonly configuration: DebugConfiguration,
    readonly parentSession?: DebugSession,
  ) {}

  async customRequest(command: string, args?: any) {}

  async getDebugProtocolBreakpoint() {}
}

export enum TestRunProfileKind {
  Run = 1,
  Debug = 2,
  Coverage = 3,
}

class MarkdownString {
  readonly md: string[] = [];

  appendMarkdown(md: string) {
    this.md.push(md);
  }

  render(): string {
    return this.md.join('\n').replace(/&nbsp;/g, ' ');
  }
}

class TestTag {
}

export class VSCode {
  isUnderTest = true;
  EventEmitter = EventEmitter;
  Location = Location;
  MarkdownString = MarkdownString;
  Position = Position;
  Range = Range;
  Selection = Selection;
  TestTag = TestTag;
  TestMessage = TestMessage;
  TestRunProfileKind = TestRunProfileKind;
  Uri = Uri;
  commands: any = {};
  debug: Debug;
  languages: any = {};
  tests: any = {};
  window: any = {};
  workspace: any = {};
  ProgressLocation = { Notification: 1 };

  private _didChangeActiveTextEditor = new EventEmitter();
  private _didChangeVisibleTextEditors = new EventEmitter();
  private _didChangeTextEditorSelection = new EventEmitter();
  private _didChangeWorkspaceFolders = new EventEmitter();
  private _didChangeTextDocument = new EventEmitter();
  private _didChangeConfiguration = new EventEmitter();
  private _didShowInputBox = new EventEmitter<any>();

  readonly onDidChangeActiveTextEditor = this._didChangeActiveTextEditor.event;
  readonly onDidChangeTextEditorSelection = this._didChangeTextEditorSelection.event;
  readonly onDidChangeVisibleTextEditors = this._didChangeVisibleTextEditors.event;
  readonly onDidChangeWorkspaceFolders = this._didChangeWorkspaceFolders.event;
  readonly onDidChangeTextDocument = this._didChangeTextDocument.event;
  readonly onDidChangeConfiguration = this._didChangeConfiguration.event;
  readonly onDidShowInputBox = this._didShowInputBox.event;

  readonly testControllers: TestController[] = [];
  readonly fsWatchers = new Set<FileSystemWatcher>();
  readonly warnings: string[] = [];
  readonly context: { subscriptions: any[]; extensionUri: Uri; };
  readonly extensions: any[] = [];
  private _webviewProviders = new Map<string, any>();
  private _browser: Browser;
  readonly webViews = new Map<string, Page>();
  readonly commandLog: string[] = [];
  lastWithProgressData = undefined;

  constructor(baseDir: string, browser: Browser) {
    this.context = { subscriptions: [], extensionUri: Uri.file(baseDir) };
    this._browser = browser;

    const commands = new Map<string, () => Promise<void>>();
    this.commands.registerCommand = (name: string, callback: () => Promise<void>) => {
      commands.set(name, callback);
      return disposable;
    };
    this.commands.executeCommand = async (name: string) => {
      await commands.get(name)?.();
      this.commandLog.push(name);
    };
    this.debug = new Debug();

    this.languages.registerHoverProvider = () => disposable;
    this.tests.createTestController = this._createTestController.bind(this);

    let lastDecorationTypeId = 0;
    this.window.onDidChangeActiveTextEditor = this.onDidChangeActiveTextEditor;
    this.window.onDidChangeTextEditorSelection = this.onDidChangeTextEditorSelection;
    this.window.onDidChangeVisibleTextEditors = this.onDidChangeVisibleTextEditors;
    this.window.onDidChangeActiveColorTheme = () => disposable;
    this.window.createTextEditorDecorationType = () => ++lastDecorationTypeId;
    this.window.showWarningMessage = (message: string) => this.warnings.push(message);
    this.window.visibleTextEditors = [];
    this.window.registerTreeDataProvider = () => disposable;
    this.window.registerWebviewViewProvider = (name: string, provider: any) => {
      this._webviewProviders.set(name, provider);
      return disposable;
    };
    this.window.createInputBox = () => {
      const didAccept = new EventEmitter<void>();
      const didChange = new EventEmitter<string>();
      const didHide = new EventEmitter<void>();
      const didAssignValue = new EventEmitter<string>();
      let value = '';
      const inputBox = {
        onDidAccept: didAccept.event,
        onDidChangeValue: didChange.event,
        onDidHide: didHide.event,
        onDidAssignValue: didAssignValue.event,
        set value(val: string) {
          value = val;
          didAssignValue.fire(val);
        },
        get value() {
          return value;
        },
        dispose: () => {},
        accept: () => didAccept.fire(),
        hide: () => didHide.fire(),
        show: () => this._didShowInputBox.fire(inputBox),
      };
      return inputBox;
    };
    this.window.withProgress = async (opts, callback) => {
      const progress = {
        report: (data: any) => this.lastWithProgressData = data,
      };
      await callback(progress, new CancellationToken());
    };
    this.window.showTextDocument = (document: TextDocument) => {
      const editor = new TextEditor(document);
      this.window.visibleTextEditors.push(editor);
      this._didChangeVisibleTextEditors.fire(this.window.visibleTextEditors);
      this._didChangeActiveTextEditor.fire(this.window.activeTextEditor);
      return editor;
    };

    this.workspace.onDidChangeWorkspaceFolders = this.onDidChangeWorkspaceFolders;
    this.workspace.onDidChangeTextDocument = this.onDidChangeTextDocument;
    this.workspace.onDidChangeConfiguration = this.onDidChangeConfiguration;
    this.workspace.createFileSystemWatcher = (glob: string) => {
      const watcher = new FileSystemWatcher(this, glob);
      this.fsWatchers.add(watcher);
      return watcher;
    };
    this.workspace.workspaceFolders = [];
    this.workspace.openTextDocument = (file: string) => {
      return new TextDocument(Uri.file(file));
    };

    this.workspace.findFiles = async pattern => {
      const uris: Uri[] = [];
      for (const workspaceFolder of this.workspace.workspaceFolders) {
        await new Promise<void>(f => {
          const cwd = workspaceFolder.uri.fsPath;
          glob(pattern, { cwd }, (err, files) => {
            uris.push(...files.map(f => Uri.file(path.join(cwd, f))));
            f();
          });
        });
      }
      return uris;
    };

    this.workspace.getWorkspaceFolder = (uri: Uri): WorkspaceFolder | undefined => {
      for (const workspaceFolder of this.workspace.workspaceFolders) {
        if (uri.fsPath.startsWith(workspaceFolder.uri.fsPath))
          return workspaceFolder;
      }
    };
    const settings = {
      'playwright.env': {},
      'playwright.logApiCalls': false,
      'playwright.reuseBrowser': false,
    };
    this.workspace.getConfiguration = scope => {
      return {
        get: key => settings[scope + '.' + key],
        update: (key, value) => {
          settings[scope + '.' + key] = value;
          this._didChangeConfiguration.fire({
            affectsConfiguration: prefix => (scope + '.' + key).startsWith(prefix)
          });
        }
      };
    };
  }

  async activate() {
    for (const extension of this.extensions)
      await extension.activate(this.context);

    for (const [name, provider] of this._webviewProviders) {
      const webview: any = {};
      webview.asWebviewUri = uri => path.relative(this.context.extensionUri.fsPath, uri.fsPath);
      const eventEmitter = new EventEmitter<any>();
      let initializedPage: Page | undefined = undefined;
      webview.onDidReceiveMessage = eventEmitter.event;
      webview.cspSource = 'http://localhost/';
      const pendingMessages: any[] = [];
      webview.postMessage = (data: any) => {
        if (!initializedPage) {
          pendingMessages.push(data);
          return;
        }
        initializedPage.evaluate((data: any) => {
          const event = new Event('message');
          (event as any).data = data;
          globalThis.dispatchEvent(event);
        }, data).catch(() => {});
      };
      provider.resolveWebviewView({ webview, onDidChangeVisibility: () => disposable });
      const context = await this._browser.newContext();
      const page = await context.newPage();
      this.webViews.set(name, page);
      await page.route('**/*', route => {
        const url = route.request().url();
        if (url === 'http://localhost/') {
          route.fulfill({ body: webview.html });
        } else {
          const suffix = url.substring('http://localhost/'.length);
          const buffer = fs.readFileSync(path.join(this.context.extensionUri.fsPath, suffix));
          route.fulfill({ body: buffer });
        }
      });
      await page.addInitScript(() => {
        globalThis.acquireVsCodeApi = () => globalThis;
      });
      await page.goto('http://localhost');
      await page.exposeFunction('postMessage', (data: any) => eventEmitter.fire(data));
      this.context.subscriptions.push({
        dispose: () => {
          context.close().catch(() => {});
        }
      });
      initializedPage = page;
      for (const m of pendingMessages)
        webview.postMessage(m);
    }
  }

  dispose() {
    for (const d of this.context.subscriptions)
      d.dispose();
  }

  private _createTestController(id: string, label: string): TestController {
    const testController = new TestController(this, id, label);
    this.testControllers.push(testController);
    return testController;
  }

  async addWorkspaceFolder(rootFolder: string, files?: { [key: string]: string }): Promise<WorkspaceFolder> {
    const workspaceFolder = new WorkspaceFolder(this, path.basename(rootFolder), Uri.file(rootFolder));
    this.workspace.workspaceFolders.push(workspaceFolder);
    await fs.promises.mkdir(rootFolder, { recursive: true });
    await workspaceFolder.addFile('package.json', '{}', true);
    if (files) {
      for (const [fsPath, content] of Object.entries(files))
        await workspaceFolder.addFile(fsPath, content, true);
    }
    this._didChangeWorkspaceFolders.fire(undefined);
    return workspaceFolder;
  }

  async openEditors(glob: string) {
    const uris = await this.workspace.findFiles(glob);
    this.window.activeTextEditor = undefined;
    this.window.visibleTextEditors = [];
    for (const uri of uris) {
      const editor = new TextEditor(new TextDocument(uri));
      if (!this.window.activeTextEditor)
        this.window.activeTextEditor = editor;
      this.window.visibleTextEditors.push(editor);
    }
    this._didChangeVisibleTextEditors.fire(this.window.visibleTextEditors);
    this._didChangeActiveTextEditor.fire(this.window.activeTextEditor);
  }

  renderExecLog(indent: string) {
    const log: string[] = [''];
    for (const extension of this.extensions)
      log.push(...extension.playwrightTestLog());
    return unescapeRegex(log.join(`\n  ${indent}`) + `\n${indent}`).replace(/\\/g, '/');
  }
}

const asciiRegex = new RegExp('[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))', 'g');
export function stripAscii(str: string): string {
  return str.replace(asciiRegex, '');
}

function unescapeRegex(regex: string) {
  return regex.replace(/\\(.)/g, '$1');
}

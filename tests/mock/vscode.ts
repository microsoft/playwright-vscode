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
import { Disposable, EventEmitter, Event } from '../../src/upstream/events';
import { minimatch } from 'minimatch';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import which from 'which';
import { Browser, Page } from '@playwright/test';
import { CancellationToken } from '../../src/vscodeTypes';

/* eslint-disable no-restricted-properties */

export class Uri {
  scheme = 'file';
  authority = '';
  path = '';
  query = '';
  fragment = '';
  fsPath = '';

  static file(fsPath: string): Uri {
    const uri = new Uri();
    // VSCode lowercases drive letters on Windows.
    if (process.platform === 'win32' && fsPath && fsPath[0] !== '\\' && fsPath[0] !== '/')
      fsPath = fsPath[0].toLowerCase() + fsPath.substring(1);
    uri.fsPath = fsPath;
    uri.path = fsPath;
    return uri;
  }

  static joinPath(base: Uri, ...args: string[]): Uri {
    return Uri.file(path.join(base.fsPath, ...args));
  }

  static parse(value: string): Uri {
    const { protocol, host, pathname, search, hash } = new URL(value);
    const uri = new Uri();
    uri.scheme = protocol.replace(/:$/, '');
    uri.authority = host;
    uri.path = pathname;
    uri.query = search;
    uri.fragment = hash;
    return uri;
  }

  toString() {
    const url = new URL(`${this.scheme}://${this.authority}${this.path}`);
    if (this.query) url.search = this.query;
    if (this.fragment) url.hash = this.fragment;
    return url.toString();
  }
}

export enum ColorThemeKind {
  Light = 1,
  Dark = 2,
  HighContrast = 3,
  HighContrastLight = 4
}

class Position {
  constructor(readonly line: number, readonly character: number) {}

  toString() {
    return `${this.line}:${this.character}`;
  }
}

export enum DiagnosticSeverity {
  Error = 'Error',
  Warning = 'Warning',
  Information = 'Information',
  Hint = 'Hint'
}

type Diagnostic = {
  message: string;
  location: Location;
  severity: DiagnosticSeverity;
};

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
  constructor(startLine: number | Position, startCharacter: number | Position, endLine?: number, endCharacter?: number) {
    if (startLine instanceof Position) {
      this.start = startLine;
      this.end = startCharacter as Position;
    } else {
      this.start = new Position(startLine as number, startCharacter as number);
      this.end = new Position(endLine as number, endCharacter as number);
    }
  }

  clone(): Range {
    return new Range(this.start.line, this.start.character, this.end.line, this.end.character);
  }

  toString() {
    return `[${this.start.toString()} - ${this.end.toString()}]`;
  }
}

class Selection extends Range {
}

class CancellationTokenSource implements Disposable {
  token: CancellationToken & { source: CancellationTokenSource };
  readonly didCancel = new EventEmitter<void>();

  constructor() {
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: this.didCancel.event,
      source: this,
    };
  }

  cancel() {
    this.token.isCancellationRequested = true;
    this.didCancel.fire();
  }

  dispose() {
    this.cancel();
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
    // TODO: investigate why watch immediately followed by changeFile doesn't emit the event.
    await new Promise(f => setTimeout(f, 1000));
    const fsPath = path.join(this.uri.fsPath, file);
    await fs.promises.writeFile(fsPath, content);
    for (const watcher of this.vscode.fsWatchers) {
      if (minimatch(fsPath, watcher.glob))
        watcher.didChange.fire(Uri.file(fsPath));
    }
  }
}

export class TestItem {
  readonly children = this;
  readonly map = new Map<string, TestItem>();
  range: Range | undefined;
  parent: TestItem | undefined;
  tags: readonly TestTag[] = [];
  canResolveChildren = false;
  status: 'none' | 'enqueued' | 'started' | 'skipped' | 'failed' | 'passed' = 'none';
  description: string | undefined;
  sortText: string | undefined;
  error: string | undefined;

  constructor(
      readonly testController: TestController,
      readonly id: string,
      readonly label: string,
      readonly uri?: Uri) {
  }

  get size() {
    return this.map.size;
  }

  [Symbol.iterator](): Iterator<[string, TestItem]> {
    return this.map[Symbol.iterator]();
  }

  async expand() {
    if (this.canResolveChildren)
      await this.testController.resolveHandler!(this);
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
    result.push(`${indent}- ${this.statusIcon()} ${this.treeTitle()}`);
    if (this.error)
      result.push(`${indent}  ${this.error}`);
    const items = [...this.children.map.values()];
    items.sort((i1, i2) => itemOrder(i1).localeCompare(itemOrder(i2)));
    for (const item of items)
      item.innerToString(indent + '  ', result);
  }

  statusIcon() {
    if (this.status === 'enqueued')
      return '🕦';
    if (this.status === 'started')
      return '↻';
    if (this.status === 'skipped')
      return '◯';
    if (this.status === 'failed')
      return '❌';
    if (this.status === 'passed')
      return '✅';
    return ' ';
  }

  treeTitle(): string {
    let location = '';
    if (this.range)
      location = ` [${this.range.start.toString()}]`;
    let description = '';
    if (this.description)
      description = ` [${this.description}]`;
    return `${this.label}${description}${location}`;
  }

  flatTitle(): string {
    let location = '';
    if (this.range)
      location = ` [${this.range.start.toString()}]`;
    const titlePath: string[] = [];
    let item: TestItem | undefined = this;
    while (item && item.parent) {
      titlePath.unshift(item.label);
      item = item.parent;
    }
    return `${titlePath.join(' > ')}${location}`;
  }
}

function itemOrder(item: TestItem) {
  let result = '';
  if (item.range)
    result += item.range.start.line.toString().padStart(5, '0');
  result += item.sortText || item.label;
  return result;
}

class TestRunProfile {
  private _isDefault = true;
  readonly didChangeDefault = new EventEmitter<boolean>();
  readonly onDidChangeDefault: Event<boolean> | undefined;

  constructor(
    private testController: TestController,
    readonly label: string,
    readonly kind: TestRunProfileKind,
    readonly runHandler: (request: TestRunRequest, token: CancellationToken) => Promise<void>,
    isDefault: boolean,
    private runProfiles: TestRunProfile[]) {
    runProfiles.push(this);
    this.onDidChangeDefault = this.didChangeDefault.event;
    this._isDefault = isDefault;
  }

  get isDefault(): boolean {
    return this._isDefault;
  }

  set isDefault(value: boolean) {
    this._isDefault = value;
    this.didChangeDefault.fire(value);
  }

  async run(include?: TestItem[], exclude?: TestItem[]): Promise<TestRun> {
    const request = new TestRunRequest(include, exclude, this);
    const [testRun] = await Promise.all([
      new Promise<TestRun>(f => this.testController.onDidCreateTestRun(testRun => {
        testRun.onDidEnd(() => f(testRun));
      })),
      this.runHandler(request, request.token),
    ]);
    return testRun;
  }

  async watch(include?: TestItem[], exclude?: TestItem[]): Promise<TestRunRequest> {
    const request = new TestRunRequest(include, exclude, this, true);
    await this.runHandler(request, request.token);
    return request;
  }

  dispose() {
    this.runProfiles.splice(this.runProfiles.indexOf(this), 1);
    this.didChangeDefault.dispose();
  }
}

export class TestRunRequest {
  readonly token = new CancellationTokenSource().token;

  include: TestItem[] | undefined;
  exclude: TestItem[] | undefined;
  profile: TestRunProfile | undefined;
  continuous?: boolean;

  constructor(include?: TestItem[], exclude?: TestItem[], profile?: TestRunProfile, continuous?: boolean) {
    this.include = include;
    this.exclude = exclude;
    this.profile = profile;
    this.continuous = continuous;
  }
}

export class TestMessage {
  constructor(
    readonly message: MarkdownString,
    readonly expectedOutput?: string,
    readonly actualOutput?: string,
    readonly location?: Location,
    readonly stackTrace?: TestMessageStackFrame[]) {}

  render(indent: string, result: string[]) {
    if (this.location)
      result.push(`${indent}${path.basename(this.location.uri.fsPath)}:${this.location.range.toString()}`);
    const message = this.message.render();
    for (let line of message.split('\n')) {
      line = line.replace(/at .*\/test-results.*[/\\]tests(.*)\)/, 'at tests$1');
      if (this.location && line.includes('    at'))
        line = line.replace(/\\/g, '/');
      if (this.location && line.includes('&nbsp;&nbsp;&nbsp;&nbsp;at'))
        line = line.replace(/\\/g, '/');
      result.push(indent + line);
    }
    if (this.stackTrace?.length) {
      result.push(indent + 'Stack trace:');
      for (const frame of this.stackTrace)
        result.push(`${indent}  ${frame.label} (${path.basename(frame.uri.fsPath)}:${frame.position.line + 1})`);
    }
  }
}

export class TestMessageStackFrame {
  constructor(
    readonly label: string,
    readonly uri: Uri,
    readonly position: Position) {}
}

type LogEntry = { status: string, duration?: number, messages?: TestMessage | TestMessage[] };

const disposable = { dispose: () => {} };

export class TestRun {
  private _didChange = new EventEmitter<void>();
  readonly onDidChange = this._didChange.event;
  readonly _didEnd = new EventEmitter<void>();
  readonly onDidEnd = this._didEnd.event;
  readonly entries = new Map<TestItem, LogEntry[]>();
  readonly token = new CancellationTokenSource().token;
  readonly output: { output: string, location?: Location, test?: TestItem }[] = [];

  constructor(
    readonly request: TestRunRequest,
    readonly name?: string,
    readonly persist?: boolean) {
  }

  enqueued(test: TestItem) {
    test.status = 'enqueued';
    this._log(test, { status: 'enqueued' });
  }

  started(test: TestItem) {
    test.status = 'started';
    this._log(test, { status: 'started' });
  }

  skipped(test: TestItem) {
    test.status = 'skipped';
    this._log(test, { status: 'skipped' });
  }

  failed(test: TestItem, messages: TestMessage[], duration?: number) {
    test.status = 'failed';
    this._log(test, { status: 'failed', duration, messages });
  }

  passed(test: TestItem, duration?: number) {
    test.status = 'passed';
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
    this.output.push({ output, location, test });
  }

  end() {
    this._didEnd.fire();
  }

  renderLog(options: { messages?: boolean, output?: boolean } = {}): string {
    const indent = '  ';
    const result: string[] = [''];
    const tests = [...this.entries.keys()];
    tests.sort((i1, i2) => itemOrder(i1).localeCompare(itemOrder(i2)));
    for (const test of tests) {
      const entries = this.entries.get(test)!;
      result.push(`  ${test.flatTitle()}`);
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
      result.push(...this._renderOutput());
    }
    return trimLog(result.join(`\n${indent}`)) + `\n${indent}`;
  }

  renderOutput(): string {
    return this._renderOutput().join('\n');
  }

  private _renderOutput(): string[] {
    const output = this.output.map(o => o.output).join('');
    const lines = output.split('\n');
    return lines.map(l => '  ' + stripAnsi(l).replace(/\d+(\.\d+)?(ms|s)/, 'XXms'));
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

  refreshHandler?: (item: TestItem | null) => Promise<void>;
  resolveHandler?: (item: TestItem | null) => Promise<void>;

  constructor(readonly vscode: VSCode, id: string, label: string) {
    this.items = new TestItem(this, id, label);
  }

  runProfile(): TestRunProfile {
    return this.runProfiles.filter(p => p.kind === TestRunProfileKind.Run)[0];
  }

  debugProfile(): TestRunProfile {
    return this.runProfiles.filter(p => p.kind === TestRunProfileKind.Debug)[0];
  }

  createTestItem(id: string, label: string, uri?: Uri): TestItem {
    return new TestItem(this, id, label, uri);
  }

  createRunProfile(label: string, kind: TestRunProfileKind, runHandler: (request: TestRunRequest, token: CancellationToken) => Promise<void>, isDefault?: boolean): TestRunProfile {
    return new TestRunProfile(this, label, kind, runHandler, !!isDefault, this.runProfiles);
  }

  createTestRun(request: TestRunRequest, name?: string, persist?: boolean): TestRun {
    const testRun = new TestRun(request, name, persist);
    this._didCreateTestRun.fire(testRun);
    return testRun;
  }

  renderTestTree() {
    const result: string[] = [''];
    const items = [...this.items.map.values()];
    items.sort((i1, i2) => itemOrder(i1).localeCompare(itemOrder(i2)));
    for (const item of items)
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
    return profile.run(include, exclude);
  }

  async watch(include?: TestItem[], exclude?: TestItem[]): Promise<TestRunRequest> {
    const profile = this.runProfiles.find(p => p.kind === this.vscode.TestRunProfileKind.Run)!;
    return profile.watch(include, exclude);
  }

  async debug(include?: TestItem[], exclude?: TestItem[]): Promise<TestRun> {
    const profile = this.runProfiles.find(p => p.kind === this.vscode.TestRunProfileKind.Debug)!;
    return profile.run(include, exclude);
  }

  dispose() {
    this.didChangeTestItem.dispose();
    this._didCreateTestRun.dispose();
  }
}

type Decoration = { type?: number, range: Range, renderOptions?: any };

class TextDocument {
  uri: Uri;
  lines: string[] = [];

  constructor(uri: Uri) {
    this.uri = uri;
  }

  get text() {
    return this.lines.join('\n');
  }

  getText(selection?: Range) {
    if (!selection)
      return this.text;
    const start = selection.start;
    const end = selection.end;
    if (start.line === end.line)
      return this.lines[start.line].substring(start.character, end.character);
    const result = [];
    result.push(this.lines[start.line].substring(start.character));
    for (let i = start.line + 1; i < end.line; ++i)
      result.push(this.lines[i]);
    result.push(this.lines[end.line].substring(0, end.character));
    return result.join('\n');
  }

  async _load() {
    const text = await fs.promises.readFile(this.uri.fsPath, 'utf-8');
    this.lines = text.split('\n');
  }

  lineAt(i: number) {
    const line = this.lines[i];
    return {
      text: line,
      isEmptyOrWhitespace: !line.replace(/\s/g, '').trim(),
      firstNonWhitespaceCharacterIndex: line.match(/^\s*/g)![0].length
    };
  }
}

class TextEditor {
  readonly document: TextDocument;
  private _log: string[] = [];
  private _state = new Map<number, Decoration[]>();
  readonly edits: { range: string, from: string, to: string }[] = [];
  selection = new Selection(0, 0, 0, 0);

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
    return trimLog(result.join(`\n${indent}`)) + `\n${indent}`;
  }

  renderWithSelection() {
    // render with selection wrapped with <selection> tag
    const prefix = this.document.getText(new Range(0, 0, this.selection.start.line, this.selection.start.character));
    const selection = this.document.getText(this.selection);
    const suffix = this.document.getText(new Range(this.selection.end.line, this.selection.end.character, this.document.lines.length - 1, this.document.lines[this.document.lines.length - 1].length));
    return `${prefix}<selection>${selection}</selection>${suffix}`;
  }

  edit(editCallback: any) {
    editCallback({
      replace: (range: Range, text: string) => {
        const from = this.renderWithSelection();
        const lines = this.document.text.split('\n');
        const editLines = text.split('\n');
        const newLines = lines.slice(0, range.start.line);
        if (editLines.length === 1) {
          newLines.push(lines[range.start.line].substring(0, range.start.character) + text + lines[range.end.line].substring(range.end.character));
        } else {
          newLines.push(lines[range.start.line].substring(0, range.start.character) + editLines[0]);
          newLines.push(...editLines.slice(1, -1));
          newLines.push(editLines[editLines.length - 1] + lines[range.end.line].substring(range.end.character));
        }
        newLines.push(...lines.slice(range.end.line + 1));
        this.document.lines = newLines;

        this.selection = range.clone();
        const lastLine = editLines[editLines.length - 1];
        const endOfLastLine = new Position(range.start.line + (editLines.length - 1), editLines.length > 1 ? lastLine.length : range.start.character + lastLine.length);
        this.selection.end = endOfLastLine;

        this.edits.push({ range: range.toString(), from, to: this.renderWithSelection() });
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
    this.didCreate.dispose();
    this.didChange.dispose();
    this.didDelete.dispose();
  }
}

type DebugConfiguration  = {
  type: string;
  name: string;
  request: string;
  [key: string]: any;
};

class Debug {
  private _didStartDebugSession = new EventEmitter<DebugSession>();
  private _didTerminateDebugSession = new EventEmitter<DebugSession>();
  readonly onDidStartDebugSession = this._didStartDebugSession.event;
  readonly onDidTerminateDebugSession = this._didTerminateDebugSession.event;
  output = '';
  dapFactories: any[] = [];
  private _dapSniffer: any;
  private _debuggerProcess?: ChildProcessWithoutNullStreams;

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
    this._debuggerProcess = spawn(node, [configuration.program, ...configuration.args], {
      cwd: configuration.cwd,
      stdio: 'pipe',
      env: configuration.env,
    });

    this._debuggerProcess.stdout.on('data', data => {
      this.output += data.toString();
      this._dapSniffer.onDidSendMessage({
        type: 'event',
        event: 'output',
        body: {
          category: 'stdout',
          output: data.toString(),
        }
      });
    });
    this._debuggerProcess.stderr.on('data', data => this.output += data.toString());
    this._debuggerProcess.on('exit', () => this._didTerminateDebugSession.fire(session));
    return true;
  }

  stopDebugging() {
    this._debuggerProcess?.kill();
  }

  simulateStoppedOnError(error: string, location: { file: string; line: number; }) {
    const errorText = `${error.replace(/\n/g, '\\n')}\n at ${location.file}:${location.line}:1 {matcherResult: ...}`;
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
            type: 'ExpectError',
            name: '__playwright_error__',
            value: errorText,
          },
        ],
      }
    });
  }

  dispose() {
    this._didStartDebugSession.dispose();
    this._didTerminateDebugSession.dispose();
  }
}

export class DebugSession {
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
  name: string;
  constructor(name: string) {
    this.name = name.replace(/.*playwright.config.[tj]s:/, '');
  }
}

class DiagnosticsCollection {
  readonly _entries = new Map<string, Diagnostic[]>();

  set(uri: Uri, diagnostics: Diagnostic[]) {
    this._entries.set(uri.toString(), diagnostics);
  }

  get(uri: Uri) {
    return this._entries.get(uri.toString()) || [];
  }

  delete(uri: Uri) {
    this._entries.delete(uri.toString());
  }

  clear() {
    this._entries.clear();
  }
}

class L10n {
  t(message: string, ...args: Array<string | number | boolean>): string {
    return message.replace(/{(\d+)}/g, function(match: string, idx) {
      return (args[parseInt(idx, 10)] ?? match) as string;
    });
  }
}

enum UIKind {
  Desktop = 1,
  Web = 2
}

type HoverProvider = {
  provideHover?(document: TextDocument, position: Position, token: CancellationToken): void
};

export class VSCode {
  isUnderTest = true;
  CancellationTokenSource = CancellationTokenSource;
  ColorThemeKind = ColorThemeKind;
  DiagnosticSeverity = DiagnosticSeverity;
  EventEmitter = EventEmitter;
  Location = Location;
  MarkdownString = MarkdownString;
  Position = Position;
  Range = Range;
  Selection = Selection;
  TestTag = TestTag;
  TestMessage = TestMessage;
  TestMessageStackFrame = TestMessageStackFrame;
  TestRunProfileKind = TestRunProfileKind;
  TestRunRequest = TestRunRequest;
  Uri = Uri;
  UIKind = UIKind;
  commands: any = {};
  debug: Debug;
  languages: any = {};
  tests: any = {};
  window: any = {};
  workspace: any = {};
  env: any = {
    uiKind: UIKind.Desktop,
    remoteName: undefined,
    openExternal: (url: any) => {
      if (url) this.openExternalUrls.push(url.toString());
    },
    asExternalUri: (uri: Uri) => Promise.resolve(uri),
  };
  ProgressLocation = { Notification: 1 };
  ViewColumn = { Active: -1 };

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
  readonly errors: string[] = [];
  readonly context: { subscriptions: any[]; extensionUri: Uri; workspaceState: any };
  readonly extensions: any[] = [];
  private _webviewProviders = new Map<string, any>();
  private _browser: Browser;
  private _webViewsByPanelType = new Map<string, Set<Page>>();
  readonly webViews = new Map<string, Page>();
  readonly commandLog: string[] = [];
  readonly l10n = new L10n();
  lastWithProgressData = undefined;
  private _hoverProviders: Map<string, HoverProvider> = new Map();
  readonly version: string;
  readonly connectionLog: any[] = [];
  readonly openExternalUrls: string[] = [];
  readonly diagnosticsCollections: DiagnosticsCollection[] = [];
  private _clipboardText = '';

  constructor(readonly versionNumber: number, baseDir: string, browser: Browser) {
    this.version = String(versionNumber);
    const workspaceStateStorage = new Map();
    const workspaceState = {
      get: (key: string) => workspaceStateStorage.get(key),
      update: (key: string, value: any) => workspaceStateStorage.set(key, value)
    };
    this.context = { subscriptions: [], extensionUri: Uri.file(baseDir), workspaceState };
    this._browser = browser;
    (globalThis as any).__logForTest = (message: any) => this.connectionLog.push(message);
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
    this.context.subscriptions.push(
        this.debug,
        this._didChangeActiveTextEditor,
        this._didChangeVisibleTextEditors,
        this._didChangeTextEditorSelection,
        this._didChangeWorkspaceFolders,
        this._didChangeTextDocument,
        this._didChangeConfiguration,
        this._didShowInputBox,
    );

    this.languages.registerHoverProvider = (language: string, provider: HoverProvider) => {
      this._hoverProviders.set(language, provider);
      return disposable;
    };
    this.languages.emitHoverEvent = (language: string, document: TextDocument, position: Position, token: CancellationToken) => {
      const provider = this._hoverProviders.get(language);
      if (!provider)
        return;
      provider.provideHover?.(document, position, token);
    };
    this.languages.getDiagnostics = () => {
      const result: Diagnostic[] = [];
      for (const collection of this.diagnosticsCollections) {
        for (const diagnostics of collection._entries.values())
          result.push(...diagnostics);
      }
      return result;
    };
    this.languages.createDiagnosticCollection = () => {
      const diagnosticsCollection = new DiagnosticsCollection();
      this.diagnosticsCollections.push(diagnosticsCollection);
      return diagnosticsCollection;
    };
    this.tests.createTestController = this._createTestController.bind(this);

    let lastDecorationTypeId = 0;
    this.window.onDidChangeActiveTextEditor = this.onDidChangeActiveTextEditor;
    this.window.onDidChangeTextEditorSelection = this.onDidChangeTextEditorSelection;
    this.window.didChangeTextEditorSelection = (textEditor: TextEditor, selection: Selection) => {
      this._didChangeTextEditorSelection.fire({ textEditor, selections: [selection] });
    };
    this.window.onDidChangeVisibleTextEditors = this.onDidChangeVisibleTextEditors;
    this.window.onDidChangeActiveColorTheme = () => disposable;
    this.window.createTextEditorDecorationType = () => ++lastDecorationTypeId;
    this.window.showWarningMessage = (message: string) => this.warnings.push(message);
    this.window.showErrorMessage = (message: string) => this.errors.push(message);
    this.window.visibleTextEditors = [];
    this.window.registerTreeDataProvider = () => disposable;
    this.window.registerWebviewViewProvider = (name: string, provider: any) => {
      this._webviewProviders.set(name, provider);
      return disposable;
    };
    this.window.createWebviewPanel = (viewType: string) => {
      const { webview, pagePromise } = this._createWebviewAndPage();
      const didDispose = new EventEmitter<void>();
      const didChangeViewState = new EventEmitter<{ webviewPanel: any }>();
      const panel: any = {};
      panel.onDidDispose = didDispose.event;
      panel.onDidChangeViewState = didChangeViewState.event;
      panel.webview = webview;
      panel.visible = true;
      webview.onDidChangeVisibility((visibilityState: string) => {
        panel.visible = visibilityState === 'visible';
        didChangeViewState.fire({ webviewPanel: panel });
      });
      void pagePromise.then(webview => {
        if (!webview) {
          // test ended.
          return;
        }
        webview.on('close', () => {
          panel.dispose();
          webviews.delete(webview);
        });
        const webviews = this._webViewsByPanelType.get(viewType) ?? new Set();
        webviews.add(webview);
        this._webViewsByPanelType.set(viewType, webviews);
      });
      panel.dispose = () => {
        void pagePromise.then(page => page?.close());
        didDispose.fire();
      };
      return panel;
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
    this.window.withProgress = async (opts: any, callback: any) => {
      const progress = {
        report: (data: any) => this.lastWithProgressData = data,
      };
      await callback(progress, new CancellationTokenSource().token);
    };
    this.window.showTextDocument = (document: TextDocument) => {
      const editor = new TextEditor(document);
      this.window.visibleTextEditors.push(editor);
      this.window.activeTextEditor = editor;
      this._didChangeVisibleTextEditors.fire(this.window.visibleTextEditors);
      this._didChangeActiveTextEditor.fire(this.window.activeTextEditor);
      return editor;
    };
    this.window.showQuickPick = async (options: any) => {
      return this.window.mockQuickPick(options);
    };
    this.window.registerTerminalLinkProvider = () => disposable;
    Object.defineProperty(this.window, 'activeColorTheme', {
      get: () => {
        const theme: string = this.workspace.getConfiguration('workbench').get('colorTheme', 'Dark Modern');
        const kind = /Dark/i.test(theme) ? 2 : 1;
        return { kind };
      },
    });

    this.workspace.onDidChangeWorkspaceFolders = this.onDidChangeWorkspaceFolders;
    this.workspace.onDidChangeTextDocument = this.onDidChangeTextDocument;
    this.workspace.onDidChangeConfiguration = this.onDidChangeConfiguration;
    this.workspace.createFileSystemWatcher = (glob: string) => {
      const watcher = new FileSystemWatcher(this, glob);
      this.fsWatchers.add(watcher);
      return watcher;
    };
    this.workspace.workspaceFolders = [];
    this.workspace.openTextDocument = async (file: string) => {
      const document = new TextDocument(Uri.file(file));
      await document._load();
      return document;
    };

    this.workspace.findFiles = async (pattern: string) => {
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
    const settings: Record<string, any> = {
      'workbench.colorTheme': 'Dark Modern',
    };
    const { properties } = require('../../package.json').contributes.configuration;
    for (const [key, value] of Object.entries(properties))
      settings[key] = (value as any).default;

    this.workspace.getConfiguration = (scope: string) => {
      return {
        get: (key: string) => settings[scope + '.' + key],
        update: (key: string, value: any, notifyListeners?: boolean) => {
          settings[scope + '.' + key] = value;
          if (notifyListeners) {
            this._didChangeConfiguration.fire({
              affectsConfiguration: (prefix: string) => (scope + '.' + key).startsWith(prefix)
            });
          }
        },
        inspect: (key: string) => {
          return { defaultValue: false, globalValue: settings[scope + '.' + key] };
        },
      };
    };

    this.env.clipboard = {
      writeText: async (text: string) => this._clipboardText = text,
      readText: async () => this._clipboardText,
    };
  }

  async activate() {
    for (const extension of this.extensions)
      await extension.activate();

    for (const [name, provider] of this._webviewProviders) {
      const { webview, pagePromise } = this._createWebviewAndPage();
      provider?.resolveWebviewView({ webview, onDidChangeVisibility: () => disposable });
      const page = await pagePromise;
      if (page)
        this.webViews.set(name, page);
    }
  }

  dispose() {
    for (const d of this.context.subscriptions)
      d.dispose();
  }

  webViewsByPanelType(viewType: string) {
    const webviews = this._webViewsByPanelType.get(viewType);
    return webviews ? [...webviews] : [];
  }

  async changeVisibility(webview: Page, state: 'visible' | 'hidden') {
    if (state === 'visible')
      await webview.goto('http://localhost');
    else
      await webview.goto('http://localhost/hidden');
  }

  private _createWebviewAndPage() {
    let initializedPage: Page | undefined = undefined;
    const webview: any = {};
    webview.asWebviewUri = (uri: Uri) => path.relative(this.context.extensionUri.fsPath, uri.fsPath).replace(/\\/g, '/');
    const didReceiveMessage = new EventEmitter<any>();
    const didChangeVisibility = new EventEmitter<'visible' | 'hidden'>();
    webview.onDidReceiveMessage = didReceiveMessage.event;
    webview.onDidChangeVisibility = didChangeVisibility.event;
    webview.cspSource = 'http://localhost/';
    const pendingMessages: any[] = [];
    webview.postMessage = (data: any) => {
      if (!initializedPage) {
        pendingMessages.push(data);
        return;
      }
      initializedPage.evaluate((data: any) => {
        const event = new globalThis.Event('message');
        (event as any).data = data;
        (globalThis as any).dispatchEvent(event);
      }, data).catch(() => {});
    };
    const createPage = async () => {
      const context = await this._browser.newContext();
      const page = await context.newPage();
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (!url.startsWith('http://localhost/')) {
          await route.continue();
        } else if (url === 'http://localhost/') {
          await route.fulfill({ body: webview.html });
        } else if (url === 'http://localhost/hidden') {
          await route.fulfill({ body: 'hidden webview' });
        } else {
          const suffix = url.substring('http://localhost/'.length);
          const buffer = fs.readFileSync(path.join(this.context.extensionUri.fsPath, suffix));
          await route.fulfill({ body: buffer });
        }
      });
      page.on('load', () => {
        const url = page.url();
        if (url === 'http://localhost/')
          didChangeVisibility.fire('visible');
        else if (url === 'http://localhost/hidden')
          didChangeVisibility.fire('hidden');
      });
      await page.addInitScript(() => {
        (globalThis as any).acquireVsCodeApi = () => globalThis;
      });
      await page.goto('http://localhost');
      await page.exposeFunction('postMessage', (data: any) => didReceiveMessage.fire(data));
      this.context.subscriptions.push({
        dispose: () => {
          context.close().catch(() => {});
        }
      });
      initializedPage = page;
      for (const m of pendingMessages)
        webview.postMessage(m);
      return page;
    };
    const pagePromise = createPage().catch(() => null);
    return { webview, pagePromise };
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
      await editor.document._load();
      if (!this.window.activeTextEditor)
        this.window.activeTextEditor = editor;
      this.window.visibleTextEditors.push(editor);
    }
    this._didChangeVisibleTextEditors.fire(this.window.visibleTextEditors);
    this._didChangeActiveTextEditor.fire(this.window.activeTextEditor);
    return this.window.visibleTextEditors;
  }

  renderExecLog(indent: string) {
    const log: string[] = [''];
    for (const extension of this.extensions)
      log.push(...extension.playwrightTestLog());
    return trimLog(unescapeRegex(log.join(`\n  ${indent}`)).replace(/\\/g, '/')) + `\n${indent}`;
  }

  async renderProjectTree(): Promise<string> {
    const result: string[] = [''];
    const webView = this.webViews.get('pw.extension.settingsView')!;
    const selectedConfig = await webView.getByTestId('models').evaluate((e: HTMLSelectElement) => e.selectedOptions[0].textContent);
    result.push(`    config: ${selectedConfig}`);
    const projectLocators = await webView.getByTestId('projects').locator('div').locator('label').all();
    for (const projectLocator of projectLocators) {
      const checked = await projectLocator.locator('input').isChecked();
      const name = await projectLocator.textContent();
      result.push(`    ${checked ? '[x]' : '[ ]'} ${name}`);
    }
    return result.join('\n');
  }
}

const asciiRegex = new RegExp('[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))', 'g');
export function stripAscii(str: string): string {
  return str.replace(asciiRegex, '');
}

function unescapeRegex(regex: string) {
  return regex.replace(/\\(.)/g, '$1');
}

function trimLog(log: string) {
  return log.split('\n').map(line => line.trimEnd()).join('\n');
}

const ansiRegex = new RegExp('[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))', 'g');
export function stripAnsi(str: string): string {
  return str.replace(ansiRegex, '');
}

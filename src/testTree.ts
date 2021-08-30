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

import * as path from 'path';
import * as vscode from 'vscode';
import * as StackUtils from 'stack-utils';

import { logger } from './logger';
import { DEFAULT_CONFIG, PlaywrightTestConfig, PlaywrightTest } from './playwrightTest';
import type * as playwrightTestTypes from './testTypes';
import { assert } from './utils';
import { testControllerEvents } from './extension';

const stackUtils = new StackUtils();

type PlaywrightTestData = TestFile | TestHeading | TestCase;

let generationCounter = 0;
export const testData = new WeakMap<vscode.TestItem, PlaywrightTestData>();

type Ancestors = {
  item: vscode.TestItem,
  children: vscode.TestItem[]
}

export class TestFile {
  public didResolve = false;
  constructor(
    private readonly playwrightTest: PlaywrightTest,
    private readonly workspaceFolder: vscode.WorkspaceFolder,
    private readonly config: PlaywrightTestConfig,
    private readonly project: string,
  ) { }

  public async updateFromDisk(ctrl: vscode.TestController, item: vscode.TestItem, cachedTests?: playwrightTestTypes.JSONReport) {
    try {
      item.error = undefined;
      await this._updateFromDisk(ctrl, item, cachedTests);
    } catch (e) {
      console.debug('--Playwright Test Exception while reloading the tests--');
      console.debug(e);
      vscode.window.showWarningMessage(e.toString());
      item.error = e.stack;
    }
  }

  /**
   * Parses the tests from the input text, and updates the tests contained
   * by this file to be those from the text,
   */
  private async _updateFromDisk(controller: vscode.TestController, item: vscode.TestItem, cachedTests?: playwrightTestTypes.JSONReport) {
    logger.debug(`TestFile._updateFromDisk ${this.config === DEFAULT_CONFIG ? 'default' : this.config} and ${this.project}`);
    const ancestors: Ancestors[] = [{ item, children: [] }];
    const tests = cachedTests ? cachedTests : await this.playwrightTest.listTests(this.config, this.project, item.uri!.fsPath);
    if (!tests)
      return;
    const thisGeneration = generationCounter++;
    this.didResolve = true;

    const ascend = (depth: number) => {
      while (ancestors.length > depth) {
        const finished = ancestors.pop()!;
        finished.item.children.replace(finished.children);
      }
    };

    const addTests = (suite: playwrightTestTypes.TestSuite, parent: Ancestors) => {
      for (const test of suite.specs) {
        const data = new TestCase(this.playwrightTest, this.config, this.project, test, thisGeneration);
        const id = `${test.file}/${data.getLabel()}`;
        const range = createRangeFromPlaywright(test);

        const tcase = controller.createTestItem(id, data.getLabel(), item.uri);
        testData.set(tcase, data);
        tcase.range = range;
        parent.children.push(tcase);
        testControllerEvents.emit('testItemCreated', tcase, this);
      }
      for (const subSuite of suite.suites || []) {
        const range = createRangeFromPlaywright(subSuite);
        const id = `${subSuite.file}/${subSuite.title}`;
        const thead = controller.createTestItem(id, subSuite.title, item.uri);
        thead.range = range;
        testData.set(thead, new TestHeading(thisGeneration));
        parent.children.push(thead);
        const ancestor: Ancestors = { item: thead, children: [] };
        ancestors.push(ancestor);
        addTests(subSuite, ancestor);
      }
    };

    for (const suite of tests.suites)
      addTests(suite, ancestors[0]);

    ascend(0); // finish and assign children for all remaining items
  }
}

export class TestHeading {
  constructor(public generation: number) { }
}

export class TestCase {
  constructor(
    private readonly playwrightTest: PlaywrightTest,
    private readonly config: PlaywrightTestConfig,
    private readonly project: string,
    private readonly spec: playwrightTestTypes.TestSpec,
    public generation: number
  ) { }

  getLabel() {
    if (this.project)
      return `${this.spec.title} [${this.project}]`;
    return this.spec.title;
  }

  getLabelWithFilename() {
    const prefix = this.project ? `[${this.project}] › ` : '';
    return `${prefix}${this.spec.file} › ${this.spec.title}`;
  }

  async run(item: vscode.TestItem, workspaceFolder: vscode.WorkspaceFolder, options: vscode.TestRun, debug: boolean): Promise<void> {
    logger.debug(`Running test ${item.label} debug=${debug}`);
    if (debug)
      await this._debug(item, options, workspaceFolder);
    else
      await this._run(item, options);
  }

  async _debug(item: vscode.TestItem, options: vscode.TestRun, workspaceFolder: vscode.WorkspaceFolder): Promise<void> {
    await this.playwrightTest.debug(this.config, this.project, workspaceFolder, item.uri!.fsPath, this.spec.line);
  }

  async _run(item: vscode.TestItem, options: vscode.TestRun): Promise<void> {
    let result;
    try {
      result = await this.playwrightTest.runTest(this.config, this.project, item.uri!.fsPath, this.spec.line);
    } catch (error) {
      options.errored(item, new vscode.TestMessage(error.toString()));
      logger.debug('Could not run tests', error);
      return;
    }
    const processSpec = (spec: playwrightTestTypes.TestSpec) => {
      assert(spec.tests.length === 1);
      const test = spec.tests[0];
      assert(test.results.length === 1);
      const result = test.results[0];
      for (const entry of result.stderr)
        options.appendOutput(extendLineFeedWithCarriageReturns(decodeJSONReporterSTDIOEntry(entry)));
      for (const entry of result.stdout)
        options.appendOutput(extendLineFeedWithCarriageReturns(decodeJSONReporterSTDIOEntry(entry)));
      switch (result.status) {
        case 'passed':
          options.passed(item, result.duration);
          break;
        case 'failed': {
          options.failed(item, parsePlaywrightTestError(spec, item, result.error), result.duration);
          if (result.error)
            options.appendOutput(extendLineFeedWithCarriageReturns(result.error.message) + '\r\n' + extendLineFeedWithCarriageReturns(result.error.stack) + '\r\n');
          break;
        }
        case 'skipped':
          options.skipped(item);
          break;
        case 'timedOut': {
          const message = new vscode.TestMessage('Timeout!');
          message.location = new vscode.Location(item.uri!, new vscode.Position(spec.line - 1, spec.column - 1));
          options.failed(item, message);
          break;
        }
        default:
          throw new Error(`Unexpected status ${result.status}`);
      }
    };
    let found = false;
    const visitSuite = (suite: playwrightTestTypes.TestSuite) => {
      if (found)
        return;
      for (const spec of suite.specs) {
        if (spec.line === this.spec.line && spec.column === this.spec.column) {
          found = true;
          processSpec(spec);
          break;
        }
      }
      for (const subSuite of suite.suites || [])
        visitSuite(subSuite);
    };
    for (const suite of result.suites)
      visitSuite(suite);
  }
}

function parsePlaywrightTestError(spec: playwrightTestTypes.TestSpec, item: vscode.TestItem, error?: playwrightTestTypes.TestError): vscode.TestMessage {
  if (!error || !error.stack || !error.message) {
    const message = new vscode.TestMessage('Error could not be extracted!');
    message.location = new vscode.Location(item.uri!, new vscode.Position(spec.line - 1, spec.column - 1));
    return message;
  }
  const lines = error.stack.split('\n').reverse();
  for (const line of lines) {
    const frame = stackUtils.parseLine(line);
    if (!frame || !frame.file || !frame.line || !frame.column)
      continue;
    if (frame.file === item.uri!.path) {
      const message = new vscode.TestMessage(`${error.message|| ''}\n${error.stack}`);
      const position = new vscode.Position(frame.line - 1, frame.column - 1);
      message.location = new vscode.Location(item.uri!, position);
      return message;
    }
  }
  const message = new vscode.TestMessage(error.message);
  message.location = new vscode.Location(item.uri!, new vscode.Position(spec.line - 1, spec.column - 1));
  return message;
}

function createRangeFromPlaywright(subSuite: playwrightTestTypes.TestSuite | playwrightTestTypes.TestSpec): vscode.Range {
  return new vscode.Range(new vscode.Position(subSuite.line - 1, subSuite.column -1), new vscode.Position(subSuite.line - 1, subSuite.column));
}

function decodeJSONReporterSTDIOEntry(entry: playwrightTestTypes.JSONReportSTDIOEntry): string {
  return 'text' in entry ? entry.text : Buffer.from(entry.buffer, 'base64').toString();
}

function extendLineFeedWithCarriageReturns(input?: string): string {
  if (!input)
    return '';
  return input.replaceAll('\n', '\r\n');
}

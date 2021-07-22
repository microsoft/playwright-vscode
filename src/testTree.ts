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

import * as vscode from 'vscode';
import { logger } from './logger';
import { DEFAULT_CONFIG, getConfigDisplayName, PlaywrightTestConfig, PlaywrightTestNPMPackage } from './playwrightTest';
import * as playwrightTestTypes from './testTypes';
import { assert } from './utils';

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
    private readonly playwrightTest: PlaywrightTestNPMPackage,
    private readonly config: PlaywrightTestConfig,
    private readonly project: string,
  ) { }

  public async updateFromDisk(ctrl: vscode.TestController, item: vscode.TestItem) {
    try {
      item.error = undefined;
      await this._updateFromDisk(ctrl, item);
    } catch (e) {
      console.debug("--Playwright Test Exception while reloading the tests--");
      console.debug(e);
      vscode.window.showErrorMessage(e.toString());
      item.error = e.stack;
    }
  }

  /**
   * Parses the tests from the input text, and updates the tests contained
   * by this file to be those from the text,
   */
  private async _updateFromDisk(controller: vscode.TestController, item: vscode.TestItem) {
    logger.debug(`TestFile._updateFromDisk ${this.config === DEFAULT_CONFIG ? 'default' : this.config} and ${this.project}`);
    const ancestors: Ancestors[] = [{ item, children: [] }];
    const tests = await this.playwrightTest.listTests(this.config, this.project, item.uri!.path);
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
        const id = `${item.uri}/${data.getLabel()}`;
        const range = createRangeFromPlaywright(test);

        const tcase = controller.createTestItem(id, data.getLabel(), item.uri);
        testData.set(tcase, data);
        tcase.range = range;
        parent.children.push(tcase);
      }
      for (const subSuite of suite.suites || []) {
        const range = createRangeFromPlaywright(subSuite);
        const id = `${item.uri}/${subSuite.title}`;

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
    private readonly playwrightTest: PlaywrightTestNPMPackage,
    private readonly config: PlaywrightTestConfig,
    private readonly project: string,
    private readonly spec: playwrightTestTypes.TestSpec,
    public generation: number
  ) { }

  getLabel() {
    return `${this.spec.title} [${this.project}]`;
  }

  async run(item: vscode.TestItem, options: vscode.TestRun, debug: boolean): Promise<void> {
    logger.debug(`Running test ${item.label} debug=${debug}`);
    if (debug)
      await this._debug(item, options);
    else
      await this._run(item, options);
  }

  async _debug(item: vscode.TestItem, options: vscode.TestRun): Promise<void> {
    await this.playwrightTest.debug(this.config, this.project, item.uri!.path, this.spec.line);
  }

  async _run(item: vscode.TestItem, options: vscode.TestRun): Promise<void> {
    let result;
    try {
      result = await this.playwrightTest.runTest(this.config, this.project, item.uri!.path, this.spec.line);
    } catch (error) {
      options.failed(item, new vscode.TestMessage(error.toString()));
      console.log(error);
      return;
    }
    const processSpec = (spec: playwrightTestTypes.TestSpec) => {
      assert(spec.tests);
      assert(spec.tests.length === 1);
      const test = spec.tests[0];
      assert(test.results.length === 1);
      const result = test.results[0];
      for (const entry of result.stderr)
        options.appendOutput(decodeJSONReporterSTDIOEntry(entry));
      for (const entry of result.stdout)
        options.appendOutput(decodeJSONReporterSTDIOEntry(entry));
      switch (result.status) {
        case "passed":
          options.passed(item, result.duration);
          break;
        case "failed": {
          let message = new vscode.TestMessage('');
          if (result.error?.stack) {
            message = new vscode.TestMessage(result.error.stack);
            message.location = new vscode.Location(item.uri!, item.range!);
          }
          options.failed(item, message, result.duration);
          break;
        }
        case "skipped":
          options.skipped(item);
          break;
        case "timedOut":
          options.failed(item, new vscode.TestMessage('Timeout!'), result.duration);
          break;
        default:
          throw new Error(`Unexpected status ${result.status}`);
      }
      // TODO: better diffs
      /**
     *
    const message = vscode.TestMessage.diff(`Expected ${item.label}`, String(this.expected), String(actual));
    message.location = new vscode.Location(item.uri!, item.range!);
    options.appendMessage(item, message);
    options.setState(item, vscode.TestResultState.Failed, duration);
     */
    };
    let found = false;
    const visit = (suite: playwrightTestTypes.TestSuite) => {
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
        visit(subSuite);
    };
    for (const suite of result.suites)
      visit(suite);
  }
}

function createRangeFromPlaywright(subSuite: playwrightTestTypes.TestSuite | playwrightTestTypes.TestSpec): vscode.Range {
  return new vscode.Range(new vscode.Position(subSuite.line - 1, subSuite.column), new vscode.Position(subSuite.line - 1, subSuite.column + 1));
}

function decodeJSONReporterSTDIOEntry(entry: playwrightTestTypes.JSONReportSTDIOEntry): string {
  return 'text' in entry ? entry.text : Buffer.from(entry.buffer, 'base64').toString();
}

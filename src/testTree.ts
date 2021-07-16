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
import { PlaywrightTestNPMPackage } from './playwrightTest';
import * as playwrightTestTypes from './testTypes';
import { assert } from './utils';

type MarkdownTestData = TestFile | TestHeading | TestCase;

let generationCounter = 0;
export const testData = new WeakMap<vscode.TestItem, MarkdownTestData>();

export class TestFile {
  public didResolve = false;
  constructor(
    private readonly playwrightTest: PlaywrightTestNPMPackage,
  ) { }

  public async updateFromDisk(item: vscode.TestItem) {
    try {
      item.error = undefined;
      await this._updateFromDisk(item);
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
  private async _updateFromDisk(item: vscode.TestItem) {
    const ancestors = [{ item, children: [] as vscode.TestItem[]}];
    const tests = await this.playwrightTest.listTests(item.uri!.path);
    if (!tests)
      return;
    const thisGeneration = generationCounter++;
    this.didResolve = true;

    const ascend = (depth: number) => {
      while (ancestors.length > depth) {
        const finished = ancestors.pop()!;
        finished.item.children.all = finished.children;
      }
    };

    const addTests = (suite: playwrightTestTypes.Suite, parent: vscode.TestItem) => {
      for (const test of suite.specs) {
        const data = new TestCase(this.playwrightTest, test, thisGeneration);
        const id = `${item.uri}/${data.getLabel()}`;
        const range = createRangeFromPlaywright(test);
        const parent = ancestors[ancestors.length - 1];

        
        const tcase = vscode.test.createTestItem(id, data.getLabel(), item.uri);
        testData.set(tcase, data);
        tcase.range = range;
        parent.children.push(tcase);
      }
      for (const subSuite of suite.suites || []) {
        const range = createRangeFromPlaywright(subSuite);
        const parent = ancestors[ancestors.length - 1];
        const id = `${item.uri}/${subSuite.title}`;

        const thead = vscode.test.createTestItem(id, subSuite.title, item.uri);
        thead.range = range;
        testData.set(thead, new TestHeading(thisGeneration));
        parent.children.push(thead);
        ancestors.push({ item: thead, children: [] });
        addTests(subSuite, thead);
      }
    };

    for (const suite of tests.suites)
      addTests(suite, item);

    ascend(0); // finish and assign children for all remaining items
  }
}

export class TestHeading {
  constructor(public generation: number) { }
}

export class TestCase {
  constructor(
    private readonly playwrightTest: PlaywrightTestNPMPackage,
    private readonly spec: playwrightTestTypes.TestSpec,
    public generation: number
  ) { }

  getLabel() {
    return this.spec.title;
  }

  async run(item: vscode.TestItem, options: vscode.TestRun): Promise<void> {
    let result;
    try {
      result = await this.playwrightTest.runTest(item.uri!.path, this.spec.line);
    } catch (error) {
      options.setState(item, vscode.TestResultState.Errored);
      console.log(error);
      return;
    }
    const processSpec = (spec: playwrightTestTypes.TestSpec) => {
      assert(spec.tests);
      assert(spec.tests.length === 1);
      const test = spec.tests[0];
      assert(test.results.length === 1);
      switch (test.results[0].status) {
        case "passed":
          options.setState(item, vscode.TestResultState.Passed, test.results[0].duration);
          break;
        case "failed":
          if (test.results[0].error) {
            const message = new vscode.TestMessage(test.results[0].error.stack);
            message.location = new vscode.Location(item.uri!, item.range!);
            options.appendMessage(item, message);
          }
          options.setState(item, vscode.TestResultState.Failed, test.results[0].duration);
          break;
        case "skipped":
          options.setState(item, vscode.TestResultState.Skipped, test.results[0].duration);
          break;
        case "timedOut":
          options.setState(item, vscode.TestResultState.Errored, test.results[0].duration);
          break;
        default:
          throw new Error(`Unexpected status ${test.results[0].status}`);
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
    const visit = (suite: playwrightTestTypes.Suite) => {
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

function createRangeFromPlaywright(subSuite: playwrightTestTypes.Suite | playwrightTestTypes.TestSpec): vscode.Range {
  return new vscode.Range(new vscode.Position(subSuite.line - 1, subSuite.column), new vscode.Position(subSuite.line - 1, subSuite.column + 1));
}

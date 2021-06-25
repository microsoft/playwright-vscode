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
  constructor(
    private readonly playwrightTest: PlaywrightTestNPMPackage,
  ) { }

  public async updateFromDisk(controller: vscode.TestController, item: vscode.TestItem) {
    try {
      item.error = undefined;
      await this.updateFromDiskImpl(controller, item);
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
  private async updateFromDiskImpl(controller: vscode.TestController, item: vscode.TestItem) {
    const ancestors: vscode.TestItem[] = [item];
    const thisGeneration = generationCounter++;
    const tests = await this.playwrightTest.listTests(item.uri!.path);
    if (!tests)
      return;

    const addTests = (suite: playwrightTestTypes.Suite, parent: vscode.TestItem) => {
      for (const test of suite.specs) {
        const data = new TestCase(this.playwrightTest, test, thisGeneration);
        const id = `${item.uri}/${data.getLabel()}`;
        const existing = parent.children.get(id);
        const range = createRangeFromPlaywright(test);
        if (existing) {
          (testData.get(existing) as TestHeading).generation = thisGeneration;
          existing.range = range;
        } else {
          const tcase = controller.createTestItem(id, data.getLabel(), parent, item.uri);
          testData.set(tcase, data);
          tcase.range = range;
        }
      }
      for (const subSuite of suite.suites || []) {
        const id = `${item.uri}/${subSuite.title}`;
        const existing = parent.children.get(id);
        const data = existing && testData.get(existing);
        const range = createRangeFromPlaywright(subSuite);
        if (existing && data instanceof TestHeading) {
          ancestors.push(existing);
          data.generation = thisGeneration;
          existing.range = range;
          addTests(subSuite, existing);
        } else {
          existing?.dispose();
          const thead = controller.createTestItem(id, subSuite.title, parent, item.uri);
          thead.range = range;
          testData.set(thead, new TestHeading(thisGeneration));
          ancestors.push(thead);
          addTests(subSuite, thead);
        }
      }
    };

    for (const suite of tests.suites)
      addTests(suite, item);

    this.prune(item, thisGeneration);
  }

  /**
   * Removes tests that were deleted from the source. Each test suite and case
   * has a 'generation' counter which is updated each time we discover it. This
   * is called after discovery is finished to remove any children who are no
   * longer in this generation.
   */
  private prune(item: vscode.TestItem, thisGeneration: number) {
    const queue: vscode.TestItem[] = [item];
    for (const parent of queue) {
      for (const child of parent.children.values()) {
        const data = testData.get(child) as TestCase | TestHeading;
        if (data.generation < thisGeneration) {
          child.dispose();
        } else if (data instanceof TestHeading) {
          queue.push(child);
        }
      }
    }
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

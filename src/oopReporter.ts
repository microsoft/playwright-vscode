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

import { FullConfig, FullResult, Location, Reporter, Suite, TestCase, TestError, TestResult, TestStep } from './reporter';
import { ConnectionTransport, PipeTransport, WebSocketTransport } from './transport';
import fs from 'fs';

export type Entry = {
  id: string;
  type: 'project' | 'file' | 'suite' | 'test';
  file: string;
  line: number;
  column: number;
  title: string;
  children?: Entry[];
};

export type TestBeginParams = {
  testId: string;
  title: string;
  location: Location;
};

export type TestEndParams = {
  testId: string;
  duration: number;
  error: TestError | undefined;
  ok: boolean;
};

export type StepBeginParams = {
  testId: string;
  stepId: string;
  title: string;
  location?: Location;
};

export type StepEndParams = {
  testId: string;
  stepId: string;
  duration: number;
  error: TestError | undefined;
};

class OopReporter implements Reporter {
  config!: FullConfig;
  suite!: Suite;
  private _transport: Promise<ConnectionTransport>;

  constructor() {
    if (process.env.PW_TEST_REPORTER_WS_ENDPOINT) {
      this._transport = WebSocketTransport.connect(process.env.PW_TEST_REPORTER_WS_ENDPOINT);
    } else if (process.stdin.isTTY)
      this._transport = Promise.resolve(new PipeTransport(fs.createWriteStream('', { fd: 2 }), fs.createReadStream('', { fd: 1 })));
    else
      this._transport = Promise.resolve(new PipeTransport(fs.createWriteStream('', { fd: 4 }), fs.createReadStream('', { fd: 3 })));
    this._transport.then(t => { t.onclose = () => process.exit(0)});
  }

  printsToStdio() {
    return false;
  }

  onBegin(config: FullConfig, rootSuite: Suite) {
    const entryMap = new Map<string, Entry>();
    const files: Entry[] = [];

    const visit = (suite: Suite, collection: Entry[]) => {
      // Don't produce entries for file suits.
      for (const child of suite.suites) {
        const id = this._entryId(child);
        let entry = entryMap.get(id);
        if (!entry) {
          let type: 'project' | 'file' | 'suite';
          if (!child.location)
            type = 'project';
          else if (child.location.line === 0)
            type = 'file';
          else
            type = 'suite'
          entry = {
            id,
            type,
            title: child.title,
            file: child.location?.file || '',
            line: child.location?.line || 0,
            column: child.location?.column || 0,
            children: [],
          };
          entryMap.set(id, entry);
          if (type === 'file')
            files.push(entry);
          collection.push(entry);
          visit(child, entry.children!);
        }
      }

      for (const test of suite.tests) {
        const id = this._entryId(test);
        let entry = entryMap.get(id);
        if (!entry) {
          entry = {
            id,
            type: 'test',
            title: test.title,
            file: test.location.file,
            line: test.location.line,
            column: test.location.column,
          };
          entryMap.set(id, entry);
          collection.push(entry);
        }
      }
    }

    visit(rootSuite, []);
    this._emit('onBegin', { files });
  }

  onTestBegin?(test: TestCase, result: TestResult): void {
    const testId = this._entryId(test);
    const params: TestBeginParams = { testId, title: test.title, location: test.location };
    this._emit('onTestBegin', params);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const params: TestEndParams = {
      testId: this._entryId(test),
      duration: result.duration,
      error: result.error,
      ok: test.ok()
    };
    this._emit('onTestEnd', params);
  }

  onStepBegin(test: TestCase, result: TestResult, step: TestStep) {
    const testId = this._entryId(test);
    const stepId = this._entryId(step);
    const params: StepBeginParams = { testId, stepId, title: step.title, location: step.location };
    this._emit('onStepBegin', params);
  }

  onStepEnd(test: TestCase, result: TestResult, step: TestStep) {
    const params: StepEndParams = {
      testId: this._entryId(test),
      stepId: this._entryId(step),
      duration: step.duration,
      error: step.error,
    };
    this._emit('onStepEnd', params);
  }

  onError(error: TestError): void {
    this._emit('onError', { error });
  }

  onEnd(result: FullResult): void | Promise<void> {
    this._emit('onEnd', {});
  }

  private _entryId(entry: TestCase | Suite | TestStep): string {
    if (entry.location)
      return entry.location!.file + ':' + entry.location!.line;
    // Merge projects.
    return '';
  }

  private _emit(method: string, params: Object) {
    this._transport.then(t => t.send({ id: 0, method, params }));
  }
}

export default OopReporter;

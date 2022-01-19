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

import { FullConfig, FullResult, Reporter, Suite, TestCase, TestError, TestResult } from './reporter';
import { PipeTransport } from './transport';

export type Entry = {
  id: string;
  type: 'test' | 'suite';
  file: string;
  line: number;
  column: number;
  title: string;
  titlePath: string[];
};

class OopReporter implements Reporter {
  config!: FullConfig;
  suite!: Suite;
  private _transport: PipeTransport;

  constructor() {
    this._transport = new PipeTransport(process.stdout, process.stdin);
    this._transport.onclose = () => process.exit(0);
  }

  printsToStdio() {
    return true;
  }

  onBegin(config: FullConfig, rootSuite: Suite) {
    const entries = new Map<string, Entry>();
    for (const project of rootSuite.suites) {
      const visit = (suite: Suite) => {
        // Don't produce entries for file suits.
        if (suite.location!.line !== 0 && suite.location!.column !== 0) {
          const id = this._entryId(suite);
          let entry = entries.get(id);
          if (!entry) {
            entry = {
              id,
              type: 'suite',
              title: suite.title,
              titlePath: suite.titlePath().slice(3),
              file: suite.location!.file,
              line: suite.location!.line,
              column: suite.location!.column,
            };
            entries.set(id, entry);
          }
        }

        for (const test of suite.tests) {
          const id = this._entryId(test);
          let entry = entries.get(id);
          if (!entry) {
            entry = {
              id,
              type: 'test',
              title: test.title,
              titlePath: test.titlePath().slice(3),
              file: test.location.file,
              line: test.location.line,
              column: test.location.column,
            };
            entries.set(id, entry);
          }
        }
      };

      project.suites.map(visit);
    }

    this._emit('onBegin', { entries: [...entries.values()] });
  }

  onTestBegin?(test: TestCase, result: TestResult): void {
    const testId = this._entryId(test);
    this._emit('onTestBegin', { testId, title: test.title, location: test.location });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this._emit('onTestEnd', {
      testId: this._entryId(test),
      duration: result.duration,
      error: result.error?.message,
      ok: test.ok()
    });
  }

  onError(error: TestError): void {
    this._emit('onError', { error });
  }

  onEnd(result: FullResult): void | Promise<void> {
    this._emit('onEnd', {});
  }

  private _entryId(entry: TestCase | Suite): string {
    return entry.location!.file + ':' + entry.location!.line;
  }

  private _emit(method: string, params: Object) {
    this._transport.send({ id: 0, method, params });
  }
}

export default OopReporter;

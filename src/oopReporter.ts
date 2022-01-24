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

import { FullConfig, FullResult, Location, Reporter, Suite, TestCase, TestError, TestResult } from './reporter';
import { PipeTransport } from './transport';
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

class OopReporter implements Reporter {
  config!: FullConfig;
  suite!: Suite;
  private _transport: PipeTransport;

  constructor() {
    this._transport = new PipeTransport(fs.createWriteStream('', { fd: 4 }), fs.createReadStream('', { fd: 3 }));
    this._transport.onclose = () => process.exit(0);
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

  onError(error: TestError): void {
    this._emit('onError', { error });
  }

  onEnd(result: FullResult): void | Promise<void> {
    this._emit('onEnd', {});
  }

  private _entryId(entry: TestCase | Suite): string {
    if (entry.location)
      return entry.location!.file + ':' + entry.location!.line;
    // Merge projects.
    return '';
  }

  private _emit(method: string, params: Object) {
    this._transport.send({ id: 0, method, params });
  }
}

export default OopReporter;

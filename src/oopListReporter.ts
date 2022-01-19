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

import { FullConfig, Reporter, Suite } from './reporter';
import { PipeTransport } from './transport';

export type FileReport = {
  file: string;
  entries: { [key: string]: Entry };
};

export type Entry = {
  type: 'test' | 'suite';
  line: number;
  column: number;
  title: string;
  titlePath: string[];
};

class OopListReporter implements Reporter {
  private _transport: PipeTransport;

  constructor() {
    this._transport = new PipeTransport(process.stdout, process.stdin);
    this._transport.onclose = () => process.exit(0);
  }

  printsToStdio() {
    return true;
  }

  onBegin(config: FullConfig, rootSuite: Suite) {
    const report = new Map<string, FileReport>();
    for (const project of rootSuite.suites) {
      for (const file of project.suites) {

        let fileReport = report.get(file.location!.file);
        if (!fileReport) {
          fileReport = {
            file: file.location!.file,
            entries: {},
          };
          report.set(file.location!.file, fileReport);
        }

        for (const test of file.allTests()) {
          const id = test.location.line + ':' + test.location.column;
          let entry = fileReport.entries[id];
          if (!entry) {
            entry = {
              type: 'test',
              title: test.title,
              titlePath: test.titlePath().slice(3),
              line: test.location.line,
              column: test.location.column,
            };
            fileReport.entries[id] = entry;
          }
        }

        const visit = (suite: Suite) => {
          const id = suite.location!.line + ':' + suite.location!.column;
          let entry = fileReport!.entries[id];
          if (!entry) {
            entry = {
              type: 'suite',
              title: suite.title,
              titlePath: suite.titlePath().slice(3),
              line: suite.location!.line,
              column: suite.location!.column,
            };
            fileReport!.entries[id] = entry;
          }
          suite.suites.map(visit);
        };
    
        file.suites.map(visit);
      }
    }

    this._emit('onBegin', [...report.values()]);
  }

  private _emit(method: string, params: Object) {
    this._transport.send({ id: 0, method, params });
  }
}

export default OopListReporter;

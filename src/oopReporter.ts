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

import type { FullConfig, FullResult, Location, Reporter, Suite, TestCase, TestError, TestResult, TestStatus, TestStep } from './reporter';
import { ConnectionTransport, WebSocketTransport } from './transport';

export type EntryType = 'project' | 'file' | 'suite' | 'test';
export type Entry = {
  type: EntryType;
  title: string;
  location: Location;
  children?: Entry[];
};

export type TestBeginParams = {
  title: string;
  location: Location;
};

export type TestEndParams = {
  title: string;
  location: Location;
  duration: number;
  errors: TestError[];
  expectedStatus: TestStatus;
  status: TestStatus;
};

export type StepBeginParams = {
  title: string;
  location: Location;
};

export type StepEndParams = {
  duration: number;
  location: Location;
  error: TestError | undefined;
};

class OopReporter implements Reporter {
  config!: FullConfig;
  suite!: Suite;
  private _transport: Promise<ConnectionTransport>;

  constructor() {
    this._transport = WebSocketTransport.connect(process.env.PW_TEST_REPORTER_WS_ENDPOINT!);
    this._transport.then(t => {
      t.onmessage = message => {
        if (message.method === 'stop')
          process.emit('SIGINT' as any);

      };
      t.onclose = () => process.exit(0);
    });
  }

  printsToStdio() {
    return false;
  }

  onBegin(config: FullConfig, rootSuite: Suite) {
    const visit = (suite: Suite, collection: Entry[]) => {
      // Don't produce entries for file suits.
      for (const child of suite.suites) {
        let type: 'project' | 'file' | 'suite' | 'test';
        if (!child.location)
          type = 'project';
        else if (child.location.line === 0)
          type = 'file';
        else
          type = 'suite';
        const entry: Entry = {
          type,
          title: child.title,
          location: child.location || { file: '', line: 0, column: 0 },
          children: [],
        };
        collection.push(entry);
        visit(child, entry.children!);
      }

      for (const test of suite.tests) {
        const entry: Entry = {
          type: 'test',
          title: test.title,
          location: test.location,
        };
        collection.push(entry);
      }
    };

    const projects: Entry[] = [];
    visit(rootSuite, projects);
    this._emit('onBegin', { projects });
  }

  onTestBegin?(test: TestCase, result: TestResult): void {
    const params: TestBeginParams = { title: test.title, location: test.location };
    this._emit('onTestBegin', params);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const params: TestEndParams = {
      title: test.title,
      location: test.location,
      duration: result.duration,
      errors: result.errors,
      expectedStatus: test.expectedStatus,
      status: result.status,
    };
    this._emit('onTestEnd', params);
  }

  onStepBegin(test: TestCase, result: TestResult, step: TestStep) {
    if (!step.location)
      return;
    const params: StepBeginParams = { title: step.title, location: step.location };
    this._emit('onStepBegin', params);
  }

  onStepEnd(test: TestCase, result: TestResult, step: TestStep) {
    if (!step.location)
      return;
    const params: StepEndParams = {
      location: step.location,
      duration: step.duration,
      error: step.error,
    };
    this._emit('onStepEnd', params);
  }

  onError(error: TestError): void {
    this._emit('onError', { error });
  }

  async onEnd(result: FullResult) {
    this._emit('onEnd', {});
    // Embedder is responsible for terminating the connection.
    await new Promise(() => {});
  }

  private _emit(method: string, params: Object) {
    this._transport.then(t => t.send({ id: 0, method, params }));
  }
}

export default OopReporter;

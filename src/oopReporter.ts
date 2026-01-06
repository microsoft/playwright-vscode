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

import { TeleReporterEmitter } from './upstream/teleEmitter';
import { FullResult, TestCase, TestResult } from './upstream/reporter';

class TeleReporter extends TeleReporterEmitter {
  private _hasSender: boolean;

  constructor(options: any) {
    let messageSink: (message: any) => void;
    if (options?._send) {
      messageSink = options._send;
    } else {
      messageSink = message => {
        console.log(message);
      };
    }
    super(messageSink, { omitBuffers: false, omitOutput: true });
    this._hasSender = !!options?._send;
  }

  async onTestPaused(test: TestCase, result: TestResult): Promise<void> {
    // block indefinitely, we are handling pause via test server events
    await new Promise(() => {});
  }

  async onEnd(result: FullResult) {
    await super.onEnd(result);
    // Embedder is responsible for terminating the connection.
    if (!this._hasSender)
      await new Promise(() => {});
  }
}

export default TeleReporter;

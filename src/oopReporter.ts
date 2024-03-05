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
import { WebSocketTransport } from './transport';
import { FullResult } from './reporter';

class TeleReporter extends TeleReporterEmitter {
  private _hasSender: boolean;

  constructor(options: any) {
    let messageSink: (message: any) => void;
    if (options?._send) {
      messageSink = options._send;
    } else if (process.env.PW_TEST_REPORTER_WS_ENDPOINT) {
      const transport = WebSocketTransport.connect(process.env.PW_TEST_REPORTER_WS_ENDPOINT!);
      transport.then(t => {
        t.onmessage = message => {
          if (message.method === 'stop')
            process.emit('SIGINT' as any);
        };
        t.onclose = () => process.exit(0);
      });
      messageSink = (message => {
        transport.then(t => t.send(message));
      });
    } else {
      messageSink = message => {
        console.log(message);
      };
    }
    super(messageSink, { omitBuffers: true, omitOutput: true });
    this._hasSender = !!options?._send;
  }

  async onEnd(result: FullResult) {
    super.onEnd(result);
    // Embedder is responsible for terminating the connection.
    if (!this._hasSender)
      await new Promise(() => {});
  }
}

export default TeleReporter;

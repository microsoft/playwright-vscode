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

import * as http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { TestListener } from './playwrightTest';
import { ConnectionTransport } from './transport';
import { createGuid } from './utils';
import * as vscodeTypes from './vscodeTypes';
import type { Location, TestError, Entry, StepBeginParams, StepEndParams, TestBeginParams, TestEndParams } from './oopReporter';

export class ReporterServer {
  private _clientSocketPromise: Promise<WebSocket>;
  private _clientSocketCallback!: (socket: WebSocket) => void;
  private _wsServer: WebSocketServer | undefined;
  private _vscode: vscodeTypes.VSCode;

  constructor(vscode: vscodeTypes.VSCode) {
    this._vscode = vscode;
    this._clientSocketPromise = new Promise(f => this._clientSocketCallback = f);
  }

  reporterFile() {
    return require.resolve('./oopReporter');
  }

  async env(options: { selfDestruct: boolean }) {
    const wsEndpoint = await this._listen();
    return {
      PW_TEST_REPORTER: this.reporterFile(),
      PW_TEST_REPORTER_WS_ENDPOINT: wsEndpoint,
      PW_TEST_REPORTER_SELF_DESTRUCT: options.selfDestruct ? '1' : '',
    };
  }

  private async _listen(): Promise<string> {
    const server = http.createServer((_, response) => response.end());
    server.on('error', error => console.error(error));

    const path = '/' + createGuid();
    const wsEndpoint = await new Promise<string>((resolve, reject) => {
      server.listen(0, () => {
        const address = server.address();
        if (!address) {
          reject(new Error('Could not bind server socket'));
          return;
        }
        const wsEndpoint = typeof address === 'string' ? `${address}${path}` : `ws://127.0.0.1:${address.port}${path}`;
        resolve(wsEndpoint);
      }).on('error', reject);
    });

    const wsServer = new WebSocketServer({ server, path });
    wsServer.on('connection', async socket => this._clientSocketCallback(socket));
    this._wsServer = wsServer;

    return wsEndpoint;
  }

  async wireTestListener(listener: TestListener, token: vscodeTypes.CancellationToken) {
    let timeout: NodeJS.Timeout | undefined;
    const transport = await this._waitForTransport();

    const killTestProcess = () => {
      if (!transport.isClosed()) {
        try {
          transport.send({ id: 0, method: 'stop', params: {} });
          timeout = setTimeout(() => transport.close(), 30000);
        } catch {
          // Close in case we are getting an error or close is racing back from remote.
          transport.close();
        }
      }
    };

    token.onCancellationRequested(killTestProcess);
    if (token.isCancellationRequested)
      killTestProcess();

    transport.onmessage = message => {
      if (token.isCancellationRequested && message.method !== 'onEnd')
        return;
      switch (message.method) {
        case 'onBegin': {
          (message.params as { projects: Entry[] }).projects.forEach((e: Entry) => patchLocation(this._vscode, e));
          listener.onBegin?.(message.params);
          break;
        }
        case 'onTestBegin': listener.onTestBegin?.(patchLocation(this._vscode, message.params as TestBeginParams)); break;
        case 'onTestEnd': listener.onTestEnd?.(patchLocation(this._vscode, message.params as TestEndParams)); break;
        case 'onStepBegin': listener.onStepBegin?.(patchLocation(this._vscode, message.params as StepBeginParams)); break;
        case 'onStepEnd': listener.onStepEnd?.(patchLocation(this._vscode, message.params as StepEndParams)); break;
        case 'onError': listener.onError?.(patchLocation(this._vscode, message.params as { error: TestError })); break;
        case 'onEnd': {
          listener.onEnd?.();
          transport.close();
          break;
        }
      }
    };
    await new Promise<void>(f => transport.onclose = f);
    if (timeout)
      clearTimeout(timeout);
  }

  private async _waitForTransport(): Promise<ConnectionTransport> {
    const socket = await this._clientSocketPromise;

    const transport: ConnectionTransport = {
      send: function(message): void {
        if (socket.readyState !== WebSocket.CLOSING)
          socket.send(JSON.stringify(message));
      },

      isClosed() {
        return socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING;
      },

      close: () => {
        socket.close();
        this._wsServer?.close();
      }
    };

    socket.on('message', (message: string) => {
      transport.onmessage?.(JSON.parse(Buffer.from(message).toString()));
    });
    socket.on('close', () => {
      this._wsServer?.close();
      transport.onclose?.();
    });
    socket.on('error', () => {
      this._wsServer?.close();
      transport.onclose?.();
    });
    return transport;
  }
}

function patchLocation<T extends { location?: Location, error?: TestError, errors?: TestError[] }>(vscode: vscodeTypes.VSCode, object: T): T {
  // Normalize all the location.file values using the Uri.file().fsPath normalization.
  // vscode will normalize Windows drive letter, etc.
  if (object.location)
    object.location.file = vscode.Uri.file(object.location.file).fsPath;
  if (object.error?.location)
    object.error.location.file = vscode.Uri.file(object.error.location.file).fsPath;
  if (object.errors) {
    object.errors.forEach(e => {
      if (e.location)
        e.location.file = vscode.Uri.file(e.location.file).fsPath;
    });
  }
  return object;
}

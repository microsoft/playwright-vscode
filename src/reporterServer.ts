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

import path from 'path';
import * as http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { ConnectionTransport } from './transport';
import { createGuid } from './utils';
import * as vscodeTypes from './vscodeTypes';
import * as reporterTypes from './upstream/reporter';
import { TeleReporterReceiver } from './upstream/teleReceiver';

export class ReporterServer {
  private _clientSocketPromise: Promise<WebSocket>;
  private _clientSocketCallback!: (socket: WebSocket) => void;
  private _wsServer: WebSocketServer | undefined;
  private _vscode: vscodeTypes.VSCode;

  constructor(vscode: vscodeTypes.VSCode) {
    this._vscode = vscode;
    this._clientSocketPromise = new Promise(f => this._clientSocketCallback = f);
  }

  async env() {
    const wsEndpoint = await this._listen();
    return {
      PW_TEST_REPORTER: require.resolve('./oopReporter'),
      PW_TEST_REPORTER_WS_ENDPOINT: wsEndpoint,
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

  async wireTestListener(listener: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken) {
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

    const teleReceiver = new TeleReporterReceiver(listener, {
      mergeProjects: true,
      mergeTestCases: true,
      resolvePath: (rootDir: string, relativePath: string) => this._vscode.Uri.file(path.join(rootDir, relativePath)).fsPath,
    });

    transport.onmessage = message => {
      if (token.isCancellationRequested && message.method !== 'onEnd')
        return;
      if (message.method === 'onEnd')
        transport.close();
      teleReceiver.dispatch(message as any);
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

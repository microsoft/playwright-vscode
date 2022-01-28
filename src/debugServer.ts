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
import * as ws from 'ws';
import { ConnectionTransport } from './transport';
import { createGuid } from './utils';

export class DebugServer {
  private _clientSocketPromise: Promise<ws.WebSocket>;
  private _clientSocketCallback!: (socket: ws.WebSocket) => void;
  private _wsServer: ws.Server | undefined;

  constructor() {
    this._clientSocketPromise = new Promise(f => this._clientSocketCallback = f);
  }

  async listen(): Promise<string> {
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

    const wsServer = new ws.Server({ server, path });
    wsServer.on('connection', async socket => this._clientSocketCallback(socket));
    this._wsServer = wsServer;

    return wsEndpoint;
  }

  async transport(): Promise<ConnectionTransport> {
    const socket = await this._clientSocketPromise;

    const transport: ConnectionTransport = {
      send: function (message): void {
        if (socket.readyState !== ws.CLOSING)
          socket.send(JSON.stringify(message));
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

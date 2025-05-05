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

import WebSocket from 'ws';

export type ProtocolRequest = {
  id: number;
  method: string;
  params: any;
};

export type ProtocolResponse = {
  id?: number;
  method?: string;
  error?: { message: string; data: any; };
  params?: any;
  result?: any;
};

export interface ConnectionTransport {
  send(s: ProtocolRequest): void;
  close(): void;  // Note: calling close is expected to issue onclose at some point.
  isClosed(): boolean,
  onmessage?: (message: ProtocolResponse) => void,
  onclose?: () => void,
}

export class WebSocketTransport implements ConnectionTransport {
  private _ws: WebSocket;

  onmessage?: (message: ProtocolResponse) => void;
  onclose?: () => void;
  readonly wsEndpoint: string;

  static async connect(url: string, headers: Record<string, string> = {}): Promise<WebSocketTransport> {
    const transport = new WebSocketTransport(url, headers);
    await new Promise<WebSocketTransport>((fulfill, reject) => {
      transport._ws.addEventListener('open', async () => {
        fulfill(transport);
      });
      transport._ws.addEventListener('error', event => {
        reject(new Error('WebSocket error: ' + event.message));
        transport._ws.close();
      });
    });
    return transport;
  }

  constructor(url: string, headers: Record<string, string> = {}) {
    this.wsEndpoint = url;
    this._ws = new WebSocket(url, [], {
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024, // 256Mb,
      handshakeTimeout: 30000,
      headers
    });

    this._ws.addEventListener('message', event => {
      try {
        if (this.onmessage)
          this.onmessage.call(null, JSON.parse(event.data.toString()));
      } catch (e) {
        this._ws.close();
      }
    });

    this._ws.addEventListener('close', event => {
      if (this.onclose)
        this.onclose.call(null);
    });
    // Prevent Error: read ECONNRESET.
    this._ws.addEventListener('error', () => {});
  }

  isClosed() {
    return this._ws.readyState === WebSocket.CLOSING || this._ws.readyState === WebSocket.CLOSED;
  }

  send(message: ProtocolRequest) {
    this._ws.send(JSON.stringify(message));
  }

  close() {
    this._ws.close();
  }

  async closeAndWait() {
    const promise = new Promise(f => this._ws.once('close', f));
    this.close();
    await promise; // Make sure to await the actual disconnect.
  }
}

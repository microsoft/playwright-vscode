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

import { spawn } from 'child_process';
import { findNode } from './utils';
import * as vscodeTypes from './vscodeTypes';
import EventEmitter from 'events';
import { WebSocketTransport } from './transport';

export class BackendServer<T extends BackendClient> {
  private _vscode: vscodeTypes.VSCode;
  private _args: string[];
  private _cwd: string;
  private _envProvider: () => NodeJS.ProcessEnv;
  private _clientFactory: () => T;

  constructor(vscode: vscodeTypes.VSCode, args: string[], cwd: string, envProvider: () => NodeJS.ProcessEnv, clientFactory: () => T) {
    this._vscode = vscode;
    this._args = args;
    this._cwd = cwd;
    this._envProvider = envProvider;
    this._clientFactory = clientFactory;
  }

  async start(): Promise<T | null> {
    const node = await findNode(this._vscode, this._cwd);
    const serverProcess = spawn(node, this._args, {
      cwd: this._cwd,
      stdio: 'pipe',
      env: {
        ...process.env,
        ...this._envProvider(),
      },
    });

    const client = this._clientFactory();

    serverProcess.stderr?.on('data', () => {});
    serverProcess.on('error', error => {
      client._onErrorEvent.fire(error);
    });

    return new Promise(fulfill => {
      serverProcess.stdout?.on('data', async data => {
        const match = data.toString().match(/Listening on (.*)/);
        if (!match)
          return;
        const wse = match[1];
        await client._connect(wse);
        fulfill(client);
      });
      serverProcess.on('exit', () => {
        fulfill(null);
        client._onCloseEvent.fire();
      });
    });
  }
}

export class BackendClient extends EventEmitter {
  private static _lastId = 0;
  private _callbacks = new Map<number, { fulfill: (a: any) => void, reject: (e: Error) => void }>();
  private _transport!: WebSocketTransport;
  wsEndpoint!: string;

  readonly onClose: vscodeTypes.Event<void>;
  readonly _onCloseEvent: vscodeTypes.EventEmitter<void>;
  readonly onError: vscodeTypes.Event<Error>;
  readonly _onErrorEvent: vscodeTypes.EventEmitter<Error>;

  constructor(vscode: vscodeTypes.VSCode) {
    super();
    this._onCloseEvent = new vscode.EventEmitter();
    this.onClose = this._onCloseEvent.event;
    this._onErrorEvent = new vscode.EventEmitter();
    this.onError = this._onErrorEvent.event;
  }

  rewriteWsEndpoint(wsEndpoint: string): string {
    return wsEndpoint;
  }

  rewriteWsHeaders(headers: Record<string, string>): Record<string, string> {
    return headers;
  }

  async _connect(wsEndpoint: string) {
    this.wsEndpoint = wsEndpoint;
    this._transport = await WebSocketTransport.connect(this.rewriteWsEndpoint(wsEndpoint), this.rewriteWsHeaders({}));
    this._transport.onmessage = (message: any) => {
      if (!message.id) {
        this.emit(message.method, message.params);
        return;
      }
      const pair = this._callbacks.get(message.id);
      if (!pair)
        return;
      this._callbacks.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.error?.message || message.error.value);
        error.stack = message.error.error?.stack;
        pair.reject(error);
      } else {
        pair.fulfill(message.result);
      }
    };
    await this.initialize();
  }

  async initialize() { }

  requestGracefulTermination() { }

  protected send(method: string, params: any = {}): Promise<any> {
    return new Promise((fulfill, reject) => {
      const id = ++BackendClient._lastId;
      const command = { id, guid: 'DebugController', method, params, metadata: {} };
      this._transport.send(command as any);
      this._callbacks.set(id, { fulfill, reject });
    });
  }
}

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

import { createServer, Socket, Server, AddressInfo } from 'net';
import type * as vscode from 'vscode';
export type VSCode = typeof vscode;

export type Unboxed<Arg> =
  Arg extends VSCodeHandle<infer T> ? T :
  Arg extends [infer A0] ? [Unboxed<A0>] :
  Arg extends [infer A0, infer A1] ? [Unboxed<A0>, Unboxed<A1>] :
  Arg extends [infer A0, infer A1, infer A2] ? [Unboxed<A0>, Unboxed<A1>, Unboxed<A2>] :
  Arg extends [infer A0, infer A1, infer A2, infer A3] ? [Unboxed<A0>, Unboxed<A1>, Unboxed<A2>, Unboxed<A3>] :
  Arg extends Array<infer T> ? Array<Unboxed<T>> :
  Arg extends object ? { [Key in keyof Arg]: Unboxed<Arg[Key]> } :
  Arg;
export type VSCodeFunction0<R> = () => R | Thenable<R>;
export type VSCodeFunction<Arg, R> = (arg: Unboxed<Arg>) => R | Thenable<R>;
export type VSCodeFunctionOn<On, Arg2, R> = (on: On, arg2: Unboxed<Arg2>) => R | Thenable<R>;

export class VSCodeEvaluator {
  private _lastId = 0;
  private _pending = new Map<number, { resolve: Function, reject: Function }>();
  private _cache = new Map<number, VSCodeHandle>();
  private _server: Server;
  private _initialized: Promise<void>;
  private _socketPromise: Promise<Socket>;
  private _listeners = new Map<number, Set<((event?: any) => any)>>();

  private _responseHandler = (data: Buffer) => {
    const { id, objectId, result, error } = JSON.parse(data.toString());

    if (id === undefined && typeof objectId === 'number') {
      // event
      const listeners = this._listeners.get(objectId);
      if (listeners) {
        for (const listener of listeners)
          listener(result);
      }
      return;
    }

    if (!this._pending.has(id))
      throw new Error(`Could not find promise for request with ID ${id}`);
    const { resolve, reject } = this._pending.get(id)!;
    this._pending.delete(id);
    if (error) {
      const e = new Error(error.message);
      e.stack = error.stack;
      reject(e);
    } else {
      resolve(result);
    }
  };

  constructor() {
    this._server = createServer();
    this._initialized = new Promise<void>(r => this._server.listen(0, r));
    this._socketPromise = new Promise<Socket>(r => this._server.once('connection', r));
    this._socketPromise.then(socket => {
      socket.on('data', this._responseHandler);
    });
    this._cache.set(0, new VSCodeHandle(0, this));
  }

  rootHandle(): VSCodeHandle<VSCode> {
    return this._cache.get(0) as VSCodeHandle<VSCode>;
  }

  async port() {
    await this._initialized;
    return (this._server.address() as AddressInfo).port;
  }

  async evaluate<R>(objectId: number, returnHandle: false, fn: VSCodeFunctionOn<any, void, R>): Promise<R>;
  async evaluate<R>(objectId: number, returnHandle: true, fn: VSCodeFunctionOn<any, void, R>): Promise<VSCodeHandle<R>>;
  async evaluate<R, Arg>(objectId: number, returnHandle: false, fn: VSCodeFunctionOn<any, Arg, R>, arg?: Arg): Promise<R>;
  async evaluate<R, Arg>(objectId: number, returnHandle: true, fn: VSCodeFunctionOn<any, Arg, R>, arg?: Arg): Promise<VSCodeHandle<R>>;
  async evaluate<R, Arg>(objectId: number, returnHandle: boolean, fn: VSCodeFunctionOn<any, Arg, R>, arg?: Arg) {
    function toParam(arg: any) {
      if (['string', 'number', 'boolean', 'null', 'undefined'].includes(typeof arg))
        return arg;
      if (arg instanceof VSCodeHandle)
        return { __vscodeHandle: true, objectId: arg.objectId };
      if (Array.isArray(arg))
        return arg.map(toParam);
      return Object.fromEntries(Object.entries(arg).map(([k, v]) => [k, toParam(v)]));
    }

    const socket = await this._socketPromise;
    const id = ++this._lastId;
    const params = arg !== undefined ? [toParam(arg)] : [];
    socket.write(JSON.stringify({ id, objectId, returnHandle, fn: fn.toString(), params }));
    const result = await new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
    if (!returnHandle)
      return result;

    const resObjectId = result as number;
    let handle = this._cache.get(resObjectId);
    if (!handle) {
      handle = new VSCodeHandle(resObjectId, this);
      this._cache.set(resObjectId, handle);
    }
    return handle;
  }

  addListener<R>(objectId: number, listener: (event: R) => any) {
    if (!this._cache.has(objectId))
      throw new Error(`No handle with id ${objectId}`);
    let listeners = this._listeners.get(objectId);
    if (!listeners) {
      listeners = new Set([listener]);
      this._listeners.set(objectId, listeners);
    } else {
      listeners.add(listener);
    }
  }

  removeListener<R>(objectId: number, listener: (event: R) => any) {
    this._listeners.get(objectId)?.delete(listener);
  }

  async release(objectId: number) {
    const socket = await this._socketPromise;
    this._listeners.delete(objectId);
    if (this._cache.delete(objectId))
      socket.write(JSON.stringify({ op: 'release', objectId }));
  }

  async dispose() {
    const socket = await this._socketPromise;
    socket.removeListener('data', this._responseHandler);
    new Promise(r => this._server.close(r));
    for (const [id, { reject }] of this._pending.entries())
      reject(new Error(`No response for request ${id} received from VSCode`));
  }
}

export class VSCodeHandle<T = VSCode> {
  readonly objectId: number;
  private _evaluator: VSCodeEvaluator;
  private _disposed = false;

  constructor(objectId: number, evaluator: VSCodeEvaluator) {
    this.objectId = objectId;
    this._evaluator = evaluator;
  }

  evaluate<R>(vscodeFunction: VSCodeFunctionOn<T, void, R>): Promise<R>;
  evaluate<R, Arg>(vscodeFunction: VSCodeFunctionOn<T, Arg, R>, arg: Arg): Promise<R>;
  evaluate<R, Arg>(vscodeFunction: VSCodeFunctionOn<T, Arg, R>, arg?: Arg): Promise<R> {
    if (this._disposed)
      throw new Error(`Handle is disposed`);
    return this._evaluator.evaluate(this.objectId, false, vscodeFunction, arg);
  }

  evaluateHandle<R>(vscodeFunction: VSCodeFunctionOn<T, void, R>): Promise<VSCodeHandle<R>>;
  evaluateHandle<R, Arg>(vscodeFunction: VSCodeFunctionOn<T, Arg, R>, arg: Arg): Promise<VSCodeHandle<R>>;
  evaluateHandle<R, Arg>(vscodeFunction: VSCodeFunctionOn<T, Arg, R>, arg?: Arg): Promise<VSCodeHandle<R>> {
    if (this._disposed)
      throw new Error(`Handle is disposed`);
    return this._evaluator.evaluate(this.objectId, true, vscodeFunction, arg);
  }

  dispose() {
    this._disposed = true;
    this._evaluator.release(this.objectId).catch(() => {});
  }
}

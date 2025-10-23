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

import { CancellationToken, CancellationTokenSource, VSCode } from './vscodeTypes';

export class Batched<I> {
  private _batch?: { inputs: I[]; result: Promise<void>; cancel: CancellationTokenSource; promote: CancellationTokenSource };
  private _ongoing?: { result: Promise<void>; cancel: CancellationTokenSource };
  private readonly _delay: number;
  private readonly _impl: (inputs: I[], token: CancellationToken) => Promise<void>;
  private readonly _vscode: VSCode;

  constructor(vscode: VSCode, impl: (inputs: I[], token: CancellationToken) => Promise<void>, delay: number) {
    this._vscode = vscode;
    this._impl = impl;
    this._delay = delay;
  }

  async invoke(input: I): Promise<void> {
    if (this._batch) {
      this._batch.inputs.push(input);
      return await this._batch.result;
    }

    const promote = new this._vscode.CancellationTokenSource();
    const batch = {
      inputs: [input],
      cancel: new this._vscode.CancellationTokenSource(),
      promote,
      result: new Promise<void>(async (resolve, reject) => {
        try {
          await Promise.race([
            Promise.all([
              new Promise(res => setTimeout(res, this._delay)),
              this._ongoing?.result.catch(() => { })
            ]),
            new Promise<void>(res => promote.token.onCancellationRequested(() => res()))
          ]);

          this._ongoing = this._batch;
          this._batch = undefined;
          await this._impl(batch.inputs, batch.cancel.token);
          resolve();
        } catch (e) {
          reject(e);
        } finally {
          if (this._ongoing === batch)
            this._ongoing = undefined;
          if (this._batch === batch)
            this._batch = undefined;
          batch.cancel.dispose();
          batch.promote.dispose();
        }
      })
    };
    this._batch = batch;
    return await batch.result;
  }

  async invokeImmediately(input: I) {
    this._ongoing?.cancel.cancel();
    // we don't wait for the ongoing to finish, so we run as fast as possible.
    // this means there might be a slight overlap, which is acceptable for our usecases.
    const result = this.invoke(input);
    this._batch!.promote.cancel();
    return await result;
  }

}
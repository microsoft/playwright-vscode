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
  private _needsRebuild: I[] = [];
  private _running?: CancellationTokenSource;
  private readonly _delay: number;
  private readonly _impl: (inputs: I[], token: CancellationToken) => Promise<void>;
  private readonly _vscode: VSCode;

  constructor(vscode: VSCode, impl: (inputs: I[], token: CancellationToken) => Promise<void>, delay: number) {
    this._vscode = vscode;
    this._impl = impl;
    this._delay = delay;
  }

  invoke(input: I): void {
    this._needsRebuild.push(input);
    if (this._running)
      return;
    void this._runBatch(true);
  }

  async invokeImmediately(input: I): Promise<void> {
    this._needsRebuild.push(input);
    this._running?.cancel();
    // we don't wait for the ongoing to finish, so we run as fast as possible.
    // this means there might be a slight overlap, which is acceptable for our usecases.
    await this._runBatch(false);
  }

  private async _runBatch(wait: boolean): Promise<void> {
    const cancel = new this._vscode.CancellationTokenSource();
    this._running = cancel;
    if (wait) {
      await Promise.race([
        new Promise(f => setTimeout(f, this._delay)),
        new Promise(f => cancel.token.onCancellationRequested(f))
      ]);
      if (cancel.token.isCancellationRequested)
        return;
    }

    const inputs = this._needsRebuild;
    this._needsRebuild = [];
    await this._impl(inputs, cancel.token).catch(() => {});
    this._running = undefined;
    if (this._needsRebuild.length)
      void this._runBatch(false);
  }

}
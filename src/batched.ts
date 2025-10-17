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

export class Batched<T> {
  private _batch?: Promise<T>;

  constructor(private readonly _impl: () => Promise<T>, private readonly _delay: number) {}

  async invoke(): Promise<T> {
    if (this._batch)
      return await this._batch;

    this._batch = new Promise<T>(async (resolve, reject) => {
      try {
        await new Promise(res => setTimeout(res, this._delay));
        this._batch = undefined;
        const result = await this._impl();
        resolve(result);
      } catch (e) {
        reject(e);
      } finally {
        this._batch = undefined;
      }
    });

    return await this._batch;
  }

}
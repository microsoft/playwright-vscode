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

import { DebugController, DebugControllerState, ReusedBrowser } from './reusedBrowser';
import { TestModelCollection } from './testModel';
import * as vscodeTypes from './vscodeTypes';

export class BrowserList {
  private _state = new Map<DebugController, { id: string; name: string; channel?: string; title: string }[]>();
  _moderniseForTest = false;

  private _onChanged: vscodeTypes.EventEmitter<void>;
  readonly onChanged;

  constructor(private readonly _vscode: vscodeTypes.VSCode, private readonly _reusedBrowser: ReusedBrowser, private readonly _models: TestModelCollection) {
    this._onChanged = new this._vscode.EventEmitter();
    this.onChanged = this._onChanged.event;

    this._reusedBrowser.onBackend(b => this._add(b));
  }

  private _add(backend: DebugController) {
    backend.onClose(() => {
      this._state.delete(backend);
      this._onChanged.fire();
    });
    backend.onError(() => {
      this._state.delete(backend);
      this._onChanged.fire();
    });
    backend.on('stateChanged', (params: DebugControllerState) => {
      // compat for <1.56
      if (!params.browsers || this._moderniseForTest) {
        let name = this._models.selectedModel()?.projects()[0]?.name || 'chromium';
        if (!['chromium', 'firefox', 'webkit'].includes(name))
          name = 'Browser';
        params.browsers = [{ id: 'unknown', name, contexts: [] }];
      }

      this._state.set(backend, params.browsers.map(b => {
        let title = b.channel ?? b.name;
        const pages = b.contexts.flatMap(c => c.pages);
        const url = pages[0]?.url;
        if (url)
          title += ` - ${new URL(url).hostname || url}`;

        return {
          id: b.id,
          name: b.name,
          channel: b.channel,
          title,
        };
      }));
      this._onChanged.fire();
    });
  }

  get() {
    return [...this._state.entries()].flatMap(([, browsers]) => browsers);
  }
}

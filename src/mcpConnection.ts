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

import { ReusedBrowser } from './reusedBrowser';
import { VSCode } from './vscodeTypes';

export class McpConnection {
  private _knownEndpoints = new Set<string>();

  constructor(private _vscode: VSCode, private _reusedBrowser: ReusedBrowser) {}

  startScanning() {
    const timeout = setTimeout(() => this._checkForUpdates().finally(() => timeout.refresh()), 500);
    return new this._vscode.Disposable(() => clearTimeout(timeout));
  }

  private async _checkForUpdates(): Promise<void> {
    for (const tool of this._vscode.lm.tools) {
      if (!tool.name.endsWith('browser_connect'))
        continue;

      const result = await this._vscode.lm.invokeTool(tool.name, {
        toolInvocationToken: undefined,
        input: { debugController: true }
      });
      const text = result.content.map(c => '' + c).join('\n');
      const url = text.match(/URL: (.+)/)?.[1];
      const version = parseFloat(text.match(/Version: (\d+\.\d+)/)?.[1] ?? 'NaN');
      if (!url || isNaN(version) || this._knownEndpoints.has(url))
        continue;

      this._knownEndpoints.add(url);
      await this._reusedBrowser.connectToDebugController(
          url,
          version,
          () => this._knownEndpoints.delete(url)
      );
    }
  }
}

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
  private _vscode: VSCode;
  private _reusedBrowser: ReusedBrowser;
  private _connectedEndpoints = new Set<string>();
  private _connectedTools = new Set<string>();

  constructor(vscode: VSCode, reusedBrowser: ReusedBrowser) {
    this._vscode = vscode;
    this._reusedBrowser = reusedBrowser;
  }

  startScanning() {
    const timeout = setTimeout(() => this._checkForUpdates().finally(() => timeout.refresh()), 500);
    return new this._vscode.Disposable(() => clearTimeout(timeout));
  }

  private async _checkForUpdates(): Promise<void> {
    for (const tool of this._vscode.lm.tools) {
      if (!tool.name.endsWith('browser_connect'))
        continue;
      if (this._connectedTools.has(tool.name))
        continue;

      const result = await this._vscode.lm.invokeTool(tool.name, {
        toolInvocationToken: undefined,
        input: { debugController: true }
      });
      const text = result.content.map(c => '' + c).join('\n');
      const wsEndpoint = text.match(/URL: (.+)/)?.[1];
      const version = parseFloat(text.match(/Version: (\d+\.\d+)/)?.[1] ?? 'NaN');
      if (!wsEndpoint || isNaN(version))
        continue;

      // the tool might have been renamed from a previous name,
      // so the previous check didn't work but we're already connected to this debug controller.
      // there can only ever be 1 connection at a time, so let's prevent by also checking the endpoint.
      if (this._connectedEndpoints.has(wsEndpoint))
        return;

      this._connectedEndpoints.add(wsEndpoint);
      this._connectedTools.add(tool.name);
      await this._reusedBrowser.connectToDebugController(
          {
            wsEndpoint,
            version,
            onClose: () => {
              // MCP closes the debug controller when MCP server shuts down (likely because user or VS Code decided to stop it),
              // or when Copilot explicitly calls the browser_close tool.
              this._connectedEndpoints.delete(wsEndpoint);
              this._connectedTools.delete(tool.name);
            }
          }
      );
    }
  }
}

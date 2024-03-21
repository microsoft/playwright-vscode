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
import { startBackend } from './backend';
import type { TestConfig } from './playwrightTest';
import { TeleReporterReceiver } from './upstream/teleReceiver';
import { TestServerConnection } from './upstream/testServerConnection';
import type * as vscodeTypes from './vscodeTypes';
import * as reporterTypes from './upstream/reporter';
import path from 'path';

export class TestServerController implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  private _connectionPromises = new Map<string, Promise<TestServerConnection | null>>();
  private _envProvider: () => NodeJS.ProcessEnv;

  constructor(vscode: vscodeTypes.VSCode, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._envProvider = envProvider;
  }

  testServerFor(config: TestConfig): Promise<TestServerConnection | null> {
    let connectionPromise = this._connectionPromises.get(config.configFile);
    if (connectionPromise)
      return connectionPromise;
    connectionPromise = this._createTestServer(config);
    this._connectionPromises.set(config.configFile, connectionPromise);
    return connectionPromise;
  }

  disposeTestServerFor(configFile: string) {
    const result = this._connectionPromises.get(configFile);
    this._connectionPromises.delete(configFile);
    if (result)
      result.then(server => server?.closeGracefully({}));
  }

  private async _createTestServer(config: TestConfig): Promise<TestServerConnection | null> {
    const args = [config.cli, 'test-server', '-c', config.configFile];
    const wsEndpoint = await startBackend(this._vscode, {
      args,
      cwd: config.workspaceFolder,
      envProvider: () => {
        return {
          ...this._envProvider(),
          FORCE_COLOR: '1',
        };
      },
      dumpIO: false,
      onClose: () => {
        this._connectionPromises.delete(config.configFile);
      },
      onError: error => {
        this._connectionPromises.delete(config.configFile);
      },
    });
    if (!wsEndpoint)
      return null;
    const testServer = new TestServerConnection(wsEndpoint);
    await testServer.connect();
    return testServer;
  }

  async wireTestListener(testServerConnection: TestServerConnection, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken) {
    const teleReceiver = new TeleReporterReceiver(reporter, {
      mergeProjects: true,
      mergeTestCases: true,
      resolvePath: (rootDir: string, relativePath: string) => this._vscode.Uri.file(path.join(rootDir, relativePath)).fsPath,
    });
    return new Promise<void>(resolve => {
      const disposable = testServerConnection.onReport(message => {
        if (token.isCancellationRequested && message.method !== 'onEnd')
          return;
        teleReceiver.dispatch(message);
        if (message.method === 'onEnd') {
          disposable.dispose();
          resolve();
        }
      });
    });
  }

  dispose() {
    for (const instancePromise of this._connectionPromises.values())
      instancePromise.then(server => server?.closeGracefully({}));
  }
}

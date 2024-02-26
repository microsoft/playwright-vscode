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

import { BackendClient, BackendServer } from './backend';
import type { ConfigFindRelatedTestFilesReport } from './listTests';
import type { TestConfig, TestListener } from './playwrightTest';
import { translateMessage } from './reporterServer';
import type { TestServerEvents, TestServerInterface } from './testServerInterface';
import type * as vscodeTypes from './vscodeTypes';

export class TestServerController implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  private _instancePromise: Promise<TestServer | null> | undefined;
  private _envProvider: () => NodeJS.ProcessEnv;

  constructor(vscode: vscodeTypes.VSCode, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._envProvider = envProvider;
  }

  async testServerFor(config: TestConfig): Promise<TestServer | null> {
    if (this._instancePromise)
      return this._instancePromise;
    this._instancePromise = this._createTestServer(config);
    return this._instancePromise;
  }

  private async _createTestServer(config: TestConfig): Promise<TestServer | null> {
    const args = [config.cli, 'test-server'];
    const testServerBackend = new BackendServer<TestServer>(this._vscode, {
      args,
      cwd: config.workspaceFolder,
      envProvider: () => {
        return {
          ...this._envProvider(),
          FORCE_COLOR: '1',
        };
      },
      clientFactory: () => new TestServer(this._vscode),
      dumpIO: false,
    });
    const testServer = await testServerBackend.start();
    return testServer;
  }

  dispose() {
    this.reset();
  }

  reset() {
    if (this._instancePromise)
      this._instancePromise.then(server => server?.closeGracefully());
    this._instancePromise = undefined;
  }
}

class TestServer extends BackendClient implements TestServerInterface, TestServerEvents {
  override async initialize(): Promise<void> {
  }

  async listFiles(params: Parameters<TestServerInterface['listFiles']>[0]) {
    return await this.send('listFiles', params);
  }

  async listTests(params: Parameters<TestServerInterface['listTests']>[0]) {
    await this.send('listTests', params);
  }

  findRelatedTestFiles(params: Parameters<TestServerInterface['findRelatedTestFiles']>[0]): Promise<ConfigFindRelatedTestFilesReport> {
    return this.send('findRelatedTestFiles', params);
  }

  async test(params: Parameters<TestServerInterface['test']>[0]) {
    await this.send('test', params);
  }

  async stop(params: Parameters<TestServerInterface['stop']>[0]) {
    await this.send('stop', {});
  }

  async closeGracefully() {
    await this.send('closeGracefully', {});
    this.close();
  }

  async wireTestListener(listener: TestListener, token: vscodeTypes.CancellationToken) {
    return new Promise<void>(f => {
      const reportHandler = (message: any) => translateMessage(this.vscode, message, listener, () => {
        this.off('report', reportHandler);
        f();
      }, token);
      this.on('report', reportHandler);
    });
  }
}

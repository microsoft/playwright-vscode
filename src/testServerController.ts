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
import { TestConfig } from './playwrightTest';
import * as vscodeTypes from './vscodeTypes';

export class TestServerController implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  private _testServers = new Map<TestConfig, TestServer>();
  private _envProvider: () => NodeJS.ProcessEnv;

  constructor(vscode: vscodeTypes.VSCode, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._envProvider = envProvider;
  }

  async testServerFor(config: TestConfig): Promise<TestServer | null> {
    const existing = this._testServers.get(config);
    if (existing)
      return existing;
    const args = [config.cli, 'test-server'];
    const testServerBackend = new BackendServer<TestServer>(this._vscode, {
      args,
      cwd: config.workspaceFolder,
      envProvider: this._envProvider,
      clientFactory: () => new TestServer(this._vscode),
      dumpIO: false,
    });
    const testServer = await testServerBackend.start();
    if (!testServer)
      return null;
    this._testServers.set(config, testServer);
    return testServer;
  }

  dispose() {
    for (const backend of this._testServers.values())
      backend.close();
    this._testServers.clear();
  }
}

class TestServer extends BackendClient {
  override async initialize(): Promise<void> {
  }

  async list(params: any) {
    await this.send('list', params);
  }

  async test(params: any) {
    await this.send('test', params);
  }

  async stop() {
    await this.send('stop', {});
  }
}

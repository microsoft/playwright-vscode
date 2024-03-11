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
import path from 'path';
import { BackendClient, BackendServer } from './backend';
import type { ConfigFindRelatedTestFilesReport } from './listTests';
import type { TestConfig } from './playwrightTest';
import type { TestServerEvents, TestServerInterface } from './testServerInterface';
import type * as vscodeTypes from './vscodeTypes';
import type * as reporterTypes from './reporter';
import { TeleReporterReceiver } from './upstream/teleReceiver';

export class TestServerController implements vscodeTypes.Disposable {
  private _vscode: vscodeTypes.VSCode;
  private _instancePromises = new Map<string, Promise<TestServer | null>>();
  private _envProvider: () => NodeJS.ProcessEnv;

  constructor(vscode: vscodeTypes.VSCode, envProvider: () => NodeJS.ProcessEnv) {
    this._vscode = vscode;
    this._envProvider = envProvider;
  }

  async testServerFor(config: TestConfig): Promise<TestServer | null> {
    let instancePromise = this._instancePromises.get(config.configFile);
    if (instancePromise)
      return instancePromise;
    instancePromise = this._createTestServer(config);
    this._instancePromises.set(config.configFile, instancePromise);
    return instancePromise;
  }

  disposeTestServerFor(configFile: string) {
    const result = this._instancePromises.get(configFile);
    this._instancePromises.delete(configFile);
    if (result)
      result.then(server => server?.closeGracefully());
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
    for (const instancePromise of this._instancePromises.values())
      instancePromise.then(server => server?.closeGracefully());
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

  async wireTestListener(mode: 'test' | 'list', reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken) {
    const teleReceiver = new TeleReporterReceiver(reporter, {
      mergeProjects: true,
      mergeTestCases: true,
      resolvePath: (rootDir: string, relativePath: string) => this.vscode.Uri.file(path.join(rootDir, relativePath)).fsPath,
    });
    return new Promise<void>(f => {
      const handler = (message: any) => {
        if (token.isCancellationRequested && message.method !== 'onEnd')
          return;
        teleReceiver.dispatch(mode, message);
        if (message.method === 'onEnd') {
          this.off('report', handler);
          f();
        }
      };
      this.on('report', handler);
    });
  }
}

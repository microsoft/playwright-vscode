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

import type { TestConfig } from './playwrightTestTypes';
import { PlaywrightTestServer } from './playwrightTestServer';
import { TraceViewer } from './traceViewer';
import { TraceViewerApp } from './traceViewerApp';

export class TestServerTraceViewer implements TraceViewer {
  private _currentFile?: string;
  private _config: TestConfig;
  private _testServer: PlaywrightTestServer;
  private _traceLoadRequestedTimeout?: NodeJS.Timeout;
  private _appPromise?: Promise<TraceViewerApp>;

  constructor(config: TestConfig, testServer: PlaywrightTestServer) {
    this._config = config;
    this._testServer = testServer;
  }

  currentFile() {
    return this._currentFile;
  }

  async willRunTests() {
    await this._startIfNeeded();
  }

  async open(file?: string) {
    this._currentFile = file;
    if (!file && !this._appPromise)
      return;
    const traceViewerApp = await this._startIfNeeded();
    this._fireLoadTraceRequestedIfNeeded(traceViewerApp);
  }

  close() {
    this._clearTraceLoadRequestedTimeout();
    this._appPromise?.then(app => app.dispose()).catch(() => {});
    this._appPromise = undefined;
    this._currentFile = undefined;
  }

  private async _startIfNeeded() {
    if (!this._appPromise)
      this._appPromise = this._testServer.openTraceViewer(() => this.close());
    return await this._appPromise;
  }

  private _clearTraceLoadRequestedTimeout() {
    if (this._traceLoadRequestedTimeout) {
      clearTimeout(this._traceLoadRequestedTimeout);
      this._traceLoadRequestedTimeout = undefined;
    }
  }

  private async _fireLoadTraceRequestedIfNeeded(traceViewerApp: TraceViewerApp) {
    this._clearTraceLoadRequestedTimeout();
    traceViewerApp.dispatchEvent({ method: 'loadTraceRequested', params: { traceUrl: this._currentFile } });
    if (this._currentFile?.endsWith('.json'))
      this._traceLoadRequestedTimeout = setTimeout(() => this._fireLoadTraceRequestedIfNeeded(traceViewerApp), 500);
  }

  async infoForTest() {
    const serverUrlPrefix = this._appPromise ? (await this._appPromise).serverUrlPrefixForTest() : undefined;
    return {
      type: 'test-server',
      serverUrlPrefix,
      testConfigFile: this._config.configFile,
      traceFile: this._currentFile,
      visible: !!this._appPromise,
    };
  }
}

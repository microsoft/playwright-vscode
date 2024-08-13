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

import { EmbeddedTraceViewer } from './embeddedTraceViewer';
import { PlaywrightTestServer } from './playwrightTestServer';
import type { TestConfig } from './playwrightTestTypes';
import { SpawnTraceViewer } from './spawnTraceViewer';
import { TestModelCollection, TestModelEmbedder } from './testModel';
import * as vscodeTypes from './vscodeTypes';

export type TraceViewer = {
  currentFile(): string | undefined;
  willRunTests(): Promise<void>;
  open(file?: string): Promise<void>;
  reveal?(): Promise<void>;
  close(): void;
  infoForTest(): Promise<{
    type: string;
    serverUrlPrefix?: string;
    testConfigFile: string;
    traceFile?: string;
    visible: boolean;
  } | undefined>;
};

export class TraceViewerFactory {
  private _embedder: TestModelEmbedder;
  private _vscode: vscodeTypes.VSCode;
  private _config: TestConfig;
  private _testServer?: PlaywrightTestServer;

  constructor(collection: TestModelCollection, config: TestConfig, testServer?: PlaywrightTestServer) {
    this._vscode = collection.vscode;
    this._embedder = collection.embedder;
    this._config = config;
    this._testServer = testServer;
  }

  create(): TraceViewer | null {
    if (this._checkEmbeddedSupport(true))
      return new EmbeddedTraceViewer(this._vscode, this._embedder.context.extensionUri, this._config, this._testServer!);
    else if (this._checkSpawnSupport(true))
      return new SpawnTraceViewer(this._vscode, this._embedder.envProvider, this._config);
    return null;
  }

  isSupported(traceViewer: TraceViewer) {
    if (traceViewer instanceof EmbeddedTraceViewer && this._checkEmbeddedSupport())
      return true;
    if (traceViewer instanceof SpawnTraceViewer && this._checkSpawnSupport())
      return true;
    return false;
  }

  private _checkSpawnSupport(userGesture?: boolean) {
    if (!this._embedder.settingsModel.showTrace.get())
      return false;
    if (!this._checkVersion(1.35, this._vscode.l10n.t('this feature'), userGesture))
      return false;
    return true;
  }

  private _checkEmbeddedSupport(userGesture?: boolean) {
    if (!this._embedder.settingsModel.showTrace.get() || !this._embedder.settingsModel.embeddedTraceViewer.get())
      return false;
    if (!this._checkVersion(1.46, this._vscode.l10n.t('embedded trace viewer'), userGesture))
      return false;
    return true;
  }

  private _checkVersion(version: number, message: string, userGesture?: boolean) {
    if (this._config.version < version) {
      if (userGesture) {
        this._vscode.window.showWarningMessage(
            this._vscode.l10n.t('Playwright v{0}+ is required for {1} to work, v{2} found', version, message, this._config.version)
        );
      }
      return false;
    }
    return true;
  }
}

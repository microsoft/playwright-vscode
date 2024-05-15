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

import { SettingsModel } from './settingsModel';
import type * as vscodeTypes from './vscodeTypes';

export type TestConfig = {
  workspaceFolder: string;
  configFile: string;
  cli: string;
  version: number;
  testIdAttributeName?: string;
};

export type PlaywrightTestRunOptions = {
  headed?: boolean;
  workers?: string | number;
  trace?: 'on' | 'off';
  video?: 'on' | 'off';
  reuseContext?: boolean;
  connectWsEndpoint?: string;
};

export interface RunHooks {
  onWillRunTests(config: TestConfig, debug: boolean): Promise<{ connectWsEndpoint?: string }>;
  onDidRunTests(debug: boolean): Promise<void>;
}

export type PlaywrightTestOptions = {
  settingsModel: SettingsModel;
  runHooks: RunHooks;
  isUnderTest: boolean;
  playwrightTestLog: string[];
  envProvider: () => NodeJS.ProcessEnv;
  onStdOut: vscodeTypes.Event<string>;
};

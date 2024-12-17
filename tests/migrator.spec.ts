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

import { expect, test } from './utils';

const lastMigration = -1;

test('should initialize version info', async ({ vscode, activate }) => {
  vscode.context.workspaceState.update('pw.workspace-version', undefined);
  await activate({});
  expect(vscode.context.workspaceState.get('pw.workspace-version')).toEqual({ version: expect.stringMatching(/\d+\.\d+\.\d+/), lastMigrationTime: expect.any(Number), lastMigration });
});

test('should update version info', async ({ vscode, activate }) => {
  vscode.context.workspaceState.update('pw.workspace-version', { version: 'v0.0.0', lastMigrationTime: 0, lastMigration: -1 });
  await activate({});
  const versionInfo = vscode.context.workspaceState.get('pw.workspace-version');
  expect(versionInfo.version).not.toBe('v0.0.0');
  expect(versionInfo.lastMigrationTime).toBeCloseTo(Date.now(), -4);
  expect(versionInfo.lastMigration).toBe(lastMigration);
});

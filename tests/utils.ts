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

import { Extension } from '../out/extension';
import { VSCode } from './mock/vscode';

export async function activate(rootDir: string, files: { [key: string]: string }) {
  const vscode = new VSCode();
  const workspaceFolder = await vscode.addWorkspaceFolder(rootDir, files);
  const extension = new Extension(vscode);
  const context = { subscriptions: [] };
  await extension.activate(context);
  return {
    vscode,
    extension,
    testController: vscode.testControllers[0],
    workspaceFolder,
    renderExecLog: (indent: string) => {
      return (['', ...extension.playwrightTestLog()].join(`\n  ${indent}`) + `\n${indent}`).replace(/\\\\/g, '/');
    },
  };
}

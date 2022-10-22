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

import { test as baseTest, PlaywrightTestConfig as BasePlaywrightTestConfig, } from '@playwright/test';
import { Extension } from '../out/extension';
import { TestController, VSCode, WorkspaceFolder } from './mock/vscode';
import path from 'path';

type ActivateResult = {
  vscode: VSCode,
  testController: TestController;
  workspaceFolder: WorkspaceFolder;
};

type TestFixtures = {
  activate: (files: { [key: string]: string }, options?: { rootDir?: string, workspaceFolders?: [string, any][] }) => Promise<ActivateResult>;
};

export type TestOptions = {
  mode: 'default' | 'reuse';
};

export { expect } from '@playwright/test';
export const test = baseTest.extend<TestFixtures & TestOptions>({
  mode: ['default', { option: true }],
  activate: async ({ browser, mode }, use, testInfo) => {
    const instances: VSCode[] = [];
    await use(async (files: { [key: string]: string }, options?: { rootDir?: string, workspaceFolders?: [string, any][] }) => {
      const vscode = new VSCode(path.resolve(__dirname, '..'), browser);
      if (options?.workspaceFolders) {
        for (const wf of options?.workspaceFolders)
          await vscode.addWorkspaceFolder(wf[0], wf[1]);
      } else {
        await vscode.addWorkspaceFolder(options?.rootDir || testInfo.outputDir, files);
      }
      const extension = new Extension(vscode);
      vscode.extensions.push(extension);
      await vscode.activate();

      if (mode === 'reuse') {
        const configuration = vscode.workspace.getConfiguration('playwright');
        configuration.update('reuseBrowser', true);
      }

      instances.push(vscode);
      return {
        vscode,
        testController: vscode.testControllers[0],
        workspaceFolder: vscode.workspace.workspaceFolders[0],
      };
    });
    for (const vscode of instances)
      vscode.dispose();
  }
});

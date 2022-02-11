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

import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PlaywrightTest } from './playwrightTest';
import { TestModel, TestProject } from './testModel';
import * as vscodeTypes from './vscodeTypes';

export class Recorder {
  private _vscode: vscodeTypes.VSCode;
  private _playwrightTest: PlaywrightTest;
  private _childProcess: ChildProcess | undefined;
  private _recording = false;

  constructor(vscode: vscodeTypes.VSCode, playwrightTest: PlaywrightTest) {
    this._vscode = vscode;
    this._playwrightTest = playwrightTest;
  }

  async record(models: TestModel[]) {
    if (this._recording)
      return;
    this._recording = true;
    try {
      await this._vscode.window.withProgress({
        location: this._vscode.ProgressLocation.Notification,
        title: 'Recording Playwright script',
        cancellable: true
      }, async (progress, token) => this._doRecord(models, token));
    } finally {
      this._recording = false;
    }
  }

  private async _doRecord(models: TestModel[], token: vscodeTypes.CancellationToken) {
    const model = models[0];
    if (!model)
      return;
    const project = model.projects.values().next().value as TestProject;
    if (!project)
      return;
    let file;
    for (let i = 1; i < 100; ++i) {
      file = path.join(project.testDir, `test-${i}.spec.ts`);
      if (fs.existsSync(file))
        continue;
      break;
    }
    if (!file)
      return;

    fs.writeFileSync(file, `import { test, expect } from '@playwright/test';

test('test', async ({ page }) => {
// Recording...
});`);

    const document = await this._vscode.workspace.openTextDocument(file);
    await this._vscode.window.showTextDocument(document);

    const childProcess = spawn(
        await this._playwrightTest.findNode(),
        [
          model.config.cli,
          'codegen',
          `--output=${file}`
        ],
        {
          env: {
            ...process.env,
            PW_CODEGEN_NO_INSPECTOR: '1',
          },
          cwd: path.dirname(model.config.configFile),
        }
    );

    token.onCancellationRequested(() => {
      process.kill(childProcess.pid!, 'SIGINT');
    });

    this._childProcess = childProcess;

    await new Promise((f, r) => {
      childProcess.on('error', e => r(e));
      childProcess.on('exit', f);
    });
  }

  dispose() {
    if (this._childProcess) {
      process.kill(this._childProcess.pid!);
      this._childProcess = undefined;
    }
  }
}

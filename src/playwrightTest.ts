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

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

import * as playwrightTestTypes from './testTypes';
import { logger } from './logger';
import type { PlaywrightDebugMode } from './extension';
import { fileExistsAsync, spawnAsync, escapeRegExp, createGuid } from './utils';

export const DEFAULT_CONFIG = Symbol('default config');
export type PlaywrightTestConfig = string | typeof DEFAULT_CONFIG

const configuration = vscode.workspace.getConfiguration();
export class PlaywrightTest {
  private _directory: string;
  private _cliEntrypoint: string;
  private _debugMode: PlaywrightDebugMode;
  private constructor(directory: string, cliPath: string, debugMode: PlaywrightDebugMode) {
    this._directory = directory;
    this._cliEntrypoint = path.join(directory, cliPath);
    this._debugMode = debugMode;
  }

  static async create(directory: string, cliPath: string, debugMode: PlaywrightDebugMode) {
    const pwTest = new PlaywrightTest(directory, cliPath, debugMode);
    if (!await fileExistsAsync(pwTest._cliEntrypoint))
      throw new Error('Could not locate Playwright Test. Is it installed? \'npm install -D @playwright/test\'');
    return pwTest;
  }

  public async listTests(config: PlaywrightTestConfig, projectName: string, fileOrFolder: string): Promise<playwrightTestTypes.JSONReport | null> {
    const jsonOutputPath = path.join(os.tmpdir(), createGuid());
    const proc = await this._executePlaywrightTestCommand(jsonOutputPath, config, projectName, ['--list', escapeRegExp(fileOrFolder)]);
    if (proc.code !== 0) {
      if (proc.stderr.includes('no tests found.'))
        return null;
      throw new Error(proc.stderr || proc.stdout);
    }
    try {
      return JSON.parse(await fs.promises.readFile(jsonOutputPath, 'utf8'));
    } finally {
      await fs.promises.unlink(jsonOutputPath);
    }
  }

  public async runTest(config: PlaywrightTestConfig, projectName: string, testPath: string, line: number): Promise<playwrightTestTypes.JSONReport> {
    const jsonOutputPath = path.join(os.tmpdir(), 'playwright-vscode-test-extension-' + createGuid() + '.json');
    await this._executePlaywrightTestCommand(jsonOutputPath, config, projectName, [`${escapeRegExp(testPath)}:${line}`]);
    try {
      return JSON.parse(await fs.promises.readFile(jsonOutputPath, 'utf8'));
    } finally {
      await fs.promises.unlink(jsonOutputPath);
    }
  }

  private async _executePlaywrightTestCommand(jsonOutputPath: string, config: PlaywrightTestConfig, projectName: string, additionalArguments: string[]) {
    const spawnArguments = [
      path.relative(this._directory, this._cliEntrypoint),
      ...this._buildBaseArgs(config, projectName),
      '--reporter=json',
      ...additionalArguments
    ];
    logger.debug(`Executing command: ${spawnArguments.join(' ')}`);
    const result = await spawnAsync('node', spawnArguments, {
      cwd: this._directory,
      env: {
        ...this._getEnv(false),
        PLAYWRIGHT_JSON_OUTPUT_NAME: jsonOutputPath,
      },
    });
    return result;
  }

  private _getEnv(vscodeDebuggerEnabled: boolean): NodeJS.ProcessEnv {
    const env = {
      ...process.env,
      ...configuration.get<Record<string, string>>('playwright.env'),
    };
    if (this._debugMode.isEnabled()) {
      // we don't want to have two debuggers at the same time
      if (vscodeDebuggerEnabled) {
        env['DEBUG'] = 'pw:api';
      } else {
        env['PWDEBUG'] = '1';
      }
    }
    return env;
  }

  private _buildBaseArgs(config: PlaywrightTestConfig, projectName: string) {
    return [
      'test',
      ...(config !== DEFAULT_CONFIG ? [`--config=${config}`] : []),
      ...(projectName ? [`--project=${projectName}`] : []),
    ];
  }

  public async debug(config: PlaywrightTestConfig, projectName: string, workspaceFolder: vscode.WorkspaceFolder, path: string, line: number): Promise<void> {
    const args = [
      ...this._buildBaseArgs(config, projectName),
      '--reporter=list',
      `${escapeRegExp(path)}:${line}`
    ];
    const debugConfiguration: vscode.DebugConfiguration = {
      args,
      console: 'internalConsole',
      cwd: '${workspaceFolder}',
      internalConsoleOptions: 'neverOpen',
      name: 'playwright-test',
      request: 'launch',
      type: 'node',
      outputCapture: 'std',
      runtimeExecutable: this._cliEntrypoint,
      env: this._getEnv(true),
    };

    await vscode.debug.startDebugging(workspaceFolder, debugConfiguration);
  }
}

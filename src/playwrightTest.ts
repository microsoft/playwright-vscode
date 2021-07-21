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

import * as path from 'path';
import * as fs from 'fs';
import { spawn, SpawnOptionsWithoutStdio } from 'child_process';
import * as playwrightTestTypes from './testTypes';
import { logger } from './logger';

export const DEFAULT_CONFIG = Symbol("default config");
export type PlaywrightTestConfig = string | typeof DEFAULT_CONFIG

function spawnAsync(cmd: string, args: string[], options: SpawnOptionsWithoutStdio): Promise<{ stdout: Buffer, stderr: Buffer, code: number | null, error?: Error }> {
  const process = spawn(cmd, args, options);

  return new Promise((resolve, reject) => {
    let stdout = Buffer.from([]);
    let stderr = Buffer.from([]);
    if (process.stdout)
      process.stdout.on('data', data => stdout = Buffer.concat([stdout, data]));
    if (process.stderr)
      process.stderr.on('data', data => stderr = Buffer.concat([stderr, data]));
    process.on('close', code => resolve({ stdout, stderr, code }));
    process.on('error', error => reject(error));
  });
}

async function fileExistsAsync(file: string): Promise<boolean> {
  return fs.promises.access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
}

export class PlaywrightTestNPMPackage {
  private _directory: string;
  private _cliEntrypoint: string;
  constructor(directory: string, cliPath: string) {
    this._directory = directory;
    this._cliEntrypoint = path.join(directory, cliPath);
  }
  static async create(directory: string, cliPath: string) {
    const pwTest = new PlaywrightTestNPMPackage(directory, cliPath);
    if (!await fileExistsAsync(pwTest._cliEntrypoint))
      throw new Error(`Could not locate Playwright Test. Is it installed? 'npm install -D @playwright/test'`);
    return pwTest;
  }
  public async listTests(config: PlaywrightTestConfig, project: string, fileOrFolder: string): Promise<playwrightTestTypes.JSONReport | null> {
    const proc = await this._executePlaywrightTestCommand(config, project, ['--list', fileOrFolder]);
    if (proc.code !== 0) {
      if (proc.stderr.includes("no tests found."))
        return null;
      throw new Error(proc.stderr.toString() || proc.stdout.toString());
    }
    return JSON.parse(proc.stdout.toString());
  }
  public async runTest(config: PlaywrightTestConfig, project: string, path: string, line: number): Promise<playwrightTestTypes.JSONReport> {
    const proc = await this._executePlaywrightTestCommand(config, project, [`${path}:${line}`]);
    const stdout = proc.stdout.toString();
    try {
      return JSON.parse(stdout);
    } catch (error) {
      logger.debug('could not parse JSON', stdout, proc.stderr.toString());
      throw error;
    }
  }
  private async _executePlaywrightTestCommand(config: PlaywrightTestConfig, project: string, additionalArguments: string[]) {
    const spawnArguments = [
      this._cliEntrypoint,
      'test',
      ...(config !== DEFAULT_CONFIG ? [`--config=${config}`] : []),
      ...(project ? [`--project=${project}`] : []),
      '--reporter=json',
      ...additionalArguments
    ];
    logger.debug(`Executing command: ${spawnArguments.join(' ')}`);
    const result = await spawnAsync('node', spawnArguments, {
      cwd: this._directory,
    });
    logger.debug(`Exit code ${result.code}`);
    return result;
  }
}

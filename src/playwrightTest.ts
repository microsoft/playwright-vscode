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

function spawnAsync(cmd: string, args: string[], options: SpawnOptionsWithoutStdio): Promise<{ stdout: Buffer, stderr: Buffer, code: number | null, error?: Error }> {
  const process = spawn(cmd, args, options);

  return new Promise(resolve => {
    let stdout = Buffer.from([]);
    let stderr = Buffer.from([]);
    if (process.stdout)
      process.stdout.on('data', data => stdout = Buffer.concat([stdout, data]));
    if (process.stderr)
      process.stderr.on('data', data => stderr = Buffer.concat([stderr, data]));
    process.on('close', code => resolve({ stdout, stderr, code }));
    process.on('error', error => resolve({ stdout, stderr, code: 1, error }));
  });
}

async function fileExistsAsync(file: string): Promise<boolean> {
  return fs.promises.access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
}

export class PlaywrightTestNPMPackage {
  private _projectName?: string;
  private _directory: string;
  private _cliEntrypoint: string;
  constructor(directory: string) {
    this._directory = directory;
    this._cliEntrypoint = path.join(directory, 'node_modules', '@playwright', 'test', 'lib', 'cli', 'cli.js');
  }
  static async create(directory: string) {
    const pwTest = new PlaywrightTestNPMPackage(directory);
    try {
      await fileExistsAsync(pwTest._cliEntrypoint);
    } catch (error) {
      throw new Error(`Could not locate Playwright Test. Is it installed? 'npm install -D @playwright/test'`);
    }
    return pwTest;
  }
  public async listTests(fileOrFolder: string): Promise<playwrightTestTypes.PlaywrightTestOutput | null> {
    const proc = await spawnAsync('node', [this._cliEntrypoint, 'test', '--reporter=json', '--list', fileOrFolder], {
      cwd: this._directory,
    });
    if (proc.code !== 0) {
      if (proc.stderr.includes("no tests found."))
        return null;
      throw new Error(proc.stderr.toString() + "\n" + proc.stdout.toString());
    }
    return JSON.parse(proc.stdout.toString());
  }
  public async runTest(path: string, line: number): Promise<playwrightTestTypes.PlaywrightTestOutput> {
    const proc = await spawnAsync('node', [this._cliEntrypoint, 'test', '--reporter=json', `--project=${this._projectName}`, `${path}:${line}`], {
      cwd: this._directory,
    });
    return JSON.parse(proc.stdout.toString());
  }
  public setProject(projectName: string) {
    this._projectName = projectName;
  }
}

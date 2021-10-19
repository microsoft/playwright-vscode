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
import * as crypto from 'crypto';
import { execSync, spawn, SpawnOptionsWithoutStdio } from 'child_process';
import * as vscode from 'vscode';

export function assert(value: any, message?: string): asserts value {
  if (!value)
    throw new Error(message);
}

export function spawnAsync(cmd: string, args: string[], options: SpawnOptionsWithoutStdio, cancelationToken?: vscode.CancellationToken): Promise<{ stdout: string, stderr: string, code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      // On non-windows platforms, `detached: true` makes child process a leader of a new
      // process group, making it possible to kill child process tree with `.kill(-pid)` command.
      // @see https://nodejs.org/api/child_process.html#child_process_options_detached
      detached: process.platform !== 'win32',
      ...options
    });
    cancelationToken?.onCancellationRequested(() => killProcess(proc.pid!));
    let stdout = '';
    let stderr = '';
    if (proc.stdout)
      proc.stdout.on('data', data => stdout += data);
    if (proc.stderr)
      proc.stderr.on('data', data => stderr += data);
    proc.on('close', code => resolve({ stdout, stderr, code }));
    proc.on('error', error => reject(error));
  });
}

function killProcess(pid: number): void {
  if (process.platform === 'win32') {
    execSync(`taskkill /pid ${pid} /T /F /FI "MEMUSAGE gt 0"`);
  } else {
    process.kill(-pid, 'SIGKILL');
  }
}

export async function fileExistsAsync(file: string): Promise<boolean> {
  return fs.promises.access(file, fs.constants.F_OK)
    .then(() => true)
    .catch(() => false);
}

export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

export function createGuid(): string {
  return crypto.randomBytes(16).toString('hex');
}

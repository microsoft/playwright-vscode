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

import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export function calculateSha1(buffer: Buffer | string): string {
  const hash = crypto.createHash('sha1');
  hash.update(buffer);
  return hash.digest('hex');
}

export function createGuid(): string {
  return crypto.randomBytes(16).toString('hex');
}

export async function findInPath(program: string): Promise<string | undefined> {
  let locator: string;
  if (process.platform === 'win32') {
    const windir = process.env['WINDIR'] || 'C:\\Windows';
    locator = path.join(windir, 'System32', 'where.exe');
  } else {
    locator = '/usr/bin/which';
  }

  try {
    if (fs.existsSync(locator)) {
      const stdout = await spawnAsync(locator, [program]);
      const lines = stdout.split(/\r?\n/);

      if (process.platform === 'win32') {
        // return the first path that has a executable extension
        const executableExtensions = String(process.env['PATHEXT'] || '.exe')
            .toUpperCase()
            .split(';');

        for (const candidate of lines) {
          const ext = path.extname(candidate).toUpperCase();
          if (ext && executableExtensions.includes(ext))
            return candidate;

        }
      } else {
        // return the first path
        if (lines.length > 0)
          return lines[0];

      }
      return undefined;
    } else {
      // do not report failure if 'locator' app doesn't exist
    }
    return program;
  } catch (err) {
    // fall through
  }

  // fail
  return undefined;
}

export function ansiToHtml(text: string): string {
  let isOpen = false;
  let isLeadingSpace = true;
  let hasTags = false;
  const tokens = [];
  for (let i = 0; i < text.length; ++i) {
    const c = text.charAt(i);
    if (c === '\u001b') {
      hasTags = true;
      const end = text.indexOf('m', i + 1);
      const code = text.substring(i + 1, end);
      if (!code.match(/\[\d+/))
        continue;
      if (isOpen) {
        tokens.push('</span>');
        isOpen = false;
      }
      switch (code) {
        case '[2': {
          tokens.push(`<span style='color:#666;'>`);
          isOpen = true;
          break;
        }
        case '[22': break;
        case '[31': {
          tokens.push(`<span style='color:#73c991;'>`);
          isOpen = true;
          break;
        }
        case '[32': {
          tokens.push(`<span style='color:#f14c4c;'>`);
          isOpen = true;
          break;
        }
        case '[39': break;
      }
      i = end;
    } else {
      if (c === '\n') {
        // Don't close to work around html parsing bug.
        tokens.push('\n<br>\n');
        isLeadingSpace = true;
      } else if (c === ' ') {
        if (isLeadingSpace)
          tokens.push('&nbsp;');
        else
          tokens.push(' ');
      } else {
        tokens.push(escapeHTML(c));
        isLeadingSpace = false;
      }
    }
  }
  // Work around html parsing bugs.
  if (hasTags)
    tokens.push('\n</span></br>');
  return tokens.join('');
}

function escapeHTML(text: string): string {
  return text.replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]!));
}

export async function spawnAsync(executable: string, args: string[], cwd?: string): Promise<string> {
  const childProcess = spawn(executable, args, {
    stdio: 'pipe',
    cwd,
    env: { ...process.env }
  });
  let output = '';
  childProcess.stdout.on('data', data => output += data.toString());
  return new Promise<string>((f, r) => {
    childProcess.on('error', error => r(error));
    childProcess.on('exit', () => f(output));
  });
}

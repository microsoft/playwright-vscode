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
import readline from 'readline';
import which from 'which';
import * as vscodeTypes from './vscodeTypes';

export function createGuid(): string {
  return crypto.randomBytes(16).toString('hex');
}

const ansiRegex = new RegExp('([\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~])))', 'g');
export function stripAnsi(str: string): string {
  return str.replace(ansiRegex, '');
}

export function stripBabelFrame(text: string) {
  const result: string[] =  [];
  for (const line of text.split('\n')) {
    if (!line.trim().match(/>?\s*\d*\s*\|/))
      result.push(line);
  }
  return result.join('\n').trim();
}

export async function spawnAsync(executable: string, args: string[], cwd?: string, settingsEnv?: NodeJS.ProcessEnv): Promise<string> {
  const childProcess = spawn(executable, args, {
    stdio: 'pipe',
    cwd,
    env: { ...process.env, ...settingsEnv }
  });
  let output = '';
  childProcess.stdout.on('data', data => output += data.toString());
  return new Promise<string>((f, r) => {
    childProcess.on('error', error => r(error));
    childProcess.on('exit', () => f(output));
  });
}

export async function resolveSourceMap(file: string, fileToSources: Map<string, string[]>, sourceToFile: Map<string, string>): Promise<string[]> {
  if (!file.endsWith('.js'))
    return [file];
  const cached = fileToSources.get(file);
  if (cached)
    return cached;

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

  let lastLine: string | undefined;
  rl.on('line', line => {
    lastLine = line;
  });
  await new Promise(f => rl.on('close', f));

  if (lastLine?.startsWith('//# sourceMappingURL=')) {
    const sourceMappingFile = path.resolve(path.dirname(file), lastLine.substring('//# sourceMappingURL='.length));
    try {
      const sourceMapping = await fs.promises.readFile(sourceMappingFile, 'utf-8');
      const sources = JSON.parse(sourceMapping).sources;
      const sourcePaths = sources.map((s: string) => {
        const source = path.resolve(path.dirname(sourceMappingFile), s);
        sourceToFile.set(source, file);
        return source;
      });
      fileToSources.set(file, sourcePaths);
      return sourcePaths;
    } catch (e) {
    }
  }
  fileToSources.set(file, [file]);
  return [file];
}

export class NodeJSNotFoundError extends Error {}

let pathToNodeJS: string | undefined;

export async function findNode(vscode: vscodeTypes.VSCode, cwd: string): Promise<string> {
  if (pathToNodeJS)
    return pathToNodeJS;

  // Stage 1: Try to find Node.js via process.env.PATH
  let node = await which('node').catch(e => undefined);
  // Stage 2: When extension host boots, it does not have the right env set, so we might need to wait.
  for (let i = 0; i < 5 && !node; ++i) {
    await new Promise(f => setTimeout(f, 200));
    node = await which('node').catch(e => undefined);
  }
  // Stage 3: If we still haven't found Node.js, try to find it via a subprocess.
  // This evaluates shell rc/profile files and makes nvm work.
  node ??= await findNodeViaShell(vscode, cwd);
  if (!node)
    throw new NodeJSNotFoundError(`Unable to find 'node' executable.\nMake sure to have Node.js installed and available in your PATH.\nCurrent PATH: '${process.env.PATH}'.`);
  pathToNodeJS = node;
  return node;
}

async function findNodeViaShell(vscode: vscodeTypes.VSCode, cwd: string): Promise<string | undefined> {
  if (process.platform === 'win32')
    return undefined;
  return new Promise<string | undefined>(resolve => {
    const startToken = '___START_PW_SHELL__';
    const endToken = '___END_PW_SHELL__';
    // NVM lazily loads Node.js when 'node' alias is invoked. In order to invoke it, we run 'node --version' if 'node' is a function.
    // See https://github.com/microsoft/playwright/issues/33996
    const childProcess = spawn(`${vscode.env.shell} -i -c 'if [[ $(type node 2>/dev/null) == *function* ]]; then node --version; fi; echo ${startToken} && which node && echo ${endToken}'`, {
      stdio: 'pipe',
      shell: true,
      cwd,
    });
    let output = '';
    childProcess.stdout.on('data', data => output += data.toString());
    childProcess.on('error', () => resolve(undefined));
    childProcess.on('exit', exitCode => {
      if (exitCode !== 0)
        return resolve(undefined);
      const start = output.indexOf(startToken);
      const end = output.indexOf(endToken);
      if (start === -1 || end === -1)
        return resolve(undefined);
      return resolve(output.substring(start + startToken.length, end).trim());
    });
  });
}

export function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const pathSeparator = process.platform === 'win32' ? ';' : ':';

export async function runNode(vscode: vscodeTypes.VSCode, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return await spawnAsync(await findNode(vscode, cwd), args, cwd, env);
}

export async function getPlaywrightInfo(vscode: vscodeTypes.VSCode, workspaceFolder: string, configFilePath: string, env: NodeJS.ProcessEnv): Promise<{ version: number, cli: string }> {
  const pwtInfo = await runNode(vscode, [
    require.resolve('./playwrightFinder'),
  ], path.dirname(configFilePath), env);
  const { version, cli, error } = JSON.parse(pwtInfo) as { version: number, cli: string, error?: string };
  if (error)
    throw new Error(error);
  let cliOverride = cli;
  if (cli.includes('/playwright/packages/playwright-test/') && configFilePath.includes('playwright-test'))
    cliOverride = path.join(workspaceFolder, 'tests/playwright-test/stable-test-runner/node_modules/@playwright/test/cli.js');
  return { cli: cliOverride, version };
}

export function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++)
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

// this is a no-op template tag. it instructs the "bierner.lit-html" vscode extension to highlight the string as HTML.
export function html(strings: TemplateStringsArray, ...expressions: unknown[]) {
  return strings.reduce((acc, str, i) => acc + expressions[i - 1] + str);
}

/**
 * This function converts lowercase drive letter to uppercase drive letter.
 *
 * ---- Explanation ----
 *
 * The Windows Filesystem is case-insensitive, but Node.js module loading is case-sensitive.
 * That means that on Windows, C:\foo and c:\foo point to the same file,
 * but on Node.js require-ing both of them will result in two instances of the file.
 * This can lead to two instances of @playwright/test being loaded, which can't happen.
 *
 * On top of that, Node.js' require algorithm sometimes turns `c:\foo` into `C:\foo`.
 * So we need to make sure that we always pass uppercase paths to Node.js.
 *
 * VS Code knows about this problem and already performs this in some cases, for example in `vscode.debug.startDebugging`.
 * But lots of other places do not, like Playwright's `--config <file>` or the CWD passed into node:child_process.
 * More on this in https://github.com/microsoft/playwright-vscode/pull/538#issuecomment-2404265216.
 *
 * ---- Solution ----
 *
 * Internally, we always use Playwright-style paths with uppercase driver letter.
 * When receiving a Uri from VSCode apis, we convert it with `uriToPath(uri)`.
 * When passing a Uri to VSCode apis, we call `vscode.Uri.file(path)`.
 */
export function uriToPath(uri: vscodeTypes.Uri): string {
  // eslint-disable-next-line no-restricted-properties
  return normalizePath(uri.fsPath);
}

// See uriToPath for details.
export function normalizePath(fsPath: string): string {
  if (process.platform === 'win32' && fsPath?.length && fsPath[0] !== '/' && fsPath[0] !== '\\')
    return fsPath[0].toUpperCase() + fsPath.substring(1);
  return fsPath;
}

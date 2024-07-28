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
import { _electron, test as base, ElectronApplication, FrameLocator, Locator, type Page } from '@playwright/test';
import { downloadAndUnzipVSCode } from '@vscode/test-electron/out/download';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { VSCode, VSCodeEvaluator, VSCodeFunctionOn, VSCodeHandle } from './vscodeHandle';
import { Disposable } from 'vscode';
export { expect } from '@playwright/test';

type TestFixtures = {
  _evaluator: VSCodeEvaluator,
  _vscodeHandle: VSCodeHandle<VSCode>,
  _vscodeAppAndEvaluator: { electronApp: ElectronApplication, evaluator: VSCodeEvaluator },
  baseDir: string,
  workbox: Page,
  getWebview: (overlappingElem: Locator) => Promise<FrameLocator>,
  evaluateInVSCode<R>(vscodeFunction: VSCodeFunctionOn<VSCode, void, R>): Promise<R>;
  evaluateInVSCode<R, Arg>(vscodeFunction: VSCodeFunctionOn<VSCode, Arg, R>, arg: Arg): Promise<R>;
  evaluateHandleInVSCode<R>(vscodeFunction: VSCodeFunctionOn<VSCode, void, R>): Promise<VSCodeHandle<R>>,
  evaluateHandleInVSCode<R, Arg>(vscodeFunction: VSCodeFunctionOn<VSCode, Arg, R>, arg: Arg): Promise<VSCodeHandle<R>>,
};

export type WorkerOptions = {
  vscodeVersion: string;
  createTempDir: () => Promise<string>;
};

export const test = base.extend<TestFixtures, WorkerOptions>({
  vscodeVersion: ['insiders', { option: true, scope: 'worker' }],
  baseDir: async ({ createTempDir }, use) => await use(await createTempDir()),

  _vscodeAppAndEvaluator: async ({ vscodeVersion, baseDir, createTempDir }, use) => {
    const evaluator = new VSCodeEvaluator();

    // remove all VSCODE_* environment variables, otherwise it fails to load custom webviews with the following error:
    // InvalidStateError: Failed to register a ServiceWorker: The document is in an invalid state
    const env = { ...process.env } as Record<string, string>;
    for (const prop in env) {
      if (/^VSCODE_/i.test(prop))
        delete env[prop];
    }
    const defaultCachePath = await createTempDir();
    const vscodePath = await downloadAndUnzipVSCode(vscodeVersion);
    const electronApp = await _electron.launch({
      executablePath: vscodePath,
      env: {
        ...env,
        PW_VSCODE_TEST_PORT: (await evaluator.port()).toString(),
      },
      args: [
        // Stolen from https://github.com/microsoft/vscode-test/blob/0ec222ef170e102244569064a12898fb203e5bb7/lib/runTest.ts#L126-L160
        // https://github.com/microsoft/vscode/issues/84238
        '--no-sandbox',
        // https://github.com/microsoft/vscode-test/issues/221
        '--disable-gpu-sandbox',
        // https://github.com/microsoft/vscode-test/issues/120
        '--disable-updates',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        `--extensionDevelopmentPath=${path.join(__dirname, '..', '..')}`,
        `--extensions-dir=${path.join(defaultCachePath, 'extensions')}`,
        `--user-data-dir=${path.join(defaultCachePath, 'user-data')}`,
        `--extensionTestsPath=${path.join(__dirname, 'injected', 'index')}`,
        baseDir,
      ],
    });
    await use({ electronApp, evaluator });
    await electronApp.close();
    await evaluator.dispose();
    const logPath = path.join(defaultCachePath, 'user-data');
    if (fs.existsSync(logPath)) {
      const logOutputPath = test.info().outputPath('vscode-logs');
      await fs.promises.cp(logPath, logOutputPath, { recursive: true });
    }
  },

  workbox: async ({ _vscodeAppAndEvaluator }, use) => {
    const { electronApp } = _vscodeAppAndEvaluator;
    const workbox = await electronApp.firstWindow();
    await workbox.context().tracing.start({ screenshots: true, snapshots: true, title: test.info().title });
    await use(workbox);
    const tracePath = test.info().outputPath('trace.zip');
    await workbox.context().tracing.stop({ path: tracePath });
    test.info().attachments.push({ name: 'trace', path: tracePath, contentType: 'application/zip' });
  },

  _evaluator: async ({ _vscodeAppAndEvaluator }, use) => {
    const { evaluator } = _vscodeAppAndEvaluator;
    await use(evaluator);
  },

  _vscodeHandle: async ({ _evaluator }, use) => {
    await use(_evaluator.rootHandle());
  },

  getWebview: async ({ workbox }, use) => {
    await use(async overlappingLocator => {
      const webviewId = await overlappingLocator.evaluate(overlappingElem => {
        function overlaps(elem: Element) {
          const rect1 = elem.getBoundingClientRect();
          const rect2 = overlappingElem.getBoundingClientRect();
          return rect1.right >= rect2.left && rect1.left <= rect2.right && rect1.bottom >= rect2.top && rect1.top <= rect2.bottom;
        }
        return [...document.querySelectorAll('.webview')].find(overlaps)?.getAttribute('name');
      });
      if (!webviewId)
        throw new Error(`No webview found overlapping ${overlappingLocator}`);
      return workbox.frameLocator(`[name='${webviewId}']`).frameLocator('iframe');
    });
  },

  evaluateInVSCode: async <R, Arg>({ _vscodeHandle }, use) => {
    await use(async (fn: VSCodeFunctionOn<VSCode, Arg, R>, arg: Arg) => {
      return await _vscodeHandle.evaluate(fn, arg);
    });
  },

  evaluateHandleInVSCode: async <R, Arg>({ _vscodeHandle }, use) => {
    const handles: Disposable[] = [];
    await use(async (fn: VSCodeFunctionOn<VSCode, Arg, R>, arg: Arg) => {
      const handle = await _vscodeHandle.evaluateHandle(fn, arg);
      handles.push(handle);
      return handle;
    });
    for (const handle of handles)
      handle.dispose();
  },

  createTempDir: [async ({ }, use) => {
    const tempDirs: string[] = [];
    await use(async () => {
      const tempDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwtest-')));
      await fs.promises.mkdir(tempDir, { recursive: true });
      tempDirs.push(tempDir);
      return tempDir;
    });
    for (const tempDir of tempDirs)
      await fs.promises.rm(tempDir, { recursive: true });
  }, { scope: 'worker' }]
});

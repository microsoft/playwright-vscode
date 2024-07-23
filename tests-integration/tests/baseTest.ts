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
import { test as base, type Page, _electron, Locator, FrameLocator } from '@playwright/test';
import { downloadAndUnzipVSCode } from '@vscode/test-electron/out/download';
export { expect } from '@playwright/test';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawnSync } from 'child_process';

export type TestOptions = {
  vscodeVersion: string;
  playwrightVersion?: 'next' | 'beta';
};

type TestFixtures = TestOptions & {
  workbox: Page,
  getWebview: (overlappingElem: Locator) => Promise<FrameLocator>,
  createProject: () => Promise<string>,
  createTempDir: () => Promise<string>,
};

export const test = base.extend<TestFixtures>({
  vscodeVersion: ['insiders', { option: true }],
  playwrightVersion: [undefined, { option: true }],
  workbox: async ({ vscodeVersion, createProject, createTempDir, }, use) => {
    // remove all VSCODE_* environment variables, otherwise it fails to load custom webviews with the following error:
    // InvalidStateError: Failed to register a ServiceWorker: The document is in an invalid state
    const env = { ...process.env } as Record<string, string>;
    for (const prop in env) {
      if (/VSCODE_/i.test(prop))
        delete env[prop];
    }

    const defaultCachePath = await createTempDir();
    const vscodePath = await downloadAndUnzipVSCode(vscodeVersion);
    const electronApp = await _electron.launch({
      executablePath: vscodePath,
      env,
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
        await createProject(),
      ],
    });
    const workbox = await electronApp.firstWindow();
    await workbox.context().tracing.start({ screenshots: true, snapshots: true, title: test.info().title });
    await use(workbox);
    const tracePath = test.info().outputPath('trace.zip');
    await workbox.context().tracing.stop({ path: tracePath });
    test.info().attachments.push({ name: 'trace', path: tracePath, contentType: 'application/zip' });
    await electronApp.close();
    const logPath = path.join(defaultCachePath, 'user-data');
    if (fs.existsSync(logPath)) {
      const logOutputPath = test.info().outputPath('vscode-logs');
      await fs.promises.cp(logPath, logOutputPath, { recursive: true });
    }
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
  createProject: async ({ createTempDir, playwrightVersion }, use) => {
    await use(async () => {
      // We want to be outside of the project directory to avoid already installed dependencies.
      const projectPath = await createTempDir();
      if (fs.existsSync(projectPath))
        await fs.promises.rm(projectPath, { recursive: true });
      console.log(`Creating project in ${projectPath}`);
      await fs.promises.mkdir(projectPath);
      spawnSync(`npm init playwright@latest --yes -- --quiet --browser=chromium --gha --install-deps ${playwrightVersion ? `--${playwrightVersion}` : ''}`, {
        cwd: projectPath,
        stdio: 'inherit',
        shell: true,
      });
      return projectPath;
    });
  },
  createTempDir: async ({ }, use) => {
    const tempDirs: string[] = [];
    await use(async () => {
      const tempDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pwtest-')));
      tempDirs.push(tempDir);
      return tempDir;
    });
    for (const tempDir of tempDirs)
      await fs.promises.rm(tempDir, { recursive: true });
  }
});

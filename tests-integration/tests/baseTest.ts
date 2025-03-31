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
import { test as base, type Page, _electron, expect } from '@playwright/test';
import { downloadAndUnzipVSCode } from '@vscode/test-electron/out/download';
export { expect } from '@playwright/test';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { spawnSync } from 'child_process';

export type TestOptions = {
  vscodeVersion: string;
  usePnp: boolean
};


type TestFixtures = TestOptions & {
  testkit: Testkit,
  createProject: () => Promise<string>,
  createTempDir: () => Promise<string>,
};

class Testkit {
  constructor(private workbox: Page) { }

  async openTestingTab() {
    const { workbox } = this;
    if (await workbox.getByRole('tab', { name: 'Testing' }).getAttribute('aria-selected') === 'true')
      return;

    await workbox.getByRole('tab', { name: 'Testing' }).locator('a').click();
  }

  async openFile(fileName: string) {
    const { workbox } = this;
    await workbox.keyboard.press('ControlOrMeta+P');
    await workbox.keyboard.type(fileName);
    // todo check parent dir for dublicates
    await workbox.getByRole('listbox', { name: /^Search files/ }).getByRole('option').first().click();
    // throw new Error('File not found');
  }
  async enableAllConfigs() {
    const { workbox } = this;
    await this.openTestingTab();
    await workbox.frameLocator('iframe').frameLocator('iframe[title="Playwright"]').getByRole('button', { name: 'Toggle Playwright Configs' }).click();
    await workbox.locator('input.quick-input-check-all').check();
    await workbox.keyboard.press('Enter');
  }

  async runTestInFile(fileName: string) {
    const { workbox } = this;
    await this.openFile(fileName);
    await expect(workbox.locator('.testing-run-glyph'), 'there are two tests in the file').toHaveCount(2);
    await workbox.locator('.testing-run-glyph').first().click();
    const passedLocator = workbox.locator('.monaco-editor').locator('.codicon-testing-passed-icon');
    await expect(passedLocator).toHaveCount(1);
  }
}

export const test = base.extend<TestFixtures>({
  vscodeVersion: ['insiders', { option: true }],
  usePnp: [false, { option: true }],

  testkit: async ({ vscodeVersion, createProject, createTempDir }, use) => {
    const defaultCachePath = await createTempDir();
    const vscodePath = await downloadAndUnzipVSCode(vscodeVersion);
    const electronApp = await _electron.launch({
      executablePath: vscodePath,
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
    const testkit = new Testkit(workbox);
    await testkit.enableAllConfigs();
    await use(testkit);
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
  createProject: async ({ createTempDir, usePnp }, use) => {
    await use(async () => {
      // We want to be outside of the project directory to avoid already installed dependencies.
      const projectPath = await createTempDir();
      if (fs.existsSync(projectPath))
        await fs.promises.rm(projectPath, { recursive: true });

      let nextUniqueId = 1;
      const createMonorepoPackage = (name: string) => {
        // creating monorepo package
        fs.mkdirSync(path.join(projectPath, name));
        runCmd('yarn init', { subdir: name });
        const packageJson = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
        packageJson.workspaces ??= [];
        packageJson.workspaces.push(name);
        fs.writeFileSync(path.join(projectPath, 'package.json'), JSON.stringify(packageJson), 'utf8');
        runCmd('yarn create playwright --pnp -- --quiet --browser=chromium --install-deps', { subdir: name });
        // currently there is a bug in extension
        // when there are two projects (both are enabled), with same test file name
        // after test is run in one project and navigation to second project
        // the second test will not have the run glyph. And it's not shown in model.
        // Rename of file fixes this. Remove this code to check bug.
        fs.renameSync(path.join(projectPath, name, 'tests/example.spec.ts'), path.join(projectPath, name, `tests/example${nextUniqueId++}.spec.ts`));
        // /
      };
      console.log(`Creating project in ${projectPath}`);
      const runCmd = (cmd: string, { subdir = '' }: { subdir?: string } = {}) => {
        const result = spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: path.join(projectPath, subdir), env: { ...process.env, YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' } });
        if (result.status !== 0)
          throw new Error(`Command failed: ${cmd} with exit code ${result.status}`);

      };
      await fs.promises.mkdir(projectPath);
      runCmd('yarn init -2');
      runCmd('yarn create playwright --pnp -- --quiet --browser=chromium --gha --install-deps');

      createMonorepoPackage('other');

      if (usePnp) {
        fs.mkdirSync(path.join(projectPath, '.vscode'));
        fs.writeFileSync(path.join(projectPath, '.vscode', 'settings.json'), JSON.stringify({
          'playwright.env': {
            'NODE_OPTIONS': '--require=${workspaceFolder}/.pnp.cjs --loader=${workspaceFolder}/.pnp.loader.mjs'
          }
        }), 'utf8');
        if (fs.existsSync(path.join(projectPath, 'node_modules')))
          throw new Error('node_modules should not exist');

      } else {
        runCmd('yarn config set nodeLinker node-modules');
        runCmd('yarn install');
        if (!fs.existsSync(path.join(projectPath, 'node_modules')))
          throw new Error('node_modules should exist');

      }

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

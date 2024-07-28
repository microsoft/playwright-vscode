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

import type { FrameLocator } from '@playwright/test';
import { spawn, SpawnOptions } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { SinonStub } from 'sinon';
import type * as vscode from 'vscode';
import type { Extension } from '../../src/extension';
import type { TestModelCollection } from '../../src/testModel';
import type { VSCodeHandle } from './vscodeHandle';
import { test as base, expect as baseExpect } from './vscodeTest';

type Diagnostic = {
  message: string,
  range: {
    start: { line: number, character: number },
    end: { line: number, character: number }
  },
  severity: string,
  source?: string,
};

export type WorkspaceFolderProxy = {
  uri: string;
  name?: string;
  addFile(file: string, content: string): Promise<void>;
  removeFile(file: string): Promise<void>;
  changeFile(file: string, content: string): Promise<void>;
};

type TestControllerProxy = {
  renderTestTree: () => Promise<string>;
  onDidChangeTestItem: (listener: (item: any) => void) => void;
  expandTestItems: (label: RegExp) => Promise<void>;
};

type VSCodeProxy = {
  overridePlaywrightVersion?: number;
  renderExecLog: () => Promise<string>;
  renderProjectTree: () => Promise<string>;
  filteredConnectionLog: (...filters: string[]) => Promise<any[]>;
  enableConfigs: (labels: string[]) => Promise<boolean>;
  openEditors: (path: string) => Promise<void>;
  webViews: {
    get(name: string): Promise<FrameLocator>;
  },
  workspace: {
    workspaceFolders: WorkspaceFolderProxy[];
  },
  languages: {
    getDiagnostics: () => Promise<Diagnostic[]>
  }
};

type ActivateResult = {
  vscode: VSCodeProxy,
  testController: TestControllerProxy;
  workspaceFolder: WorkspaceFolderProxy;
};

type TestFixtures = {
  _activatedExtensionHandle: VSCodeHandle<() => Promise<Extension>>;
  vscode: VSCodeProxy;
  workspaceFolder: WorkspaceFolderProxy;
  _getTestController: () => Promise<TestControllerProxy>;
  activate: (files: { [key: string]: string }, options?: { rootDir?: string, workspaceFolders?: [string, any][], env?: Record<string, any> }) => Promise<ActivateResult>;
  createWorkspaceFolder: (uri: string, name?: string) => Promise<WorkspaceFolderProxy>,
  createProject: (rootDir?: string) => Promise<string>,
};

export type WorkerOptions = {
  playwrightVersion?: 'latest' | 'next';
  overridePlaywrightVersion?: number;
  projectTemplateDir: string;
};

export async function spawnAsync(executable: string, args: string[], options: Exclude<SpawnOptions, 'stdio'>): Promise<string> {
  const childProcess = spawn(executable, args, {
    ...options,
    stdio: 'pipe',
  });
  let output = '';
  childProcess.stdout.on('data', data => output += data.toString());
  return new Promise<string>((f, r) => {
    childProcess.on('error', error => r(error));
    childProcess.on('exit', () => f(output));
  });
}

export const expect = baseExpect.extend({
  async toHaveTestTree(testController: TestControllerProxy, expectedTree: string) {
    try {
      await expect.poll(() => testController.renderTestTree()).toBe(expectedTree);
      return { pass: true, message: () => '' };
    } catch (e) {
      return {
        pass: false,
        message: () => e.toString()
      };
    }
  },

  async toHaveExecLog(vscode: VSCodeProxy, expectedLog: string) {
    if (!vscode.overridePlaywrightVersion)
      return { pass: true, message: () => '' };
    try {
      await expect.poll(() => vscode.renderExecLog()).toBe(expectedLog);
      return { pass: true, message: () => '' };
    } catch (e) {
      return {
        pass: false,
        message: () => e.toString()
      };
    }
  },

  async toHaveConnectionLog(vscode: VSCodeProxy, expectedLog: any[]) {
    if (vscode.overridePlaywrightVersion)
      return { pass: true, message: () => '' };
    try {
      await expect.poll(() => vscode.filteredConnectionLog('ping', 'initialize')).toEqual(expectedLog);
      return { pass: true, message: () => '' };
    } catch (e) {
      return {
        pass: false,
        message: () => e.toString()
      };
    }
  },

  async toHaveProjectTree(vscode: VSCodeProxy, expectedTree: string) {
    try {
      await expect.poll(() => vscode.renderProjectTree().then(s => s.trim().replace(/\\/, '/'))).toBe(expectedTree.trim());
      return { pass: true, message: () => '' };
    } catch (e) {
      return {
        pass: false,
        message: () => e.toString()
      };
    }
  },
});

export const test = base.extend<TestFixtures, WorkerOptions>({
  overridePlaywrightVersion: [undefined, { option: true, scope: 'worker' }],
  playwrightVersion: [undefined, { option: true, scope: 'worker' }],

  _activatedExtensionHandle: async ({ evaluateHandleInVSCode }, use) => {
    await use(await evaluateHandleInVSCode(vscode => () => new Promise<Extension>(async (resolve, reject) => {
      const extension = vscode.extensions.getExtension('ms-playwright.playwright');
      if (!extension)
        throw new Error(`Extension ms-playwright.playwright not found`);

      if (!extension.isActive) {
        try {
          const extensionInstance = await extension.activate();
          resolve(extensionInstance);
        } catch (e) {
          reject(e);
        }
      } else {
        resolve(extension.exports);
      }
    })));
  },

  vscode: async ({ evaluateInVSCode, evaluateHandleInVSCode, overridePlaywrightVersion, workbox, getWebview, _activatedExtensionHandle }, use) => {
    const functions = await evaluateHandleInVSCode(async (vscode, activatedExtension) => {
      const path = await import('path');

      function unescapeRegex(regex: string) {
        return regex.replace(/\\(.)/g, '$1');
      }

      function trimLog(log: string) {
        return log.split('\n').map(line => line.trimEnd()).join('\n');
      }

      function renderExecLog(indent: string = '') {
        const log: string[] = [''];
        for (const extension of vscode.extensions.all)
          log.push(...extension.exports?.playwrightTestLog?.());
        return trimLog(unescapeRegex(log.join(`\n  ${indent}`)).replace(/\\/g, '/')) + `\n${indent}`;
      }

      const connectionLog: any[] = [];
      (globalThis as any).__logForTest = message => connectionLog.push(message);

      function filteredConnectionLog(...filters: string[]) {
        const filterCommands = new Set(filters);
        return connectionLog.filter(e => !filterCommands.has(e.method));
      }

      async function enableConfigs(labels: string[]) {
        const extension = await activatedExtension();
        const models = (extension as any)._models as TestModelCollection;
        const indexedModels = new Map(models.models().map(m => {
          const label = path.relative(m.config.workspaceFolder, m.config.configFile);
          return [label, m];
        }));
        const allLabels = new Set(indexedModels.keys());
        if (!labels.every(l => allLabels.has(l)))
          return false;
        for (const [label, model] of indexedModels.entries())
          models.setModelEnabled(model.config.configFile, labels.includes(label), true);
        return true;
      }

      async function openEditors(path: string) {
        const paths = await vscode.workspace.findFiles(path);
        for (const [index, path] of paths.sort().entries())
          await vscode.window.showTextDocument(path, { preview: false, viewColumn: index > 0 ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active });
      }

      return { renderExecLog, filteredConnectionLog, enableConfigs, openEditors };
    }, _activatedExtensionHandle);

    async function getSettingsView() {
      const testingBtn = workbox.locator('[role=tab]:not(.checked) > [aria-label="Testing"]:visible');
      await testingBtn.click({ timeout: 1000 }).catch(() => {});
      return await getWebview(workbox.locator('.pane', { has: workbox.getByLabel('Playwright Section') }));
    }

    await use({
      overridePlaywrightVersion,
      renderExecLog: () => evaluateInVSCode(
          (_, { renderExecLog }) => renderExecLog(),
          functions
      ),
      filteredConnectionLog: (...filters: string[]) => evaluateInVSCode(
          (_, { functions: { filteredConnectionLog }, filters }) => filteredConnectionLog(...filters),
          { functions, filters }
      ),
      webViews: {
        async get(name: string) {
          if (name === 'pw.extension.settingsView')
            return await getSettingsView();
          throw new Error(`webview ${name} not handled yet`);
        },
      },
      workspace: {
        workspaceFolders: []
      },
      languages: {
        getDiagnostics: async () => {
          return await evaluateInVSCode(vscode => {
            return vscode.languages.getDiagnostics().flatMap(([, diagnostics]) => diagnostics).map(d => ({
              message: d.message,
              range: {
                start: { line: d.range.start.line, character: d.range.start.character },
                end: { line: d.range.end.line, character: d.range.end.line }
              },
              severity: vscode.DiagnosticSeverity[d.severity],
              source: d.source,
            }));
          });
        },
      },
      async renderProjectTree(): Promise<string> {
        const result: string[] = [''];
        const webView = await getSettingsView();
        const selectedConfig = await webView.getByTestId('models').evaluate((e: HTMLSelectElement) => e.selectedOptions[0].textContent);
        result.push(`    config: ${selectedConfig}`);
        const projectLocators = await webView.getByTestId('projects').locator('div').locator('label').all();
        for (const projectLocator of projectLocators) {
          const checked = await projectLocator.locator('input').isChecked();
          const name = await projectLocator.textContent();
          result.push(`    ${checked ? '[x]' : '[ ]'} ${name}`);
        }
        return result.join('\n');
      },
      enableConfigs: (labels: string[]) => evaluateInVSCode(
          (_, { functions: { enableConfigs }, labels }) => enableConfigs(labels),
          { functions, labels }
      ),
      openEditors: (path: string) => evaluateInVSCode(
          (_, { functions: { openEditors }, path }) => openEditors(path),
          { functions, path }
      ),
    });
  },

  _getTestController: async ({ evaluateHandleInVSCode, evaluateInVSCode, _activatedExtensionHandle }, use) => {
    async function createTestController() {
      const functions = await evaluateHandleInVSCode(async (vscode, activatedExtension) => {
        const sinon = await import('sinon');

        function listenToCalls<TArgs extends readonly any[], TResult>(
          target: SinonStub<TArgs, TResult>,
          listener: (event: { args: TArgs, resultValue: TResult }) => any
        ) {
          target.callsFake(function fireListener(...args) {
            const resultValue = target.wrappedMethod(...args);
            listener({ args, resultValue });
            return resultValue;
          });
        }

        const testControllerPromise = activatedExtension().then(extension => (extension as any)._testController as vscode.TestController);

        const statusByItem = new Map<vscode.TestItem, string>();

        testControllerPromise.then(testController => {
          const createTestRunStub = sinon.stub(testController, 'createTestRun').callsFake(
              (...args) => {
                const testRun = createTestRunStub.wrappedMethod(...args);
                listenToCalls(sinon.stub(testRun, 'enqueued'), ({ args: [item] }) => statusByItem.set(item, 'enqueued'));
                listenToCalls(sinon.stub(testRun, 'errored'), ({ args: [item] }) => statusByItem.set(item, 'errored'));
                listenToCalls(sinon.stub(testRun, 'failed'), ({ args: [item] }) => statusByItem.set(item, 'failed'));
                listenToCalls(sinon.stub(testRun, 'skipped'), ({ args: [item] }) => statusByItem.set(item, 'skipped'));
                listenToCalls(sinon.stub(testRun, 'passed'), ({ args: [item] }) => statusByItem.set(item, 'passed'));
                listenToCalls(sinon.stub(testRun, 'started'), ({ args: [item] }) => statusByItem.set(item, 'started'));
                return testRun;
              },
          );
        });

        function itemOrder(item: vscode.TestItem) {
          let result = '';
          if (item.range)
            result += item.range.start.line.toString().padStart(5, '0');
          result += item.label;
          return result;
        }

        function statusIcon(item: vscode.TestItem) {
          const status = statusByItem.get(item);
          if (status === 'skipped')
            return '◯';
          if (status === 'failed')
            return '❌';
          if (status === 'passed')
            return '✅';
          if (status === 'enqueued')
            return '🕦';
          if (status === 'started')
            return '↻';
          return ' ';
        }

        function treeTitle(item: vscode.TestItem): string {
          let location = '';
          if (item.range)
            location = ` [${item.range.start.line}:${item.range.start.character}]`;
          return `${item.label}${location}`;
        }

        function innerToString(item: vscode.TestItem, indent: string, result: string[]) {
          result.push(`${indent}- ${statusIcon(item)} ${treeTitle(item)}`);
          const items = [...item.children].map(([, item]) => item);
          items.sort((i1, i2) => itemOrder(i1).localeCompare(itemOrder(i2)));
          for (const item of items)
            innerToString(item, indent + '  ', result);
        }

        async function renderTestTree() {
          const testController = await testControllerPromise;
          const result: string[] = [''];
          const items = [...testController.items].map(([, item]) => item);
          items.sort((i1, i2) => itemOrder(i1).localeCompare(itemOrder(i2)));
          for (const item of items)
            innerToString(item, '    ', result);
          result.push('  ');
          return result.join('\n');
        }

        async function expandTestItems(label: RegExp, rootItem?: vscode.TestItem) {
          const testController = await testControllerPromise;
          for (const [, item] of (rootItem?.children ?? testController.items)) {
            if (item.label === 'Loading\u2026') {
              // wait and retry
              await new Promise(r => setTimeout(r, 1000));
              expandTestItems(label, rootItem);
              return;
            }

            // we always expand root items
            if (item.canResolveChildren && item.children.size === 0 && (!rootItem || label.test(item.label)))
              await testController.resolveHandler?.(item);
            await expandTestItems(label, item);
          }
        }

        return { renderTestTree, expandTestItems };
      }, _activatedExtensionHandle);

      return {
        renderTestTree: () => evaluateInVSCode(
            (_, { renderTestTree }) => renderTestTree(),
            functions
        ),
        expandTestItems: ({ source, flags }: RegExp) => evaluateInVSCode(
            (_, { functions: { expandTestItems }, label: { source, flags } }) => expandTestItems(new RegExp(source, flags)),
            { functions, label: { source, flags } }
        ),
        onDidChangeTestItem: () => {
          throw new Error(`not implemented`);
        },
      };
    }

    let testControllerPromise: Promise<TestControllerProxy> | undefined;
    await use(async () => {
      if (!testControllerPromise)
        testControllerPromise = createTestController();
      return await testControllerPromise;
    });
  },

  activate: async ({ baseDir, createProject, vscode, workspaceFolder, createWorkspaceFolder, evaluateInVSCode, _getTestController }, use) => {
    await use(async (files: { [key: string]: string }, options?: { rootDir?: string, workspaceFolders?: [string, any][], env?: Record<string, any> }) => {
      if (files && Object.keys(files).length > 0) {
        await createProject(baseDir);
        for (const [fsPath, content] of Object.entries(files))
          await workspaceFolder.addFile(fsPath, content);
      }
      if (options?.workspaceFolders) {
        for (const [rootFolder, files] of options?.workspaceFolders) {
          const workspaceFolder = await createWorkspaceFolder(rootFolder, path.basename(rootFolder));
          await workspaceFolder.addFile('package.json', '{}');
          if (files) {
            for (const [fsPath, content] of Object.entries(files as Record<string, string>))
              await workspaceFolder.addFile(fsPath, content);
          }
        }
      }

      await evaluateInVSCode(vscode => vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer'));

      const testController = await _getTestController();

      return {
        vscode,
        testController,
        workspaceFolder,
      };
    });
  },

  workspaceFolder: async ({ baseDir, createWorkspaceFolder }, use) => await use(await createWorkspaceFolder(baseDir)),

  createWorkspaceFolder: async ({ baseDir, vscode, evaluateHandleInVSCode, evaluateInVSCode }, use) => {
    function getAbsoluteFile(root: string, uri: string) {
      return path.isAbsolute(uri) ? uri : path.join(root, uri);
    }

    await use(async (uri: string, name?: string) => {
      uri = getAbsoluteFile(baseDir, uri);
      await fs.promises.mkdir(uri, { recursive: true });
      await evaluateHandleInVSCode((vscode, { uri, name }) => {
        vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, null, {
          uri: vscode.Uri.file(uri),
          name,
        });
      }, { uri, name });
      const workspaceFolder = {
        name,
        uri,
        async addFile(file: string, content: string) {
          await evaluateInVSCode(async (vscode, { uri, content }) => {
            await vscode.workspace.fs.writeFile(vscode.Uri.file(uri), new TextEncoder().encode(content));
          }, { uri: getAbsoluteFile(uri, file), content });
        },
        async removeFile(file: string) {
          await evaluateInVSCode(async (vscode, uri) => {
            await vscode.workspace.fs.delete(vscode.Uri.file(uri));
          }, getAbsoluteFile(uri, file));
        },
        async changeFile(file: string, content: string) {
          await evaluateInVSCode(async (vscode, { uri, content }) => {
            await vscode.workspace.fs.writeFile(vscode.Uri.file(uri), new TextEncoder().encode(content));
          }, { uri: getAbsoluteFile(uri, file), content });
        },
      };
      vscode.workspace.workspaceFolders.push(workspaceFolder);
      return workspaceFolder;
    });
  },

  createProject: async ({ createTempDir, projectTemplateDir }, use) => {
    await use(async (rootDir?: string) => {
      // We want to be outside of the project directory to avoid already installed dependencies.
      const projectPath = rootDir ?? await createTempDir();
      await fs.promises.mkdir(projectPath, { recursive: true });
      await fs.promises.cp(projectTemplateDir, projectPath, { recursive: true });
      return projectPath;
    });
  },

  projectTemplateDir: [async ({ createTempDir, playwrightVersion }, use) => {
    const projectPath = await createTempDir();
    await spawnAsync('npm', ['init', 'playwright@latest', '--yes', '--', '--quiet', '--browser=chromium', '--lang=js', '--no-examples', '--install-deps', playwrightVersion ? `--${playwrightVersion}` : ''], {
      cwd: projectPath,
      stdio: 'inherit',
      shell: true,
    });
    await use(projectPath);
  }, { scope: 'worker' }],
});

export async function enableProjects(vscode: VSCodeProxy, projects: string[]) {
  const webView = await vscode.webViews.get('pw.extension.settingsView')!;

  // ensures all projects exist
  for (const project of projects)
    await webView.getByTestId('projects').locator('div').locator('label', { hasText: project }).locator('input').check();

  const projectLocators = await webView.getByTestId('projects').locator('div').locator('label', { has: webView.getByRole('checkbox', { checked: true }) }).all();
  for (const projectLocator of projectLocators) {
    const name = await projectLocator.textContent();
    if (!projects.includes(name!))
      await projectLocator.locator('input').uncheck();
  }
}

export async function enableConfigs(vscode: VSCodeProxy, labels: string[]) {
  await expect.poll(() => vscode.enableConfigs(labels)).toBeTruthy();
}

function escapeRegex(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const escapedPathSep = escapeRegex(path.sep);

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
import { PipeTransport } from './transport';
import path from 'path';
import { findInPath } from './pathUtils';
import { Entry, FileReport, Project } from './oopListReporter';
import vscode from 'vscode';

export type Config = { workspaceFolder: string, configFile: string };

export class TestModel {
  private _configs: Config[] = [];
  private _files = new Map<string, { entries: Entry[] | null, configs: Config[] }>();
  private _isDogFood = false;

  reset(isDogFood: boolean) {
    this._configs = [];
    this._files.clear();
    this._isDogFood = isDogFood;
  }

  addConfig(workspaceFolder: string, configFile: string) {
    this._configs.push({
      workspaceFolder,
      configFile,
    });
  }

  async loadEntries(file: string): Promise<Entry[]> {
    const fileInfo = this._files.get(file);
    if (fileInfo && fileInfo.entries)
      return fileInfo.entries;
    const entries: { [key: string]: Entry } = {};
    const nonEmptyConfigs = [];
    for (const config of fileInfo?.configs || this._configs) {
      const files: FileReport[] = await this.query(config, [file, '--list', '--reporter', path.join(__dirname, 'oopListReporter.js')]);
      if (!files)
        continue;
      nonEmptyConfigs.push(config);
      for (const file of files || []) {
        for (const [id, entry] of Object.entries(file.entries)) {
          let existingEntry = entries[id];
          if (!existingEntry) {
            existingEntry = entry;
            entries[id] = existingEntry;
          } else {
            existingEntry.projects = [...existingEntry.projects, ...entry.projects];
          }
          for (const project of existingEntry.projects)
            project.configFile = config.configFile;
        }
      }
    }

    const entryArray = Object.values(entries);
    this._files.set(file, { entries: entryArray, configs: nonEmptyConfigs });
    return entryArray;
  }

  discardEntries(file: string) {
    if (this._files.has(file))
      this._files.get(file)!.entries = null;
  }

  async runTest(project: Project, location: { file: string; line?: number; }, debug: boolean) {
    const fileInfo = this._files.get(location.file);
    if (!fileInfo)
      return;
    for (const config of fileInfo.configs) {
      if (config.configFile !== project.configFile)
        continue;
      const filter = location.line ? location.file + ':' + location.line : location.file;
      const args = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'test', '-c', config.configFile, filter, '--project', project.projectName];
      if (debug)
        args.push('--headed', '--timeout', '0');
      vscode.debug.startDebugging(undefined, {
        type: 'pwa-node',
        name: 'Playwright Test',
        request: 'launch',
        cwd: config.workspaceFolder,
        env: { ...process.env, PW_OUT_OF_PROCESS: '1' },
        args,
        resolveSourceMapLocations: [],
        outFiles: [],
        noDebug: !debug,
      });
    }
  }

  async runFile(file: string) {
    await this.loadEntries(file);
    const fileInfo = this._files.get(file);
    if (!fileInfo)
      return;
    const projects = new Map<string, Project>();
    for (const entry of fileInfo.entries || []) {
      for (const project of entry.projects)
        projects.set(project.configFile + ':' + project.projectName, project);
    }
    const projectArray = [...projects.values()];
    if (!projectArray.length)
      return;
    if (projectArray.length === 1) {
      await this.runTest(projectArray[0], { file }, false);
      return;
    }

    const item = await vscode.window.showQuickPick([...projects.values()].map(p => p.projectName), {
      title: 'Select Playwright project',
    });
    const project = projectArray.find(p => p.projectName === item);
    if (project)
      this.runTest(project!, { file }, false);
  }

  async query(config: Config, args: string[]): Promise<any> {
    const node = findInPath('node', process.env);
    if (!node)
      throw new Error('Unable to launch `node`, make sure it is in your PATH');
    const allArgs = [`${this._nodeModules(config)}/playwright-core/lib/cli/cli`, 'test', '-c', config.configFile, ...args];
    const childProcess = spawn(node, allArgs, {
      cwd: config.workspaceFolder,
      stdio: 'pipe',
      env: { ...process.env }
    });
  
    const stdio = childProcess.stdio;
    const transport = new PipeTransport(stdio[0]!, stdio[1]!);
    let result: any;
    transport.onmessage = message => {
      result = message.params;
    };
    return new Promise(f => {
      transport.onclose = () => {
        f(result);
      };
    });
  }

  private _nodeModules(config: Config) {
    if (!this._isDogFood)
      return 'node_modules';

    if (config.configFile.includes('playwright-test'))
      return 'tests/playwright-test/stable-test-runner/node_modules';
    return 'packages';
  }
}

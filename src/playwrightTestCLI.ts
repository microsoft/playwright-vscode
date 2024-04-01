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
import path from 'path';
import { ConfigFindRelatedTestFilesReport, ConfigListFilesReport } from './listTests';
import { ReporterServer } from './reporterServer';
import { escapeRegex, findNode, pathSeparator, runNode } from './utils';
import * as vscodeTypes from './vscodeTypes';
import * as reporterTypes from './upstream/reporter';
import type { PlaywrightTestOptions, PlaywrightTestRunOptions, TestConfig } from './playwrightTestTypes';
import { debugSessionName } from './debugSessionName';

export class PlaywrightTestCLI {
  private _vscode: vscodeTypes.VSCode;
  private _options: PlaywrightTestOptions;
  private _config: TestConfig;

  constructor(vscode: vscodeTypes.VSCode, config: TestConfig, options: PlaywrightTestOptions) {
    this._vscode = vscode;
    this._config = config;
    this._options = options;
  }

  reset() {
  }

  async listFiles(): Promise<ConfigListFilesReport> {
    const configFolder = path.dirname(this._config.configFile);
    const configFile = path.basename(this._config.configFile);
    const allArgs = [this._config.cli, 'list-files', '-c', configFile];
    {
      // For tests.
      this._log(`${escapeRegex(path.relative(this._config.workspaceFolder, configFolder))}> playwright list-files -c ${configFile}`);
    }
    const output = await this._runNode(allArgs, configFolder);
    const result = JSON.parse(output) as Partial<ConfigListFilesReport>;
    return {
      // list-files does not return `projects: []` if there is an error.
      projects: [],
      ...result,
    };
  }

  async listTests(locations: string[], reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    const args = [];
    args.push('--list', '--reporter=null');
    await this._innerSpawn(locations, args, {}, reporter, token);
  }

  async runTests(locations: string[], options: PlaywrightTestRunOptions, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    const args = [];
    if (options.projects)
      options.projects.forEach(p => args.push(`--project=${p}`));
    if (options.grep)
      args.push(`--grep=${escapeRegex(options.grep)}`);
    args.push('--repeat-each=1');
    args.push('--retries=0');
    if (options.headed)
      args.push('--headed');
    if (options.workers)
      args.push(`--workers=${options.workers}`);
    if (options.trace)
      args.push(`--trace=${options.trace}`);
    await this._innerSpawn(locations, args, options, reporter, token);
  }

  async _innerSpawn(locations: string[], extraArgs: string[], options: PlaywrightTestRunOptions, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken) {
    if (token?.isCancellationRequested)
      return;

    // Playwright will restart itself as child process in the ESM mode and won't inherit the 3/4 pipes.
    // Always use ws transport to mitigate it.
    const reporterServer = new ReporterServer(this._vscode);
    const node = await findNode(this._vscode, this._config.workspaceFolder);
    const configFolder = path.dirname(this._config.configFile);
    const configFile = path.basename(this._config.configFile);
    const escapedLocations = locations.map(escapeRegex).sort();

    {
      // For tests.
      const relativeLocations = locations.map(f => path.relative(configFolder, f)).map(escapeRegex).sort();
      const printArgs = extraArgs.filter(a => !a.includes('--repeat-each') && !a.includes('--retries') && !a.includes('--workers') && !a.includes('--trace'));
      this._log(`${escapeRegex(path.relative(this._config.workspaceFolder, configFolder))}> playwright test -c ${configFile}${printArgs.length ? ' ' + printArgs.join(' ') : ''}${relativeLocations.length ? ' ' + relativeLocations.join(' ') : ''}`);
    }

    const childProcess = spawn(node, [
      this._config.cli,
      'test',
      '-c', configFile,
      ...extraArgs,
      ...escapedLocations,
    ], {
      cwd: configFolder,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CI: this._options.isUnderTest ? undefined : process.env.CI,
        // Don't debug tests when running them.
        NODE_OPTIONS: undefined,
        ...this._options.envProvider(),
        PW_TEST_REUSE_CONTEXT: options.reuseContext ? '1' : undefined,
        PW_TEST_CONNECT_WS_ENDPOINT: options.connectWsEndpoint,
        ...(await reporterServer.env()),
        // Reset VSCode's options that affect nested Electron.
        ELECTRON_RUN_AS_NODE: undefined,
        FORCE_COLOR: '1',
        PW_TEST_HTML_REPORT_OPEN: 'never',
        PW_TEST_NO_REMOVE_OUTPUT_DIRS: '1',
      }
    });

    const stdio = childProcess.stdio;
    stdio[1].on('data', data => reporter.onStdOut?.(data));
    stdio[2].on('data', data => reporter.onStdErr?.(data));
    await reporterServer.wireTestListener(reporter, token);
  }

  async debugTests(locations: string[], testDirs: string[], options: PlaywrightTestRunOptions, reporter: reporterTypes.ReporterV2, token: vscodeTypes.CancellationToken): Promise<void> {
    const configFolder = path.dirname(this._config.configFile);
    const configFile = path.basename(this._config.configFile);
    const escapedLocations = locations.map(escapeRegex);
    const args = ['test',
      '-c', configFile,
      ...escapedLocations,
      options.headed ? '--headed' : '',
      ...(options.projects || []).map(p => `--project=${p}`),
      '--repeat-each', '1',
      '--retries', '0',
      '--timeout', '0',
      '--workers', options.workers,
    ].filter(Boolean);
    if (options.grep)
      args.push(`--grep=${escapeRegex(options.grep)}`);

    {
      // For tests.
      const relativeLocations = locations.map(f => path.relative(configFolder, f)).map(escapeRegex);
      this._log(`${escapeRegex(path.relative(this._config.workspaceFolder, configFolder))}> debug -c ${configFile}${relativeLocations.length ? ' ' + relativeLocations.join(' ') : ''}`);
    }

    const reporterServer = new ReporterServer(this._vscode);
    const testOptions = await this._options.runHooks.onWillRunTests(this._config, true);
    try {
      await this._vscode.debug.startDebugging(undefined, {
        type: 'pwa-node',
        name: debugSessionName,
        request: 'launch',
        cwd: configFolder,
        env: {
          ...process.env,
          CI: this._options.isUnderTest ? undefined : process.env.CI,
          ...this._options.envProvider(),
          PW_TEST_CONNECT_WS_ENDPOINT: testOptions.connectWsEndpoint,
          ...(await reporterServer.env()),
          // Reset VSCode's options that affect nested Electron.
          ELECTRON_RUN_AS_NODE: undefined,
          FORCE_COLOR: '1',
          PW_TEST_SOURCE_TRANSFORM: require.resolve('./debugTransform'),
          PW_TEST_SOURCE_TRANSFORM_SCOPE: testDirs.join(pathSeparator),
          PW_TEST_HTML_REPORT_OPEN: 'never',
          PWDEBUG: 'console',
        },
        program: this._config.cli,
        args,
      });
      await reporterServer.wireTestListener(reporter, token);
    } finally {
      await this._options.runHooks.onDidRunTests(true);
    }
  }

  async findRelatedTestFiles(files: string[]): Promise<ConfigFindRelatedTestFilesReport> {
    const configFolder = path.dirname(this._config.configFile);
    const configFile = path.basename(this._config.configFile);
    const allArgs = [this._config.cli, 'find-related-test-files', '-c', configFile, ...files];
    {
      // For tests.
      this._log(`${escapeRegex(path.relative(this._config.workspaceFolder, configFolder))}> playwright find-related-test-files -c ${configFile}`);
    }
    try {
      const output = await this._runNode(allArgs, configFolder);
      const result = JSON.parse(output) as ConfigFindRelatedTestFilesReport;
      return result;
    } catch (error: any) {
      return {
        errors: [{
          location: { file: configFile, line: 0, column: 0 },
          message: error.message,
        }],
        testFiles: files,
      };
    }
  }

  private async _runNode(args: string[], cwd: string) {
    return await runNode(this._vscode, args, cwd, this._options.envProvider());
  }

  private _log(line: string) {
    this._options.playwrightTestLog.push(line);
  }
}

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
import * as vscode from 'vscode';
import { PlaywrightTestNPMPackage } from './playwrightTest';
import { TestCase, TestFile, testData } from './testTree';

const configuration = vscode.workspace.getConfiguration();

export async function activate(context: vscode.ExtensionContext) {
  if (!vscode.workspace.workspaceFolders) {
    vscode.window.showWarningMessage('Playwright Test only works when a folder is opened.');
    return;
  }

  const ctrl = vscode.test.createTestController('playwrightTestController');
  context.subscriptions.push(ctrl);

  // All VS Code tests are in a tree, starting at the automatically created "root".
  // We'll give it a label, and set its status so that VS Code will call
  // `resolveChildrenHandler` when the test explorer is opened.
  ctrl.root.label = 'Playwright Test';
  ctrl.root.canResolveChildren = true;

  ctrl.runHandler = (request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) => {
    const queue: { test: vscode.TestItem; data: TestCase }[] = [];
    const run = ctrl.createTestRun(request);
    const discoverTests = async (tests: Iterable<vscode.TestItem>) => {
      for (const test of tests) {
        if (request.exclude?.includes(test)) {
          continue;
        }

        const data = testData.get(test);
        if (data instanceof TestCase) {
          run.setState(test, vscode.TestResultState.Queued);
          queue.push({test, data});
        } else {
          if (data instanceof TestFile && test.children.size === 0) {
            await data.updateFromDisk(ctrl, test);
          }

          await discoverTests(test.children.values());
        }
      }
    };

    const runTestQueue = async () => {
      for (const {test, data} of queue) {
        run.appendOutput(`Running ${test.id}\r\n`);
        if (cancellation.isCancellationRequested) {
          run.setState(test, vscode.TestResultState.Skipped);
        } else {
          run.setState(test, vscode.TestResultState.Running);
          await data.run(test, run);
        }
        run.appendOutput(`Completed ${test.id}\r\n`);
      }

      run.end();
    };

    discoverTests(request.tests).then(runTestQueue);
  };

  const playwrightTestConfigsFromSettings = configuration.get<string[]>("playwright.configs");
  const playwrightTestConfig = playwrightTestConfigsFromSettings?.length === 1 ? playwrightTestConfigsFromSettings[0] : null;

  const playwrightTest = await PlaywrightTestNPMPackage.create(vscode.workspace.workspaceFolders[0].uri.path, playwrightTestConfig);

  ctrl.resolveChildrenHandler = async item => {
    if (item === ctrl.root) {
      await startWatchingWorkspace(ctrl, playwrightTest);
      return;
    }
    const data = testData.get(item);
    if (data instanceof TestFile)
      await data.updateFromDisk(ctrl, item);
  };

  function updateNodeForDocument(e: vscode.TextDocument) {
    if (!['.ts', '.js'].some(extension => e.uri.path.endsWith(extension))) {
      return;
    }

    const { file, data } = getOrCreateFile(ctrl, e.uri, playwrightTest);
    data.updateFromDisk(ctrl, file);
  }

  for (const document of vscode.workspace.textDocuments) {
    updateNodeForDocument(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
    vscode.workspace.onDidSaveTextDocument(updateNodeForDocument)
  );

  const commandHandler = async () => {
    const tests = await playwrightTest.listTests(vscode.workspace.workspaceFolders![0].uri.path);
    if (!tests)
      return;
    const items: vscode.QuickPickItem[] = tests.config.projects.map(project => ({
      label: project.name,
      description: `Playwright Test project: ${project.name}`,
    }));

    const selection = await vscode.window.showQuickPick(items);
    // the user canceled the selection
    if (!selection) {
      return;
    }
    playwrightTest.setProject(selection.label);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('playwright-test-provider.selectProject', commandHandler)
  );
}

function getOrCreateFile(controller: vscode.TestController, uri: vscode.Uri, playwrightTest: PlaywrightTestNPMPackage) {
  const existing = controller.root.children.get(uri.toString());
  if (existing) {
    return { file: existing, data: testData.get(existing) as TestFile };
  }

  const file = controller.createTestItem(
    uri.toString(),
    path.relative(vscode.workspace.workspaceFolders![0].uri.path, uri.path),
    controller.root,
    uri,
  );

  const data = new TestFile(playwrightTest);
  testData.set(file, data);

  file.canResolveChildren = true;
  return { file, data };
}

function startWatchingWorkspace(controller: vscode.TestController, playwrightTest: PlaywrightTestNPMPackage) {
  if (!vscode.workspace.workspaceFolders) {
    return [];
  }

  return Promise.all(
    vscode.workspace.workspaceFolders.map(async workspaceFolder => {
      const tests = await playwrightTest.listTests(workspaceFolder.uri.path);
      if (!tests)
        return;
      // set default project
      playwrightTest.setProject(tests.config.projects[0].name);
      for (const suite of tests.suites)
        getOrCreateFile(controller, vscode.Uri.file(path.join(tests.config.rootDir, suite.file)), playwrightTest);
    })
  );
}

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

  const playwrightTestConfigsFromSettings = configuration.get<string[]>("playwright.configs");
  const playwrightTestConfig = playwrightTestConfigsFromSettings?.[0] || null;

  let playwrightTest: PlaywrightTestNPMPackage;

  try {
    playwrightTest = await PlaywrightTestNPMPackage.create(vscode.workspace.workspaceFolders[0].uri.path, playwrightTestConfig);
  } catch (error) {
    vscode.window.showWarningMessage(error.toString());
    return;
  }


  const ctrl = vscode.test.createTestController('playwrightTestController', 'Playwright Test');
  context.subscriptions.push(ctrl);

  const runHandler: vscode.TestRunHandler = (request: vscode.TestRunRequest, cancellation: vscode.CancellationToken) => {
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
          queue.push({test, data });
        } else {
          if (data instanceof TestFile && !data.didResolve) {
            await data.updateFromDisk(test);
          }

          await discoverTests(test.children.all);
        }
      }
    };

    const runTestQueue = async () => {
      for (const { test, data } of queue) {
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

    discoverTests(request.include ?? ctrl.items.all).then(runTestQueue);
  };
  
  ctrl.createRunConfiguration('Run Tests', vscode.TestRunConfigurationGroup.Run, runHandler, true);

  ctrl.resolveChildrenHandler = async item => {
    const data = testData.get(item);
    if (data instanceof TestFile) {
      await data.updateFromDisk(item);
    }
  };

  function updateNodeForDocument(e: vscode.TextDocument) {
    if (!['.ts', '.js'].some(extension => e.uri.path.endsWith(extension))) {
      return;
    }

    const { file, data } = getOrCreateFile(ctrl, e.uri, playwrightTest);
    data.updateFromDisk(file);
  }

  for (const document of vscode.workspace.textDocuments) {
    updateNodeForDocument(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
    vscode.workspace.onDidSaveTextDocument(updateNodeForDocument)
  );
  await startWatchingWorkspace(ctrl, playwrightTest);
}

function getOrCreateFile(controller: vscode.TestController, uri: vscode.Uri, playwrightTest: PlaywrightTestNPMPackage) {
  const existing = controller.items.get(uri.toString());
  if (existing) {
    return { file: existing, data: testData.get(existing) as TestFile };
  }

  const file = vscode.test.createTestItem(uri.toString(), uri.path.split('/').pop()!, uri);
  controller.items.add(file);

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

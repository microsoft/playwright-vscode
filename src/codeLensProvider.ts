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

import vscode from 'vscode';
import { TestModel } from './testModel';

export class CodelensProvider implements vscode.CodeLensProvider {
  readonly onDidChangeCodeLensesEmitter: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this.onDidChangeCodeLensesEmitter.event;
  private _testModel: TestModel;

  constructor(testModel: TestModel) {
    this._testModel = testModel;
    vscode.workspace.onDidChangeConfiguration((_) => {
      this.onDidChangeCodeLensesEmitter.fire();
    });
  }

  public async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
    const codeLenses = [];
    const text = document.getText();
    const entries = await this._testModel.loadEntries(document.uri.fsPath);
    for (const entry of entries) {
      for (const project of entry.projects) {
        if (document.isDirty && !entry.text)
          continue;
        let position: vscode.Position;
        if (document.isDirty) {
          // When dirty, locate by text.
          let index = text.indexOf(entry.text!);
          if (index === -1)
            continue;
          position = document.positionAt(index);
        } else {
          // When dirty, locate by reporter data.
          position = new vscode.Position(entry.line - 1, entry.column - 1);
        }

        const range = position ? document.getWordRangeAtPosition(position, /(.+)/g) : null;
        if (!range)
          continue;

        if (!entry.text)
          entry.text = document.getText(range);

        codeLenses.push(new vscode.CodeLens(range, {
          title: `Run ${project.projectName}`,
          tooltip: `Run ${project.projectName}`,
          command: "pw.extension.runTest",
          arguments: [{ file: document.uri.fsPath, line: entry.line }, project]
        }));
        codeLenses.push(new vscode.CodeLens(range, {
          title: `Debug ${project.projectName}`,
          tooltip: `Debug ${project.projectName}`,
          command: "pw.extension.debugTest",
          arguments: [{ file: document.uri.fsPath, line: entry.line }, project]
        }));
      }
    }
    return codeLenses;
  }
}

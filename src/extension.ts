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

import * as vscodeTypes from './vscodeTypes';
import { discardHighlightCaches, hideHighlight, highlightLocator } from './highlighter';
import { DebuggerLocation, TestModel } from './testModel';

const debugSessions = new Map<string, vscodeTypes.DebugSession>();

export async function activate(context: vscodeTypes.ExtensionContext) {
  // Do not await, quickly run the extension, schedule work.
  new Extension(require('vscode')).activate(context);
}

export class Extension {
  private _vscode: vscodeTypes.VSCode;
  readonly testModel: TestModel;

  constructor(vscode: vscodeTypes.VSCode) {
    this._vscode = vscode;
    this.testModel = new TestModel(vscode);
  }

  async activate(context: vscodeTypes.ExtensionContext) {
    const vscode = this._vscode;
    const testModel = this.testModel;

    const activeStepDecorationType = this._vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: { id: 'editor.wordHighlightStrongBackground' },
      borderColor: { id: 'editor.wordHighlightStrongBorder' },
      after: {
        color: { id: 'editorCodeLens.foreground' },
        contentText: ' \u2014 ⌛waiting\u2026',
      },
    });

    const completedStepDecorationType = this._vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      after: {
        color: { id: 'editorCodeLens.foreground' },
      },
    });

    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession(session => {
          if (session.type === 'node-terminal' || session.type === 'pwa-node')
            debugSessions.set(session.id, session);
        }),
        vscode.debug.onDidTerminateDebugSession(session => {
          debugSessions.delete(session.id);
          hideHighlight();
          discardHighlightCaches();
        }),
        vscode.languages.registerHoverProvider('typescript', {
          provideHover(document, position, token) {
            highlightLocator(debugSessions, document, position, token).catch();
            return null;
          }
        }),
        vscode.window.onDidChangeTextEditorSelection(event => {
          highlightLocator(debugSessions, event.textEditor.document, event.selections[0].start).catch();
        }),
        vscode.debug.registerDebugAdapterTrackerFactory('*', {
          createDebugAdapterTracker(session: vscodeTypes.DebugSession) {
            let lastCatchLocation: DebuggerLocation | undefined;
            return {
              onDidSendMessage: async message => {
                if (message.type !== 'response' || !message.success)
                  return;
                if (message.command === 'scopes') {
                  const catchBlock = message.body.scopes.find((scope: any) => scope.name === 'Catch Block');
                  if (catchBlock) {
                    lastCatchLocation = {
                      path: catchBlock.source.path,
                      line: catchBlock.line,
                      column: catchBlock.column
                    };
                  }
                }

                if (message.command === 'variables') {
                  const errorVariable = message.body.variables.find((v: any) => v.name === 'playwrightError' && v.type === 'error');
                  if (errorVariable && lastCatchLocation) {
                    const error = errorVariable.value;
                    testModel.errorInDebugger(error.replaceAll('\\n', '\n'), lastCatchLocation);
                  }
                }
              }
            };
          }
        }),
        testModel.onExecutionLinesChanged(locations => {
          for (const editor of vscode.window.visibleTextEditors) {
            const activeDecorations: vscodeTypes.DecorationOptions[] = [];
            for (const { location } of locations.active) {
              if (location.uri.fsPath === editor.document.uri.fsPath)
                activeDecorations.push({ range: location.range });
            }

            const completedDecorations: vscodeTypes.DecorationOptions[] = [];
            for (const { location, duration } of locations.completed) {
              if (location.uri.fsPath === editor.document.uri.fsPath) {
                completedDecorations.push({
                  range: location.range,
                  renderOptions: {
                    after: {
                      contentText: ` \u2014 ${duration}ms`
                    }
                  }
                });
              }
            }

            editor.setDecorations(activeStepDecorationType, activeDecorations);
            editor.setDecorations(completedStepDecorationType, completedDecorations);
          }
        }),
        testModel
    );
    await testModel.init();
  }
}

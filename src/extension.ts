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

import { EventEmitter } from 'events';
import vscode from 'vscode';
import { discardHighlightCaches, hideHighlight, highlightLocator } from './highlighter';
import { DebuggerLocation, TestModel } from './testModel';

export const testControllers: vscode.TestController[] = [];
export const testControllerEvents = new EventEmitter();

const debugSessions = new Map<string, vscode.DebugSession>();

export async function activate(context: vscode.ExtensionContext) {
	const executionLineDecorationType = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
		backgroundColor: { id: 'editor.wordHighlightStrongBackground' },
		borderColor: { id: 'editor.wordHighlightStrongBorder' },
	});

  // When extension activates, list config files and register them in the model.
  const testModel = new TestModel();

  // const codeLensProvider = new CodelensProvider(testModel);
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
      createDebugAdapterTracker(session: vscode.DebugSession) {
        let lastCatchLocation: DebuggerLocation | undefined;
        return {
          onDidSendMessage: async message => {
            if (message.type === 'response' && message.command === 'scopes') {
              const catchBlock = message.body.scopes.find((scope: any) => scope.name === 'Catch Block');
              if (catchBlock) {
                lastCatchLocation = {
                  path: catchBlock.source.path,
                  line: catchBlock.line,
                  column: catchBlock.column
                };
              }
            }

            if (message.type === 'response' && message.command === 'variables') {
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
        const decorations: vscode.DecorationOptions[] = [];
        for (const location of locations) {
          if (location.uri.fsPath === editor.document.uri.fsPath)
            decorations.push({ range: location.range })
        }
        editor.setDecorations(executionLineDecorationType, decorations);
      }
    }),
    testModel
  );
}

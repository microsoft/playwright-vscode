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

import { discardHighlightCaches, hideHighlight, highlightLocator } from './highlighter';
import * as vscodeTypes from './vscodeTypes';

export type DebuggerLocation = { path: string, line: number, column: number };
export type DebuggerError = { error: string, location: DebuggerLocation };

const debugSessions = new Map<string, vscodeTypes.DebugSession>();

export class DebugHighlight {
  private _vscode: vscodeTypes.VSCode;
  private _errorInDebugger: vscodeTypes.EventEmitter<DebuggerError>;
  readonly onErrorInDebugger: vscodeTypes.Event<DebuggerError>;

  constructor(vscode: vscodeTypes.VSCode) {
    this._vscode = vscode;
    this._errorInDebugger = new vscode.EventEmitter();
    this.onErrorInDebugger = this._errorInDebugger.event;
  }

  async activate(context: vscodeTypes.ExtensionContext) {
    const vscode = this._vscode;
    const self = this;
    const disposables = [
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
                  const error = errorVariable.value as string;
                  self._errorInDebugger.fire({
                    error: error.replace(/\\n/g, '\n'),
                    location: lastCatchLocation!
                  });
                }
              }
            }
          };
        }
      }),
    ];
    context.subscriptions.push(...disposables);
  }

}

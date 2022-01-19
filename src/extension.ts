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
import { TestModel } from './testModel';

export const testControllers: vscode.TestController[] = [];
export const testControllerEvents = new EventEmitter();

const debugSessions = new Map<string, vscode.DebugSession>();

export async function activate(context: vscode.ExtensionContext) {
  // When extension activates, list config files and register them in the model.
  const testModel = new TestModel();

  // const codeLensProvider = new CodelensProvider(testModel);
  context.subscriptions.push(
    ...testModel.initialize(),
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
        highlightLocator(debugSessions, document, position).catch();
        return null;
      }
    }),
    vscode.window.onDidChangeTextEditorSelection(event => {
      highlightLocator(debugSessions, event.textEditor.document, event.selections[0].start).catch();
    }),
  );
}

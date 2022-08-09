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

import { discardBabelAstCache, locatorForSourcePosition } from './babelHighlightUtil';
import { debugSessionName } from './debugSessionName';
import * as vscodeTypes from './vscodeTypes';

export type DebuggerLocation = { path: string, line: number, column: number };
export type DebuggerError = { error: string, location: DebuggerLocation };

const debugSessions = new Map<string, vscodeTypes.DebugSession>();

export class DebugHighlight {
  private _errorInDebugger: vscodeTypes.EventEmitter<DebuggerError>;
  readonly onErrorInDebugger: vscodeTypes.Event<DebuggerError>;
  private _disposables: vscodeTypes.Disposable[] = [];

  constructor(vscode: vscodeTypes.VSCode) {
    this._errorInDebugger = new vscode.EventEmitter();
    this.onErrorInDebugger = this._errorInDebugger.event;

    const self = this;
    this._disposables = [
      vscode.debug.onDidStartDebugSession(session => {
        if (isPlaywrightSession(session))
          debugSessions.set(session.id, session);
      }),
      vscode.debug.onDidTerminateDebugSession(session => {
        debugSessions.delete(session.id);
        hideHighlight();
        discardHighlightCaches();
      }),
      vscode.languages.registerHoverProvider('typescript', {
        provideHover(document, position, token) {
          highlightLocator(document, position, token).catch();
          return null;
        }
      }),
      vscode.languages.registerHoverProvider('javascript', {
        provideHover(document, position, token) {
          highlightLocator(document, position, token).catch();
          return null;
        }
      }),
      vscode.window.onDidChangeTextEditorSelection(event => {
        highlightLocator(event.textEditor.document, event.selections[0].start).catch();
      }),
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker(session: vscodeTypes.DebugSession) {
          if (!isPlaywrightSession(session))
            return {};

          let lastCatchLocation: DebuggerLocation | undefined;
          return {
            onDidSendMessage: async message => {
              if (!message.success)
                return;
              if (message.command === 'scopes' && message.type === 'response') {
                const catchBlock = message.body.scopes.find((scope: any) => scope.name === 'Catch Block');
                if (catchBlock) {
                  lastCatchLocation = {
                    path: catchBlock.source.path,
                    line: catchBlock.line,
                    column: catchBlock.column
                  };
                }
              }

              if (message.command === 'variables' && message.type === 'response') {
                const errorVariable = message.body.variables.find((v: any) => v.name === 'playwrightError' && v.type && v.type.toLowerCase() === 'error');
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
  }

  dispose() {
    for (const d of this._disposables)
      d?.dispose?.();
    this._disposables = [];
  }
}

export type StackFrame = {
  id: string;
  line: number;
  column: number;
  source: { path: string };
};

const sessionsWithHighlight = new Set<vscodeTypes.DebugSession>();

export async function highlightLocator(document: vscodeTypes.TextDocument, position: vscodeTypes.Position, token?: vscodeTypes.CancellationToken) {
  if (!debugSessions.size)
    return;
  const fsPath = document.uri.fsPath;
  for (const session of debugSessions.values()) {
    if (token?.isCancellationRequested)
      return;
    const stackFrames = await pausedStackFrames(session, undefined);
    if (!stackFrames)
      continue;
    for (const stackFrame of stackFrames) {
      const sourcePath = mapRemoteToLocalPath(stackFrame.source.path);
      if (!sourcePath || document.uri.fsPath !== sourcePath)
        continue;
      if (token?.isCancellationRequested)
        return;
      const vars = await scopeVariables(session, stackFrame);
      const text = document.getText();
      const locatorExpression = locatorForSourcePosition(text, vars, fsPath, {
        line: position.line + 1,
        column: position.character + 1
      });
      if (!locatorExpression)
        continue;
      if (token?.isCancellationRequested)
        return;
      if (await doHighlightLocator(session, stackFrame.id, locatorExpression))
        return;
    }
  }
  await hideHighlight();
}

async function pausedStackFrames(session: vscodeTypes.DebugSession, threadId: number | undefined): Promise<StackFrame[] | undefined> {
  const { threads } = await session.customRequest('threads').then(result => result, () => ({ threads: [] }));
  for (const thread of threads) {
    if (threadId !== undefined && thread.id !== threadId)
      continue;
    try {
      const { stackFrames } = await session.customRequest('stackTrace', { threadId: thread.id }).then(result => result, () => ({ stackFrames: [] }));
      return stackFrames;
    } catch {
      continue;
    }
  }
}

async function scopeVariables(session: vscodeTypes.DebugSession, stackFrame: StackFrame): Promise<{
  pages: string[],
  locators: string[],
}> {
  const pages: string[] = [];
  const locators: string[] = [];
  const { scopes } = await session.customRequest('scopes', { frameId: stackFrame.id }).then(result => result, () => ({ scopes: [] }));
  for (const scope of scopes) {
    if (scope.name === 'Global')
      continue;
    const { variables } = await session.customRequest('variables', {
      variablesReference: scope.variablesReference,
      filter: 'names',
    }).then(result => result, () => ({ variables: [] }));
    for (const variable of variables) {
      if (variable.value.startsWith('Page '))
        pages.push(variable.name);
      if (variable.value.startsWith('Locator '))
        locators.push(variable.name);
    }
  }
  return { pages, locators };
}

async function doHighlightLocator(session: vscodeTypes.DebugSession, frameId: string, locatorExpression: string) {
  const expression = `(${locatorExpression})._highlight()`;
  sessionsWithHighlight.add(session);
  const result = await session.customRequest('evaluate', {
    expression,
    frameId,
  }).then(result => result, () => undefined);
  return !!result;
}

export async function hideHighlight() {
  const copy = new Set([...sessionsWithHighlight]);
  sessionsWithHighlight.clear();
  for (const session of copy) {
    await session.customRequest('evaluate', {
      expression: 'global._playwrightInstance._hideHighlight().catch(() => {})',
    }).then(result => result, () => undefined);
  }
}

export function discardHighlightCaches() {
  discardBabelAstCache();
}

function isPlaywrightSession(session: vscodeTypes.DebugSession): boolean {
  let rootSession = session;
  while (rootSession.parentSession)
    rootSession = rootSession.parentSession;
  return rootSession.name === debugSessionName;
}

/**
 * From WSL:
 * vscode-remote://wsl%2Bubuntu/mnt/c/Users/john/doe/foo.spec.ts -> /mnt/c/Users/john/doe/foo.spec.ts
 */
function mapRemoteToLocalPath(maybeRemoteUri?: string): string | undefined {
  if (!maybeRemoteUri)
    return;
  if (maybeRemoteUri.startsWith('vscode-remote://')) {
    const decoded = decodeURIComponent(maybeRemoteUri.substring(16));
    const separator = decoded.indexOf('/');
    return decoded.slice(separator, decoded.length);
  }
  return maybeRemoteUri;
}

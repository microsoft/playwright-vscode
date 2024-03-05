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

import { locatorForSourcePosition, pruneAstCaches } from './babelHighlightUtil';
import { debugSessionName } from './debugSessionName';
import { replaceActionWithLocator, locatorMethodRegex } from './methodNames';
import type { Location } from './reporter';
import { ReusedBrowser } from './reusedBrowser';
import * as vscodeTypes from './vscodeTypes';

export type DebuggerError = { error: string, location: Location };

export class DebugHighlight {
  private _debugSessions = new Map<string, vscodeTypes.DebugSession>();
  private _errorInDebugger: vscodeTypes.EventEmitter<DebuggerError>;
  readonly onErrorInDebugger: vscodeTypes.Event<DebuggerError>;
  private _disposables: vscodeTypes.Disposable[] = [];
  private _reusedBrowser: ReusedBrowser;

  constructor(vscode: vscodeTypes.VSCode, reusedBrowser: ReusedBrowser) {
    this._reusedBrowser = reusedBrowser;
    this._errorInDebugger = new vscode.EventEmitter();
    this.onErrorInDebugger = this._errorInDebugger.event;

    const self = this;
    this._disposables = [
      vscode.debug.onDidStartDebugSession(session => {
        if (isPlaywrightSession(session))
          this._debugSessions.set(session.id, session);
      }),
      vscode.debug.onDidTerminateDebugSession(session => {
        this._debugSessions.delete(session.id);
        self._hideHighlight();
      }),
      vscode.languages.registerHoverProvider('typescript', {
        provideHover(document, position, token) {
          self._highlightLocator(document, position, token).catch();
          return null;
        }
      }),
      vscode.languages.registerHoverProvider('javascript', {
        provideHover(document, position, token) {
          self._highlightLocator(document, position, token).catch();
          return null;
        }
      }),
      vscode.window.onDidChangeTextEditorSelection(event => {
        self._highlightLocator(event.textEditor.document, event.selections[0].start).catch();
      }),
      vscode.window.onDidChangeVisibleTextEditors(event => {
        pruneHighlightCaches(vscode.window.visibleTextEditors.map(e => e.document.fileName));
      }),
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker(session: vscodeTypes.DebugSession) {
          if (!isPlaywrightSession(session))
            return {};

          let lastCatchLocation: Location | undefined;
          return {
            onDidSendMessage: async message => {
              if (!message.success)
                return;
              if (message.command === 'scopes' && message.type === 'response') {
                const catchBlock = message.body.scopes.find((scope: any) => scope.name === 'Catch Block');
                if (catchBlock) {
                  lastCatchLocation = {
                    file: catchBlock.source.path,
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

  private async _highlightLocator(document: vscodeTypes.TextDocument, position: vscodeTypes.Position, token?: vscodeTypes.CancellationToken) {
    if (!this._reusedBrowser.pageCount())
      return;
    const result = await locatorToHighlight(this._debugSessions, document, position, token);
    if (result)
      this._reusedBrowser.highlight(result);
    else
      this._hideHighlight();
  }

  private _hideHighlight() {
    this._reusedBrowser.hideHighlight();
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
  source?: { path: string };
};

const sessionsWithHighlight = new Set<vscodeTypes.DebugSession>();

async function locatorToHighlight(debugSessions: Map<string, vscodeTypes.DebugSession>, document: vscodeTypes.TextDocument, position: vscodeTypes.Position, token?: vscodeTypes.CancellationToken): Promise<string | undefined> {
  const fsPath = document.uri.fsPath;

  if (!debugSessions.size) {
    // When not debugging, discover all the locator-alike expressions.
    const text = document.getText();
    const line = document.lineAt(position.line);
    if (!line.text.match(locatorMethodRegex))
      return;
    let locatorExpression = locatorForSourcePosition(text, { pages: [], locators: [] }, fsPath, {
      line: position.line + 1,
      column: position.character + 1
    });
    // Translate locator expressions starting with "component." to be starting with "page.".
    locatorExpression = locatorExpression?.replace(/^component\s*\./, `page.locator('#root').locator('internal:control=component').`);
    // Translate 'this.page', or 'this._page' to 'page' to have best-effort support for POMs.
    locatorExpression = locatorExpression?.replace(/this\._?page\s*\./, 'page.');
    // Translate page.click() to page.locator()
    locatorExpression = locatorExpression ? replaceActionWithLocator(locatorExpression) : undefined;
    // Only consider locator expressions starting with "page." because we know the base for them (root).
    // Other locators can be relative.
    const match = locatorExpression?.match(/^page\s*\.([\s\S]*)/m);
    if (match) {
      // It is Ok to return the locator expression, not the selector because the highlight call is going to handle it
      // just fine.
      return match[1];
    }
    return;
  }

  for (const session of debugSessions.values()) {
    if (token?.isCancellationRequested)
      return;
    const stackFrames = await pausedStackFrames(session, undefined);
    if (!stackFrames)
      continue;
    for (const stackFrame of stackFrames) {
      if (!stackFrame.source)
        continue;
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
      const result = await computeLocatorForHighlight(session, stackFrame.id, locatorExpression);
      if (result)
        return result;
    }
  }
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

async function computeLocatorForHighlight(session: vscodeTypes.DebugSession, frameId: string, locatorExpression: string): Promise<string> {
  const innerExpression = `(${locatorExpression})._selector`;
  const base64Encoded = Buffer.from(innerExpression).toString('base64');
  const expression = `eval(Buffer.from("${base64Encoded}", "base64").toString())`;
  sessionsWithHighlight.add(session);
  return await session.customRequest('evaluate', {
    expression,
    frameId,
  }).then(result => {
    if (result.result.startsWith('\'') && result.result.endsWith('\''))
      return result.result.substring(1, result.result.length - 1);
    return result.result;
  }, () => undefined);
}

export function pruneHighlightCaches(fsPathsToRetain: string[]) {
  pruneAstCaches(fsPathsToRetain);
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

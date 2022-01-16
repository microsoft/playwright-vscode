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
import { discardBabelAstCache, locatorForPosition } from './babelUtil';

export type StackFrame = {
  id: string;
  line: number;
  column: number;
  source: { path: string };
};

const sessionsWithHighlight = new Set<vscode.DebugSession>();

export async function highlightLocator(debugSessions: Map<string, vscode.DebugSession>, document: vscode.TextDocument, position: vscode.Position) {
  if (!debugSessions.size)
    return;
  const fsPath = document.uri.fsPath;
  for (const session of debugSessions.values()) {
    const stackFrames = await pausedStackFrames(session, undefined);
    if (!stackFrames)
      continue;
    for (const stackFrame of stackFrames) {
      if (!stackFrame.source || document.uri.fsPath !== stackFrame.source.path)
        continue;
      const vars = await scopeVariables(session, stackFrame);
      const text = document.getText();
      const locatorExpression = locatorForPosition(text, vars, fsPath, position);
      if (!locatorExpression)
        continue;
      if (await doHighlightLocator(session, stackFrame.id, locatorExpression))
        return;
    }
  }
  await hideHighlight();
}

async function pausedStackFrames(session: vscode.DebugSession, threadId: number | undefined): Promise<StackFrame[] | undefined> {
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

async function scopeVariables(session: vscode.DebugSession, stackFrame: StackFrame): Promise<{
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

async function doHighlightLocator(session: vscode.DebugSession, frameId: string, locatorExpression: string) {
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

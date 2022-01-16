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

import { parse, ParseResult } from '@babel/parser';
import traverse from '@babel/traverse';
import type { File, SourceLocation } from '@babel/types';
import vscode from 'vscode';

export type StackFrame = {
  id: string;
  line: number;
  column: number;
  source: { path: string };
};

const astCache = new Map<string, { text: string, ast: ParseResult<File> }>();
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
      const text = document.getText();
      const locatorExpression = locatorForPosition(text, fsPath, position);
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
  astCache.clear();
}

function locatorForPosition(text: string, fsPath: string, position: vscode.Position): string | undefined {
  const cached = astCache.get(fsPath);
  let ast = cached?.ast;
  if (!cached || cached.text !== text) {
    ast = parse(text, { errorRecovery: true, plugins: ['typescript'], sourceType: 'module' });
    astCache.set(fsPath, { text, ast });
  }

  let rangeMatch: string | undefined;
  let lineMatch: string | undefined;
  traverse(ast, {
    enter(path) {
      let locatorNode;
      // Web-first assertions: expect(a).to*
      if (path.node.type === 'MemberExpression' &&
          path.node.property.type === 'Identifier' &&
          matchers.includes(path.node.property.name) &&
          path.node.object.type === 'CallExpression' &&
          path.node.object.callee.type === 'Identifier' &&
          path.node.object.callee.name === 'expect') {
        locatorNode = path.node.object.arguments[0];
      }

      // *.locator() call
      if (path.node.type === 'CallExpression' &&
          path.node.callee.type === 'MemberExpression' &&
          path.node.callee.property.type === 'Identifier' &&
          path.node.callee.property.name === 'locator') {
        locatorNode = path.node;
      }

      if (!locatorNode)
        return;
      const locatorRange = babelLocationToVsCodeRange(locatorNode.loc!);

      if (!lineMatch && locatorRange.start.line === position.line)
        lineMatch = text.substring(locatorNode.start!, locatorNode.end!);

        if (locatorRange.contains(position)) {
        const candidate = text.substring(locatorNode.start!, locatorNode.end!);
        if (!rangeMatch || candidate.length < rangeMatch.length)
          rangeMatch = candidate;  
      }
    }
  });
  return rangeMatch || lineMatch;
}

function babelLocationToVsCodeRange(location: SourceLocation): vscode.Range {
  return new vscode.Range(
    new vscode.Position(location.start.line - 1, location.start.column - 1),
    new vscode.Position(location.end.line - 1, location.end.column - 1));
}

const matchers = [
  'toBeChecked',
  'toBeDisabled',
  'toBeEditable',
  'toBeEmpty',
  'toBeEnabled',
  'toBeFocused',
  'toBeHidden',
  'toContainText',
  'toHaveAttribute',
  'toHaveClass',
  'toHaveCount',
  'toHaveCSS',
  'toHaveId',
  'toHaveJSProperty',
  'toHaveText',
  'toHaveValue',
  'toBeVisible',
];

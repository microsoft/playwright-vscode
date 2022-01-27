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

import { types as t } from '@babel/core';
import { parse, ParseResult } from '@babel/parser';
import traverse from '@babel/traverse';
import type { File, SourceLocation } from '@babel/types';
import vscode from 'vscode';
import { asyncMatchers, pageMethods } from './methodNames';

const astCache = new Map<string, { text: string, ast: ParseResult<File> }>();

export function discardBabelAstCache() {
  astCache.clear();
}

export function locatorForPosition(text: string, vars: { pages: string[], locators: string[] }, fsPath: string, position: vscode.Position): string | undefined {
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
      let expressionNode;
      let pageSelectorNode;
      let pageSelectorCallee;

      // page.*(selector) will highlight `page.locator(selector)`
      if (t.isCallExpression(path.node) &&
          t.isMemberExpression(path.node.callee) &&
          t.isIdentifier(path.node.callee.object) &&
          t.isIdentifier(path.node.callee.property) &&
          (vars.pages.includes(path.node.callee.object.name) && pageMethods.includes(path.node.callee.property.name))) {
        expressionNode = path.node;
        pageSelectorNode = path.node.arguments[0];
        pageSelectorCallee = path.node.callee.object.name;
      }

      // locator.*() will highlight `locator`
      if (t.isIdentifier(path.node) &&
          vars.locators.includes(path.node.name)) {
        expressionNode = path.node;
      }

      // Web-first assertions: expect(a).to*
      if (t.isMemberExpression(path.node) &&
          t.isIdentifier(path.node.property) &&
          asyncMatchers.includes(path.node.property.name) &&
          t.isCallExpression(path.node.object) &&
          t.isIdentifier(path.node.object.callee) &&
          path.node.object.callee.name === 'expect') {
        expressionNode = path.node.object.arguments[0];
      }

      // *.locator() call
      if (t.isCallExpression(path.node) &&
          t.isMemberExpression(path.node.callee) &&
          t.isIdentifier(path.node.callee.property) &&
          path.node.callee.property.name === 'locator') {
        expressionNode = path.node;
      }

      if (!expressionNode)
        return;
      const expressionRange = babelLocationToVsCodeRange(expressionNode.loc!);
      const isRangeMatch = expressionRange.contains(position);
      const isLineMatch = expressionRange.start.line === position.line;
      if (isRangeMatch || isLineMatch) {
        let expression;
        if (pageSelectorNode)
          expression = `${pageSelectorCallee}.locator(${text.substring(pageSelectorNode.start!, pageSelectorNode.end!)})`;
        else
          expression = text.substring(expressionNode.start!, expressionNode.end!);

        if (isRangeMatch && (!rangeMatch || expression.length < rangeMatch.length)) {
          // Prefer shortest range match to better support chains.
          rangeMatch = expression;
        }
        if (isLineMatch && (!lineMatch || expression.length < lineMatch.length)) {
          // Prefer longest line match to better support chains.
          lineMatch = expression;
        }
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

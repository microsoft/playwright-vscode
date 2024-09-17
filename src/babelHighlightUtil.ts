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

import path from 'path';
import { t, parse, ParseResult, traverse, SourceLocation, babelPresetTypescript, babelPluginProposalDecorators } from './babelBundle';
import { asyncMatchers, pageMethods, locatorMethods } from './methodNames';

const astCache = new Map<string, { text: string, ast?: ParseResult }>();

export function pruneAstCaches(fsPathsToRetain: string[]) {
  const retain = new Set(fsPathsToRetain);
  for (const key of astCache.keys()) {
    if (!retain.has(key))
      astCache.delete(key);
  }
}

export type SourcePosition = {
  line: number;  // 1-based
  column: number;  // 1-based
};

export function locatorForSourcePosition(text: string, vars: { pages: string[], locators: string[] }, fsPath: string, position: SourcePosition): string | undefined {
  const cached = astCache.get(fsPath);
  let ast = cached?.ast;
  if (!cached || cached.text !== text) {
    try {
      ast = parse(text, {
        filename: path.basename(fsPath),
        plugins: [
          [babelPluginProposalDecorators, { version: '2023-05' }],
        ],
        presets: [[babelPresetTypescript, { onlyRemoveTypeImports: false }]],
        babelrc: false,
        configFile: false,
        sourceType: 'module',
      });
      astCache.set(fsPath, { text, ast });
    } catch (e) {
      astCache.set(fsPath, { text, ast: undefined });
    }
  }

  if (!ast)
    return;

  let rangeMatch: string | undefined;
  let lineMatch: string | undefined;
  traverse(ast, {
    enter(path) {
      let expressionNode;
      let pageSelectorNode;
      let pageSelectorCallee;

      // Hover over page.[click,check,...](selector) will highlight `page.locator(selector)`.
      if (t.isCallExpression(path.node) &&
          t.isMemberExpression(path.node.callee) &&
          t.isIdentifier(path.node.callee.object) &&
          t.isIdentifier(path.node.callee.property) &&
          (vars.pages.includes(path.node.callee.object.name) && pageMethods.includes(path.node.callee.property.name))) {
        expressionNode = path.node;
        pageSelectorNode = path.node.arguments[0];
        pageSelectorCallee = path.node.callee.object.name;
      }


      // Hover over locator variables will highlight `locator`.
      if (t.isIdentifier(path.node) &&
          vars.locators.includes(path.node.name))
        expressionNode = path.node;


      // Web assertions: expect(a).to*.
      if (t.isMemberExpression(path.node) &&
          t.isIdentifier(path.node.property) &&
          asyncMatchers.includes(path.node.property.name) &&
          t.isCallExpression(path.node.object) &&
          t.isIdentifier(path.node.object.callee) &&
          path.node.object.callee.name === 'expect')
        expressionNode = path.node.object.arguments[0];


      // *.locator(), *.getBy*(), *.click(), *.fill(), *.type() call
      if (t.isCallExpression(path.node) &&
          t.isMemberExpression(path.node.callee) &&
          t.isIdentifier(path.node.callee.property) &&
          locatorMethods.includes(path.node.callee.property.name))
        expressionNode = path.node;


      if (!expressionNode || !expressionNode.loc)
        return;
      const isRangeMatch = containsPosition(expressionNode.loc, position);
      const isLineMatch = expressionNode.loc.start.line === position.line;
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
        if (isLineMatch && (!lineMatch || lineMatch.length < expression.length)) {
          // Prefer longest line match to better support chains.
          lineMatch = expression;
        }
      }
    }
  });
  return rangeMatch || lineMatch;
}

function containsPosition(location: SourceLocation, position: SourcePosition): boolean {
  if (position.line < location.start.line || position.line > location.end.line)
    return false;
  if (position.line === location.start.line && position.column < location.start.column)
    return false;
  if (position.line === location.end.line && position.column > location.end.column)
    return false;
  return true;
}

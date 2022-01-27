/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { declare } from '@babel/helper-plugin-utils';
import { types as t } from '@babel/core';

export default declare(api => {
  api.assertVersion(7);

  return {
    name: 'playwright-debug-transform',
    visitor: {
      CallExpression(path) {
        if (!t.isExpressionStatement(path.parentPath.node) && !t.isAwaitExpression(path.parentPath.node))
          return;
        if (!t.isMemberExpression(path.node.callee))
          return;
        const matcher = path.node.callee;
        if (!t.isCallExpression(matcher.object) || !t.isIdentifier(matcher.object.callee) || matcher.object.callee.name !== 'expect')
          return;
        if (!t.isIdentifier(matcher.property) || !matcher.property.name.startsWith('to'))
          return;
        const isAsync = t.isAwaitExpression(path.parentPath.node);
        if (isAsync) {

          // For async, translate:
          //   await expect(...).to*(...)
          // into
          //   await expect(...).to*(...).catch(playwrightError => { debugger; throw playwrightError; })
          //
          // Do this regardless if parent is the expression statement.
          path.replaceWith(
            t.callExpression(
              t.memberExpression(
                path.node,
                t.identifier('catch')
              ),
              [
                t.arrowFunctionExpression(
                  [t.identifier('playwrightError')],
                  t.blockStatement([
                    t.debuggerStatement(),
                    t.throwStatement(t.identifier('playwrightError'))
                  ]))
              ]
            )
          );
          path.skip();
        } else {

          // For sync, translate
          //   expect(...).to*(...)
          // into
          //   try {
          //     expect(...).to*(...)
          //   } catch (playwrightError) {}
          //     debugger;
          //     throw playwrightError;
          //   }
          //
          // Only do this when expect is the whole expression statement.

          const expressionStatement = path.parentPath.node as t.ExpressionStatement;
          path.parentPath.replaceWith(t.tryStatement(
            t.blockStatement([
              expressionStatement
            ]),
            t.catchClause(
              t.identifier('playwrightError'),
              t.blockStatement([
                t.debuggerStatement(),
                t.throwStatement(t.identifier('playwrightError'))
              ])
            )
          ));

          // We are swapping parent, so fix the source maps.
          path.parentPath.skip();
          path.parentPath.node.start = expressionStatement.start;
          path.parentPath.node.end = expressionStatement.end;
          path.parentPath.node.loc = expressionStatement.loc;
          path.parentPath.node.range = expressionStatement.range;
        }
      }
    }
  }
});
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

import { declare, t } from './babelBundle';

export default declare(api => {
  api.assertVersion(7);

  return {
    name: 'playwright-debug-transform',
    visitor: {
      ExpressionStatement(path) {
        const expression = path.node.expression;
        const isAwaitExpression = t.isAwaitExpression(expression);
        const isCallExpression = t.isCallExpression(expression);
        if (!isAwaitExpression && !isCallExpression)
          return;
        // Prevent re-enterability without calling path.skip.
        if (path.parentPath.isBlockStatement() && path.parentPath.parentPath.isTryStatement())
          return;
        if (isAwaitExpression && !t.isCallExpression(expression.argument))
          return;
        path.replaceWith(t.tryStatement(
            t.blockStatement([
              path.node
            ]),
            t.catchClause(
                t.identifier('playwrightError'),
                t.blockStatement([
                  t.debuggerStatement(),
                  t.throwStatement(t.identifier('playwrightError'))
                ])
            )
        ));

        // Patch source map.
        path.node.start = expression.start;
        path.node.end = expression.end;
        path.node.loc = expression.loc;
        path.node.range = expression.range;
      }
    }
  };
});
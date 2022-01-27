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
        if (!t.isMemberExpression(path.node.callee))
          return;
        const matcher = path.node.callee;
        if (!t.isIdentifier(matcher.property) || !matcher.property.name.startsWith('to'))
          return;
        if (!t.isCallExpression(matcher.object) || !t.isIdentifier(matcher.object.callee) || matcher.object.callee.name !== 'expect')
          return;
        let replacePath = path.parentPath;
        if (t.isAwaitExpression(replacePath.node))
          replacePath = replacePath.parentPath!;
        const replaceNode = replacePath.node;
        replacePath.replaceWith(t.tryStatement(
            t.blockStatement([
              t.cloneNode(replaceNode as any)
            ]),
            t.catchClause(
                t.identifier('playwrightError'),
                t.blockStatement([
                  t.debuggerStatement(),
                  t.throwStatement(t.identifier('playwrightError'))
                ])
            )
        ));
        replacePath.skip();
        replacePath.node.start = replaceNode.start;
        replacePath.node.end = replaceNode.end;
        replacePath.node.loc = replaceNode.loc;
        replacePath.node.range = replaceNode.range;
      }
    },
  };
});

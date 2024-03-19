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
import * as vscodeTypes from './vscodeTypes';

export function registerTerminalLinkProvider(vscode: vscodeTypes.VSCode): vscodeTypes.Disposable {
  return vscode.window.registerTerminalLinkProvider({
    provideTerminalLinks: (context, token) => {
      const supportedCommands = /(npx|pnpm exec|yarn) playwright (show-report|show-trace).*$/;
      const match = context.line.match(supportedCommands);
      if (!match)
        return [];

      return [
        {
          command: match[0],
          startIndex: match.index!,
          length: match[0].length,
          tooltip: 'Show HTML report',
        }
      ];
    },
    handleTerminalLink: (link: vscodeTypes.TerminalLink & { command: string }) => {
      const terminal = vscode.window.activeTerminal;
      if (terminal)
        terminal.sendText(link.command);
    }
  });
}

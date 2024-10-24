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
      // The end is either two spaces (box is expanded) or the right box character (end of box is reached).
      const supportedCommands = /((npx|pnpm exec|yarn) playwright (show-report|show-trace|install).*?)(  | ║|$)/;
      const match = context.line.match(supportedCommands);
      if (!match)
        return [];
      const command = match[1];
      return [
        {
          command,
          startIndex: match.index!,
          length: command.length,
          tooltip: `Run ${command}`,
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

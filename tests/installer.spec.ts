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

import { expect, test } from '@playwright/test';
import { installPlaywright } from '../src/installer';

test('install command works in Windows cmd', async ({}, testInfo) => {
  const sentTexts = await runInstallPlaywrightCommand(testInfo.outputDir, 'win32', [
    'Chromium',
    'Firefox',
    'WebKit',
    'Add GitHub Actions workflow',
  ]);

  expect(sentTexts).toEqual([
    'npm init playwright@latest --yes "--" . "--quiet" "--browser=chromium" "--browser=firefox" "--browser=webkit" "--gha"',
  ]);
  expect(sentTexts[0]).not.toContain('\'');
});

test('install command preserves no-browsers option', async ({}, testInfo) => {
  const sentTexts = await runInstallPlaywrightCommand(testInfo.outputDir, process.platform, [
    'Use JavaScript',
  ]);

  expect(sentTexts).toEqual([
    `npm init playwright@latest --yes "--" . ${quoteForCurrentPlatform('--quiet')} ${quoteForCurrentPlatform('--no-browsers')} ${quoteForCurrentPlatform('--lang=js')}`,
  ]);
});

async function runInstallPlaywrightCommand(workspacePath: string, platform: NodeJS.Platform, selectedLabels: string[]): Promise<string[]> {
  const originalPlatform = process.platform;
  const sentTexts: string[] = [];
  const vscode: any = {
    QuickPickItemKind: { Separator: 'separator' },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspacePath } }],
    },
    window: {
      createTerminal: (options: { cwd: string }) => {
        expect(options.cwd).toBe(workspacePath);
        return {
          show: () => {},
          sendText: (text: string) => sentTexts.push(text),
        };
      },
      showErrorMessage: async (message: string) => {
        throw new Error(message);
      },
      showQuickPick: async (options: { label: string }[]) => {
        return options.filter(option => selectedLabels.includes(option.label));
      },
    },
  };

  try {
    Object.defineProperty(process, 'platform', { value: platform });
    await installPlaywright(vscode);
    return sentTexts;
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  }
}

function quoteForCurrentPlatform(s: string): string {
  if (process.platform === 'win32')
    return `"${s}"`;
  return `'${s}'`;
}

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
import { defineConfig } from '@playwright/test';
import { WorkerOptions } from './tests/utils';

// Determine optimal worker count based on OS
function getWorkerCount(): number | undefined {
  if (!process.env.CI)
    return undefined;

  // macOS has resource constraints with debug tests; use 1 worker
  if (process.platform === 'darwin')
    return 1;

  // Windows and Linux can handle more parallelism; use 4 workers
  return 4;
}

export default defineConfig<WorkerOptions>({
  testDir: './tests',
  outputDir: './test-results/inner',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: getWorkerCount(),
  reporter: process.env.CI ? [
    ['line'],
    ['blob'],
  ] : [
    ['line']
  ],
  tag: process.env.PW_TAG,  // Set when running vscode extension tests in playwright repo CI.
  projects: [
    {
      name: 'default',
    },
    {
      name: 'default-reuse',
      use: {
        showBrowser: true,
      }
    },
    {
      name: 'default-trace',
      use: {
        showTrace: true,
      }
    },
  ]
});

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

export default defineConfig<WorkerOptions>({
  testDir: './tests',
  outputDir: './test-results/inner',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [
    ['line'],
    ['blob'],
  ] : [
    ['line']
  ],
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
        showTrace: 'spawn',
      }
    },
    {
      name: 'default-trace-embedded',
      testMatch: '*trace-viewer*.spec.ts',
      use: {
        showTrace: 'embedded',
      }
    },
    {
      name: 'legacy',
      use: {
        overridePlaywrightVersion: 1.43,
      }
    },
    {
      name: 'legacy-reuse',
      use: {
        overridePlaywrightVersion: 1.43,
        showBrowser: true,
      }
    },
    {
      name: 'legacy-trace',
      use: {
        overridePlaywrightVersion: 1.43,
        showTrace: 'spawn',
      }
    },
    {
      name: 'legacy-trace-embedded',
      testMatch: '*trace-viewer*.spec.ts',
      use: {
        overridePlaywrightVersion: 1.43,
        showTrace: 'embedded',
      }
    },
  ]
});

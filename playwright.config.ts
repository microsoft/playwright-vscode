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
import { PlaywrightTestConfig } from '@playwright/test';
import { WorkerOptions } from './tests/utils';

const config: PlaywrightTestConfig<WorkerOptions> = {
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'line',
  projects: [
    {
      name: 'default',
    },
    {
      name: 'reuse',
      testIgnore: '**/settings.spec.ts',
      use: {
        mode: 'reuse',
        screenshot: 'only-on-failure', // 失败时截屏
        trace: 'retain-on-failure' // 失败时跟踪记录
      }
    }
  ],
};
export default config;

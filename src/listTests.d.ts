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

import type { TestError } from './upstream/reporter';

// This matches the structs in packages/playwright-test/src/runner/runner.ts.

export type ProjectConfigWithFiles = {
  name: string;
  testDir: string;
  use: {
    // Legacy attribute, this is now part of FullProject['use'].
    // Remove once https://github.com/microsoft/playwright/commit/1af4e367f4a46323f3b5a013527b944fe3176203 is common.
    testIdAttribute?: string;
  };
  files: string[];
};

export type ConfigListFilesReport = {
  projects: ProjectConfigWithFiles[];
  error?: TestError;
};

export type ConfigFindRelatedTestFilesReport = {
  testFiles: string[];
  errors?: TestError[];
};

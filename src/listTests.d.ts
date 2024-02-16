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

import type { TestError } from './reporter';

// This matches the structs in packages/playwright-test/src/runner/runner.ts.

export type ProjectConfigWithFiles = {
  name: string;
  testDir: string;
  use: { testIdAttribute?: string };
  files: string[];
};

export type ConfigListFilesReport = {
  projects: ProjectConfigWithFiles[];
  cliEntryPoint?: string;
  error?: TestError;
};

export type ConfigFindRelatedTestFilesReport = {
  testFiles: string[];
  errors?: TestError[];
};

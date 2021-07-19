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

import type { FullConfig, TestStatus, TestError, Project, TestInfo } from '@playwright/test';

//#region Mirrored from @playwright/test JSON reporter

export interface JSONReport {
  config: Omit<FullConfig, 'projects'> & {
    projects: {
      outputDir: string,
      repeatEach: number,
      retries: number,
      metadata: any,
      name: string,
      testDir: string,
      testIgnore: string[],
      testMatch: string[],
      timeout: number,
    }[],
  };
  suites: JSONReportSuite[];
  errors: TestError[];
}
export interface JSONReportSuite {
  title: string;
  file: string;
  column: number;
  line: number;
  specs: JSONReportSpec[];
  suites?: JSONReportSuite[];
}

export interface JSONReportSpec {
  title: string;
  ok: boolean;
  tests: JSONReportTest[];
  file: string;
  line: number;
  column: number;
}
export interface JSONReportTest {
  timeout: number;
  annotations: { type: string, description?: string }[],
  expectedStatus: TestStatus;
  projectName: string;
  results: JSONReportTestResult[];
  status: 'skipped' | 'expected' | 'unexpected' | 'flaky';
}
export interface JSONReportTestResult {
  workerIndex: number;
  status: TestStatus | undefined;
  duration: number;
  error: TestError | undefined;
  stdout: JSONReportSTDIOEntry[],
  stderr: JSONReportSTDIOEntry[],
  retry: number;
  attachments: { name: string, path?: string, body?: string, contentType: string }[];
}
export type JSONReportSTDIOEntry = { text: string } | { buffer: string };
//#endregion

export type TestSpec = JSONReportSpec;
export type Suite = JSONReportSuite;

export type ProjectWithIndex = Project & {
  index: number
}
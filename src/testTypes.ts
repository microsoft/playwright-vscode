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

export interface PlaywrightTestOutput {
  config: Config;
  suites: Suite[];
  errors: any[];
}

export interface Config {
  forbidOnly:      boolean;
  globalSetup:     null;
  globalTeardown:  null;
  globalTimeout:   number;
  maxFailures:     number;
  preserveOutput:  string;
  projects:        Project[];
  reporter:        Array<string[]>;
  rootDir:         string;
  quiet:           boolean;
  shard:           null;
  updateSnapshots: string;
  workers:         number;
}

export interface Project {
  outputDir:  string;
  repeatEach: number;
  retries:    number;
  name:       string;
  testDir:    string;
  testIgnore: any[];
  testMatch:  string[];
  timeout:    number;
}

export interface Suite {
  title:   string;
  file:    string;
  line:    number;
  column:  number;
  specs:   TestSpec[];
  suites?: Suite[];
}

export interface TestSpec {
  title:  string;
  ok:     boolean;
  tests:  Test[];
  file:   string;
  line:   number;
  column: number;
}

export interface Test {
  timeout:        number;
  annotations:    any[];
  expectedStatus: string;
  projectName:    string;
  results:        TestResult[];
}

export interface TestResult {
  workerIndex: number
  status: "passed" | "failed"
  duration: number
  stdout: string[]
  stderr: string[]
  retry: number
  error?: {
    message: string
    stack: string
  }
}
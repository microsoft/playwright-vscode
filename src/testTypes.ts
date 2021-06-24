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
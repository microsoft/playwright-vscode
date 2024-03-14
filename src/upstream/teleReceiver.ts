// *************** DO NOT EDIT *******************
// THIS FILE HAS BEEN COPIED FROM PLAYWRIGHT REPO
// ***********************************************

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

import type { Annotation } from '../reporter';
import type { FullProject, Metadata } from '../reporter';
import type * as reporterTypes from '../reporter';
import type { ReporterV2 } from '../reporter';

export type StringIntern = (s: string) => string;
export type JsonLocation = reporterTypes.Location;
export type JsonError = string;
export type JsonStackFrame = { file: string, line: number, column: number };

export type JsonStdIOType = 'stdout' | 'stderr';

export type JsonConfig = Pick<reporterTypes.FullConfig, 'configFile' | 'globalTimeout' | 'maxFailures' | 'metadata' | 'rootDir' | 'version' | 'workers'>;

export type JsonPattern = {
  s?: string;
  r?: { source: string, flags: string };
};

export type JsonProject = {
  grep: JsonPattern[];
  grepInvert: JsonPattern[];
  metadata: Metadata;
  name: string;
  dependencies: string[];
  // This is relative to root dir.
  snapshotDir: string;
  // This is relative to root dir.
  outputDir: string;
  repeatEach: number;
  retries: number;
  suites: JsonSuite[];
  teardown?: string;
  // This is relative to root dir.
  testDir: string;
  testIgnore: JsonPattern[];
  testMatch: JsonPattern[];
  timeout: number;
};

export type JsonSuite = {
  title: string;
  location?: JsonLocation;
  suites: JsonSuite[];
  tests: JsonTestCase[];
};

export type JsonTestCase = {
  testId: string;
  title: string;
  location: JsonLocation;
  retries: number;
  tags?: string[];
  repeatEachIndex: number;
};

export type JsonTestEnd = {
  testId: string;
  expectedStatus: reporterTypes.TestStatus;
  timeout: number;
  annotations: { type: string, description?: string }[];
};

export type JsonTestResultStart = {
  id: string;
  retry: number;
  workerIndex: number;
  parallelIndex: number;
  startTime: number;
};

export type JsonAttachment = Omit<reporterTypes.TestResult['attachments'][0], 'body'> & { base64?: string };

export type JsonTestResultEnd = {
  id: string;
  duration: number;
  status: reporterTypes.TestStatus;
  errors: reporterTypes.TestError[];
  attachments: JsonAttachment[];
};

export type JsonTestStepStart = {
  id: string;
  parentStepId?: string;
  title: string;
  category: string,
  startTime: number;
  location?: reporterTypes.Location;
};

export type JsonTestStepEnd = {
  id: string;
  duration: number;
  error?: reporterTypes.TestError;
};

export type JsonFullResult = {
  status: reporterTypes.FullResult['status'];
  startTime: number;
  duration: number;
};

export type JsonEvent = {
  method: string;
  params: any
};

type TeleReporterReceiverOptions = {
  mergeProjects: boolean;
  mergeTestCases: boolean;
  resolvePath: (rootDir: string, relativePath: string) => string;
  configOverrides?: Pick<reporterTypes.FullConfig, 'configFile' | 'quiet' | 'reportSlowTests' | 'reporter'>;
  clearPreviousResultsWhenTestBegins?: boolean;
};

export class TeleReporterReceiver {
  private _rootSuite: TeleSuite;
  private _options: TeleReporterReceiverOptions;
  private _reporter: Partial<ReporterV2>;
  private _tests = new Map<string, TeleTestCase>();
  private _rootDir!: string;
  private _listOnly = false;
  private _config!: reporterTypes.FullConfig;

  constructor(reporter: Partial<ReporterV2>, options: TeleReporterReceiverOptions) {
    this._rootSuite = new TeleSuite('', 'root');
    this._options = options;
    this._reporter = reporter;
  }

  dispatch(mode: 'list' | 'test', message: JsonEvent): Promise<void> | void {
    const { method, params } = message;
    if (method === 'onConfigure') {
      this._onConfigure(params.config);
      this._listOnly = mode === 'list';
      return;
    }
    if (method === 'onProject') {
      this._onProject(params.project);
      return;
    }
    if (method === 'onBegin') {
      this._onBegin();
      return;
    }
    if (method === 'onTestBegin') {
      this._onTestBegin(params.testId, params.result);
      return;
    }
    if (method === 'onTestEnd') {
      this._onTestEnd(params.test, params.result);
      return;
    }
    if (method === 'onStepBegin') {
      this._onStepBegin(params.testId, params.resultId, params.step);
      return;
    }
    if (method === 'onStepEnd') {
      this._onStepEnd(params.testId, params.resultId, params.step);
      return;
    }
    if (method === 'onError') {
      this._onError(params.error);
      return;
    }
    if (method === 'onStdIO') {
      this._onStdIO(params.type, params.testId, params.resultId, params.data, params.isBase64);
      return;
    }
    if (method === 'onEnd')
      return this._onEnd(params.result);
    if (method === 'onExit')
      return this._onExit();
  }

  private _onConfigure(config: JsonConfig) {
    this._rootDir = config.rootDir;
    this._config = this._parseConfig(config);
    this._reporter.onConfigure?.(this._config);
  }

  private _onProject(project: JsonProject) {
    let projectSuite = this._options.mergeProjects ? this._rootSuite.suites.find(suite => suite.project()!.name === project.name) : undefined;
    if (!projectSuite) {
      projectSuite = new TeleSuite(project.name, 'project');
      this._rootSuite.suites.push(projectSuite);
      projectSuite.parent = this._rootSuite;
    }
    // Always update project in watch mode.
    projectSuite._project = this._parseProject(project);
    this._mergeSuitesInto(project.suites, projectSuite);

    // Remove deleted tests when listing. Empty suites will be auto-filtered
    // in the UI layer.
    if (this._listOnly) {
      const testIds = new Set<string>();
      const collectIds = (suite: JsonSuite) => {
        suite.tests.map(t => t.testId).forEach(testId => testIds.add(testId));
        suite.suites.forEach(collectIds);
      };
      project.suites.forEach(collectIds);

      const filterTests = (suite: TeleSuite) => {
        suite.tests = suite.tests.filter(t => testIds.has(t.id));
        suite.suites.forEach(filterTests);
      };
      filterTests(projectSuite);
    }
  }

  private _onBegin() {
    this._reporter.onBegin?.(this._rootSuite);
  }

  private _onTestBegin(testId: string, payload: JsonTestResultStart) {
    const test = this._tests.get(testId)!;
    if (this._options.clearPreviousResultsWhenTestBegins)
      test._clearResults();
    const testResult = test._createTestResult(payload.id);
    testResult.retry = payload.retry;
    testResult.workerIndex = payload.workerIndex;
    testResult.parallelIndex = payload.parallelIndex;
    testResult.setStartTimeNumber(payload.startTime);
    this._reporter.onTestBegin?.(test, testResult);
  }

  private _onTestEnd(testEndPayload: JsonTestEnd, payload: JsonTestResultEnd) {
    const test = this._tests.get(testEndPayload.testId)!;
    test.timeout = testEndPayload.timeout;
    test.expectedStatus = testEndPayload.expectedStatus;
    test.annotations = testEndPayload.annotations;
    const result = test._resultsMap.get(payload.id)!;
    result.duration = payload.duration;
    result.status = payload.status;
    result.errors = payload.errors;
    result.error = result.errors?.[0];
    result.attachments = this._parseAttachments(payload.attachments);
    this._reporter.onTestEnd?.(test, result);
    // Free up the memory as won't see these step ids.
    result._stepMap = new Map();
  }

  private _onStepBegin(testId: string, resultId: string, payload: JsonTestStepStart) {
    const test = this._tests.get(testId)!;
    const result = test._resultsMap.get(resultId)!;
    const parentStep = payload.parentStepId ? result._stepMap.get(payload.parentStepId) : undefined;

    const location = this._absoluteLocation(payload.location);
    const step = new TeleTestStep(payload, parentStep, location);
    if (parentStep)
      parentStep.steps.push(step);
    else
      result.steps.push(step);
    result._stepMap.set(payload.id, step);
    this._reporter.onStepBegin?.(test, result, step);
  }

  private _onStepEnd(testId: string, resultId: string, payload: JsonTestStepEnd) {
    const test = this._tests.get(testId)!;
    const result = test._resultsMap.get(resultId)!;
    const step = result._stepMap.get(payload.id)!;
    step.duration = payload.duration;
    step.error = payload.error;
    this._reporter.onStepEnd?.(test, result, step);
  }

  private _onError(error: reporterTypes.TestError) {
    this._reporter.onError?.(error);
  }

  private _onStdIO(type: JsonStdIOType, testId: string | undefined, resultId: string | undefined, data: string, isBase64: boolean) {
    const chunk = isBase64 ? ((globalThis as any).Buffer ? Buffer.from(data, 'base64') : atob(data)) : data;
    const test = testId ? this._tests.get(testId) : undefined;
    const result = test && resultId ? test._resultsMap.get(resultId) : undefined;
    if (type === 'stdout') {
      result?.stdout.push(chunk);
      this._reporter.onStdOut?.(chunk, test, result);
    } else {
      result?.stderr.push(chunk);
      this._reporter.onStdErr?.(chunk, test, result);
    }
  }

  private async _onEnd(result: JsonFullResult): Promise<void> {
    await this._reporter.onEnd?.({
      status: result.status,
      startTime: new Date(result.startTime),
      duration: result.duration,
    });
  }

  private _onExit(): Promise<void> | void {
    return this._reporter.onExit?.();
  }

  private _parseConfig(config: JsonConfig): reporterTypes.FullConfig {
    const result = { ...baseFullConfig, ...config };
    if (this._options.configOverrides) {
      result.configFile = this._options.configOverrides.configFile;
      result.reportSlowTests = this._options.configOverrides.reportSlowTests;
      result.quiet = this._options.configOverrides.quiet;
      result.reporter = [...this._options.configOverrides.reporter];
    }
    return result;
  }

  private _parseProject(project: JsonProject): TeleFullProject {
    return {
      metadata: project.metadata,
      name: project.name,
      outputDir: this._absolutePath(project.outputDir),
      repeatEach: project.repeatEach,
      retries: project.retries,
      testDir: this._absolutePath(project.testDir),
      testIgnore: parseRegexPatterns(project.testIgnore),
      testMatch: parseRegexPatterns(project.testMatch),
      timeout: project.timeout,
      grep: parseRegexPatterns(project.grep) as RegExp[],
      grepInvert: parseRegexPatterns(project.grepInvert) as RegExp[],
      dependencies: project.dependencies,
      teardown: project.teardown,
      snapshotDir: this._absolutePath(project.snapshotDir),
      use: {},
    };
  }

  private _parseAttachments(attachments: JsonAttachment[]): reporterTypes.TestResult['attachments'] {
    return attachments.map(a => {
      return {
        ...a,
        body: a.base64 && (globalThis as any).Buffer ? Buffer.from(a.base64, 'base64') : undefined,
      };
    });
  }

  private _mergeSuitesInto(jsonSuites: JsonSuite[], parent: TeleSuite) {
    for (const jsonSuite of jsonSuites) {
      let targetSuite = parent.suites.find(s => s.title === jsonSuite.title);
      if (!targetSuite) {
        targetSuite = new TeleSuite(jsonSuite.title, parent._type === 'project' ? 'file' : 'describe');
        targetSuite.parent = parent;
        parent.suites.push(targetSuite);
      }
      targetSuite.location = this._absoluteLocation(jsonSuite.location);
      this._mergeSuitesInto(jsonSuite.suites, targetSuite);
      this._mergeTestsInto(jsonSuite.tests, targetSuite);
    }
  }

  private _mergeTestsInto(jsonTests: JsonTestCase[], parent: TeleSuite) {
    for (const jsonTest of jsonTests) {
      let targetTest = this._options.mergeTestCases ? parent.tests.find(s => s.title === jsonTest.title && s.repeatEachIndex === jsonTest.repeatEachIndex) : undefined;
      if (!targetTest) {
        targetTest = new TeleTestCase(jsonTest.testId, jsonTest.title, this._absoluteLocation(jsonTest.location), jsonTest.repeatEachIndex);
        targetTest.parent = parent;
        parent.tests.push(targetTest);
        this._tests.set(targetTest.id, targetTest);
      }
      this._updateTest(jsonTest, targetTest);
    }
  }

  private _updateTest(payload: JsonTestCase, test: TeleTestCase): TeleTestCase {
    test.id = payload.testId;
    test.location = this._absoluteLocation(payload.location);
    test.retries = payload.retries;
    test.tags = payload.tags ?? [];
    return test;
  }

  private _absoluteLocation(location: reporterTypes.Location): reporterTypes.Location;
  private _absoluteLocation(location?: reporterTypes.Location): reporterTypes.Location | undefined;
  private _absoluteLocation(location: reporterTypes.Location | undefined): reporterTypes.Location | undefined {
    if (!location)
      return location;
    return {
      ...location,
      file: this._absolutePath(location.file),
    };
  }

  private _absolutePath(relativePath: string): string;
  private _absolutePath(relativePath?: string): string | undefined;
  private _absolutePath(relativePath?: string): string | undefined {
    if (relativePath === undefined)
      return;
    return this._options.resolvePath(this._rootDir, relativePath);
  }
}

export class TeleSuite implements reporterTypes.Suite {
  title: string;
  location?: reporterTypes.Location;
  parent?: TeleSuite;
  _requireFile: string = '';
  suites: TeleSuite[] = [];
  tests: TeleTestCase[] = [];
  _timeout: number | undefined;
  _retries: number | undefined;
  _project: TeleFullProject | undefined;
  _parallelMode: 'none' | 'default' | 'serial' | 'parallel' = 'none';
  readonly _type: 'root' | 'project' | 'file' | 'describe';

  constructor(title: string, type: 'root' | 'project' | 'file' | 'describe') {
    this.title = title;
    this._type = type;
  }

  allTests(): TeleTestCase[] {
    const result: TeleTestCase[] = [];
    const visit = (suite: TeleSuite) => {
      for (const entry of [...suite.suites, ...suite.tests]) {
        if (entry instanceof TeleSuite)
          visit(entry);
        else
          result.push(entry);
      }
    };
    visit(this);
    return result;
  }

  titlePath(): string[] {
    const titlePath = this.parent ? this.parent.titlePath() : [];
    // Ignore anonymous describe blocks.
    if (this.title || this._type !== 'describe')
      titlePath.push(this.title);
    return titlePath;
  }

  project(): TeleFullProject | undefined {
    return this._project ?? this.parent?.project();
  }
}

export class TeleTestCase implements reporterTypes.TestCase {
  title: string;
  fn = () => {};
  results: TeleTestResult[] = [];
  location: reporterTypes.Location;
  parent!: TeleSuite;

  expectedStatus: reporterTypes.TestStatus = 'passed';
  timeout = 0;
  annotations: Annotation[] = [];
  retries = 0;
  tags: string[] = [];
  repeatEachIndex = 0;
  id: string;

  _resultsMap = new Map<string, TeleTestResult>();

  constructor(id: string, title: string, location: reporterTypes.Location, repeatEachIndex: number) {
    this.id = id;
    this.title = title;
    this.location = location;
    this.repeatEachIndex = repeatEachIndex;
  }

  titlePath(): string[] {
    const titlePath = this.parent ? this.parent.titlePath() : [];
    titlePath.push(this.title);
    return titlePath;
  }

  outcome(): 'skipped' | 'expected' | 'unexpected' | 'flaky' {
    // Ignore initial skips that may be a result of "skipped because previous test in serial mode failed".
    const results = [...this.results];
    while (results[0]?.status === 'skipped' || results[0]?.status === 'interrupted')
      results.shift();

    // All runs were skipped.
    if (!results.length)
      return 'skipped';

    const failures = results.filter(result => result.status !== 'skipped' && result.status !== 'interrupted' && result.status !== this.expectedStatus);
    if (!failures.length) // all passed
      return 'expected';
    if (failures.length === results.length) // all failed
      return 'unexpected';
    return 'flaky'; // mixed bag
  }

  ok(): boolean {
    const status = this.outcome();
    return status === 'expected' || status === 'flaky' || status === 'skipped';
  }

  _clearResults() {
    this.results = [];
    this._resultsMap.clear();
  }

  _createTestResult(id: string): TeleTestResult {
    const result = new TeleTestResult(this.results.length);
    this.results.push(result);
    this._resultsMap.set(id, result);
    return result;
  }
}

class TeleTestStep implements reporterTypes.TestStep {
  title: string;
  category: string;
  location: reporterTypes.Location | undefined;
  parent: reporterTypes.TestStep | undefined;
  duration: number = -1;
  steps: reporterTypes.TestStep[] = [];

  private _startTime: number = 0;

  constructor(payload: JsonTestStepStart, parentStep: reporterTypes.TestStep | undefined, location: reporterTypes.Location | undefined) {
    this.title = payload.title;
    this.category = payload.category;
    this.location = location;
    this.parent = parentStep;
    this._startTime = payload.startTime;
  }

  titlePath() {
    const parentPath = this.parent?.titlePath() || [];
    return [...parentPath, this.title];
  }

  get startTime(): Date {
    return new Date(this._startTime);
  }

  set startTime(value: Date) {
    this._startTime = +value;
  }
}

class TeleTestResult implements reporterTypes.TestResult {
  retry: reporterTypes.TestResult['retry'];
  parallelIndex: reporterTypes.TestResult['parallelIndex'] = -1;
  workerIndex: reporterTypes.TestResult['workerIndex'] = -1;
  duration: reporterTypes.TestResult['duration'] = -1;
  stdout: reporterTypes.TestResult['stdout'] = [];
  stderr: reporterTypes.TestResult['stderr'] = [];
  attachments: reporterTypes.TestResult['attachments'] = [];
  status: reporterTypes.TestStatus = 'skipped';
  steps: TeleTestStep[] = [];
  errors: reporterTypes.TestResult['errors'] = [];
  error: reporterTypes.TestResult['error'];

  _stepMap: Map<string, reporterTypes.TestStep> = new Map();

  private _startTime: number = 0;

  constructor(retry: number) {
    this.retry = retry;
  }

  setStartTimeNumber(startTime: number) {
    this._startTime = startTime;
  }

  get startTime(): Date {
    return new Date(this._startTime);
  }

  set startTime(value: Date) {
    this._startTime = +value;
  }
}

export type TeleFullProject = FullProject;

export const baseFullConfig: reporterTypes.FullConfig = {
  forbidOnly: false,
  fullyParallel: false,
  globalSetup: null,
  globalTeardown: null,
  globalTimeout: 0,
  grep: /.*/,
  grepInvert: null,
  maxFailures: 0,
  metadata: {},
  preserveOutput: 'always',
  projects: [],
  reporter: [[process.env.CI ? 'dot' : 'list']],
  reportSlowTests: { max: 5, threshold: 15000 },
  configFile: '',
  rootDir: '',
  quiet: false,
  shard: null,
  updateSnapshots: 'missing',
  version: '',
  workers: 0,
  webServer: null,
};

export function serializeRegexPatterns(patterns: string | RegExp | (string | RegExp)[]): JsonPattern[] {
  if (!Array.isArray(patterns))
    patterns = [patterns];
  return patterns.map(s => {
    if (typeof s === 'string')
      return { s };
    return { r: { source: s.source, flags: s.flags } };
  });
}

export function parseRegexPatterns(patterns: JsonPattern[]): (string | RegExp)[] {
  return patterns.map(p => {
    if (p.s)
      return p.s;
    return new RegExp(p.r!.source, p.r!.flags);
  });
}

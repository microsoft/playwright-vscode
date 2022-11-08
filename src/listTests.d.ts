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

type Metadata = { [key: string]: any };
type ViewportSize = {
  width: number;
  height: number;
};
type TraceMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';
type VideoMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';

type Fixtures = {
  acceptDownloads?: boolean;
  actionTimeout?: number;
  baseURL?: string;
  browserName: string;
  bypassCSP?: boolean;
  channel: string | undefined;
  colorScheme?: null | 'light' | 'dark' | 'no-preference';
  connectOptions: any;
  contextOptions?: any;
  defaultBrowserType: string;
  deviceScaleFactor?: number;
  extraHTTPHeaders?: Record<string, string>;
  geolocation?: null | { latitude: number; longitude: number; accuracy?: number; };
  hasTouch?: boolean;
  headless: boolean | undefined;
  httpCredentials?: null | { username: string; password: string; };
  ignoreHTTPSErrors?: boolean;
  isMobile?: boolean;
  javaScriptEnabled?: boolean;
  launchOptions: any;
  locale?: string;
  navigationTimeout?: number;
  offline?: boolean;
  permissions?: string[];
  proxy?: { server: string; bypass?: string; username?: string; password?: string; };
  screenshot: 'off' | 'on' | 'only-on-failure';
  storageState?: string | any;
  testIdAttribute?: string;
  timezoneId?: string;
  trace: TraceMode | /** deprecated */ 'retry-with-trace' | { mode: TraceMode, snapshots?: boolean, screenshots?: boolean, sources?: boolean };
  userAgent?: string;
  video: VideoMode | /** deprecated */ 'retry-with-video' | { mode: VideoMode, size?: ViewportSize };
  viewport?: ViewportSize | null;
};

export type ProjectConfigWithFiles = {
  grep: RegExp | RegExp[];
  grepInvert: RegExp | RegExp[] | null;
  metadata: Metadata;
  name: string;
  snapshotDir: string;
  outputDir: string;
  repeatEach: number;
  retries: number;
  testDir: string;
  testIgnore: string | RegExp | (string | RegExp)[];
  testMatch: string | RegExp | (string | RegExp)[];
  timeout: number;
  use: Fixtures;

  files: string[];
};

type ReporterDescription = [string] | [string, any];

type WebServerConfig = {
  command: string;
  port?: number;
  url?: string;
  ignoreHTTPSErrors?: boolean;
  timeout?: number;
  reuseExistingServer?: boolean;
  cwd?: string;
  env?: { [key: string]: string; };
};

type GlobalConfig = {
  expect?: {
    timeout?: number;
    toHaveScreenshot?: {
      animations?: 'allow' | 'disabled';
      caret?: 'hide' | 'initial';
      maxDiffPixelRatio?: number;
      maxDiffPixels?: number;
      scale?: 'css' | 'device';
      threshold?: number;
    };

    toMatchSnapshot?: {
      maxDiffPixelRatio?: number;
      maxDiffPixels?: number;
      threshold?: number;
    };
  };
  forbidOnly?: boolean;
  fullyParallel?: boolean;
  globalSetup?: string;
  globalTeardown?: string;
  globalTimeout?: number;
  grep?: RegExp | Array<RegExp>;
  grepInvert?: RegExp | Array<RegExp>;
  ignoreSnapshots?: boolean;
  maxFailures?: number;
  metadata?: Metadata;
  name: string;
  outputDir?: string;
  preserveOutput?: 'always' | 'never' | 'failures-only';
  quiet?: boolean;
  repeatEach?: number;
  reporter?: string | ReporterDescription[];
  reportSlowTests?: null | { max: number; threshold: number; };
  retries?: number;
  shard?: null | { total: number; current: number; };
  snapshotDir?: string;
  testDir: string;
  testIgnore?: string | RegExp | Array<string | RegExp>;
  testMatch?: string | RegExp | Array<string | RegExp>;
  timeout?: number;
  updateSnapshots?: 'all' | 'none' | 'missing';
  version: string;
  webServer?: WebServerConfig | WebServerConfig[];
  workers?: number | string;
};

export type ConfigListFilesReport = {
  projects: ProjectConfigWithFiles[];
  config?: GlobalConfig;
};

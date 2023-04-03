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

const gulp = require('gulp');
const nls = require('vscode-nls-dev');
const sourcemaps = require('gulp-sourcemaps');
const ts = require('gulp-typescript');

const tsProject = ts.createProject('./tsconfig.json');
const OUT_DIR = 'out';

const languages = [
  { id: 'zh-CN', folderName: 'chs' },
  // { id: 'zh-TW', folderName: 'cht' },
];

// Generate package.nls.*.json files from: ./i18n/*/package.i18n.json
// Outputs to root path, as these nls files need to be along side package.json
const generatedAdditionalLocFiles = () => {
  return gulp
      .src(['package.nls.json'])
      .pipe(nls.createAdditionalLanguageFiles(languages, 'i18n'))
      .pipe(gulp.dest('.'));
};

// Generates ./dist/nls.bundle.<language_id>.json from files in ./i18n/** *//<src_path>/<filename>.i18n.json
// Localized strings are read from these files at runtime.
const generatedSrcLocBundle = () => {
  // Transpile the TS to JS, and let vscode-nls-dev scan the files for calls to localize.
  return tsProject
      .src()
      .pipe(sourcemaps.init())
      .pipe(tsProject())
      .js
      .pipe(nls.rewriteLocalizeCalls())
      .pipe(nls.createAdditionalLanguageFiles(languages, 'i18n'))
      .pipe(nls.bundleMetaDataFiles('ms-playwright.playwright', OUT_DIR))
      .pipe(nls.bundleLanguageFiles())
      .pipe(gulp.dest(OUT_DIR));
};

gulp.task('translate', gulp.series(generatedSrcLocBundle, generatedAdditionalLocFiles));

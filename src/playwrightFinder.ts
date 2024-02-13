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

const path = require('path');

const packages = [
  '@playwright/test',
  'playwright',
  '@playwright/experimental-ct-react',
  '@playwright/experimental-ct-react17',
  '@playwright/experimental-ct-vue',
  '@playwright/experimental-ct-vue2',
  '@playwright/experimental-ct-solid',
  '@playwright/experimental-ct-svelte',
];

for (const packageName of packages) {
  let packageJSONPath;
  try {
    packageJSONPath = require.resolve(path.join(packageName, 'package.json'), { paths: [process.cwd()] });
  } catch (e) {
    continue;
  }
  try {
    const packageJSON = require(packageJSONPath);
    const { version } = packageJSON;
    const v = parseFloat(version.replace(/-(next|beta)$/, ''));
    const cli = path.join(packageJSONPath, '../cli.js');
    console.log(JSON.stringify({ version: v, cli }, null, 2));
    process.exit(0);
  } catch (e) {
    console.log(JSON.stringify({ error: String(e) }, null, 2));
    process.exit(0);
  }
}

console.log(JSON.stringify({ error: 'Playwright installation not found for ' + process.cwd() }));

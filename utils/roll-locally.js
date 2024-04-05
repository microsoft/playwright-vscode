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

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const packageNames = ['playwright-core', 'playwright', 'playwright-test'];
const upstreamFiles = new Map([
  ['src/upstream/events.ts', 'packages/playwright/src/isomorphic/events.ts'],
  ['src/upstream/testServerConnection.ts', 'packages/playwright/src/isomorphic/testServerConnection.ts'],
  ['src/upstream/testServerInterface.ts', 'packages/playwright/src/isomorphic/testServerInterface.ts'],
  ['src/upstream/testTree.ts', 'packages/playwright/src/isomorphic/testTree.ts'],

  // TODO: Roll these manually, on demand, upon changes into versioned folders.
  // ['src/upstream/teleEmitter.ts', 'packages/playwright/src/reporters/teleEmitter.ts'],
  // ['src/upstream/teleReceiver.ts', 'packages/playwright/src/isomorphic/teleReceiver.ts'],
]);

(async () => {
  const playwrightWorkspace = path.resolve(__dirname, '../../playwright');
  for (const packageName of packageNames) {
    console.log('Packaging ' + packageName);
    console.log(execSync(`node ./utils/pack_package ${packageName} ` + path.join(__dirname, `../out/${packageName}.tgz`), { cwd: playwrightWorkspace }).toString());
  }
  const nodeModules = path.join(__dirname, '../test-results', 'node_modules');
  await fs.promises.mkdir(nodeModules, { recursive: true });
  for (const packageName of packageNames) {
    const packagePath = path.join(__dirname, '../out', packageName + '.tgz');
    if (fs.existsSync(packagePath)) {
      console.log('Extracting ' + packageName);
      console.log(execSync(`npm install ${packagePath}`, { cwd: nodeModules }).toString());
    }
  }

  // Copy reused source files
  for (const [to, from] of upstreamFiles) {
    const fromPath = path.join(playwrightWorkspace, from);
    const toPath = path.join(__dirname, '..', to);
    const fromContent = await fs.promises.readFile(fromPath, 'utf8');
    const toContent = await fs.promises.readFile(toPath, 'utf8');
    const [fromPrefix, fromSuffix] = fromContent.split(upstreamBoundary);
    const [toPrefix] = toContent.split(downstreamBoundary);
    if (fromSuffix)
      await fs.promises.writeFile(toPath, toPrefix + downstreamBoundary + fromSuffix, 'utf8');
    else
      await fs.promises.writeFile(toPath, fromPrefix, 'utf8');
  }
})();

const upstreamBoundary = '// -- Reuse boundary -- Everything below this line is reused in the vscode extension.';
const downstreamBoundary = '// -- Reuse boundary -- Everything below this line is taken from playwright core.';

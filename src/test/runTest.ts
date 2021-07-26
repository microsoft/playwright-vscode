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
import * as path from 'path';
import * as glob from 'glob';
import * as util from 'util';
import * as fs from 'fs';

import { runTests } from '@vscode/test-electron';

const globAsync = util.promisify(glob);

async function main() {
	try {
		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		const suites = await globAsync(path.join(__dirname, 'suites', '*'));

		for (const suite of suites) {
			if (!fs.statSync(suite).isDirectory())
				return;
			// The path to the extension test script
			// Passed to --extensionTestsPath
			const extensionTestsPath = path.resolve(suite, 'index');

			// Download VS Code, unzip it and run the integration test
			await runTests({
				version: 'insiders',
				extensionDevelopmentPath,
				extensionTestsPath,
				launchArgs: [path.join(__dirname, '..', '..', 'test', 'assets', path.basename(suite))]
			});
		}
	} catch (err) {
		console.error('Failed to run tests');
		process.exit(1);
	}
}

main();

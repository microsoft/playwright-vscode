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
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';

import { runTests as runVSCodeTests } from '@vscode/test-electron';

type Suite = {
	suite: string;
	assetDir: string;
	open: string;
}

function getSuites(): Suite[] {
	return glob.sync(path.join(__dirname, 'suites', '*'))
		.map(suite => {
			if (!(fs.statSync(suite)).isDirectory())
				return;
			const assetDir = path.join(__dirname, '..', '..', 'test', 'assets', path.basename(suite));
			const potentialWorkspaceFile = path.join(assetDir, 'my.code-workspace');
			return {
				suite,
				assetDir,
				open: fs.existsSync(potentialWorkspaceFile) ? potentialWorkspaceFile : assetDir
			};
		}).filter((suite): suite is Suite => !!suite);
}

async function runTests() {
	// The folder containing the Extension Manifest package.json
	// Passed to `--extensionDevelopmentPath`
	const extensionDevelopmentPath = path.resolve(__dirname, '../../');

	const userDataDir = path.join(os.tmpdir(), 'pw-vsc-tests');
	const cleanupUserDir = async () => {
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		await fs.promises.rmdir(userDataDir).catch(() => { });
	};

	const suites = getSuites();

	for (const { suite, open } of suites) {
		await cleanupUserDir();
		// The path to the extension test script
		// Passed to --extensionTestsPath
		const extensionTestsPath = path.resolve(suite, 'index');

		// Download VS Code, unzip it and run the integration test
		await runVSCodeTests({
			version: 'insiders',
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				`--user-data-dir=${userDataDir}`,
				'--disable-extensions',
				open,
			]
		});

		await runVSCodeTests({
			version: 'stable',
			extensionDevelopmentPath,
			extensionTestsPath,
			launchArgs: [
				`--user-data-dir=${userDataDir}`,
				'--disable-extensions',
				open,
			]
		});
	}
	await cleanupUserDir();
}


async function main() {
	switch (process.argv[2]) {
		case 'run':
			await runTests();
			break;
		case 'install':
			for (const { assetDir } of getSuites())
				spawnSync('npm i', { cwd: assetDir, stdio: 'inherit', shell: true });
			break;
		default: {
			const command = 'node ' + path.relative(process.cwd(), process.argv[1]) + ' ';
			throw new Error(`Unkown parameter '${command}${process.argv[2] || ''}'\n` +
				'Supported parameters:\n' +
				`	- ${command}run\n` +
				`	- ${command}install`);
		}
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
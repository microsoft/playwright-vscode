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
import * as vscodeTypes from './vscodeTypes';
import * as pack from '../package.json';

const workspaceVersionKey = 'pw.workspace-version';
interface WorkspaceVersionState {
  version: string;
  lastMigrationTime: number;
  lastMigration: number;
}

export class Migrator {
  constructor(private readonly context: vscodeTypes.ExtensionContext) {}

  async migrate() {
    const state = this.context.workspaceState.get<WorkspaceVersionState>(workspaceVersionKey) ?? { version: '0.0.0', lastMigrationTime: 0, lastMigration: -1 };
    await this.runMigrations(state.lastMigration);
    await this.context.workspaceState.update(workspaceVersionKey, { version: pack.version, lastMigrationTime: Date.now(), lastMigration: this.migrations.length - 1 });
  }

  private migrations: Function[] = [];

  private async runMigrations(lastMigration: number) {
    for (let i = lastMigration + 1; i < this.migrations.length; ++i)
      await this.migrations[i]();
  }
}
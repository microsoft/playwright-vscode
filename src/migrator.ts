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
  public isNewWorkspace: boolean;
  private state: WorkspaceVersionState;
  constructor(private readonly context: vscodeTypes.ExtensionContext) {
    const state = this.context.workspaceState.get<WorkspaceVersionState>(workspaceVersionKey);
    if (state) {
      this.isNewWorkspace = false;
      this.state = state;
    } else {
      this.isNewWorkspace = true;
      this.state = { version: '0.0.0', lastMigrationTime: 0, lastMigration: -1 };
    }
  }

  async migrate() {
    const lastMigration = await this.runMigrations();
    this.state = { version: pack.version, lastMigrationTime: Date.now(), lastMigration };
    await this.context.workspaceState.update(workspaceVersionKey, this.state);
  }

  private async runMigrations() {
    for (const migration of this.migrations.slice(this.state.lastMigration + 1))
      await migration();
    return this.migrations.length - 1;
  }

  private migrations: Function[] = [];
}
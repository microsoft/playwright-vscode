/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class TestwiseProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TestwiseItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private workspaceRoot: string | undefined) { }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TestwiseItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TestwiseItem): Promise<TestwiseItem[]> {
    if (!this.workspaceRoot)
      return [new TestwiseItem('Open a folder to see seed data', vscode.TreeItemCollapsibleState.None, 'info_node')];

    const dataPath = path.join(this.workspaceRoot, 'seed-data', 'subjects.json');
    if (!fs.existsSync(dataPath)) return [];

    let rawData: any[] = [];
    try {
      rawData = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
    } catch (err) { return []; }

    if (!element)
      return [new TestwiseItem('Subjects', vscode.TreeItemCollapsibleState.Collapsed, 'root')];

    if (element.contextValue === 'root') {
      const uniqueSubjects = [...new Set(rawData
          .map((item: any) => item.subject)
          .filter(s => typeof s === 'string')
          .map(s => s.trim())
      )].sort();

      console.log('Found subjects:', uniqueSubjects);

      return uniqueSubjects.map(s => new TestwiseItem(s, vscode.TreeItemCollapsibleState.Collapsed, 'subject'));
    }

    if (element.contextValue === 'subject') {
      const subjectName = typeof element.label === 'string' ? element.label : (element.label?.label || '');
      const hasVariants = rawData.some(item => item.subject === subjectName && item.variant && item.variant.trim() !== '');

      if (hasVariants) {
        return [
          new TestwiseItem('Default', vscode.TreeItemCollapsibleState.Collapsed, 'screens_container', subjectName, null),
          new TestwiseItem('Variants', vscode.TreeItemCollapsibleState.Collapsed, 'variants_container', subjectName)
        ];
      } else {
        return this.getScreenCheckboxes(subjectName, null);
      }
    }

    if (element.contextValue === 'screens_container' || element.contextValue === 'variant_item') {
      const subjectName = element.parentSubject || '';
      const variantName = element.contextValue === 'variant_item'
        ? (typeof element.label === 'string' ? element.label : element.label?.label || '')
        : null;
      return this.getScreenCheckboxes(subjectName, variantName);
    }

    if (element.contextValue === 'variants_container') {
      const subjectName = element.parentSubject || '';
      const uniqueVariants = [...new Set(rawData
          .filter((item: any) => item.subject === subjectName && item.variant && item.variant.trim() !== '')
          .map((item: any) => item.variant))];

      return uniqueVariants.map(v =>
        new TestwiseItem(v as string, vscode.TreeItemCollapsibleState.Collapsed, 'variant_item', subjectName, v as string)
      );
    }

    return [];
  }

  private getScreenCheckboxes(subjectName: string, variantName: string | null): TestwiseItem[] {
    const registeredPath = path.join(this.workspaceRoot!, 'seed-data', 'registeredSubjects.json');
    let registered: any[] = [];
    if (fs.existsSync(registeredPath))
      try { registered = JSON.parse(fs.readFileSync(registeredPath, 'utf-8')); } catch (e) { }

    return ['popup', 'main', 'detail', 'zoom'].map(type => {
      const item = new TestwiseItem(type, vscode.TreeItemCollapsibleState.None, 'checkbox', subjectName, variantName);

      const isRegistered = registered.some(r =>
        r.subject === subjectName &&
        r.variant === variantName &&
        r.screen_type === type
      );

      item.checkboxState = isRegistered
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;

      return item;
    });
  }
}

export class TestwiseItem extends vscode.TreeItem {
  public parentSubject: string | undefined;
  public variant: string | null | undefined;

  constructor(
    label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
    parentSubject?: string,
    variant?: string | null
  ) {
    super(label, collapsibleState);
    this.parentSubject = parentSubject;
    this.variant = variant;

    if (contextValue === 'checkbox') {
      this.iconPath = undefined;
      this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;

      this.command = {
        command: 'testwise.toggleCheckbox',
        title: 'Toggle Checkbox',
        arguments: [this]
      };
    } else if (contextValue === 'variants_container') {
      this.iconPath = new vscode.ThemeIcon('folder');
    } else if (contextValue === 'subject' || contextValue === 'variant_item' || contextValue === 'screens_container') {
      this.iconPath = new vscode.ThemeIcon('repo');
    }
  }
}


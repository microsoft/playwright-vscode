

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
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class TestwiseProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TestwiseItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private workspaceRoot: string | undefined) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TestwiseItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TestwiseItem): Promise<TestwiseItem[]> {
    console.log('TESTWISE: getChildren called for element:', element?.label || 'root');
    if (!this.workspaceRoot) {
        console.log('TESTWISE: No workspace root found!');
        return [new TestwiseItem('Open a folder to see seed data', vscode.TreeItemCollapsibleState.None, 'info_node')];
    }

    const dataPath = path.join(this.workspaceRoot, 'seed-data', 'subjects.json');

    // 1. Check if the file exists
    if (!fs.existsSync(dataPath)) {
      if (!element) {
        return [new TestwiseItem(
          'No seed data found', 
          vscode.TreeItemCollapsibleState.None, 
          'info_node'
        )];
      }
      return [];
    }

    // 2. Try to read and parse the data safely
    let rawData: any[] = [];
    try {
      const content = fs.readFileSync(dataPath, 'utf-8');
      rawData = JSON.parse(content);
    } catch (err) {
      if (!element) {
        return [new TestwiseItem('Error parsing subjects.json', vscode.TreeItemCollapsibleState.None, 'info_node')];
      }
      return [];
    }

    // 3. Root Level: Show "Subjects" folder
    if (!element) {
      return [new TestwiseItem('Subjects', vscode.TreeItemCollapsibleState.Expanded, 'root')];
    }

    // 4. Level 1: List unique subjects
    if (element.contextValue === 'root') {
      const uniqueSubjects = [...new Set(rawData.map((item: any) => item.subject))];
      return uniqueSubjects.map(s => new TestwiseItem(s as string, vscode.TreeItemCollapsibleState.Collapsed, 'subject'));
    }

    // --- 5. Level 2: Subject Expanded ---
    if (element.contextValue === 'subject' || element.contextValue === 'variant_item') {
      const subjectName = element.contextValue === 'subject' ? element.label : (element.parentSubject || '');
      const variantName = element.contextValue === 'variant_item' ? element.label : (element.variant || null);

      // READ THE REGISTERED FILE
      const registeredPath = path.join(this.workspaceRoot!, 'seed-data', 'registeredSubjects.json');
      let registered: any[] = [];
      if (fs.existsSync(registeredPath)) {
          try { registered = JSON.parse(fs.readFileSync(registeredPath, 'utf-8')); } catch(e) {}
      }

      const items = ['popup', 'main', 'detail', 'zoom'].map(type => {
          const item = new TestwiseItem(type, vscode.TreeItemCollapsibleState.None, 'checkbox', subjectName, variantName);
          
          // CHECK IF THIS ROW SHOULD BE TICKED
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

      if (element.contextValue === 'subject') {
          items.push(new TestwiseItem('variants', vscode.TreeItemCollapsibleState.Collapsed, 'variants_container', subjectName));
      }
      return items;
    }
  }
}

class TestwiseItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
    public readonly parentSubject?: string,
    public readonly variant?: string | null
  ) {
    super(label, collapsibleState);
    
    if (contextValue === 'checkbox') {
      this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
      this.iconPath = new vscode.ThemeIcon('primitive-dot');
    } else if (contextValue === 'subject' || contextValue === 'variant_item') {
      this.iconPath = new vscode.ThemeIcon('repo');
    }
  }
}
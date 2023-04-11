/**
 * Copyright
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

/**
 * Pick Item
 * @description
 * 断言类型，扩展 VSCode QuickPickItem
 */
interface ExtendQuickPickItem extends vscodeTypes.QuickPickItem {
  /**
   * if need to show an input field to get pick value after user picked an pick type
   */
  needInputValue: boolean,
  /**
   * title of the pick value
   */
  pickValueTitle?: string,
  /**
   * default value of the pick value
   */
  pickDefaultValue?: string,

  /**
   * generate pick content code
   */
  genCode?: (variable?: string, selector?: string) => string;
}

const PICK_ITEMS: ExtendQuickPickItem[] = [{
  // 获取页面标题
  label: 'title',
  description: 'Get page title',
  needInputValue: true,
  genCode: (variable?: string) => {
    return `let ${variable} = await page.title();`;
  }
},{
  // 获取页面url
  label: 'url',
  description: 'Get page url',
  needInputValue: true,
  genCode: (variable?: string) => {
    return `let ${variable} = page.url();`;
  }
},
{
  // 打开定位器
  label: 'locator',
  description: 'Locator dom and get Content',
  needInputValue: true,
},
];

const LOCATOR_ITEMS: ExtendQuickPickItem[] = [{
  // 获取元素文本
  label: 'textContent',
  description: 'Get text content',
  needInputValue: true,
  genCode: (variable?: string, selector?: string) => {
    return `let ${variable} = await page.${selector}.innerText();`;
  }
},{
  // 获取input中的内容
  label: 'inputValue',
  description: 'Get input content',
  needInputValue: true,
  genCode: (variable?: string, selector?: string) => {
    return `let ${variable} = await page.${selector}.inputValue();`;
  }
}
];


export class PickContentDialog {
  private _vscode: vscodeTypes.VSCode;
  private _editor?: vscodeTypes.TextEditor;

  constructor(vscode: vscodeTypes.VSCode, editor?: vscodeTypes.TextEditor) {
    this._vscode = vscode;
    this._editor = editor;
  }

  async selectPickType() {
    return this._vscode.window.showQuickPick(PICK_ITEMS, {
      title: `Please select pick type`,
      placeHolder: 'Select pick type',
    }).then(pickedItem => {
      return pickedItem;
    });
  }

  async pickPageContent(pickItem: ExtendQuickPickItem) {
    const pickLabel = pickItem.label;
    return this._vscode.window.showInputBox({
      title: `Pick Page ${pickLabel}, please input content name`,
      value: ''
    }).then(async inputValue => {
      if (!pickItem?.genCode) return;
      const codeText = pickItem.genCode(inputValue || '');
      this._vscode.env.clipboard.writeText(codeText);
      if (this._editor) {
        const targetIndentation = guessIndentation(this._editor);
        const range = new this._vscode.Range(this._editor.selection.end, this._editor.selection.end);
        await this._editor.edit(async editBuilder => {
          editBuilder.replace(range, '\n' + ' '.repeat(targetIndentation) + codeText + '\n');
        });
        this._editor.selection = new this._vscode.Selection(this._editor.selection.end, this._editor.selection.end);
      }
    });

  }


  async updateOrCancelInspectPick(selector: string) {
    let pickType: ExtendQuickPickItem | undefined;
    let variable = '';

    return this._vscode.window.showQuickPick(LOCATOR_ITEMS, {
      title: `Please select pick type for ${selector}`,
      placeHolder: 'Select pick type',
    }).then(pickedItem => {
      pickType = pickedItem;
      if (pickType?.needInputValue && pickType.label) {
        return this._vscode.window.showInputBox({
          title: pickType.pickValueTitle ||  `Locator pick  ${pickType.label}, please input content name`,
          value: pickType.pickDefaultValue,
          prompt: 'Please input something',
        });
      }
    }).then(inputValue => {
      variable = inputValue || '';
    }).then(async () => {
      if (pickType?.label && pickType?.genCode) {
        const codeText = pickType.genCode(variable, selector);
        this._vscode.env.clipboard.writeText(codeText);
        if (this._editor) {
          const targetIndentation = guessIndentation(this._editor);
          const range = new this._vscode.Range(this._editor.selection.end, this._editor.selection.end);
          await this._editor.edit(async editBuilder => {
            editBuilder.replace(range, '\n' + ' '.repeat(targetIndentation) + codeText + '\n');
          });
          this._editor.selection = new this._vscode.Selection(this._editor.selection.end, this._editor.selection.end);
        }
      }
    });

  }
}

function guessIndentation(editor: vscodeTypes.TextEditor): number {
  const lineNumber = editor.selection.start.line;
  for (let i = lineNumber; i >= 0; --i) {
    const line = editor.document.lineAt(i);
    if (!line.isEmptyOrWhitespace)
      return line.firstNonWhitespaceCharacterIndex;
  }
  return 0;
}

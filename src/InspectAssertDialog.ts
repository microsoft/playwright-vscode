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
 * 断言类型，扩展 VSCode QuickPickItem
 */
interface ExtendQuickPickItem extends vscodeTypes.QuickPickItem {
  /**
   * if need to show an input field to get assert value after user picked an assert type
   * also used for screenshot name
   */
  needAssertValue: boolean,
  /**
   * title of the assert value
   */
  assertValueTitle?: string,
  /**
   * default value of the assert value
   */
  assertDefaultValue?: string,
  /**
   * generate assert (and screenshot) code
   */
  genAssertCode: (selector: string, assertValue?: string) => string;
}

const ASSERT_ITEMS: ExtendQuickPickItem[] = [{
  // 判断元素是否可见
  label: 'toBeVisible',
  detail: 'Check if an item is visible',
  needAssertValue: false,
  genAssertCode: (selector: string) => {
    return `expect(await page.${selector}).toBeVisible();`;
  }
}, {
  // 判断元素是否包含字符串
  label: 'toContain',
  detail: 'Check if an item contains a text',
  needAssertValue: true,
  genAssertCode: (selector: string, assertValue?: string) => {
    return `expect(await page.${selector}.textContent()).toContain(${JSON.stringify(assertValue)});`;
  }
}, {
  // 截图
  label: 'screenshot',
  detail: 'Take a screenshot',
  needAssertValue: true,
  assertValueTitle: 'please input screenshot file name',
  assertDefaultValue: 'screenshot.png',
  genAssertCode: (selector: string, assertValue = 'screenshot.png') => {
    return `await page.${selector}.screenshot({ path: ${JSON.stringify(assertValue)} });`;
  }
}];

export class InspectAssertDialog {
  private _vscode: vscodeTypes.VSCode;
  private _editor?: vscodeTypes.TextEditor;

  constructor(vscode: vscodeTypes.VSCode, editor?: vscodeTypes.TextEditor) {
    this._vscode = vscode;
    this._editor = editor;
  }


  updateOrCancelInspectAssert(selector: string) {
    let assertType: ExtendQuickPickItem | undefined;
    let assertValue = '';

    return this._vscode.window.showQuickPick(ASSERT_ITEMS, {
      title: `Please select an assert type for ${selector}`,
    }).then(pickedItem => {
      assertType = pickedItem;
      console.log(assertType);
      if (assertType?.needAssertValue && assertType.label) {
        return this._vscode.window.showInputBox({
          title: assertType.assertValueTitle || 'please input assert value',
          value: assertType.assertDefaultValue,
        });
      }
    }).then(inputValue => {
      assertValue = inputValue || '';
    }).then(async () => {
      if (assertType?.label) {
        const codeText = assertType.genAssertCode(selector, assertValue);
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

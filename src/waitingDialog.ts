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

export class WaitingDialog {
  private _vscode: vscodeTypes.VSCode;
  private _editor?: vscodeTypes.TextEditor;

  constructor(vscode: vscodeTypes.VSCode, editor?: vscodeTypes.TextEditor) {
    this._vscode = vscode;
    this._editor = editor;
  }

  openDialog() {
    let toolValue = '';
    return this._vscode.window.showInputBox({
      title: 'please enter the waiting time(ms)',
      value: '1000', // 默认1ms
    }).then(inputValue => {
      toolValue = inputValue?.trim() || '';
    }).then(async () => {
      const reg = /^[\d]+$/;
      if (!toolValue) {
        // 如果没有输入值或者取消输入，就不插入代码
        return;
      }
      if (!reg.test(toolValue)) {
        // 如果输入非法的字符，即非数字字符，提示
        this._vscode.window.showWarningMessage(`请输入数字`);
        return;
      }
      const codeText = `await page.waitForTimeout(${Number(toolValue || '1000')});`;
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

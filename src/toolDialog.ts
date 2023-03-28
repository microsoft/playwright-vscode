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

type Tool = 'wait' | 'title';
interface QuickPickItem  {
  inputTitle: string,
  inputDefaultValue?: string,
  genCode: (inputValue: string) => string;
  parameterCheck?: (inputValue: string, vscode: vscodeTypes.VSCode) => boolean
}

const TOOL_MAP: Record<Tool, QuickPickItem> = {
  'title': {
    inputTitle: 'please enter the title',
    genCode: (inputValue: string) => {
      return `await expect(page).toHaveTitle('${inputValue}')`;
    },
  },
  'wait': {
    inputTitle: 'please enter the waiting time(ms)',
    inputDefaultValue: '1000',
    genCode: (inputValue: string) => {
      return `await page.waitForTimeout(${Number(inputValue || '1000')});`;
    },
    parameterCheck: (inputValue: string, vscode: vscodeTypes.VSCode) => {
      const reg = /^[\d]+$/;
      if (!reg.test(inputValue)) {
        // 如果输入非法的字符，即非数字字符，提示
        vscode.window.showWarningMessage(`请输入数字`);
        return false;
      }
      return true;
    }
  }
};

export class TooolDialog {
  private _vscode: vscodeTypes.VSCode;
  private _editor?: vscodeTypes.TextEditor;
  public tool: Tool;


  constructor(tool: Tool, vscode: vscodeTypes.VSCode, editor?: vscodeTypes.TextEditor) {
    this._vscode = vscode;
    this._editor = editor;
    this.tool = tool;
  }

  openDialog() {
    let toolValue = '';
    const tool = TOOL_MAP[this.tool];

    return this._vscode.window.showInputBox({
      title: tool.inputTitle,
      value: tool.inputDefaultValue || '', // 默认1ms
    }).then(inputValue => {
      toolValue = inputValue?.trim() || '';
    }).then(async () => {
      if (!toolValue) {
        // 如果没有输入值或者取消输入，就不插入代码
        return false;
      }
      if (tool.parameterCheck && !tool.parameterCheck(toolValue, this._vscode)) {
        // 校验不通过
        return;
      }
      const codeText = tool.genCode(toolValue);
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

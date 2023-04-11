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

type Tool = 'wait' | 'title' | 'basic_assert';
type InputItem = {
  inputTitle: string,
  inputDefaultValue?: string,
  parameterCheck?: (inputValue: string, vscode: vscodeTypes.VSCode) => boolean;
};
interface QuickPickItem  {
  inputBox: InputItem[]
  genCode: (inputValues: string[]) => string;
}

const TOOL_MAP: Record<Tool, QuickPickItem> = {
  'title': {
    inputBox: [{ inputTitle: 'please enter the title', }],
    genCode: (inputValues: string[]) => {
      return `await expect(page).toHaveTitle('${inputValues[0]}')`;
    },
  },
  'wait': {
    inputBox: [{
      inputTitle: 'please enter the waiting time(ms)',
      inputDefaultValue: '1000',
      parameterCheck: (inputValue: string, vscode: vscodeTypes.VSCode) => {
        const reg = /^[\d]+$/;
        if (!reg.test(inputValue)) {
        // 如果输入非法的字符，即非数字字符，提示
          vscode.window.showWarningMessage(`请输入数字`);
          return false;
        }
        return true;
      }
    }],
    genCode: (inputValues: string[]) => {
      return `await page.waitForTimeout(${Number(inputValues[0] || '1000')});`;
    },

  },
  'basic_assert': {
    inputBox: [{
      inputTitle: 'please enter variable name',
    },{
      inputTitle: 'please enter the expected value',
    }],
    genCode: (inputValues: string[]) => {
      return `await expect(${inputValues[0]}).toEqual(${inputValues[1]})`;
    },
  }
};

export class ToolDialog {
  private _vscode: vscodeTypes.VSCode;
  private _editor?: vscodeTypes.TextEditor;
  public tool: Tool;


  constructor(tool: Tool, vscode: vscodeTypes.VSCode, editor?: vscodeTypes.TextEditor) {
    this._vscode = vscode;
    this._editor = editor;
    this.tool = tool;
  }


  async openDialog() {
    const toolItem = TOOL_MAP[this.tool];
    const inputItems = toolItem['inputBox'];

    const inputValues = [];
    for (const item of inputItems) {
      // 遍历inputItems依次创建input框，将输入的值存入inputValues
      const input = await this._vscode.window.showInputBox({
        title: item.inputTitle,
        value: item.inputDefaultValue
      });
      if (!input) {
        // 如果没有输入值或者取消输入，就不插入代码
        return false;
      }
      if (item.parameterCheck && !item.parameterCheck(input, this._vscode)) {
        // 校验不通过
        return;
      }
      inputValues.push(input || '');
    }

    const codeText = toolItem.genCode(inputValues);
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

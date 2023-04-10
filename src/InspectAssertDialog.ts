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
 * Assert Type Pick Item
 * @description
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
   * if need to input Xpath
   */
  needInputXpath?: boolean
  /**
   * generate assert (and screenshot) code
   */
  genAssertCode?: (selector: string, assertValue?: string, xPath?: string) => string;
}

const PICK_ITEMS: ExtendQuickPickItem[] = [{
  // 页面title 断言
  label: 'title assert',
  description: 'Check the page title if have the input value',
  needAssertValue: true,
}, {
  // 基础断言
  label: 'basic assert',
  description: 'basic assert',
  needAssertValue: true,
},{
  // 需要打开浏览器获取页面元素的断言
  label: 'locator assert',
  description: 'locator assert',
  needAssertValue: true,
},
];


const ASSERT_ITEMS: ExtendQuickPickItem[] = [{
  // 确认元素的文本包含提供的值
  label: 'toContain',
  description: 'Check if an item contains a text',
  needAssertValue: true,
  genAssertCode: (selector: string, assertValue?: string) => {
    return `await expect(page.${selector}).toContainText(${JSON.stringify(assertValue)});`;
  }
},{
  // 确认元素的文本不包含提供的值
  label: 'not.toContain',
  description: 'Check if an item do not contains a text',
  needAssertValue: true,
  genAssertCode: (selector: string, assertValue?: string) => {
    return `await expect(page.${selector}).not.toContainText(${JSON.stringify(assertValue)});`;
  }
},
// {
//   // 确认下拉元素中所选选项的value属性包含提供的值
//   label: 'multi-select toHaveValues',
//   description: 'Ensures the Locator points to multi-select/combobox the specified values are selected.',
//   needAssertValue: false,
//   genAssertCode: (selector: string, assertValue?: string) => {
//     return `await expect(page.${selector}).toHaveValues(${JSON.stringify(assertValue)});`;
//   }
// }
{
  // 确认选择框是否选中某些值。
  label: 'toHaveSelectedLabel',
  description: 'Check if the selected dropdown options contain label',
  needAssertValue: true,
  genAssertCode: (selector: string, assertValue?: string) => {
    const code_snippets = `
    /*** 断言select是否包含输入的标签值 开始 ***/
    {
      let inputValue = '${assertValue}';
      let inputOptions = inputValue.split(/[,，]/).map(item => item.trim());
      for (const item of inputOptions) {
        await expect(page.${selector}).toContainText(item)
      }

    }
    /*** 断言select是否包含输入的标签值 结束 ***/
    `;
    return code_snippets;
  }
},
// {
//   // 确认ant-desing提供的select框包含提供的标签
//   label: 'toHaveSelectedLabel',
//   description: 'only for ant-design, Check if the selected dropdown options contain label',
//   needAssertValue: true,
//   genAssertCode: (selector: string, assertValue?: string) => {
//     const assert_snippets = `
//     /**断言select是否包含输入的标签值 开始***/
//     {
//       await page.${selector}?.click();
//       // 主动等待1s，避免其他下拉框还未回收影响新下拉框选择
//       await page.waitForTimeout(1000);
//       let dropdown = await page.waitForSelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)', {timeout:3000})
//                     .catch(() => {
//                         console.log('下拉框未出现，再次点击选择框，确保下拉框出现')
//                         return page.${selector}?.click().then(() => page.waitForSelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)'));
//                     });
//       let values = await dropdown.$$eval('.ant-select-item-option[aria-selected="true"] > .ant-select-item-option-content',
//           options => options.map(option => option?.textContent?.trim())
//       );
//       console.log('下拉框中选中的标签:', values);
//       let inputValue = '${assertValue}';
//       let inputOptions = inputValue.split(/[,，]/).map(item => item.trim());
//       // 比较选中的标签和断言的标签是否一致
//       let result = inputOptions.every((itemA) =>
//           values.some((itemB) => itemB?.indexOf(itemA) !== -1)
//       );
//       expect(result).toBe(true);
//     }
//     /**断言select是否包含输入的标签值 结束***/

//     `;
//     // return `await expect(page.${selector}).not.toContainText(${JSON.stringify(assertValue)});`;
//     return assert_snippets;
//   }
// },
{
  // 确认目标元素存在于页面上的某处。
  label: 'toBeVisible',
  description: 'Check if an item is visible',
  needAssertValue: false,
  genAssertCode: (selector: string) => {
    return `await expect(await page.${selector}).toBeVisible();`;
  }
},
// {
//   // 确认目标元素不在页面上任何地方
//   label: 'toBeHidden',
//   description: 'Check if an item is not in the page',
//   needAssertValue: false,
//   genAssertCode: (selector: string) => {
//     // .toBeVisible 是 async 方法
//     return `await expect(await page.${selector}).toBeHidden();`;
//   }
// },
{
  // 确认目标元素是可编辑的
  label: 'toBeEditable',
  description: 'Check if an item editable',
  needAssertValue: false,
  genAssertCode: (selector: string) => {
    return `await expect(await page.${selector}).toBeEditable();`;
  }
},
// {
//   // 确认目标元素是不可操作的
//   label: 'toBeDisabled',
//   description: 'Check if an item is disabled',
//   needAssertValue: false,
//   genAssertCode: (selector: string) => {
//     // .toBeVisible 是 async 方法
//     return `await expect(await page.${selector}).toBeDisabled();`;
//   }
// }
{
  // 确认目标元素已被勾选
  label: 'toBeChecked',
  description: 'Check if an item is checked',
  needAssertValue: false,
  genAssertCode: (selector: string) => {
    return `await expect(await page.${selector}).toBeChecked();`;
  }
},{
  // 确认目标元素未被勾选
  label: 'not.toBeChecked',
  description: 'Check if an item is not checked',
  needAssertValue: false,
  genAssertCode: (selector: string) => {
    return `await expect(await page.${selector}).not.toBeChecked();`;
  }
},{
  // 检查输入框中的值
  label: 'toCheckInputValue',
  description: 'Check if an input text',
  needAssertValue: true,
  needInputXpath: true,
  genAssertCode: (selector: string, assertValue?: string, xPath?: string) => {
    const assert_snippets =  `
    /** 断言输入框中的值开始 **/
    {
      let inputValue = await page.${selector}.inputValue();
      expect(inputValue?.trim()).toBe('${assertValue?.trim()}')
    }
    /** 断言输入框的值结束 **/
    `;
    return assert_snippets;
  },
},{
  // 截图对比
  label: 'toHaveScreenshot',
  description: 'produce and visually compare screenshots',
  assertValueTitle: 'toHaveScreenshot: please input snapshot name',
  needAssertValue: true,
  genAssertCode: (selector: string, assertValue?: string) => {
    return `
    // 注意: 第一次运行这段代码时，测试用例会报 A snapshot doesn't exist 的错误，但是不用担心，这是符合预期的, 
    // 此时文件夹下就会生成一个以你输入的文件名作为前缀命名的截图，后续每次运行，都会和这个预先生成的截图进行对比
    // 你可以进行第二次运行，此时只要图片没有差异，即可运行通过
    await expect(await page.${selector}).toHaveScreenshot('${assertValue}.png', {
      maxDiffPixelRatio: 0.01 // 最大差异像素点比率：可手动调整此处的值
    });
    `;
  }
}];


export class InspectAssertDialog {
  private _vscode: vscodeTypes.VSCode;
  private _editor?: vscodeTypes.TextEditor;

  constructor(vscode: vscodeTypes.VSCode, editor?: vscodeTypes.TextEditor) {
    this._vscode = vscode;
    this._editor = editor;
  }

  async selectPickType() {
    return this._vscode.window.showQuickPick(PICK_ITEMS, {
      title: `Please select assert type`,
      placeHolder: 'Select assert type',
    }).then(pickedItem => {
      return pickedItem;
    });
  }

  async updateOrCancelInspectAssert(selector: string) {
    let assertType: ExtendQuickPickItem | undefined;
    let assertValue = '';

    return this._vscode.window.showQuickPick(ASSERT_ITEMS, {
      title: `Please select an assert type for ${selector}`,
      placeHolder: 'Select an assert type',
    }).then(pickedItem => {
      assertType = pickedItem;
      console.log(assertType);
      if (assertType?.needAssertValue && assertType.label) {
        return this._vscode.window.showInputBox({
          title: assertType.assertValueTitle ||  `${assertType.label}: please input assert value for ${selector}`,
          value: assertType.assertDefaultValue,
          prompt: 'Please input something',
        });
      }
    }).then(inputValue => {
      assertValue = inputValue || '';
    }).then(async () => {
      if (assertType?.label && assertType.genAssertCode) {
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

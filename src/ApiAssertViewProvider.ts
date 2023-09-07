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

export class ApiAssertViewProvider implements vscodeTypes.WebviewViewProvider, vscodeTypes.Disposable {
  private _disposables: vscodeTypes.Disposable[];
  private _view?: vscodeTypes.WebviewView;
  private _vscode: vscodeTypes.VSCode;


  public static readonly viewType = 'apiAssert.apiAssertView';

  constructor(
    vscode: vscodeTypes.VSCode,
		private readonly _extensionUri: vscodeTypes.Uri,
  ) {
    this._vscode = vscode;
    this._disposables = [
      vscode.window.registerWebviewViewProvider(ApiAssertViewProvider.viewType, this),
    ];
  }
  dispose() {
    for (const d of this._disposables)
      d.dispose();
    this._disposables = [];
  }

  public resolveWebviewView(
    webviewView: vscodeTypes.WebviewView,
    context: vscodeTypes.WebviewViewResolveContext,
    _token: vscodeTypes.CancellationToken,
  ) {
    this._view = webviewView;
    const vscode = this._vscode;

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,

      localResourceRoots: [
        this._extensionUri
      ]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(data => {
      switch (data.type) {
        case 'apiTestInsert':
        {
          const method = data.method;
          const url = data.url;
          let params = {};
          try {
            // 将JSON字符串解析成对象
            params = JSON.parse(data.params);
          } catch (e) {
            vscode.window.showWarningMessage(`请输入合法的json参数传：报错详情${e}`);
            return;
          }
          const reqData = method === 'get' ? {
            params
          } : {
            data: params
          };

          const apiTest = `
/*** API 断言开始 ***/
{
  const response = await request.${method}('${url}',${JSON.stringify(reqData)}
  );
  // 断言请求结果返回状态是否为200
  expect(response.ok()).toBeTruthy();
  // resultBody为json后的返回内容，可resultBody.xx获取相应的字段值
  const resultBody = await response.json();
  $1
}
/*** API 断言结束 ***/
`;
          const snippet = new vscode.SnippetString(apiTest);

          vscode.window.activeTextEditor?.insertSnippet(snippet);
          break;
        }
      }
    });
  }


  private _getHtmlForWebview(webview: vscodeTypes.Webview) {
    const vscode = this._vscode;
    // Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js'));

    // Do the same for the stylesheet.
    const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
    const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
    const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css'));

    // Use a nonce to only allow a specific script to be run.
    const nonce = getNonce();

    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
					Use a content security policy to only allow loading styles from our extension directory,
					and only allow scripts that have a specific nonce.
					(See the 'webview-sample' extension sample for img-src content security policy examples)
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${styleResetUri}" rel="stylesheet">
				<link href="${styleVSCodeUri}" rel="stylesheet">
				<link href="${styleMainUri}" rel="stylesheet">

				<title>Api Test</title>
			</head>
			<body>
      <ul class="api-container">
        <li>
          <p>method:</p>
          <select id="method" class="api-select">
            <option value="get">get</option>
            <option value="post">post</option>
          </select>
        </li>
        <li>
          <p>url:<p>
          <input class="api-test-input" type="text" id="url">
        </li>
        <li>
          <p>params:</p>
          <textarea id="params" class="api-test-input"></textarea>
        </li>
				<button class="generate-api-button">Generate Api Test</button>
      </ul>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++)
    text += possible.charAt(Math.floor(Math.random() * possible.length));

  return text;
}
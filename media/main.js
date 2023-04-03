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
// @ts-check

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.
(function() {
  const vscode = acquireVsCodeApi();

  document.querySelector('.generate-api-button').addEventListener('click', () => {
    generateApiTest();
  });


  // const textarea = document.getElementById('params');

  // // @ts-ignore
  // textarea.addEventListener('input', e => {
  // // @ts-ignore
  //   // textarea.style.height = '100px';
  //   // @ts-ignore
  //   textarea.style.height = e.target.scrollHeight + 'px';
  // });


  function generateApiTest() {
    // @ts-ignore
    const method = document.getElementById('method').value;
    // @ts-ignore
    const url = document.getElementById('url').value;
    // @ts-ignore
    const params = document.getElementById('params').value;
    vscode.postMessage({ type: 'apiTestInsert', method: method,
      url: url,
      params: params, });
  }
})();



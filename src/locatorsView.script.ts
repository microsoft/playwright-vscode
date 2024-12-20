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

import { createAction, vscode } from './common';

// @ts-check
const locatorInput = document.getElementById('locator') as HTMLInputElement;
const ariaTextArea = document.getElementById('ariaSnapshot') as HTMLTextAreaElement;

locatorInput.addEventListener('input', () => {
  vscode.postMessage({ method: 'locatorChanged', params: { locator: locatorInput.value } });
});

ariaTextArea.addEventListener('input', () => {
  vscode.postMessage({ method: 'ariaSnapshotChanged', params: { ariaSnapshot: ariaTextArea.value } });
});

window.addEventListener('message', event => {
  const locatorError = document.getElementById('locatorError')!;
  const ariaSnapshotError = document.getElementById('ariaSnapshotError')!;
  const ariaSection = document.getElementById('ariaSection')!;
  const actionsElement = document.getElementById('actions')!;

  const { method, params } = event.data;
  if (method === 'update') {
    locatorInput.value = params.locator.locator;
    locatorError.textContent = params.locator.error || '';
    locatorError.style.display = params.locator.error ? 'inherit' : 'none';
    ariaTextArea.value = params.ariaSnapshot.yaml;
    ariaSnapshotError.textContent = params.ariaSnapshot.error || '';
    ariaSnapshotError.style.display = params.ariaSnapshot.error ? 'inherit' : 'none';
    ariaSection.style.display = params.hideAria ? 'none' : 'flex';
  } else if (method === 'actions') {
    actionsElement.textContent = '';
    for (const action of params.actions) {
      const actionElement = createAction(action, { omitText: true });
      if (actionElement)
        actionsElement.appendChild(actionElement);
    }
  }
});

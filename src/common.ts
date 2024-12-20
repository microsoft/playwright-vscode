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

declare global {
  function acquireVsCodeApi(): { postMessage(msg: any): void };
}

export const vscode = acquireVsCodeApi();

export interface Config {
  configFile: string;
}

export interface ProjectEntry {
  name: string;
  enabled: boolean;
}

export interface ActionDescriptor {
  command: string;
  text: string;
  svg: string;
  title?: string;
  location?: string;
  hidden?: boolean;
  disabled?: boolean;
}

export function createAction(action: ActionDescriptor, options?: { omitText?: boolean }): HTMLElement | null {
  const actionElement = document.createElement('div');
  actionElement.classList.add('action');
  if (action.hidden)
    return null;
  if (action.disabled)
    actionElement.setAttribute('disabled', 'true');
  const label = document.createElement('label');
  if (!action.disabled) {
    label.addEventListener('click', () => {
      vscode.postMessage({ method: 'execute', params: { command: label.getAttribute('command') } });
    });
  }
  label.setAttribute('role', 'button');
  label.setAttribute('command', action.command);
  const svg = /** @type {HTMLElement} */(document.createElement('svg'));
  label.appendChild(svg);
  svg.outerHTML = action.svg;
  if (!options?.omitText && action.text)
    label.appendChild(document.createTextNode(action.text));
  label.title = action.title || action.text;
  actionElement.appendChild(label);
  return actionElement;
}

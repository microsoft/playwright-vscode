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

import { Config, createAction, ProjectEntry, vscode } from './common';

let selectConfig: Config;

const selectAllButton = document.getElementById('selectAll') as HTMLAnchorElement;
const unselectAllButton = document.getElementById('unselectAll') as HTMLAnchorElement;

function updateProjects(projects: ProjectEntry[]) {
  const projectsElement = document.getElementById('projects') as HTMLElement;
  projectsElement.textContent = '';
  for (const project of projects) {
    const { name, enabled } = project;
    const div = document.createElement('div');
    div.classList.add('action');
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = enabled;
    input.addEventListener('change', () => {
      vscode.postMessage({ method: 'setProjectEnabled', params: { configFile: selectConfig.configFile, projectName: name, enabled: input.checked } });
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode(name || '<untitled>'));
    div.appendChild(label);
    projectsElement.appendChild(div);
  }

  const allEnabled = projects.every(p => p.enabled);
  selectAllButton.hidden = allEnabled;
  unselectAllButton.hidden = !allEnabled;
}

function setAllProjectsEnabled(enabled: boolean) {
  vscode.postMessage({ method: 'setAllProjectsEnabled', params: { configFile: selectConfig.configFile, enabled } });
}
selectAllButton.addEventListener('click', () => setAllProjectsEnabled(true));
unselectAllButton.addEventListener('click', () => setAllProjectsEnabled(false));

for (const input of Array.from(document.querySelectorAll('input[type=checkbox]'))) {
  input.addEventListener('change', event => {
    vscode.postMessage({ method: 'toggle', params: { setting: input.getAttribute('setting') } });
  });
}
for (const select of Array.from(document.querySelectorAll<HTMLSelectElement>('select[setting]'))) {
  select.addEventListener('change', event => {
    vscode.postMessage({ method: 'set', params: { setting: select.getAttribute('setting'), value: select.value } });
  });
}

window.addEventListener('message', event => {
  const actionsElement = document.getElementById('actions')!;
  const configToolbarElement = document.getElementById('configToolbar')!;
  const rareActionsElement = document.getElementById('rareActions')!;
  const modelSelector = document.getElementById('model-selector')!;

  const { method, params } = event.data;
  if (method === 'settings') {
    for (const [key, value] of Object.entries(params.settings as Record<string, string | boolean>)) {
      const input = document.querySelector('input[setting=' + key + ']') as HTMLInputElement;
      if (input) {
        if (typeof value === 'boolean')
          input.checked = value;
        else
          input.value = value;
      }
      const select = document.querySelector('select[setting=' + key + ']') as HTMLSelectElement;
      if (select)
        select.value = value as string;
    }
  } else if (method === 'actions') {
    actionsElement.textContent = '';
    configToolbarElement.textContent = '';
    rareActionsElement.textContent = '';
    for (const action of params.actions) {
      const actionElement = createAction(action);
      if (!actionElement)
        continue;
      if (action.location === 'configToolbar')
        configToolbarElement.appendChild(actionElement);
      else if (action.location === 'rareActions')
        rareActionsElement.appendChild(actionElement);
      else
        actionsElement.appendChild(actionElement);
    }
  } else if (method === 'models') {
    const { configs, showModelSelector } = params;
    const select = document.getElementById('models') as HTMLSelectElement;
    select.textContent = '';
    const configsMap = new Map();
    for (const config of configs) {
      configsMap.set(config.configFile, config);
      const option = document.createElement('option');
      option.value = config.configFile;
      option.textContent = config.label;
      select.appendChild(option);
      if (config.selected) {
        selectConfig = config;
        select.value = config.configFile;
        updateProjects(config.projects);
      }
    }
    select.addEventListener('change', event => {
      vscode.postMessage({ method: 'selectModel', params: { configFile: select.value } });
      updateProjects(configsMap.get(select.value).projects);
    });
    modelSelector.style.display = showModelSelector ? 'block' : 'none';
  }
});

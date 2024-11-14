/*
  Copyright (c) Microsoft Corporation.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

export function ansi2html(text: string, defaultColors?: { bg: string, fg: string }): string {
  const regex = /(\x1b\[(\d+(;\d+)*)m)|([^\x1b]+)/g;
  const tokens: string[] = [];
  let match;
  let style: any = {};

  let reverse = false;
  let fg: string | undefined = defaultColors?.fg;
  let bg: string | undefined = defaultColors?.bg;

  while ((match = regex.exec(text)) !== null) {
    const [, , codeStr, , text] = match;
    if (codeStr) {
      const code = +codeStr;
      switch (code) {
        case 0: style = {}; break;
        case 1: style['font-weight'] = 'bold'; break;
        case 2: style['opacity'] = '0.8'; break;
        case 3: style['font-style'] = 'italic'; break;
        case 4: style['text-decoration'] = 'underline'; break;
        case 7:
          reverse = true;
          break;
        case 8: style.display = 'none'; break;
        case 9: style['text-decoration'] = 'line-through'; break;
        case 22:
          delete style['font-weight'];
          delete style['font-style'];
          delete style['opacity'];
          delete style['text-decoration'];
          break;
        case 23:
          delete style['font-weight'];
          delete style['font-style'];
          delete style['opacity'];
          break;
        case 24:
          delete style['text-decoration'];
          break;
        case 27:
          reverse = false;
          break;
        case 30:
        case 31:
        case 32:
        case 33:
        case 34:
        case 35:
        case 36:
        case 37:
          fg = ansiColors[code - 30];
          break;
        case 39:
          fg = defaultColors?.fg;
          break;
        case 40:
        case 41:
        case 42:
        case 43:
        case 44:
        case 45:
        case 46:
        case 47:
          bg = ansiColors[code - 40];
          break;
        case 49:
          bg = defaultColors?.bg;
          break;
        case 53: style['text-decoration'] = 'overline'; break;
        case 90:
        case 91:
        case 92:
        case 93:
        case 94:
        case 95:
        case 96:
        case 97:
          fg = brightAnsiColors[code - 90];
          break;
        case 100:
        case 101:
        case 102:
        case 103:
        case 104:
        case 105:
        case 106:
        case 107:
          bg = brightAnsiColors[code - 100];
          break;
      }
    } else if (text) {
      let token = escapeHTML(text);
      const isBold = style['font-weight'] === 'bold';
      if (isBold)
        token = `<b>${token}</b>`;
      const isItalic = style['font-style'] === 'italic';
      if (isItalic)
        token = `<i>${token}</i>`;
      const hasOpacity = style['opacity'] === '0.8';
      if (hasOpacity)
        token = `<span style='color:#666;'>${token}</span>`;
      const color = reverse ? (bg || '#000') : fg;
      if (color)
        token = `<span style='color:${color};'>${token}</span>`;
      const backgroundColor = reverse ? fg : bg;
      if (backgroundColor)
        token = `<span style='background-color:${backgroundColor};'>${token}</span>`;
      tokens.push(token);
    }
  }
  return tokens.join('');
}

const ansiColors: Record<number, string> = {
  0: '#000',
  1: '#f14c4c',
  2: '#73c991',
  3: '#ffcc66',
  4: '#44a8f2',
  5: '#b084eb',
  6: '#afdab6',
  7: '#fff',
};

const brightAnsiColors: Record<number, string> = {
  0: '#808080',
  1: '#f14c4c',
  2: '#73c991',
  3: '#ffcc66',
  4: '#44a8f2',
  5: '#b084eb',
  6: '#afdab6',
  7: '#fff',
};

function escapeHTML(text: string): string {
  return text.replace(/[&"<> \n]/g, c => ({
    ' ': '&nbsp;',
    '\n': '\n<br>\n',
    '&': '&amp;',
    '"': '&quot;',
    '<': '&lt;',
    '>': '&gt;'
  }[c]!));
}

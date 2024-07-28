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
const { createConnection } = require('net');
const vscode = require('vscode');

function run() {
  const port = parseInt(process.env.PW_VSCODE_TEST_PORT, 10);
  console.log(`listening port ${port}`);
  return new Promise((resolve, reject) => {
    const client = createConnection(port, '0.0.0.0', () => {
      console.log('Connected');
    });
    let lastObjectId = 0;
    const objectsById = new Map([[0, vscode]]);
    const idByObjects = new Map([[vscode, 0]]);

    function fromParam(param) {
      if (['string', 'number', 'boolean', 'null', 'undefined'].includes(typeof param))
        return param;
      if (param.__vscodeHandle)
        return objectsById.get(param.objectId);
      if (Array.isArray(param))
        return param.map(fromParam);
      return Object.fromEntries(Object.entries(param).map(([k, v]) => [k, fromParam(v)]));
    }

    client.on('data', async data => {
      const { op, objectId, id, returnHandle, fn, params } = JSON.parse(data.toString());
      if (op === 'release') {
        const obj = objectsById.get(objectId);
        if (obj !== undefined) {
          objectsById.delete(objectId);
          idByObjects.delete(obj);
        }
        return;
      }

      if (!fn)
        return;
      let result;
      let error;
      try {
        const context = !objectId ? vscode : objectsById.get(objectId);
        if (!context)
          throw new Error(`No object with ID ${objectId} found`);
        const func = new Function(`return ${fn}`)();
        result = await func(context, ...fromParam(params));
        if (returnHandle) {
          let objectId = idByObjects.get(result);
          if (objectId === undefined) {
            objectId = ++lastObjectId;
            objectsById.set(objectId, result);
            idByObjects.set(result, objectId);
          }
          result = objectId;
        }
      } catch (e) {
        error = {
          message: e.message ?? e.toString(),
          stack: e.stack
        };
      }
      client.write(JSON.stringify({ id, result, error }));
    });
    client.on('error', reject);
    client.on('close', resolve);
  });
}

exports.run = run;

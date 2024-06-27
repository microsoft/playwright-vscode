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

const fs = require('fs');
const path = require('path');

const baseFilePath = path.join(__dirname, '..', 'package.nls.json');
const localizationFiles = [
  'package.nls.de.json',
  'package.nls.fr.json',
  'package.nls.zh-CN.json'
];

function verifyLocalizationConsistency() {
  const baseContent = JSON.parse(fs.readFileSync(baseFilePath, 'utf8'));
  let hasDiscrepancies = false;

  for (const localizationFile of localizationFiles) {
    const localizationFilePath = path.join(__dirname, '..', localizationFile);
    const localizationContent = JSON.parse(fs.readFileSync(localizationFilePath, 'utf8'));

    const missingKeys = Object.keys(baseContent).filter(key => !(key in localizationContent));
    const extraKeys = Object.keys(localizationContent).filter(key => !(key in baseContent));

    if (missingKeys.length > 0) {
      console.log(`Missing keys in ${localizationFile}: ${missingKeys.join(', ')}`);
      hasDiscrepancies = true;
    }

    if (extraKeys.length > 0) {
      console.log(`Extra keys in ${localizationFile}: ${extraKeys.join(', ')}`);
      hasDiscrepancies = true;
    }
  }

  if (hasDiscrepancies) {
    console.error('Localization files have discrepancies. Please fix them before proceeding.');
    process.exit(1);
  } else {
    console.log('All localization files are consistent.');
  }
}

verifyLocalizationConsistency();

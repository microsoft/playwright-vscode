const path = require('path');

/**@type {import('eslint').Linter.Config} */
// eslint-disable-next-line no-undef
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: [
    '@typescript-eslint',
    'notice',
  ],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  rules: {
    'semi': [2, 'always'],
    'quotes': [2, 'single'],
    '@typescript-eslint/no-unused-vars': 0,
    '@typescript-eslint/no-explicit-any': 0,
    '@typescript-eslint/explicit-module-boundary-types': 0,
    '@typescript-eslint/no-non-null-assertion': 0,
    // copyright
    'notice/notice': [2, {
      'mustMatch': 'Copyright',
      'templateFile': path.join(__dirname, 'utils', 'copyright.js'),
    }],
    'indent': ['error', 2],
  },
  'overrides': [
    {
      'files': '**/*.js',
      rules: {
        '@typescript-eslint/no-var-requires': 'off',
        'no-undef': 'off',
      }
    }
  ]
};
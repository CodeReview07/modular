'use strict';

// eslint-disable-next-line  no-unused-vars
const ERROR = 'error';
const WARN = 'warn';
const OFF = 'off';

module.exports = {
  extends: ['modular-app'],
  rules: {
    strict: [WARN, 'global'],
  },
  overrides: [
    {
      files: 'packages/modular-scripts/types/**/*',
      rules: {
        'react/jsx-pascal-case': OFF,
      },
    },
    {
      // if we want to use js in this repo, then they have
      // to be explitly marked as modules
      files: '**/*.js',
      parserOptions: {
        sourceType: 'script',
      },
    },
  ],
};

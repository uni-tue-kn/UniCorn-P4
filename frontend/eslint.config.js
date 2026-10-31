import js from '@eslint/js';
import globals from 'globals';
import hooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser, __APP_VERSION__: 'readonly' }, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { 'react-hooks': hooks },
    rules: { ...js.configs.recommended.rules, 'no-unused-vars': 'off', 'no-constant-binary-expression': 'off', 'react-hooks/rules-of-hooks': 'error' },
  },
];

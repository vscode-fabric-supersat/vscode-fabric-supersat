import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', '.vscode-test/**', '.vscode-test-web/**'] },
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/naming-convention': [
        'warn',
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
      ],
      curly: 'warn',
      eqeqeq: 'warn',
      'no-throw-literal': 'warn',
    },
  },
);

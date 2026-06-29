import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Flat config. Deliberately lenient — this is a maturity guardrail, not a style
// crusade: TypeScript already catches the important things, so we lint for unused
// code and obvious mistakes and leave formatting to Prettier.
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**', '*.config.ts', '*.config.js', '_*.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-undef': 'off', // TypeScript resolves globals/types; this rule double-flags them
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Tests use casts/mocks freely; keep them quiet.
    files: ['test/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);

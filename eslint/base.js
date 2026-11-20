// @ts-check
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import tseslint from 'typescript-eslint';

/**
 * Type-aware rules shared by every workspace.
 * Consumers must set `languageOptions.parserOptions.tsconfigRootDir` to their own directory.
 */
export default defineConfig([
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    '**/.turbo/**',
    '**/.next/**',
    '**/.expo/**',
    '**/android/**',
    '**/ios/**',
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true },
    },
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The performance benches (ADR-008 §7) are for scripts, benches, dev screens and tests,
    // never for shipped code. library.js and packages that set their own
    // no-restricted-imports repeat the restriction, since a later block replaces this one.
    files: ['**/*.{ts,tsx}'],
    ignores: ['**/src/dev/**', '**/scripts/**', '**/src/bench/**', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@codetta/annotations/bench',
              message: 'The bench is for scripts and dev screens only (ADR-008 §7).',
            },
            {
              name: '@codetta/annotations/bench/pdf',
              message: 'The export bench builds a 121 MB book: dev screens only (ADR-014).',
            },
          ],
        },
      ],
    },
  },
  prettier,
]);

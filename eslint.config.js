// @ts-check
import { defineConfig } from 'eslint/config';

import library from './eslint/library.js';

/** Imports that shipped code (src/, outside tests) must not use. */
const shippedImportPatterns = [
  { group: ['node:*'], message: 'Shipped code must not use Node APIs.' },
  {
    group: ['react', 'react-*', 'react-native', 'react-native-*', '@react-native/*'],
    message: 'Domain code must stay framework-free: no React, React Native, Expo or Next.js.',
  },
  {
    group: ['next', 'next/*', 'expo', 'expo-*', '@expo/*'],
    message: 'Domain code must stay framework-free: no React, React Native, Expo or Next.js.',
  },
  {
    // src/bench/** imports its own files as ./cases and ./live, which this misses.
    group: ['**/bench', '**/bench/*', '@codetta/annotations/bench'],
    message: 'The benches are for scripts and dev screens only (ADR-008 §7).',
  },
];

/**
 * perfect-freehand is a devDependency: it must never reach the app bundle (ADR-008 §4, §7). It
 * lives in src/bench/naive.ts, which only perf-report imports, so nothing else in src/ may
 * import that module either.
 */
const devDependencyPatterns = [
  {
    group: ['perfect-freehand'],
    message:
      'perfect-freehand is a devDependency: only tests and src/bench/naive.ts (perf-report) may use it.',
  },
  {
    group: ['**/naive', '**/naive.*'],
    message: 'src/bench/naive.ts uses a devDependency: only perf-report and tests may import it.',
  },
];

/**
 * pdf-lib and pako are for the annotated-PDF export only (ADR-014): the reader and the web get
 * `@codetta/annotations` without them, and only what imports `@codetta/annotations/pdf` pays for them.
 */
const pdfExportPatterns = [
  {
    group: ['pdf-lib', 'pako', '**/pdf', '**/pdf/*'],
    message: 'The annotated-PDF export lives in src/pdf (`@codetta/annotations/pdf`, ADR-014).',
  },
];

export default defineConfig([
  library,
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  {
    // Shipped code runs in Hermes (JS and UI runtimes) and in the browser: no Node APIs. The
    // test helpers in src/test count too: the bench (and so the app, via dev-perf) uses them.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-globals': ['error', 'Buffer', 'process', 'require', 'global'],
      'no-restricted-imports': [
        'error',
        { patterns: [...shippedImportPatterns, ...devDependencyPatterns, ...pdfExportPatterns] },
      ],
    },
  },
  {
    // The export itself, and the bench that measures it (ADR-014).
    files: ['src/pdf/**/*.ts', 'src/bench/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/bench/naive.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...shippedImportPatterns, ...devDependencyPatterns] },
      ],
    },
  },
  {
    // The perfect-freehand comparison, imported only by perf-report (not exported by
    // `@codetta/annotations/bench`, so the app never bundles it).
    files: ['src/bench/naive.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: shippedImportPatterns }],
    },
  },
]);

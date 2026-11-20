// @ts-check
import { defineConfig } from 'eslint/config';

import base from './base.js';

/**
 * The `no-restricted-imports` patterns of every domain package. Exported so a package that
 * adds its own patterns (a later block replaces this one) can repeat these.
 */
export const libraryImportPatterns = [
  {
    group: ['react', 'react-*', 'react-native', 'react-native-*', '@react-native/*'],
    message: 'Domain code must stay framework-free: no React, React Native, Expo or Next.js.',
  },
  {
    group: ['next', 'next/*', 'expo', 'expo-*', '@expo/*'],
    message: 'Domain code must stay framework-free: no React, React Native, Expo or Next.js.',
  },
  {
    group: ['@codetta/annotations/bench'],
    message: 'The benches are for scripts and dev screens only (ADR-008 §7).',
  },
];

/** Pure domain code: no UI frameworks allowed. */
export default defineConfig([
  base,
  {
    rules: {
      'no-restricted-imports': ['error', { patterns: libraryImportPatterns }],
    },
  },
  {
    // Scripts, the benches themselves and tests may use the benches (as in base.js).
    files: ['**/scripts/**', '**/src/bench/**', '**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: libraryImportPatterns.filter(
            (pattern) => !pattern.group.includes('@codetta/annotations/bench'),
          ),
        },
      ],
    },
  },
]);

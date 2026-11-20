import { defineConfig } from 'vitest/config';

/** `pnpm size-report` and `pnpm perf-report` (ADR-008): measurements, not part of `pnpm test`. */
export default defineConfig({
  test: {
    include: ['scripts/*-report.ts'],
    testTimeout: 120_000,
    // The reports print their tables.
    silent: false,
    reporters: ['verbose'],
  },
});

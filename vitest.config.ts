import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Own module cache next to the package, so that two Vitest runs never share one.
    fsModuleCachePath: fileURLToPath(new URL('node_modules/.vitest-cache', import.meta.url)),
    include: ['src/**/*.test.ts'],
  },
});

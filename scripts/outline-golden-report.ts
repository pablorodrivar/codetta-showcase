/// <reference types="node" />
/**
 * `pnpm outline-golden`: writes `src/smoothing/outline.golden.json`,
 * the fingerprints of the outline that `outline-golden.test.ts` checks. Only when the outline is
 * meant to change (ADR-008 §7).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { it } from 'vitest';

import { outlineFingerprints } from '../src/test/outline-fingerprints';

it('writes the outline fingerprints', () => {
  const file = join(import.meta.dirname, '..', 'src', 'smoothing', 'outline.golden.json');
  writeFileSync(file, `${JSON.stringify(outlineFingerprints(), null, 2)}\n`);
  console.log(`Wrote ${file}`);
}, 120_000);

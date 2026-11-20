import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FINGERPRINT_LENGTHS, outlineFingerprints } from '../test/outline-fingerprints';

/**
 * The outline gives the very same numbers as before a change of how the builder stores its
 * points (ADR-008 §7): live and prepared, with strokes of 1, 2, 100, 2,000 and 10,000 points.
 * `outline.golden.json` was written by the builder before that change. Regenerate it
 * (`pnpm outline-golden`) only when the outline is meant to change,
 * and say why in the PR.
 */
describe('outline fingerprints', () => {
  it('match the outline of before, bit for bit', () => {
    const golden = JSON.parse(
      readFileSync(join(import.meta.dirname, 'outline.golden.json'), 'utf8'),
    ) as unknown;
    const actual = outlineFingerprints();
    expect(Object.keys(actual)).toHaveLength(FINGERPRINT_LENGTHS.length * 5);
    expect(actual).toEqual(golden);
  }, 60_000);
});

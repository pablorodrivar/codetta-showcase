import { describe, expect, it } from 'vitest';

import { encodeAnnotationData } from '../schema/rows';
import { busyPageStrokes } from '../test/synthetic-strokes';
import { PreparedCache, preparePage } from './prepare-page';

const SCORE = '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0c';
const LAYER = '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0d';
const OWNER = '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0e';

let nextId = 0;

/** A stored row as the local SQLite holds it, with `data` encoded. */
function newAnnotationRow(input: {
  readonly z: number;
  readonly annotation: Parameters<typeof encodeAnnotationData>[0];
}) {
  return {
    id: `019a7a2e-1c2d-7e3f-8a4b-${String(++nextId).padStart(12, '0')}`,
    owner_id: OWNER,
    score_id: SCORE,
    layer_id: LAYER,
    page_index: 0,
    type: input.annotation.type,
    data: encodeAnnotationData(input.annotation),
    z: input.z,
    created_at: '2026-11-10T00:00:00.000Z',
    updated_at: '2026-11-10T00:00:00.000Z',
    deleted_at: null,
  };
}

/** A clock that advances 1 ms per reading, so every phase has a known duration. */
function ticking() {
  let time = 0;
  return () => time++;
}

describe('preparePage', () => {
  const rows = busyPageStrokes(4).map((points, z) =>
    newAnnotationRow({
      z,
      annotation: {
        type: 'stroke',
        data: { v: 1, ink: 'red', width: 0.003, input: 'pen', points },
      },
    }),
  );

  it('reads, outlines and hit-tests every row, and times each phase', () => {
    const page = preparePage(rows, 1.414, { now: ticking() });
    expect(page.items).toHaveLength(4);
    for (const item of page.items) {
      expect(item.outline?.length).toBeGreaterThan(8);
      expect(item.hit.annotation).toBe(item.annotation);
    }
    expect(page.timings).toEqual({ read: 1, outlines: 1, hitTargets: 1, total: 3 });
  });

  it('reads JSON text rows like the local SQLite returns them', () => {
    const page = preparePage(
      rows.map((row) => JSON.stringify(row)),
      1.414,
      { now: ticking() },
    );
    expect(page.items).toHaveLength(4);
  });

  it('sorts by z and gives text and shapes no outline', () => {
    const text = newAnnotationRow({
      z: -1,
      annotation: {
        type: 'text',
        data: { v: 1, text: 'rit.', x: 0.2, y: 0.2, fontSize: 0.02, ink: 'blue' },
      },
    });
    const page = preparePage([...rows, text], 1.414, { now: ticking() });
    expect(page.items[0]?.annotation.type).toBe('text');
    expect(page.items[0]?.outline).toBeNull();
  });

  it('counts unsupported and invalid rows and draws the rest', () => {
    const page = preparePage(
      [rows[0], { ...rows[1], type: 'link' }, { ...rows[2], data: { v: 1 } }, 'null'],
      1.414,
      { now: ticking() },
    );
    expect(page.items).toHaveLength(1);
    expect(page.unsupported).toBe(1);
    expect(page.invalid).toHaveLength(2);
  });

  it('leaves out a corrupt text row and reports it, without breaking the page', () => {
    const text = rows.map((row) => JSON.stringify(row));
    const page = preparePage([text[0], '{"id": "019a7a2e', text[1], ''], 1.414, {
      now: ticking(),
      cache: new PreparedCache(),
    });
    expect(page.items).toHaveLength(2);
    expect(page.invalid).toEqual([
      { id: null, issues: ['row: not JSON'] },
      { id: null, issues: ['row: not JSON'] },
    ]);
  });

  it('reuses prepared rows until they change', () => {
    const cache = new PreparedCache();
    const first = preparePage(rows, 1.414, { now: ticking(), cache });
    expect(first.cached).toBe(0);
    const changed = rows.map((row, index) =>
      index === 0 ? { ...row, updated_at: '2026-11-11T00:00:00.000Z' } : row,
    );
    const second = preparePage(changed, 1.414, { now: ticking(), cache });
    expect(second.cached).toBe(3);
    expect(second.items[1]).toBe(first.items[1]);
    // Another aspect is another geometry.
    expect(preparePage(rows, 1, { now: ticking(), cache }).cached).toBe(0);
    cache.retain(new Set());
    expect(cache.size).toBe(0);
  });

  it('uses the measured text box when the renderer gives one', () => {
    const text = newAnnotationRow({
      z: 0,
      annotation: {
        type: 'text',
        data: { v: 1, text: 'cresc.', x: 0.1, y: 0.1, fontSize: 0.02, ink: 'red' },
      },
    });
    const page = preparePage([text], 1, {
      now: ticking(),
      hitTest: { measureText: () => ({ width: 0.5, height: 0.04 }) },
    });
    expect(page.items[0]?.hit.box).toEqual([0.1, 0.1, 0.6, 0.14]);
  });
});

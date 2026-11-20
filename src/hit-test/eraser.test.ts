import { describe, expect, it } from 'vitest';

import { toPointBuffer } from '../points';
import type { Annotation } from '../schema/rows';
import { STAMP_BASE_SIZE } from '../stamps/catalog';
import { longStroke } from '../test/synthetic-strokes';
import {
  addFreehandHitPoints,
  createFreehandHit,
  erasableOn,
  eraseHits,
  eraserTouches,
  finishFreehandHit,
  hitTarget,
  segmentDistance2,
} from './eraser';

const ASPECT = 297 / 210;
let nextId = 0;

function row(type: Annotation['type'], data: unknown, layer = 'layer-a'): Annotation {
  nextId++;
  return {
    id: `00000000-0000-7000-8000-${String(nextId).padStart(12, '0')}`,
    owner_id: 'owner',
    score_id: 'score',
    layer_id: layer,
    page_index: 0,
    type,
    data,
    z: 0,
    created_at: '2026-11-10T00:00:00Z',
    updated_at: '2026-11-10T00:00:00Z',
    deleted_at: null,
  } as Annotation;
}

function stroke(points: [number, number][], width = 0.002): Annotation {
  return row('stroke', {
    v: 1,
    ink: 'red',
    width,
    input: 'pen',
    points: toPointBuffer(points.map(([x, y], index) => [x, y, 0.5, index * 4])),
  });
}

function hits(annotation: Annotation, from: [number, number], to: [number, number], radius = 0.01) {
  return eraseHits([hitTarget(annotation, ASPECT)], from, to, radius, ASPECT).length > 0;
}

describe('freehand hit target in parts', () => {
  it('is the same as hitTarget whatever the parts', () => {
    const annotation = row('stroke', {
      v: 1,
      ink: 'red',
      width: 0.003,
      input: 'pen',
      points: longStroke(1000),
    }) as Extract<Annotation, { type: 'stroke' }>;
    const whole = hitTarget(annotation, ASPECT);
    for (const size of [1, 13, 256, 5000]) {
      const builder = createFreehandHit();
      for (let from = 0; from < 1000; from += size) {
        addFreehandHitPoints(builder, annotation.data.points, from, from + size, ASPECT);
      }
      expect(finishFreehandHit(builder, annotation)).toEqual(whole);
    }
  });
});

describe('segmentDistance2', () => {
  it.each([
    // crossing
    [[0, 0, 2, 2, 0, 2, 2, 0], 0],
    // parallel, 1 apart
    [[0, 0, 2, 0, 0, 1, 2, 1], 1],
    // collinear and overlapping
    [[0, 0, 2, 0, 1, 0, 3, 0], 0],
    // collinear with a gap of 1
    [[0, 0, 1, 0, 2, 0, 3, 0], 1],
    // T: endpoint 0.5 from the other segment
    [[1, 0.5, 1, 3, 0, 0, 2, 0], 0.25],
    // degenerate segments (points)
    [[0, 0, 0, 0, 3, 4, 3, 4], 25],
  ] as const)('%j → %s', (coordinates, expected) => {
    const [ax, ay, bx, by, cx, cy, dx, dy] = coordinates;
    expect(segmentDistance2(ax, ay, bx, by, cx, cy, dx, dy)).toBeCloseTo(expected, 12);
  });
});

describe('eraser on freehand annotations', () => {
  const line = stroke([
    [0.2, 0.5],
    [0.4, 0.5],
    [0.6, 0.5],
  ]);

  it('erases a stroke the eraser touches', () => {
    expect(hits(line, [0.3, 0.505], [0.3, 0.505])).toBe(true);
  });

  it('misses a stroke out of reach', () => {
    // 0.05 of the height below, radius 0.01 width units: far away.
    expect(hits(line, [0.3, 0.55], [0.35, 0.55])).toBe(false);
  });

  it('reaches the visible edge of a heavy pen stroke', () => {
    // Pen thinning 0.6: at full pressure the drawn half width is 0.8 × width.
    const heavy = stroke(
      [
        [0.2, 0.5],
        [0.6, 0.5],
      ],
      0.02,
    );
    const y = 0.5 + (0.015 + 0.0005) / ASPECT; // 0.0155 from the centre line, radius 0.0001
    expect(hits(heavy, [0.4, y], [0.4, y], 0.0001)).toBe(true);
    const beyond = 0.5 + 0.0165 / ASPECT;
    expect(hits(heavy, [0.4, beyond], [0.4, beyond], 0.0001)).toBe(false);
  });

  it('counts the stroke width', () => {
    const thick = stroke(
      [
        [0.2, 0.5],
        [0.6, 0.5],
      ],
      0.02,
    );
    const thin = stroke(
      [
        [0.2, 0.5],
        [0.6, 0.5],
      ],
      0.0002,
    );
    // 0.015 width units away, eraser radius 0.01: reaches the thick stroke's edge only.
    const y = 0.5 + 0.015 / ASPECT;
    expect(hits(thick, [0.4, y], [0.4, y])).toBe(true);
    expect(hits(thin, [0.4, y], [0.4, y])).toBe(false);
  });

  it('catches a stroke crossed between two events (fast swipe)', () => {
    // The previous and current positions are both far from the line, on opposite sides.
    expect(hits(line, [0.4, 0.3], [0.4, 0.7])).toBe(true);
  });

  it('measures in width units, not normalized ones', () => {
    // On a tall page, 0.009 of the height is 0.0127 width units: out of a 0.01 radius
    // (plus half a 0.002 stroke). In normalized units it would look close enough.
    const y = 0.5 + 0.009;
    expect(hits(line, [0.3, y], [0.3, y])).toBe(false);
    expect(hits(line, [0.3, 0.5 + 0.007], [0.3, 0.5 + 0.007])).toBe(true);
  });

  it('erases a single-point stroke (a dot)', () => {
    const dot = stroke([[0.5, 0.5]]);
    expect(hits(dot, [0.505, 0.5], [0.505, 0.5])).toBe(true);
    expect(hits(dot, [0.53, 0.5], [0.53, 0.5])).toBe(false);
  });

  it('works for the highlighter too', () => {
    const highlight = row('highlight', {
      v: 1,
      ink: 'yellow',
      width: 0.02,
      input: 'pen',
      points: toPointBuffer([
        [0.1, 0.1, 0.5, 0],
        [0.3, 0.1, 0.5, 40],
      ]),
    });
    expect(hits(highlight, [0.2, 0.1], [0.2, 0.1])).toBe(true);
  });
});

describe('eraser on shapes', () => {
  const style = { v: 1, ink: 'blue', width: 0.002 };

  it('follows the curve of a slur, not its chord', () => {
    const slur = row('shape', {
      ...style,
      kind: 'slur',
      from: [0.2, 0.5],
      to: [0.6, 0.5],
      bulge: 0.25,
    });
    // Apex: 0.1 width units above the chord's middle.
    const apexY = 0.5 - 0.1 / ASPECT;
    expect(hits(slur, [0.4, apexY], [0.4, apexY], 0.005)).toBe(true);
    expect(hits(slur, [0.4, 0.5], [0.4, 0.5], 0.005)).toBe(false);
    // Negative bulge: below.
    const below = row('shape', {
      ...style,
      kind: 'slur',
      from: [0.2, 0.5],
      to: [0.6, 0.5],
      bulge: -0.25,
    });
    expect(hits(below, [0.4, 0.5 + 0.1 / ASPECT], [0.4, 0.5 + 0.1 / ASPECT], 0.005)).toBe(true);
  });

  it('hits both lines of a hairpin but not its inside', () => {
    const hairpin = row('shape', {
      ...style,
      kind: 'hairpin',
      apex: [0.2, 0.5],
      end: [0.6, 0.5],
      opening: 0.04,
    });
    const upper = 0.5 - 0.02 / ASPECT;
    const lower = 0.5 + 0.02 / ASPECT;
    expect(hits(hairpin, [0.6, upper], [0.6, upper], 0.003)).toBe(true);
    expect(hits(hairpin, [0.6, lower], [0.6, lower], 0.003)).toBe(true);
    expect(hits(hairpin, [0.55, 0.5], [0.55, 0.5], 0.003)).toBe(false);
  });

  it('hits the border of a rectangle but not its inside', () => {
    const rect = row('shape', { ...style, kind: 'rect', x: 0.2, y: 0.2, w: 0.4, h: 0.2 });
    expect(hits(rect, [0.2, 0.3], [0.2, 0.3], 0.003)).toBe(true);
    expect(hits(rect, [0.4, 0.4], [0.4, 0.4], 0.003)).toBe(true);
    expect(hits(rect, [0.4, 0.3], [0.4, 0.3], 0.003)).toBe(false);
  });

  it('hits a line', () => {
    const line = row('shape', { ...style, kind: 'line', from: [0.1, 0.1], to: [0.9, 0.9] });
    expect(hits(line, [0.5, 0.5], [0.5, 0.5], 0.003)).toBe(true);
    expect(hits(line, [0.5, 0.6], [0.5, 0.6], 0.003)).toBe(false);
  });
});

describe('eraser on text and stamps', () => {
  it('hits anywhere in a stamp box', () => {
    const stamp = row('stamp', {
      v: 1,
      kind: 'smufl',
      glyph: 'dynamicForte',
      x: 0.5,
      y: 0.5,
      scale: 2,
      ink: 'graphite',
    });
    const half = STAMP_BASE_SIZE; // scale 2: side 2 · base, half side = base
    expect(hits(stamp, [0.5, 0.5], [0.5, 0.5], 0.001)).toBe(true);
    expect(hits(stamp, [0.5 + half * 0.9, 0.5], [0.5 + half * 0.9, 0.5], 0.001)).toBe(true);
    expect(hits(stamp, [0.5 + half + 0.005, 0.5], [0.5 + half + 0.005, 0.5], 0.001)).toBe(false);
    // A swipe across the box with both ends outside.
    expect(hits(stamp, [0.4, 0.5], [0.6, 0.5], 0.001)).toBe(true);
  });

  it('estimates the text box from its characters and lines', () => {
    const text = row('text', {
      v: 1,
      text: 'dolce\ncresc. poco a poco',
      x: 0.2,
      y: 0.2,
      fontSize: 0.02,
      ink: 'red',
    });
    const target = hitTarget(text, ASPECT);
    const [x0, y0, x1, y1] = target.bounds;
    expect(x0).toBe(0.2);
    expect(y0).toBeCloseTo(0.2 * ASPECT, 12);
    expect(x1 - x0).toBeCloseTo(18 * 0.02 * 0.6, 12);
    expect(y1 - y0).toBeCloseTo(2 * 0.02 * 1.3, 12);
    // Inside the second line.
    expect(hits(text, [0.3, 0.2 + 0.03 / ASPECT], [0.3, 0.2 + 0.03 / ASPECT], 0.001)).toBe(true);
  });

  it('wraps estimated text at its maximum width', () => {
    const text = row('text', {
      v: 1,
      text: 'x'.repeat(50),
      x: 0,
      y: 0,
      fontSize: 0.02,
      ink: 'red',
      maxWidth: 0.2,
    });
    const [x0, y0, x1, y1] = hitTarget(text, ASPECT).bounds;
    expect(x1 - x0).toBeCloseTo(0.2, 12);
    // 50 × 0.012 = 0.6 wide → 3 lines of 0.2.
    expect(y1 - y0).toBeCloseTo(3 * 0.026, 12);
  });

  it('uses the measured size when the renderer gives it', () => {
    const text = row('text', { v: 1, text: 'ff', x: 0.5, y: 0.5, fontSize: 0.02, ink: 'red' });
    const target = hitTarget(text, ASPECT, { measureText: () => ({ width: 0.3, height: 0.1 }) });
    expect(target.bounds[2] - target.bounds[0]).toBeCloseTo(0.3, 12);
  });
});

describe('eraseHits', () => {
  it('returns every touched annotation in order and respects the filter', () => {
    const a = stroke([
      [0.1, 0.5],
      [0.9, 0.5],
    ]);
    const b = row(
      'shape',
      { v: 1, ink: 'blue', width: 0.002, kind: 'line', from: [0.5, 0.1], to: [0.5, 0.9] },
      'layer-locked',
    );
    const c = stroke([
      [0.1, 0.1],
      [0.2, 0.1],
    ]);
    const targets = [a, b, c].map((annotation) => hitTarget(annotation, ASPECT));
    expect(eraseHits(targets, [0.5, 0.5], [0.5, 0.5], 0.01, ASPECT)).toEqual([a.id, b.id]);
    const filter = erasableOn([
      { id: 'layer-a', visible: true, locked: false, deleted_at: null },
      { id: 'layer-locked', visible: true, locked: true, deleted_at: null },
    ]);
    expect(eraseHits(targets, [0.5, 0.5], [0.5, 0.5], 0.01, ASPECT, filter)).toEqual([a.id]);
  });

  it('skips hidden and deleted layers and deleted annotations', () => {
    const filter = erasableOn([
      { id: 'hidden', visible: false, locked: false, deleted_at: null },
      { id: 'gone', visible: true, locked: false, deleted_at: '2026-11-10T00:00:00Z' },
      { id: 'open', visible: true, locked: false, deleted_at: null },
    ]);
    expect(filter({ ...stroke([[0, 0]]), layer_id: 'hidden' })).toBe(false);
    expect(filter({ ...stroke([[0, 0]]), layer_id: 'gone' })).toBe(false);
    expect(filter({ ...stroke([[0, 0]]), layer_id: 'open' })).toBe(true);
    expect(filter({ ...stroke([[0, 0]]), layer_id: 'open', deleted_at: 'x' })).toBe(false);
    expect(filter({ ...stroke([[0, 0]]), layer_id: 'unknown' })).toBe(false);
  });

  it('rejects by bounding box before testing segments', () => {
    const far = hitTarget(
      stroke([
        [0.8, 0.8],
        [0.9, 0.9],
      ]),
      ASPECT,
    );
    expect(eraserTouches(far, 0, 0, 0.1, 0.1, 0.01)).toBe(false);
  });
});

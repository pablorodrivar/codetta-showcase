import { describe, expect, it } from 'vitest';

import { applyToPoint } from '../geometry/matrix';
import { OUTLINE_SCALE } from '../geometry/page-frame';
import { STAMP_EM_PER_BOX, TEXT_BASELINE, TEXT_LINE_HEIGHT } from '../geometry/text-and-stamps';
import { preparePage } from '../page/prepare-page';
import { toPointBuffer } from '../points';
import type { encodeAnnotationData } from '../schema/rows';
import { SMUFL_GLYPH_NAMES, STAMP_BASE_SIZE, stampSymbolDrawing } from '../stamps/catalog';
import { SMUFL_OUTLINES, SMUFL_UNITS_PER_EM } from '../stamps/generated/smufl-outlines';
import { storedRow } from '../test/stored-row';
import { annotationInks, highlighterInks, highlighterOpacity } from '../tokens';
import {
  countPaintOps,
  highlightGroups,
  type PaintOp,
  paintPage,
  parsePdfPath,
  PATH_CLOSE,
  PATH_CUBIC,
  PATH_LINE,
  PATH_MOVE,
  smuflGlyphPath,
} from './paint-page';

type Data = Parameters<typeof encodeAnnotationData>[0];

const ASPECT = 297 / 210;

function paint(annotations: readonly Data[], aspect = ASPECT): PaintOp[] {
  const rows = annotations.map((annotation, z) => storedRow(z, annotation));
  const { items, invalid } = preparePage(rows, aspect, { now: () => 0 });
  expect(invalid).toEqual([]);
  return paintPage(items, aspect);
}

const points = (from: [number, number], to: [number, number]) =>
  toPointBuffer(
    Array.from({ length: 21 }, (_, index) => [
      from[0] + ((to[0] - from[0]) * index) / 20,
      from[1] + ((to[1] - from[1]) * index) / 20,
      0.5,
      index * 8,
    ]),
  );

const pen = (ink: 'red' | 'blue', y: number): Data => ({
  type: 'stroke',
  data: { v: 1, ink, width: 0.004, input: 'mouse', points: points([0.2, y], [0.6, y]) },
});

const marker = (ink: 'yellow' | 'pink', y: number): Data => ({
  type: 'highlight',
  data: { v: 1, ink, width: 0.02, input: 'mouse', points: points([0.1, y], [0.7, y]) },
});

/** Centre of a polygon's bounding box. */
function centre(polygon: readonly number[]): [number, number] {
  const xs = polygon.filter((_, index) => index % 2 === 0);
  const ys = polygon.filter((_, index) => index % 2 === 1);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

describe('paintPage', () => {
  it('paints nothing for an empty page', () => {
    expect(paintPage([], ASPECT)).toEqual([]);
  });

  it('puts the highlighters first, one group per ink, then the ink in the order given', () => {
    const ops = paint([
      pen('red', 0.1),
      marker('yellow', 0.2),
      marker('pink', 0.3),
      pen('blue', 0.4),
      marker('yellow', 0.5),
    ]);
    expect(ops.map((op) => op.kind)).toEqual(['group', 'group', 'fill', 'fill']);
    const [yellow, pink, red, blue] = ops;
    // Both yellow strokes in one group, painted opaque and composited once.
    expect(yellow).toMatchObject({ kind: 'group', opacity: highlighterOpacity });
    expect(
      yellow?.kind === 'group' && yellow.ops.map((op) => op.kind === 'fill' && op.color),
    ).toEqual([highlighterInks.yellow, highlighterInks.yellow]);
    expect(pink?.kind === 'group' && pink.ops.length).toBe(1);
    expect(red).toMatchObject({ kind: 'fill', color: annotationInks.red });
    expect(blue).toMatchObject({ kind: 'fill', color: annotationInks.blue });
    expect(countPaintOps(ops)).toBe(7);
  });

  it('fills a stroke with its prepared outline, in outline units', () => {
    const [op] = paint([pen('red', 0.5)]);
    if (op?.kind !== 'fill') throw new Error('not a fill');
    const [x, y] = centre(op.polygon);
    expect(x).toBeCloseTo(0.4 * OUTLINE_SCALE, 0);
    expect(y).toBeCloseTo(0.5 * ASPECT * OUTLINE_SCALE, 0);
  });

  it('strokes a shape along its centre line, with its width', () => {
    const [op] = paint([
      {
        type: 'shape',
        data: { v: 1, kind: 'line', from: [0.1, 0.2], to: [0.5, 0.2], ink: 'green', width: 0.003 },
      },
    ]);
    expect(op).toEqual({
      kind: 'stroke',
      color: annotationInks.green,
      width: 3,
      polylines: [[100, 0.2 * ASPECT * 1000, 500, 0.2 * ASPECT * 1000]],
      closed: false,
    });
  });

  it('writes each text line on its baseline, keeping the gap of an empty line', () => {
    const [op] = paint([
      {
        type: 'text',
        data: { v: 1, text: 'Allegro\n\nrit.', x: 0.1, y: 0.2, fontSize: 0.02, ink: 'graphite' },
      },
    ]);
    const size = 0.02 * OUTLINE_SCALE;
    const top = 0.2 * ASPECT * OUTLINE_SCALE;
    expect(op).toMatchObject({ kind: 'text', color: annotationInks.graphite, size, x: 100 });
    if (op?.kind !== 'text') throw new Error('not text');
    expect(op.lines.map((line) => line.text)).toEqual(['Allegro', 'rit.']);
    expect(op.lines[0]?.baseline).toBeCloseTo(top + size * TEXT_BASELINE);
    expect(op.lines[1]?.baseline).toBeCloseTo(top + size * (TEXT_BASELINE + 2 * TEXT_LINE_HEIGHT));
  });

  it('centres a SMuFL stamp’s ink box on its point, at its size', () => {
    const [op] = paint([
      {
        type: 'stamp',
        data: { v: 1, kind: 'smufl', glyph: 'dynamicForte', x: 0.3, y: 0.6, scale: 2, ink: 'blue' },
      },
    ]);
    if (op?.kind !== 'glyph') throw new Error('not a glyph');
    expect(op.color).toBe(annotationInks.blue);
    expect(op.path).toBe(smuflGlyphPath('dynamicForte'));
    const [x0, y0, x1, y1] = SMUFL_OUTLINES.dynamicForte.box;
    const [cx, cy] = applyToPoint(op.matrix, (x0 + x1) / 2, (y0 + y1) / 2);
    expect(cx).toBeCloseTo(0.3 * OUTLINE_SCALE);
    expect(cy).toBeCloseTo(0.6 * ASPECT * OUTLINE_SCALE);
    // One em is STAMP_EM_PER_BOX stamp boxes; font units are y up.
    const em = STAMP_BASE_SIZE * 2 * STAMP_EM_PER_BOX * OUTLINE_SCALE;
    expect(op.matrix[0]).toBeCloseTo(em / SMUFL_UNITS_PER_EM);
    expect(op.matrix[3]).toBeCloseTo(-em / SMUFL_UNITS_PER_EM);
  });

  it('strokes a symbol stamp around its point', () => {
    const [op] = paint([
      {
        type: 'stamp',
        data: { v: 1, kind: 'symbol', symbol: 'glasses', x: 0.5, y: 0.5, scale: 1, ink: 'red' },
      },
    ]);
    if (op?.kind !== 'stroke') throw new Error('not a stroke');
    const unit = STAMP_BASE_SIZE * OUTLINE_SCALE;
    expect(op.width).toBeCloseTo(stampSymbolDrawing('glasses').strokeWidth * unit);
    const all = op.polylines.flat();
    const [x, y] = centre(all);
    expect(x).toBeCloseTo(0.5 * OUTLINE_SCALE, 0);
    expect(Math.abs(y - 0.5 * ASPECT * OUTLINE_SCALE)).toBeLessThan(unit / 2);
  });
});

describe('highlightGroups', () => {
  it('groups the highlighters by ink, in the order each ink first appears, leaving the ink out', () => {
    const rows = [
      marker('yellow', 0.2),
      pen('red', 0.25),
      marker('pink', 0.3),
      marker('yellow', 0.4),
    ].map((annotation, z) => storedRow(z, annotation));
    const { items } = preparePage(rows, ASPECT, { now: () => 0 });
    const groups = highlightGroups(items);
    expect(groups.map((group) => [group.color, group.items.length])).toEqual([
      [highlighterInks.yellow, 2],
      [highlighterInks.pink, 1],
    ]);
    // The second yellow (z 3) goes under the pink (z 2): the yellow group came first.
    expect(groups[0]?.items.map((item) => item.annotation.z)).toEqual([0, 3]);
  });
});

describe('parsePdfPath', () => {
  it('reads move, line, cubic and close', () => {
    expect(parsePdfPath('1 2 m 3 4 l 5 6 7 8 9 10 c h')).toEqual([
      PATH_MOVE,
      1,
      2,
      PATH_LINE,
      3,
      4,
      PATH_CUBIC,
      5,
      6,
      7,
      8,
      9,
      10,
      PATH_CLOSE,
    ]);
  });

  it('rejects what it does not know', () => {
    expect(() => parsePdfPath('1 2 re')).toThrow();
    expect(() => parsePdfPath('1 m')).toThrow();
    expect(() => parsePdfPath('1 2 m 3')).toThrow();
  });

  it('reads every Bravura outline, starting with a move', () => {
    for (const glyph of SMUFL_GLYPH_NAMES) {
      const path = smuflGlyphPath(glyph);
      expect(path[0], glyph).toBe(PATH_MOVE);
      expect(path.length, glyph).toBeGreaterThan(6);
    }
  });
});

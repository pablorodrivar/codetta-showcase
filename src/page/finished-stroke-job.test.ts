import { describe, expect, it } from 'vitest';

import { hitTarget } from '../hit-test/eraser';
import { POINT_STRIDE } from '../points';
import { encodeAnnotationData, parseAnnotationRow } from '../schema/rows';
import { outlineParts, outlinePolygon, takeCommittedChunks } from '../smoothing/outline';
import {
  addSample,
  createStrokeCapture,
  finishStroke,
  finishStrokeParts,
  freehandOutline,
  type FreehandStyle,
  type StrokeCapture,
} from '../smoothing/stroke';
import { firstDifference } from '../test/compare';
import { longStroke } from '../test/synthetic-strokes';
import { FinishedStrokeJob, type FreehandAnnotation } from './finished-stroke-job';
import { pageFromCache } from './page-job';
import { PreparedCache } from './prepare-page';

const ASPECT = 1.414;
const ONE_STEP = { outOfTime: () => true };
const NO_LIMIT = { outOfTime: () => false };

/** Draws `points` as the reader does: a sample per event, the committed pieces taken each time. */
function draw(style: FreehandStyle, points: Float32Array): StrokeCapture {
  const capture = createStrokeCapture(style, ASPECT);
  for (let offset = 0; offset + POINT_STRIDE <= points.length; offset += POINT_STRIDE) {
    addSample(
      capture,
      points[offset] ?? 0,
      points[offset + 1] ?? 0,
      points[offset + 2] ?? 0,
      points[offset + 3] ?? 0,
    );
    takeCommittedChunks(capture.builder);
  }
  return capture;
}

function annotationOf(
  style: FreehandStyle,
  points: Float32Array,
  ink: 'red' | 'yellow',
): FreehandAnnotation {
  const parsed = parseAnnotationRow({
    id: '019a7a2e-1c2d-7e3f-8a4b-000000000001',
    owner_id: '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0e',
    score_id: '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0c',
    layer_id: '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0d',
    page_index: 0,
    type: style.type,
    data: JSON.stringify(
      encodeAnnotationData({
        type: style.type,
        data: { v: 1, ink, width: style.width, input: style.input, points },
      } as Parameters<typeof encodeAnnotationData>[0]),
    ),
    z: 0,
    created_at: '2026-11-27T00:00:00.000Z',
    updated_at: '2026-11-27T00:00:00.000Z',
    deleted_at: null,
  });
  if (parsed.status !== 'ok') throw new Error('invalid row');
  return parsed.annotation as FreehandAnnotation;
}

const PEN: FreehandStyle = { type: 'stroke', input: 'pen', width: 0.003 };

const STYLES: readonly (readonly [string, FreehandStyle, 'red' | 'yellow'])[] = [
  ['pen with a stylus', { type: 'stroke', input: 'pen', width: 0.003 }, 'red'],
  ['pen with a finger', { type: 'stroke', input: 'touch', width: 0.003 }, 'red'],
  ['highlighter', { type: 'highlight', input: 'touch', width: 0.012 }, 'yellow'],
];

describe('finishStrokeParts', () => {
  it.each(STYLES)('gives the parts and the tail of the live outline (%s)', (_name, style) => {
    const capture = draw(style, longStroke(2000));
    const finished = finishStrokeParts(capture);
    const before = finishStroke(capture);
    if (!finished || !before) throw new Error('no points');
    expect(Array.from(finished.points)).toEqual(Array.from(before.points));
    // The live path closed with the tail is the outline: committed pieces taken + tail.
    expect(finished.tail.length).toBeGreaterThan(0);
    expect(finished.tail.length).toBeLessThan(before.outline.length);
  });

  it('has nothing to give without points', () => {
    expect(finishStrokeParts(createStrokeCapture(PEN, ASPECT))).toBeNull();
  });
});

describe('FinishedStrokeJob', () => {
  it.each(STYLES)(
    'makes the entry of the live outline, bit for bit, without outlining again (%s)',
    (_name, style, ink) => {
      const capture = draw(style, longStroke(2000));
      const finished = finishStrokeParts(capture);
      if (!finished) throw new Error('no points');
      const annotation = annotationOf(style, finished.points, ink);
      const cache = new PreparedCache();
      const job = new FinishedStrokeJob(annotation, finished.parts, ASPECT, { cache });
      expect(job.run(NO_LIMIT)).toBe(true);
      const item = job.entry?.item;
      expect(
        firstDifference(item?.outline ?? [], outlinePolygon(outlineParts(capture.builder, true))),
      ).toBeUndefined();
      expect(
        firstDifference(item?.outline ?? [], freehandOutline(style, finished.points, ASPECT)),
      ).toBeUndefined();
      expect(item?.hit).toEqual(hitTarget(annotation, ASPECT));
      expect(
        pageFromCache([{ id: annotation.id, updated_at: annotation.updated_at }], ASPECT, cache)
          .missing,
      ).toEqual([]);
    },
  );

  it('goes a few points at a time, and gives the same with any step', () => {
    const style = PEN;
    const capture = draw(style, longStroke(3000));
    const finished = finishStrokeParts(capture);
    if (!finished) throw new Error('no points');
    const annotation = annotationOf(style, finished.points, 'red');
    const whole = new FinishedStrokeJob(annotation, finished.parts, ASPECT, {
      cache: new PreparedCache(),
    });
    whole.run(NO_LIMIT);
    for (const stepPoints of [1, 7, 64, 256, 100_000]) {
      const job = new FinishedStrokeJob(annotation, finished.parts, ASPECT, {
        cache: new PreparedCache(),
        stepPoints,
      });
      let steps = 0;
      while (!job.run(ONE_STEP)) steps++;
      expect(
        firstDifference(job.entry?.item.outline ?? [], whole.entry?.item.outline ?? []),
      ).toBeUndefined();
      // Never the whole stroke in one step, unless the step is that long.
      if (stepPoints < 3000) expect(steps).toBeGreaterThan(3000 / stepPoints);
    }
  });

  it.each([1, 2, 3])(
    'handles the short strokes of %i points (the dot and the special cases)',
    (count) => {
      const style = PEN;
      const points = new Float32Array(count * POINT_STRIDE);
      for (let index = 0; index < count; index++) {
        points[index * POINT_STRIDE] = 0.3 + index * 0.01;
        points[index * POINT_STRIDE + 1] = 0.4;
        points[index * POINT_STRIDE + 2] = 0.5;
        points[index * POINT_STRIDE + 3] = index * 10;
      }
      const capture = draw(style, points);
      const finished = finishStrokeParts(capture);
      if (!finished) throw new Error('no points');
      const job = new FinishedStrokeJob(
        annotationOf(style, finished.points, 'red'),
        finished.parts,
        ASPECT,
        { cache: new PreparedCache(), stepPoints: 1 },
      );
      while (!job.run(ONE_STEP));
      expect(
        firstDifference(
          job.entry?.item.outline ?? [],
          freehandOutline(style, finished.points, ASPECT),
        ),
      ).toBeUndefined();
    },
  );
});

import { getStroke, type StrokeOptions } from 'perfect-freehand';
import { describe, expect, it } from 'vitest';

import { OUTLINE_SCALE } from '../geometry/page-frame';
import { POINT_STRIDE, toPointBuffer } from '../points';
import { firstDifference } from '../test/compare';
import { longStroke, seededRandom, syntheticStrokes } from '../test/synthetic-strokes';
import {
  addInputPoint,
  continueOutlinePolygon,
  createOutlineBuilder,
  type OutlineOptions,
  outlineParts,
  outlinePolygon,
  startOutlinePolygon,
  tailPolygon,
  takeCommittedChunks,
} from './outline';
import {
  addSample,
  capturedPoints,
  createStrokeCapture,
  freehandOutline,
  type FreehandStyle,
  MIN_SAMPLE_DISTANCE,
  outlineOptions,
} from './stroke';

const PEN: OutlineOptions = {
  size: 3,
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.35,
  simulatePressure: false,
  taperStart: 0,
  taperEnd: 0,
  capStart: true,
  capEnd: true,
};

/** The same options in perfect-freehand's shape. */
function freehandOptions(options: OutlineOptions, last: boolean): StrokeOptions {
  return {
    size: options.size,
    thinning: options.thinning,
    smoothing: options.smoothing,
    streamline: options.streamline,
    simulatePressure: options.simulatePressure,
    start: { cap: options.capStart, taper: options.taperStart },
    end: { cap: options.capEnd, taper: options.taperEnd },
    last,
  };
}

type Input = [x: number, y: number, pressure: number][];

function build(options: OutlineOptions, input: Input) {
  const builder = createOutlineBuilder(options);
  for (const [x, y, p] of input) addInputPoint(builder, x, y, p);
  return builder;
}

function ours(options: OutlineOptions, input: Input, complete: boolean): number[] {
  return outlinePolygon(outlineParts(build(options, input), complete));
}

function reference(options: OutlineOptions, input: Input, complete: boolean): number[] {
  return getStroke(input, freehandOptions(options, complete)).flat();
}

function expectSamePolygon(actual: number[], expected: number[]): void {
  expect(actual.length).toBe(expected.length);
  // One expect for the whole polygon: one per coordinate dominated the time of the tests on
  // long strokes. Every coordinate is still compared; `!(difference < 1e-9)` also catches NaN.
  const differs = (value: number, index: number) =>
    !(Math.abs(value - (expected[index] ?? Number.NaN)) < 1e-9);
  const first = actual.findIndex(differs);
  if (first < 0) return;
  const count = actual.filter(differs).length;
  const got = actual[first] ?? Number.NaN;
  const want = expected[first] ?? Number.NaN;
  expect.fail(
    `point ${String(first >> 1)} ${first % 2 === 0 ? 'x' : 'y'}: ${String(got)} vs ` +
      `${String(want)} (difference ${String(Math.abs(got - want))}); ` +
      `${String(count)} of ${String(actual.length)} coordinates differ`,
  );
}

/** Synthetic strokes in outline units on an A4 page. */
function inputs(seed: number): Input[] {
  const aspect = 297 / 210;
  return syntheticStrokes(seed).map((stroke) =>
    stroke.points.map(([x, y, p]): [number, number, number] => [
      x * OUTLINE_SCALE,
      y * aspect * OUTLINE_SCALE,
      p,
    ]),
  );
}

/** Winding number of a closed polygon around a point. */
function winding(polygon: readonly number[], px: number, py: number): number {
  let count = 0;
  const points = polygon.length / 2;
  for (let index = 0; index < points; index++) {
    const x0 = polygon[index * 2] ?? 0;
    const y0 = polygon[index * 2 + 1] ?? 0;
    const x1 = polygon[((index + 1) % points) * 2] ?? 0;
    const y1 = polygon[((index + 1) % points) * 2 + 1] ?? 0;
    const cross = (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0);
    if (y0 <= py) {
      if (y1 > py && cross > 0) count++;
    } else if (y1 <= py && cross < 0) {
      count--;
    }
  }
  return count;
}

const VARIANTS: [string, OutlineOptions][] = [
  ['pen', PEN],
  ['simulated pressure', { ...PEN, thinning: 0.35, streamline: 0.5, simulatePressure: true }],
  ['highlighter', { ...PEN, thinning: 0, capStart: false, capEnd: false }],
  ['tapered', { ...PEN, taperStart: 12, taperEnd: 20 }],
  ['negative thinning, big', { ...PEN, size: 16, thinning: -0.4, smoothing: 0.2, streamline: 0.8 }],
];

describe('outline matches perfect-freehand', () => {
  it.each(VARIANTS)('%s, finished and while drawing', (_name, options) => {
    for (const input of inputs(3)) {
      expectSamePolygon(ours(options, input, true), reference(options, input, true));
      expectSamePolygon(ours(options, input, false), reference(options, input, false));
    }
  });

  it.each(VARIANTS)('%s, at every prefix of a stroke', (_name, options) => {
    const input =
      inputs(5)
        .find((stroke) => stroke.length > 150)
        ?.slice(0, 150) ?? [];
    const builder = createOutlineBuilder(options);
    for (let count = 1; count <= input.length; count++) {
      const [x, y, p] = input[count - 1] ?? [0, 0, 0];
      addInputPoint(builder, x, y, p);
      const prefix = input.slice(0, count);
      expectSamePolygon(
        outlinePolygon(outlineParts(builder, false)),
        reference(options, prefix, false),
      );
      expectSamePolygon(
        outlinePolygon(outlineParts(builder, true)),
        reference(options, prefix, true),
      );
    }
  });

  it('handles the special cases: one point, two, repeats, a missing pressure, sharp corners', () => {
    const cases: Input[] = [
      [[10, 10, 0.5]],
      [
        [10, 10, 0.5],
        [40, 12, 0.7],
      ],
      [
        [10, 10, 0.5],
        [10, 10, 0.5],
        [10, 10, 0.5],
      ],
      Array.from({ length: 30 }, (_, index): [number, number, number] => [
        10,
        10,
        0.2 + index / 60,
      ]),
      [
        [0, 0, -1],
        [50, 0, -1],
        [100, 0, -1],
        [150, 0, -1],
      ],
      // Back and forth: sharp corners on every turn.
      Array.from({ length: 60 }, (_, index): [number, number, number] => [
        (index % 10 < 5 ? index % 5 : 5 - (index % 5)) * 20,
        index * 2,
        0.5,
      ]),
      // Many points within the end-noise distance.
      Array.from({ length: 40 }, (_, index): [number, number, number] => [index * 0.1, 0, 0.5]),
    ];
    for (const input of cases) {
      for (const [, options] of VARIANTS) {
        expectSamePolygon(ours(options, input, true), reference(options, input, true));
        expectSamePolygon(ours(options, input, false), reference(options, input, false));
      }
    }
  });

  it('returns nothing for no input or no size', () => {
    expect(ours(PEN, [], true)).toEqual([]);
    expect(ours({ ...PEN, size: 0 }, [[1, 1, 0.5]], true)).toEqual([]);
  });

  it('stays exact on long random strokes', () => {
    const random = seededRandom(23);
    for (let round = 0; round < 10; round++) {
      let x = 500;
      let y = 700;
      const input: Input = Array.from({ length: 400 }, () => {
        x += (random() - 0.5) * 12;
        y += (random() - 0.5) * 12;
        return [x, y, random()];
      });
      expectSamePolygon(ours(PEN, input, true), reference(PEN, input, true));
    }
  });
});

describe('outline polygon in parts', () => {
  it('assembles the same polygon whatever the size of the parts', () => {
    const points = longStroke(1200);
    const input: Input = [];
    for (let offset = 0; offset < points.length; offset += POINT_STRIDE) {
      input.push([
        (points[offset] ?? 0) * OUTLINE_SCALE,
        (points[offset + 1] ?? 0) * OUTLINE_SCALE,
        points[offset + 2] ?? 0,
      ]);
    }
    for (const complete of [true, false]) {
      const parts = outlineParts(build(PEN, input), complete);
      const whole = outlinePolygon(parts);
      for (const size of [1, 7, 64, 1000, 100_000]) {
        const assembly = startOutlinePolygon(parts);
        let steps = 1;
        while (!continueOutlinePolygon(assembly, size)) steps++;
        expect(assembly.polygon).toEqual(whole);
        // Each step reverses at most `size` points of the right side; one more joins them.
        const right = (parts.tailRight.length + parts.committedRight.length) / 2;
        expect(steps).toBe(Math.ceil(right / size) + 1);
      }
    }
  });

  it('assembles tiny strokes too', () => {
    for (const input of [
      [[10, 10, 0.5]],
      [
        [10, 10, 0.5],
        [12, 11, 0.5],
      ],
    ] as Input[]) {
      const parts = outlineParts(build(PEN, input), true);
      const assembly = startOutlinePolygon(parts);
      let steps = 1;
      while (!continueOutlinePolygon(assembly, 1)) steps++;
      const right = (parts.tailRight.length + parts.committedRight.length) / 2;
      expect(steps).toBe(parts.dot ? 1 : right + 1);
      expect(assembly.polygon).toEqual(outlinePolygon(parts));
      expect(assembly.polygon?.length).toBeGreaterThan(0);
    }
  });
});

describe('incremental cost', () => {
  it('walks a bounded number of points per new input point', () => {
    const points = longStroke(4000);
    const builder = createOutlineBuilder(PEN);
    let worst = 0;
    for (let offset = 0; offset < points.length; offset += POINT_STRIDE) {
      addInputPoint(
        builder,
        (points[offset] ?? 0) * OUTLINE_SCALE,
        (points[offset + 1] ?? 0) * OUTLINE_SCALE,
        points[offset + 2] ?? 0,
      );
      const before = builder.work;
      outlineParts(builder, false);
      const work = builder.work - before;
      if (offset / POINT_STRIDE > 50) worst = Math.max(worst, work);
    }
    // A full recompute would walk up to 4,000 points per update. The tail is the points
    // within the end-noise distance (3 units) plus two: 15 on this stroke at 240 Hz.
    expect(worst).toBeLessThanOrEqual(24);
    expect(builder.committed).toBeGreaterThan(3900);
  });

  it('commits a resting pen once it moves on', () => {
    const builder = createOutlineBuilder(PEN);
    // 200 samples barely moving (a resting pen, after the capture's distance filter would
    // have dropped most), then a normal line.
    for (let index = 0; index < 200; index++) addInputPoint(builder, 100 + index * 0.26, 100, 0.5);
    for (let index = 0; index < 200; index++) addInputPoint(builder, 152 + index * 2, 100, 0.5);
    const before = builder.work;
    outlineParts(builder, false);
    expect(builder.work - before).toBeLessThanOrEqual(12);
  });
});

describe('live drawing pieces', () => {
  it('add up to the whole outline (nonzero winding)', () => {
    for (const input of inputs(7)) {
      const builder = createOutlineBuilder(PEN);
      const chunks: number[][] = [];
      let tail: number[] = [];
      input.forEach(([x, y, p], index) => {
        addInputPoint(builder, x, y, p);
        // Like the UI thread: take new pieces most frames, not all.
        if (index % 3 !== 1) chunks.push(...takeCommittedChunks(builder));
        tail = tailPolygon(builder, false);
      });
      const whole = outlinePolygon(outlineParts(builder, false));
      const random = seededRandom(input.length);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let index = 0; index < whole.length; index += 2) {
        minX = Math.min(minX, whole[index] ?? 0);
        maxX = Math.max(maxX, whole[index] ?? 0);
        minY = Math.min(minY, whole[index + 1] ?? 0);
        maxY = Math.max(maxY, whole[index + 1] ?? 0);
      }
      // One check per stroke, not one expect per sample (2,100 of them): the first sample that
      // differs, and how many do.
      const pieces = [...chunks, tail];
      const samples: [number, number][] = [];
      const fromPieces: number[] = [];
      const fromWhole: number[] = [];
      for (let sample = 0; sample < 300; sample++) {
        const px = minX + random() * (maxX - minX);
        const py = minY + random() * (maxY - minY);
        samples.push([px, py]);
        fromPieces.push(pieces.reduce((sum, piece) => sum + winding(piece, px, py), 0));
        fromWhole.push(winding(whole, px, py));
      }
      const wrong = fromPieces.findIndex((value, index) => value !== fromWhole[index]);
      expect(
        firstDifference(fromPieces, fromWhole),
        `winding at random points, stroke of ${String(input.length)} points` +
          (wrong < 0 ? '' : `; first wrong sample at (${String(samples[wrong])})`),
      ).toBeUndefined();
    }
  });

  it('hands out nothing twice', () => {
    const builder = createOutlineBuilder(PEN);
    for (const [x, y, p] of inputs(9)[0] ?? []) addInputPoint(builder, x, y, p);
    expect(takeCommittedChunks(builder).length).toBeLessThanOrEqual(1);
    expect(takeCommittedChunks(builder)).toEqual([]);
  });
});

describe('stroke capture', () => {
  const aspect = 297 / 210;
  const style: FreehandStyle = { type: 'stroke', input: 'pen', width: 0.003 };

  it('draws the same outline live and from the stored points', () => {
    for (const stroke of syntheticStrokes(13)) {
      const capture = createStrokeCapture({ ...style, input: stroke.input }, aspect);
      for (const [x, y, p, t] of stroke.points) addSample(capture, x, y, p, 1_000_000 + t);
      const live = outlinePolygon(outlineParts(capture.builder, true));
      const stored = freehandOutline(
        { ...style, input: stroke.input },
        capturedPoints(capture),
        aspect,
      );
      expect(firstDifference(stored, live), stroke.name).toBeUndefined();
    }
  });

  it('snaps samples to the grid, clamps them and keeps time monotonic', () => {
    const capture = createStrokeCapture(style, aspect);
    addSample(capture, -0.2, 0.5, 2, 500);
    addSample(capture, 0.5, 1.4, 0.5, 520);
    addSample(capture, 0.6, 0.6, 0.5, 510); // clock jitter
    const points = capturedPoints(capture);
    expect(points[0]).toBe(0);
    expect(points[2]).toBe(1);
    expect(points[3]).toBe(0);
    expect(points[5]).toBe(1);
    expect(points[7]).toBe(20);
    expect(points[11]).toBe(20);
    expect(points).toEqual(
      toPointBuffer(
        [...Array(3).keys()].map((index) => [...points.slice(index * 4, index * 4 + 4)]),
      ),
    );
  });

  it('drops samples closer than the minimum distance', () => {
    const capture = createStrokeCapture(style, aspect);
    const step = (MIN_SAMPLE_DISTANCE / 2 / OUTLINE_SCALE) * 0.9;
    expect(addSample(capture, 0.5, 0.5, 0.5, 0)).toBe('added');
    expect(addSample(capture, 0.5 + step, 0.5, 0.5, 4)).toBe('skipped');
    expect(addSample(capture, 0.5 + step * 8, 0.5, 0.5, 8)).toBe('added');
    expect(capture.points.length / POINT_STRIDE).toBe(2);
  });

  it('survives NaN samples from the platform', () => {
    const capture = createStrokeCapture(style, aspect);
    addSample(capture, 0.1, 0.1, 0.5, 100);
    addSample(capture, Number.NaN, 0.3, Number.NaN, Number.NaN);
    addSample(capture, 0.3, 0.3, 0.5, 120);
    const points = capturedPoints(capture);
    expect(points.every(Number.isFinite)).toBe(true);
    // Time never goes back, even after a NaN timestamp.
    expect(points[7]).toBe(0);
    expect(points[11]).toBe(20);
  });

  it('ignores pressure for finger and mouse', () => {
    const capture = createStrokeCapture({ ...style, input: 'touch' }, aspect);
    addSample(capture, 0.1, 0.1, 0.9, 0);
    addSample(capture, 0.2, 0.1, 0.1, 8);
    expect(capture.points[2]).toBe(capture.points[6]);
    expect(capture.points[2]).toBeCloseTo(0.5, 2);
  });

  it('reports full at the point limit', () => {
    const capture = createStrokeCapture(style, aspect);
    let result = 'added';
    let index = 0;
    while (result !== 'full') {
      result = addSample(capture, (index % 1000) / 1000, Math.floor(index / 1000) / 20, 0.5, index);
      index++;
    }
    expect(capture.points.length / POINT_STRIDE).toBe(10_000);
  });
});

describe('outlineOptions', () => {
  it('maps the presets', () => {
    expect(outlineOptions({ type: 'stroke', input: 'pen', width: 0.002 })).toMatchObject({
      size: 2,
      simulatePressure: false,
      capStart: true,
      capEnd: true,
    });
    expect(outlineOptions({ type: 'stroke', input: 'mouse', width: 0.002 }).simulatePressure).toBe(
      true,
    );
    expect(outlineOptions({ type: 'highlight', input: 'pen', width: 0.01 })).toMatchObject({
      thinning: 0,
      capStart: false,
      capEnd: false,
    });
  });

  it('gives cut ends a flat cap', () => {
    expect(
      outlineOptions({ type: 'stroke', input: 'pen', width: 0.002, taperStart: false }),
    ).toMatchObject({ capStart: false, capEnd: true });
  });
});

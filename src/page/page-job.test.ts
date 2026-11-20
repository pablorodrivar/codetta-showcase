import { describe, expect, it } from 'vitest';

import { encodeAnnotationData, parseAnnotationRow } from '../schema/rows';
import { addSample, createStrokeCapture, finishStroke } from '../smoothing/stroke';
import { firstDifference } from '../test/compare';
import { busyPageStrokes, longStroke } from '../test/synthetic-strokes';
import { CHUNK_RESERVE_MS, pageFromCache, PageJob, POINTS_PER_STEP } from './page-job';
import { PreparedCache, preparedFinishedStroke, preparePage } from './prepare-page';

const SCORE = '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0c';
const LAYER = '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0d';
const OWNER = '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0e';
const ASPECT = 1.414;

let nextId = 0;

/** A stored row as the local SQLite holds it: `data` as JSON text. */
function row(z: number, annotation: Parameters<typeof encodeAnnotationData>[0]) {
  return {
    id: `019a7a2e-1c2d-7e3f-8a4b-${String(++nextId).padStart(12, '0')}`,
    owner_id: OWNER,
    score_id: SCORE,
    layer_id: LAYER,
    page_index: 0,
    type: annotation.type,
    data: JSON.stringify(encodeAnnotationData(annotation)),
    z,
    created_at: '2026-11-10T00:00:00.000Z',
    updated_at: '2026-11-10T00:00:00.000Z',
    deleted_at: null,
  };
}

/** A budget that is always spent: the job takes exactly one step per call. */
const ONE_STEP = { outOfTime: () => true };
const NO_LIMIT = { outOfTime: () => false };

const strokes = busyPageStrokes(5).map((points, z) =>
  row(z, { type: 'stroke', data: { v: 1, ink: 'red', width: 0.003, input: 'pen', points } }),
);
const highlight = row(10, {
  type: 'highlight',
  data: { v: 1, ink: 'yellow', width: 0.01, input: 'touch', points: longStroke(600) },
});
const text = row(11, {
  type: 'text',
  data: { v: 1, text: 'dolce', x: 0.2, y: 0.3, fontSize: 0.02, ink: 'blue' },
});
const rows = [...strokes, highlight, text];

describe('PageJob', () => {
  it('prepares the same annotations as preparePage, one step at a time', () => {
    const cache = new PreparedCache();
    const job = new PageJob(rows, ASPECT, { cache });
    let calls = 0;
    while (!job.run(ONE_STEP)) calls++;
    expect(calls).toBeGreaterThan(rows.length);
    expect(job.prepared).toBe(rows.length);

    const expected = preparePage(rows, ASPECT, { now: () => 0 }).items;
    const { items, missing } = pageFromCache(rows, ASPECT, cache);
    expect(missing).toEqual([]);
    expect(items.map((item) => item.annotation.id)).toEqual(
      expected.map((item) => item.annotation.id),
    );
    items.forEach((item, index) => {
      const reference = expected[index];
      expect(item.annotation).toEqual(reference?.annotation);
      expect(firstDifference(item.outline ?? [], reference?.outline ?? [])).toBeUndefined();
      expect(item.hit.box).toEqual(reference?.hit.box);
    });
  });

  it('cuts a long stroke into steps of a few hundred points', () => {
    const long = row(0, {
      type: 'stroke',
      data: { v: 1, ink: 'red', width: 0.003, input: 'pen', points: longStroke(10_000) },
    });
    const job = new PageJob([long], ASPECT, { cache: new PreparedCache() });
    let steps = 0;
    while (!job.run(ONE_STEP)) steps++;
    // Reading the row, then decoding and outlining POINTS_PER_STEP points per step.
    expect(steps).toBeGreaterThanOrEqual(Math.ceil(10_000 / POINTS_PER_STEP) * 2);
    expect(job.prepared).toBe(1);
  });

  it('gives the same page in chunks timed by the clock', () => {
    const cache = new PreparedCache();
    const job = new PageJob(rows, ASPECT, { cache });
    let done = false;
    while (!done) {
      const start = performance.now();
      const remainingMs = () => Math.max(0, 8 - (performance.now() - start));
      done = job.run({
        now: () => performance.now(),
        remainingMs,
        outOfTime: () => remainingMs() <= 0,
      });
    }
    const expected = preparePage(rows, ASPECT, { now: () => 0 }).items;
    const { items } = pageFromCache(rows, ASPECT, cache);
    expect(items.map((item) => item.annotation)).toEqual(expected.map((item) => item.annotation));
    expect(items.map((item) => item.outline)).toEqual(expected.map((item) => item.outline));
    expect(items.map((item) => item.hit)).toEqual(expected.map((item) => item.hit));
  });

  it.each([
    ['a budget', { now: () => performance.now(), remainingMs: () => NaN, outOfTime: () => false }],
    ['a clock', { now: () => NaN, remainingMs: () => 8, outOfTime: () => false }],
  ])('ends with the same page when %s gives NaN', (_, budget) => {
    const cache = new PreparedCache();
    const job = new PageJob(rows, ASPECT, { cache });
    let runs = 0;
    while (!job.run(budget)) {
      runs++;
      if (runs > 100_000) throw new Error('stuck');
    }
    const expected = preparePage(rows, ASPECT, { now: () => 0 }).items;
    expect(pageFromCache(rows, ASPECT, cache).items.map((item) => item.outline)).toEqual(
      expected.map((item) => item.outline),
    );
  });

  it('takes one small step when only the reserve is left', () => {
    const long = row(0, {
      type: 'stroke',
      data: { v: 1, ink: 'red', width: 0.003, input: 'pen', points: longStroke(2000) },
    });
    const job = new PageJob([long], ASPECT, { cache: new PreparedCache() });
    const reserveOnly = {
      now: () => performance.now(),
      remainingMs: () => CHUNK_RESERVE_MS,
      outOfTime: () => false,
    };
    let runs = 0;
    while (!job.run(reserveOnly)) runs++;
    // At least one step per call, of the smallest size (16 points): decode and feed alone are
    // 2 × 2000 / 16 steps.
    expect(runs).toBeGreaterThanOrEqual((2 * 2000) / 16);
    expect(job.prepared).toBe(1);
  });

  it('leaves the reserve it is given unused', () => {
    const long = row(0, {
      type: 'stroke',
      data: { v: 1, ink: 'red', width: 0.003, input: 'pen', points: longStroke(2000) },
    });
    let clock = 0;
    // Each look at the clock is 0.01 ms later; 2.5 ms are left in every chunk.
    const budget = { now: () => (clock += 0.01), remainingMs: () => 2.5, outOfTime: () => false };
    const runs = (reserveMs?: number) => {
      const job = new PageJob([long], ASPECT, {
        cache: new PreparedCache(),
        ...(reserveMs === undefined ? {} : { reserveMs }),
      });
      let count = 0;
      while (!job.run(budget)) count++;
      expect(job.prepared).toBe(1);
      return count;
    };
    // With 3 ms of reserve nothing fits after the first step of each chunk; with 1.5 ms it does.
    expect(runs(3)).toBeGreaterThan(runs());
    // A reserve that is not a number is the default.
    expect(runs(Number.NaN)).toBe(runs());
  });

  it('learns from the clock: on a fast clock its steps grow past POINTS_PER_STEP', () => {
    const long = row(0, {
      type: 'stroke',
      data: { v: 1, ink: 'red', width: 0.003, input: 'pen', points: longStroke(10_000) },
    });
    let clock = 0;
    // Every look at the clock is a microsecond later: each step seems almost free.
    const fast = { now: () => (clock += 0.001), remainingMs: () => 8, outOfTime: () => true };
    const job = new PageJob([long], ASPECT, { cache: new PreparedCache() });
    let steps = 0;
    while (!job.run(fast)) steps++;
    expect(job.prepared).toBe(1);
    // Without a clock every step is POINTS_PER_STEP points.
    const fixed = new PageJob([long], ASPECT, { cache: new PreparedCache() });
    let fixedSteps = 0;
    while (!fixed.run(ONE_STEP)) fixedSteps++;
    expect(steps).toBeLessThan(fixedSteps / 2);
  });

  it('runs to the end in one call when there is time', () => {
    const job = new PageJob(rows, ASPECT, { cache: new PreparedCache() });
    expect(job.run(NO_LIMIT)).toBe(true);
    expect(job.done).toBe(true);
    expect(job.run(NO_LIMIT)).toBe(true);
  });

  it('finds points broken after the first steps, and keeps the result', () => {
    // 600 points, then the text cut: the decoder fails past the first POINTS_PER_STEP points.
    const full = encodeAnnotationData({
      type: 'stroke',
      data: { v: 1, ink: 'red', width: 0.003, input: 'pen', points: longStroke(600) },
    }) as { points: string };
    const broken = {
      ...row(0, {
        type: 'stroke',
        data: { v: 1, ink: 'red', width: 0.003, input: 'pen', points: longStroke(600) },
      }),
    };
    broken.data = JSON.stringify({ ...full, points: full.points.slice(0, -40) });
    const job = new PageJob([broken], ASPECT, { cache: new PreparedCache() });
    let steps = 0;
    while (!job.run(ONE_STEP)) steps++;
    expect(steps).toBeGreaterThan(1);
    expect(job.prepared).toBe(0);
    expect(job.invalid.map((entry) => entry.id)).toEqual([broken.id]);
    const point = /Truncated point (\d+)/.exec(job.invalid[0]?.issues[0] ?? '');
    expect(Number(point?.[1])).toBeGreaterThan(POINTS_PER_STEP);
  });

  it('leaves out bad and unsupported rows, and lists the unsupported ids', () => {
    const good = strokes[0];
    const corrupt = {
      ...strokes[1],
      data: (strokes[1]?.data ?? '').replace(/"points":"[^"]{12}/, '"points":"AAAAAAAAAAAA'),
    };
    const unsupported = { ...text, id: '019a7a2e-1c2d-7e3f-8a4b-0000000fffff', type: 'link' };
    const job = new PageJob([good, corrupt, unsupported, 'not json', { id: 'x' }], ASPECT, {
      cache: new PreparedCache(),
    });
    job.run(NO_LIMIT);
    expect(job.prepared).toBe(1);
    expect(job.unsupported).toBe(1);
    expect(job.unsupportedIds).toEqual([unsupported.id]);
    expect(job.invalid.map((entry) => entry.id)).toEqual([corrupt.id, null, 'x']);
  });
});

describe('pageFromCache', () => {
  it('lists what is missing, and takes a changed row as missing', () => {
    const cache = new PreparedCache();
    expect(pageFromCache(rows, ASPECT, cache).missing).toHaveLength(rows.length);
    new PageJob(rows, ASPECT, { cache }).run(NO_LIMIT);
    const edited = rows.map((entry, index) =>
      index === 2 ? { ...entry, updated_at: '2026-11-11T00:00:00.000Z' } : entry,
    );
    const page = pageFromCache(edited, ASPECT, cache);
    expect(page.missing).toEqual([rows[2]?.id]);
    expect(page.items).toHaveLength(rows.length - 1);
    // Another page shape is another preparation.
    expect(pageFromCache(rows, 0.7, cache).missing).toHaveLength(rows.length);
  });
});

describe('a stroke just drawn', () => {
  it('goes to the cache with the live outline, the same as preparing it again', () => {
    const capture = createStrokeCapture({ type: 'stroke', input: 'pen', width: 0.003 }, ASPECT);
    const points = longStroke(800);
    for (let offset = 0; offset < points.length; offset += 4) {
      addSample(
        capture,
        points[offset] ?? 0,
        points[offset + 1] ?? 0,
        points[offset + 2] ?? 0,
        points[offset + 3] ?? 0,
      );
    }
    const finished = finishStroke(capture);
    if (!finished) throw new Error('no points');
    const saved = row(3, {
      type: 'stroke',
      data: { v: 1, ink: 'red', width: 0.003, input: 'pen', points: finished.points },
    });
    const annotation = parseAnnotationRow(saved);
    if (annotation.status !== 'ok') throw new Error('invalid row');
    const cache = new PreparedCache();
    const { key, item } = preparedFinishedStroke(annotation.annotation, finished.outline, ASPECT);
    cache.set(key, item);
    expect(pageFromCache([saved], ASPECT, cache).missing).toEqual([]);
    const fresh = preparePage([saved], ASPECT, { now: () => 0 }).items[0];
    expect(firstDifference(finished.outline, fresh?.outline ?? [])).toBeUndefined();
  });

  it('has nothing to save without points', () => {
    const capture = createStrokeCapture({ type: 'stroke', input: 'pen', width: 0.003 }, ASPECT);
    expect(finishStroke(capture)).toBeNull();
  });
});

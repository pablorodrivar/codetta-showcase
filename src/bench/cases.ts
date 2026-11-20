// The cases of `perf-report` (Node) and of the device bench screen (Hermes), in one place so
// both run the same work on the same deterministic data (ADR-008 §7). Not for production
// code: lint keeps it out of everything but scripts, benches and dev screens.

import { decodePoints, encodePoints } from '../codec/points-codec';
import { OUTLINE_SCALE } from '../geometry/page-frame';
import { eraseHits, type HitTarget } from '../hit-test/eraser';
import { pageFromCache, PageJob } from '../page/page-job';
import { PreparedCache, preparePage } from '../page/prepare-page';
import { POINT_STRIDE, type PointBuffer } from '../points';
import { encodeAnnotationData } from '../schema/rows';
import { outlineOptions } from '../smoothing/stroke';
import { busyPageStrokes, longStroke } from '../test/synthetic-strokes';
import { finishedOutlineSamples, liveEventSamples } from './live';

/** A4 page: height over width. */
export const BENCH_ASPECT = 297 / 210;
export const BENCH_STYLE = { type: 'stroke', input: 'pen', width: 0.003 } as const;

export type BenchId =
  | 'live-1000'
  | 'live-4000'
  | 'live-10000'
  | 'live-naive-4000'
  | 'outline-2000'
  | 'outline-10000'
  | 'decode-2000'
  | 'decode-10000'
  | 'page'
  | 'page-read'
  | 'page-outlines'
  | 'page-hit-targets'
  | 'page-cached'
  | 'page-job-chunk'
  | 'page-job-chunk-long'
  | 'page-job-chunk-long-page'
  | 'page-job-chunk-reserve-3'
  | 'page-job-chunk-long-page-reserve-3'
  | 'page-job-step'
  | 'page-job-step-long'
  | 'eraser-500'
  | 'page-gc-count'
  | 'page-gc-pause'
  | 'calibration';

export interface BenchCase {
  readonly id: BenchId;
  /** perf-report's line, in English. */
  readonly label: string;
  /** The row of the ADR-008 §7 tables. */
  readonly adr: string;
  /** The device budget of ADR-008 §7, checked against p95; none for reference rows. */
  readonly budgetMs: number | null;
  /** Whether the case runs on a worklet runtime too (worklet code only). */
  readonly worklet: boolean;
  /** What the samples count: milliseconds (the default) or a number of things. */
  readonly unit?: 'ms' | 'count';
}

export const BENCH_CASES: readonly BenchCase[] = [
  {
    id: 'live-1000',
    label: 'Live, every event while drawing a 1000-pt stroke',
    adr: 'Live event, incremental, 1,000-point stroke',
    budgetMs: 0.5,
    worklet: true,
  },
  {
    id: 'live-4000',
    label: 'Live, every event while drawing a 4000-pt stroke',
    adr: 'Live event, incremental, 4,000 points',
    budgetMs: 0.5,
    worklet: true,
  },
  {
    id: 'live-10000',
    label: 'Live, every event while drawing a 10000-pt stroke',
    adr: 'Live event, incremental, 10,000 points',
    budgetMs: 0.5,
    worklet: true,
  },
  {
    id: 'live-naive-4000',
    label: 'Live, every event of a 4000-pt stroke, full recompute (perfect-freehand)',
    adr: 'Live event, full recompute with perfect-freehand, 4,000 points',
    budgetMs: null,
    worklet: false,
  },
  {
    id: 'outline-2000',
    label: 'Finished outline, 2000 pts',
    adr: 'Finished outline, 2,000 points',
    budgetMs: 2,
    worklet: true,
  },
  {
    id: 'outline-10000',
    label: 'Finished outline, 10000 pts',
    adr: 'Finished outline, 10,000 points',
    budgetMs: null,
    worklet: true,
  },
  {
    id: 'decode-2000',
    label: 'Decode, 2000 pts',
    adr: 'Decode 2,000 points',
    // Reference since 15/11/2026: unreachable without a JIT; decoding is budgeted per step,
    // inside a chunk (`page-job-step`, ADR-008 §7).
    budgetMs: null,
    worklet: false,
  },
  {
    id: 'decode-10000',
    label: 'Decode, 10000 pts',
    adr: 'Decode 10,000 points',
    budgetMs: null,
    worklet: false,
  },
  {
    id: 'page',
    label: 'Page, 300 strokes × 100 pts, cold, all (preparePage: read rows, outlines, hit targets)',
    adr: 'Page of 300 strokes of 100 points, cold, all of it (`preparePage`)',
    // No total budget for a cold page: it is prepared in slices of ≤ 8 ms, never during a
    // page turn; the 30 ms are for a cached page (ADR-008 §7).
    budgetMs: null,
    worklet: false,
  },
  {
    id: 'page-read',
    label: '  of which reading the rows (JSON.parse, Zod, decode)',
    adr: '… of which reading the rows (JSON, Zod and decoding)',
    budgetMs: null,
    worklet: false,
  },
  {
    id: 'page-outlines',
    label: '  of which the outlines',
    adr: '… of which the outlines',
    budgetMs: null,
    worklet: false,
  },
  {
    id: 'page-hit-targets',
    label: '  of which the hit targets',
    adr: '… of which the eraser boxes',
    budgetMs: null,
    worklet: false,
  },
  {
    id: 'page-cached',
    label: 'Page of 300 strokes from the cache (pageFromCache, id and updated_at only)',
    adr: 'Page of 300 strokes from the cache (`pageFromCache`, only `id` and `updated_at`)',
    budgetMs: 30,
    worklet: false,
  },
  {
    id: 'page-job-chunk',
    label: 'Each frame chunk of preparing that page cold (PageJob, 8 ms budget)',
    adr: 'Each chunk of preparing that page cold (`PageJob`, 8 ms per chunk)',
    budgetMs: 8,
    worklet: false,
  },
  {
    id: 'page-job-chunk-long',
    label: 'Each frame chunk of preparing one 10000-pt stroke cold (PageJob, 8 ms budget)',
    adr: 'Each chunk of preparing a 10,000-point stroke cold (`PageJob`, 8 ms per chunk)',
    budgetMs: 8,
    worklet: false,
  },
  {
    id: 'page-job-chunk-long-page',
    label: 'Each frame chunk of preparing a page of 20 × 2000-pt and 100 × 100-pt strokes cold',
    adr: 'Each chunk of preparing cold a page of 20 strokes of 2,000 points and 100 of 100 (`PageJob`, 8 ms per chunk)',
    budgetMs: 8,
    worklet: false,
  },
  {
    id: 'page-job-chunk-reserve-3',
    label: 'Each frame chunk of preparing the 300-stroke page cold, leaving 3 ms (not 1.5) unused',
    adr: 'Each chunk of preparing the 300-stroke page cold with a 3 ms reserve, not 1.5 (`PageJob`, 8 ms per chunk)',
    budgetMs: 8,
    worklet: false,
  },
  {
    id: 'page-job-chunk-long-page-reserve-3',
    label: 'Each frame chunk of preparing the page of long strokes cold, leaving 3 ms unused',
    adr: 'Each chunk of preparing the page of long strokes cold with a 3 ms reserve (`PageJob`, 8 ms per chunk)',
    budgetMs: 8,
    worklet: false,
  },
  {
    id: 'page-job-step',
    label: 'Each step of PageJob on the 300-stroke page (the parts a chunk is made of)',
    adr: 'Each `PageJob` step on the 300-stroke page (the parts of a chunk)',
    // A target, not a device budget: steps of a few ms keep the chunks within 8 ms.
    budgetMs: 3,
    worklet: false,
  },
  {
    id: 'page-job-step-long',
    label: 'Each step of PageJob on one 10000-pt stroke',
    adr: 'Each `PageJob` step on a 10,000-point stroke',
    budgetMs: 3,
    worklet: false,
  },
  {
    id: 'eraser-500',
    label: 'Eraser move, 500 strokes on the page',
    adr: 'One eraser move, 500 strokes on the page',
    budgetMs: 1,
    worklet: false,
  },
  {
    id: 'page-gc-count',
    label:
      'Collections while preparing the 300-stroke page cold in chunks (a count, not ms; Hermes only)',
    adr: 'Collections while preparing the 300-stroke page cold in chunks (a count, not ms; Hermes only)',
    budgetMs: null,
    worklet: false,
    unit: 'count',
  },
  {
    id: 'page-gc-pause',
    label:
      'Average pause of the JS thread per young collection while preparing that page (Hermes only)',
    adr: 'Mean JS-thread pause per young collection while preparing that page (Hermes only)',
    budgetMs: null,
    worklet: false,
  },
  {
    id: 'calibration',
    label: 'Calibration: a fixed loop of plain JS (to compare sessions and machines)',
    adr: 'Calibration: a fixed JS loop (to compare runs and machines)',
    budgetMs: null,
    worklet: false,
  },
];

export interface BenchRow {
  readonly id: BenchId;
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  /** Samples above the case's budget; 0 for cases without one. */
  readonly overBudget: number;
}

/** p50, p95 and max of durations in ms (nearest rank, like perf-report always did). */
export function benchRow(id: BenchId, samples: readonly number[]): BenchRow {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
  const budget = BENCH_CASES.find((benchCase) => benchCase.id === id)?.budgetMs ?? null;
  const overBudget = budget === null ? 0 : sorted.filter((value) => value > budget).length;
  return { id, samples: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1), overBudget };
}

/** `[x, y, pressure, …]` in outline units, as the live stroke receives it. */
export function liveInput(points: PointBuffer, aspect = BENCH_ASPECT): number[] {
  const input: number[] = [];
  for (let offset = 0; offset < points.length; offset += POINT_STRIDE) {
    input.push(
      (points[offset] ?? 0) * OUTLINE_SCALE,
      (points[offset + 1] ?? 0) * aspect * OUTLINE_SCALE,
      points[offset + 2] ?? 0,
    );
  }
  return input;
}

/** The inputs of the cases that also run on a worklet runtime, as plain arrays. */
export function workletInputs(): {
  readonly live: Readonly<Record<'live-1000' | 'live-4000' | 'live-10000', number[]>>;
  readonly outline: Readonly<Record<'outline-2000' | 'outline-10000', number[]>>;
} {
  return {
    live: {
      'live-1000': liveInput(longStroke(1000)),
      'live-4000': liveInput(longStroke(4000)),
      'live-10000': liveInput(longStroke(10_000)),
    },
    outline: {
      'outline-2000': Array.from(longStroke(2000)),
      'outline-10000': Array.from(longStroke(10_000)),
    },
  };
}

/** Repeats of the timed cases (perf-report's). */
export const OUTLINE_REPEAT = 50;
export const DECODE_REPEAT = 200;
export const PAGE_REPEAT = 20;
/** Untimed runs before each case; the UI runtime column uses the same (`dev-perf`). */
export const WARMUP = 5;

function time(run: () => void, repeat: number): number[] {
  for (let index = 0; index < WARMUP; index++) run();
  const samples: number[] = [];
  for (let index = 0; index < repeat; index++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  return samples;
}

/** A busy page as read from SQLite: JSON text rows of `count` strokes of 100 points. */
export function busyPageRows(count: number): string[] {
  return strokeRows(busyPageStrokes(count));
}

/** Stored stroke rows (JSON text, as from SQLite) for these points, `z` in order. */
function strokeRows(strokes: readonly PointBuffer[]): string[] {
  return strokes.map((points, index) =>
    JSON.stringify({
      id: `019a7a2e-1c2d-7e3f-8a4b-${String(index).padStart(12, '0')}`,
      owner_id: '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0c',
      score_id: '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0c',
      layer_id: '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0c',
      page_index: 0,
      type: 'stroke',
      data: JSON.stringify(
        encodeAnnotationData({
          type: 'stroke',
          data: { v: 1, ink: 'red', width: 0.003, input: 'pen', points },
        }),
      ),
      z: index,
      created_at: '2026-11-10T00:00:00Z',
      updated_at: '2026-11-10T00:00:00Z',
      deleted_at: null,
    }),
  );
}

/** A page with long strokes: 20 of 2000 points (about 8 s of pen each) and 100 of 100. */
export function longStrokePageRows(): string[] {
  const long = Array.from({ length: 20 }, (_, index) => longStroke(2000, 100 + index));
  return strokeRows([...long, ...busyPageStrokes(100)]);
}

/**
 * A fixed amount of plain JS (arithmetic, typed-array reads, array pushes and calls), about the
 * mix of the hot paths: its time tells how fast the machine and the session were, so rows of
 * two sessions can be compared divided by it (ADR-008 §7).
 */
export function calibrationWork(): number {
  const table = new Float32Array(4096);
  for (let index = 0; index < table.length; index++) table[index] = index / table.length;
  const out: number[] = [];
  const mix = (a: number, b: number) => (a * 31 + b) % 4096;
  let state = 1;
  for (let index = 0; index < 20_000; index++) {
    state = mix(state, index);
    out.push((table[state] ?? 0) + index);
  }
  return out.length + state;
}

export interface RunOptions {
  /** Called before each case, e.g. to show progress. */
  readonly onCase?: (benchCase: BenchCase) => void;
  /** Lets the host breathe between cases (a UI repaints); a no-op by default. */
  readonly yieldNow?: () => Promise<void>;
  /**
   * The perfect-freehand comparison (`naiveLiveSamples` from `./naive`), only from
   * `perf-report`: perfect-freehand is a devDependency and must never reach the app bundle.
   * Without it the row is left out.
   */
  readonly naiveLiveSamples?: () => number[];
}

/** One stored stroke of `count` points, as the local SQLite returns it. */
function longStrokeRow(count: number): string {
  const [first] = busyPageRows(1);
  const row = JSON.parse(first ?? '{}') as Record<string, unknown>;
  const data = JSON.parse(String(row.data)) as Record<string, unknown>;
  return JSON.stringify({
    ...row,
    data: JSON.stringify({ ...data, points: encodePoints(longStroke(count)) }),
  });
}

/** Collections so far and their time in ms, from Hermes; null elsewhere (Node, browsers). */
/**
 * Collections so far, the young ones (the only ones that stop the JS thread for their whole run),
 * and the time the JS thread was stopped by them in ms, from Hermes; null elsewhere (Node,
 * browsers). In Hermes (`GCBase::recordGCStats`), `js_gcTime` adds up only the pauses of the JS
 * thread, in seconds: the concurrent work of an old-generation collection is not in it, though it
 * counts in `js_numGCs`.
 */
function collectorStats(): {
  readonly count: number;
  readonly young: number | null;
  readonly pauseMs: number;
} | null {
  const internal = (
    globalThis as {
      HermesInternal?: {
        getInstrumentedStats?: () => Record<string, number | Record<string, number> | undefined>;
      };
    }
  ).HermesInternal;
  const stats = internal?.getInstrumentedStats?.();
  const count = stats?.js_numGCs;
  const seconds = stats?.js_gcTime;
  const specific = stats?.js_gcSpecific;
  const young = typeof specific === 'object' ? specific.js_numYGCollections : undefined;
  return typeof count === 'number' && typeof seconds === 'number'
    ? { count, young: typeof young === 'number' ? young : null, pauseMs: seconds * 1000 }
    : null;
}

/** Rounds of the collector rows: each prepares the whole page (≈ 0,7 s on the emulator). */
const GC_ROUNDS = 6;

/** The budget the app's frame scheduler gives a task (`FRAME_BUDGET_MS`). */
const CHUNK_BUDGET_MS = 8;

/**
 * The chunks of preparing `pageRows` cold, three rounds with a fresh cache each (the first
 * warms up), each chunk with the scheduler's budget.
 */
function pageJobChunks(pageRows: readonly string[], rounds = 3, reserveMs?: number): number[] {
  const chunks: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const job = new PageJob(pageRows, BENCH_ASPECT, {
      cache: new PreparedCache(),
      ...(reserveMs === undefined ? {} : { reserveMs }),
    });
    let done = false;
    while (!done) {
      const start = performance.now();
      const remainingMs = () => Math.max(0, CHUNK_BUDGET_MS - (performance.now() - start));
      done = job.run({
        now: () => performance.now(),
        remainingMs,
        outOfTime: () => remainingMs() <= 0,
      });
      if (round > 0 || rounds === 1) chunks.push(performance.now() - start);
    }
  }
  return chunks;
}

/**
 * The steps of preparing `pageRows` cold, one per `run` (a budget that is spent after the first
 * step), each sized as at the start of a chunk; three rounds, the first warms up.
 */
function pageJobSteps(pageRows: readonly string[]): number[] {
  const steps: number[] = [];
  for (let round = 0; round < 3; round++) {
    const job = new PageJob(pageRows, BENCH_ASPECT, { cache: new PreparedCache() });
    const budget = {
      now: () => performance.now(),
      remainingMs: () => CHUNK_BUDGET_MS,
      outOfTime: () => true,
    };
    let done = false;
    while (!done) {
      const start = performance.now();
      done = job.run(budget);
      if (round > 0) steps.push(performance.now() - start);
    }
  }
  return steps;
}

/**
 * Every case on the calling thread, in `BENCH_CASES` order, warmed up before measuring. The
 * page rows come from the same `preparePage` runs, so its breakdown adds up.
 */
export async function runBench(options: RunOptions = {}): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  const yieldNow = options.yieldNow ?? (() => Promise.resolve());
  const step = async (id: BenchId) => {
    const benchCase = BENCH_CASES.find((candidate) => candidate.id === id);
    if (benchCase) options.onCase?.(benchCase);
    await yieldNow();
  };
  const outline = outlineOptions(BENCH_STYLE);
  const inputs = workletInputs();

  // Warm every path first, so the first row is not slower for that alone.
  liveEventSamples(inputs.live['live-4000'], outline);
  finishedOutlineSamples(BENCH_STYLE, inputs.outline['outline-2000'], BENCH_ASPECT, 1, 0);

  for (const id of ['live-1000', 'live-4000', 'live-10000'] as const) {
    await step(id);
    rows.push(benchRow(id, liveEventSamples(inputs.live[id], outline)));
  }

  if (options.naiveLiveSamples) {
    await step('live-naive-4000');
    rows.push(benchRow('live-naive-4000', options.naiveLiveSamples()));
  }

  for (const [outlineId, decodeId, count] of [
    ['outline-2000', 'decode-2000', 2000],
    ['outline-10000', 'decode-10000', 10_000],
  ] as const) {
    await step(outlineId);
    rows.push(
      benchRow(
        outlineId,
        finishedOutlineSamples(
          BENCH_STYLE,
          inputs.outline[outlineId],
          BENCH_ASPECT,
          WARMUP,
          OUTLINE_REPEAT,
        ),
      ),
    );
    await step(decodeId);
    const encoded = encodePoints(longStroke(count));
    rows.push(
      benchRow(
        decodeId,
        time(() => decodePoints(encoded), DECODE_REPEAT),
      ),
    );
  }

  await step('page');
  {
    const pageRows = busyPageRows(300);
    const now = () => performance.now();
    for (let run = 0; run < WARMUP; run++) preparePage(pageRows, BENCH_ASPECT, { now });
    const timings = Array.from(
      { length: PAGE_REPEAT },
      () => preparePage(pageRows, BENCH_ASPECT, { now }).timings,
    );
    rows.push(
      benchRow(
        'page',
        timings.map((timing) => timing.total),
      ),
    );
    rows.push(
      benchRow(
        'page-read',
        timings.map((timing) => timing.read),
      ),
    );
    rows.push(
      benchRow(
        'page-outlines',
        timings.map((timing) => timing.outlines),
      ),
    );
    rows.push(
      benchRow(
        'page-hit-targets',
        timings.map((timing) => timing.hitTargets),
      ),
    );
  }

  await step('page-cached');
  {
    const pageRows = busyPageRows(300);
    const cache = new PreparedCache();
    new PageJob(pageRows, BENCH_ASPECT, { cache }).run({ outOfTime: () => false });
    // Phase 1 reads only id and updated_at.
    const refs = pageRows.map((text) => JSON.parse(text) as { id: string; updated_at: string });
    rows.push(
      benchRow(
        'page-cached',
        time(() => pageFromCache(refs, BENCH_ASPECT, cache), PAGE_REPEAT),
      ),
    );
  }

  for (const [id, pageRows] of [
    ['page-job-chunk', busyPageRows(300)],
    ['page-job-chunk-long', [longStrokeRow(10_000)]],
    ['page-job-chunk-long-page', longStrokePageRows()],
  ] as const) {
    await step(id);
    rows.push(benchRow(id, pageJobChunks(pageRows)));
  }

  // The same pages with a reserve of 3 ms: whether a larger reserve keeps the collector's pauses
  // inside the budget, and how many more chunks (frames) a page takes for it (ADR-008 §7).
  for (const [id, pageRows] of [
    ['page-job-chunk-reserve-3', busyPageRows(300)],
    ['page-job-chunk-long-page-reserve-3', longStrokePageRows()],
  ] as const) {
    await step(id);
    rows.push(benchRow(id, pageJobChunks(pageRows, 3, 3)));
  }

  for (const [id, pageRows] of [
    ['page-job-step', busyPageRows(300)],
    ['page-job-step-long', [longStrokeRow(10_000)]],
  ] as const) {
    await step(id);
    rows.push(benchRow(id, pageJobSteps(pageRows)));
  }

  await step('eraser-500');
  {
    const targets: HitTarget[] = preparePage(busyPageRows(500), BENCH_ASPECT, {
      now: () => 0,
    }).items.map((item) => item.hit);
    const moves: [number, number][] = Array.from({ length: 500 }, (_, index) => [
      index / 500,
      0.3 + (index % 7) / 50,
    ]);
    const erase: number[] = [];
    for (let round = 0; round < 2; round++) {
      erase.length = 0; // the first round warms up
      for (let index = 1; index < moves.length; index++) {
        const from = moves[index - 1] ?? [0, 0];
        const to = moves[index] ?? [0, 0];
        const start = performance.now();
        eraseHits(targets, from, to, 0.01, BENCH_ASPECT);
        erase.push(performance.now() - start);
      }
    }
    rows.push(benchRow('eraser-500', erase));
  }

  if (collectorStats()) {
    await step('page-gc-count');
    const pageRows = busyPageRows(300);
    const counts: number[] = [];
    const pauses: number[] = [];
    // The same chunks as `page-job-chunk`; the first round warms up.
    for (let round = 0; round <= GC_ROUNDS; round++) {
      const before = collectorStats();
      pageJobChunks(pageRows, 1);
      const after = collectorStats();
      if (round === 0 || !before || !after) continue;
      const count = after.count - before.count;
      counts.push(count);
      // Per young collection where Hermes says how many there were: the old ones barely pause.
      const paused =
        after.young !== null && before.young !== null ? after.young - before.young : count;
      if (paused > 0) pauses.push((after.pauseMs - before.pauseMs) / paused);
    }
    rows.push(benchRow('page-gc-count', counts));
    if (pauses.length > 0) rows.push(benchRow('page-gc-pause', pauses));
  }

  await step('calibration');
  rows.push(benchRow('calibration', time(calibrationWork, DECODE_REPEAT)));

  return rows;
}

/** Milliseconds the way the ADR writes them: decimals by magnitude (0,008 · 0,53 · 6,9 · 46), decimal comma. */
export function formatMs(value: number): string {
  const digits = value < 0.1 ? 3 : value < 1 ? 2 : value < 10 ? 1 : 0;
  return value.toFixed(digits).replace('.', ',');
}

/**
 * A Markdown table for ADR-008 §7: one row per case with p50, p95 and max per runtime, and
 * the budget with ✓ or ✗ against the worst p95 measured.
 */
export function benchMarkdown(
  columns: readonly { readonly title: string; readonly rows: readonly BenchRow[] }[],
): string {
  const header = [
    'Operation',
    ...columns.flatMap((column) => [
      `${column.title} p50`,
      `${column.title} p95`,
      `${column.title} max`,
    ]),
    'Budget',
  ];
  const lines = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (const benchCase of BENCH_CASES) {
    const found = columns.map((column) => column.rows.find((row) => row.id === benchCase.id));
    if (found.every((row) => row === undefined)) continue;
    const unit = benchCase.unit === 'count' ? '' : ' ms';
    // A count is a whole number (nearest-rank percentiles of whole numbers).
    const format = benchCase.unit === 'count' ? (value: number) => String(value) : formatMs;
    const cells = found.flatMap((row) =>
      row ? [row.p50, row.p95, row.max].map((value) => `${format(value)}${unit}`) : ['—', '—', '—'],
    );
    const worst = Math.max(...found.map((row) => row?.p95 ?? 0));
    const budget =
      benchCase.budgetMs === null
        ? '—'
        : `≤ ${formatMs(benchCase.budgetMs)} ms ${worst <= benchCase.budgetMs ? '✓' : '✗'}`;
    lines.push(`| ${[benchCase.adr, ...cells, budget].join(' | ')} |`);
  }
  const over = overBudgetLines(columns);
  const calibration = calibrationLine(columns);
  return [lines.join('\n'), over, calibration].filter((part) => part !== null).join('\n\n');
}

/**
 * For each case with a budget: how many samples there were and how many went over, per column
 * (the table only has p50, p95 and max). Null when no column has such a row.
 */
export function overBudgetLines(
  columns: readonly { readonly title: string; readonly rows: readonly BenchRow[] }[],
): string | null {
  const lines: string[] = [];
  for (const benchCase of BENCH_CASES) {
    if (benchCase.budgetMs === null) continue;
    const found = columns.flatMap((column) => {
      const row = column.rows.find((candidate) => candidate.id === benchCase.id);
      return row ? [`${column.title} ${String(row.overBudget)} of ${String(row.samples)}`] : [];
    });
    if (found.length > 0) lines.push(`- ${benchCase.adr}: ${found.join(' · ')}`);
  }
  return lines.length > 0 ? `Samples over the budget:\n${lines.join('\n')}` : null;
}

/**
 * The session's calibration (p50 of `calibration` in each column that has it), to print with
 * every table: two sessions compare row by row once each is divided by its own (ADR-008 §7).
 */
export function calibrationLine(
  columns: readonly { readonly title: string; readonly rows: readonly BenchRow[] }[],
): string | null {
  const found = columns.flatMap((column) => {
    const row = column.rows.find((candidate) => candidate.id === 'calibration');
    return row ? [`${column.title} ${formatMs(row.p50)} ms`] : [];
  });
  return found.length > 0
    ? `Calibration of this run (p50): ${found.join(' · ')}. To compare with another run, divide each row by its calibration.`
    : null;
}

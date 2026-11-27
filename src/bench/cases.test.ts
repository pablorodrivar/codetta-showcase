import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { preparePage } from '../page/prepare-page';
import { outlineOptions } from '../smoothing/stroke';
import {
  BENCH_ASPECT,
  BENCH_CASES,
  BENCH_STYLE,
  benchMarkdown,
  benchRow,
  busyPageRows,
  calibrationWork,
  formatMs,
  longStrokePageRows,
  workletInputs,
} from './cases';
import { finishedOutlineSamples, liveEventSamples } from './live';

describe('bench cases', () => {
  it('has one entry per id, and budgets only where ADR-008 §7 sets them', () => {
    const ids = BENCH_CASES.map((benchCase) => benchCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      BENCH_CASES.filter((benchCase) => benchCase.budgetMs !== null).map((benchCase) => [
        benchCase.id,
        benchCase.budgetMs,
      ]),
    ).toEqual([
      ['live-1000', 0.5],
      ['live-4000', 0.5],
      ['live-10000', 0.5],
      ['outline-2000', 2],
      ['finish-parts-2000', 2],
      ['page-cached', 30],
      ['page-job-chunk', 8],
      ['page-job-chunk-long', 8],
      ['page-job-chunk-long-page', 8],
      ['page-job-chunk-reserve-3', 8],
      ['page-job-chunk-long-page-reserve-3', 8],
      ['page-job-step', 3],
      ['page-job-step-long', 3],
      ['eraser-500', 1],
    ]);
  });

  it('takes nearest-rank percentiles', () => {
    const samples = Array.from({ length: 101 }, (_, index) => 100 - index);
    expect(benchRow('page', samples)).toEqual({
      id: 'page',
      samples: 101,
      p50: 50,
      p95: 95,
      max: 100,
      overBudget: 0,
    });
    // Over the budget of `page-job-chunk` (8 ms): 9 to 100.
    expect(benchRow('page-job-chunk', samples).overBudget).toBe(92);
  });

  it('writes milliseconds like the ADR', () => {
    expect([0.0081, 0.34, 1.09, 3.3, 32.4].map(formatMs)).toEqual([
      '0,008',
      '0,34',
      '1,1',
      '3,3',
      '32',
    ]);
  });

  it('builds a Markdown table per runtime, with the budget checked against the worst p95', () => {
    const table = benchMarkdown([
      { title: 'JS thread', rows: [benchRow('live-1000', [0.1, 0.2, 0.3])] },
      { title: 'UI runtime', rows: [benchRow('live-1000', [0.4, 0.6, 0.7])] },
    ]);
    expect(table.split('\n')).toEqual([
      '| Operation | JS thread p50 | JS thread p95 | JS thread max | UI runtime p50 | UI runtime p95 | UI runtime max | Budget |',
      '|---|---|---|---|---|---|---|---|',
      '| Live event, incremental, 1,000-point stroke | 0,20 ms | 0,20 ms | 0,30 ms | 0,60 ms | 0,60 ms | 0,70 ms | ≤ 0,50 ms ✗ |',
      '',
      'Samples over the budget:',
      '- Live event, incremental, 1,000-point stroke: JS thread 0 of 3 · UI runtime 2 of 3',
    ]);
  });

  it('writes a count without ms', () => {
    const table = benchMarkdown([
      { title: 'JS thread', rows: [benchRow('page-gc-count', [8, 9, 11])] },
    ]);
    expect(table.split('\n')[2]).toBe(
      '| Collections while preparing the 300-stroke page cold in chunks (a count, not ms; Hermes only) | 9 | 9 | 11 | — |',
    );
  });

  it('prints the session calibration under the table', () => {
    const table = benchMarkdown([
      { title: 'JS thread', rows: [benchRow('calibration', [1.2, 1.25, 1.3])] },
      { title: 'UI runtime', rows: [] },
    ]);
    expect(table.split('\n').at(-1)).toBe(
      'Calibration of this run (p50): JS thread 1,3 ms. To compare with another run, divide each row by its calibration.',
    );
  });

  it('times one live event per input point and one outline per repeat', () => {
    const { live, outline } = workletInputs();
    const input = live['live-1000'];
    expect(liveEventSamples(input, outlineOptions(BENCH_STYLE))).toHaveLength(input.length / 3);
    expect(
      finishedOutlineSamples(BENCH_STYLE, outline['outline-2000'], BENCH_ASPECT, 1, 3),
    ).toHaveLength(3);
  });

  it('builds the busy page as valid text rows', () => {
    const page = preparePage(busyPageRows(30), BENCH_ASPECT, { now: () => 0 });
    expect(page.items).toHaveLength(30);
    expect(page.invalid).toEqual([]);
  });

  it('builds the page of long strokes as valid text rows', () => {
    const page = preparePage(longStrokePageRows(), BENCH_ASPECT, { now: () => 0 });
    expect(page.items).toHaveLength(120);
    expect(page.invalid).toEqual([]);
    expect(
      page.items.filter(
        (item) => item.annotation.type === 'stroke' && item.annotation.data.points.length === 8000,
      ),
    ).toHaveLength(20);
  });

  it('calibrates with a fixed, deterministic amount of work', () => {
    expect(calibrationWork()).toBe(calibrationWork());
  });
});

describe('the app side of the bench', () => {
  // `@codetta/annotations/bench` reaches the app bundle through dev-perf; perfect-freehand is a
  // devDependency and must not (ADR-008 §4, §7). Lint stops any import of perfect-freehand or
  // of ./naive in src/ outside the tests; this checks the entry on top of that.
  it('does not export the perfect-freehand comparison', () => {
    const entry = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8');
    expect(entry).not.toMatch(/['"]\.\/naive(\.[jt]s)?['"]/);
  });
});

/// <reference types="node" />
/**
 * `pnpm perf-report`: timings of the hot paths on long synthetic
 * strokes (ADR-008 §7). Node (V8 with JIT) is a lower bound: Hermes is measured on the device
 * with the measuring screen (`dev-perf`), which runs these same cases (`../src/bench`).
 */
import { it } from 'vitest';

import { BENCH_CASES, benchMarkdown, type BenchRow, runBench } from '../src/bench';
// Not part of `@codetta/annotations/bench`: perfect-freehand stays out of the app (./naive).
import { naiveLiveSamples } from '../src/bench/naive';

function line(row: BenchRow): string {
  const benchCase = BENCH_CASES.find((candidate) => candidate.id === row.id);
  const unit = benchCase?.unit === 'count' ? '' : ' ms';
  return `${benchCase?.label ?? row.id}: p50 ${row.p50.toFixed(4)} · p95 ${row.p95.toFixed(4)} · max ${row.max.toFixed(4)}${unit}`;
}

it('prints the performance table', async () => {
  const rows = await runBench({ naiveLiveSamples });
  const calibration = rows.find((row) => row.id === 'calibration');
  // The calibration first: it tells how fast this machine and session were.
  console.log(
    `Node ${process.version} · calibration p50 ${calibration ? calibration.p50.toFixed(4) : '—'} ms\n${rows.map(line).join('\n')}`,
  );
  console.log(`\n${benchMarkdown([{ title: 'V8', rows }])}`);
}, 120_000);

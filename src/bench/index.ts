/**
 * `@codetta/annotations/bench`: the performance cases of ADR-008 §7, shared by `perf-report`
 * (Node) and the device bench screen (Hermes). Not for production code (lint enforces it).
 */
export {
  BENCH_ASPECT,
  BENCH_CASES,
  BENCH_STYLE,
  type BenchCase,
  type BenchId,
  benchMarkdown,
  type BenchRow,
  benchRow,
  busyPageRows,
  calibrationLine,
  calibrationWork,
  finishedStrokeInput,
  formatMs,
  liveInput,
  longStrokePageRows,
  OUTLINE_REPEAT,
  overBudgetLines,
  runBench,
  type RunOptions,
  WARMUP,
  workletInputs,
} from './cases';
export { finishedOutlineSamples, finishSamples, liveEventSamples } from './live';

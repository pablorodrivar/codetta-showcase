/**
 * `@codetta/annotations/testing`: deterministic synthetic strokes for tests and benchmarks
 * outside this package (the web test reader's 300-stroke page), so their numbers
 * compare with `perf-report` (ADR-008 §7). Not for production code.
 */
export {
  busyPageStrokes,
  longStroke,
  seededRandom,
  type SyntheticStroke,
  syntheticStrokes,
} from './test/synthetic-strokes';

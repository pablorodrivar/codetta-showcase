// The live stroke recomputed from scratch with perfect-freehand on every event (ADR-008 §7):
// the quadratic cost that the incremental outline (§4) avoids. perfect-freehand is only a
// devDependency, so this case is for `perf-report` (Node) alone: `@codetta/annotations/bench`
// does not export it, so the app never bundles it, and lint keeps perfect-freehand out of the
// rest of src/ except the tests. Hermes measured it once, on 11/11/2026 (ADR-008 §7).
import { getStroke } from 'perfect-freehand';

import { outlineOptions } from '../smoothing/stroke';
import { longStroke } from '../test/synthetic-strokes';
import { BENCH_STYLE, liveInput } from './cases';

/** Every event of a 4,000-point stroke, each one recomputing the whole outline. */
export function naiveLiveSamples(): number[] {
  const outline = outlineOptions(BENCH_STYLE);
  const input = liveInput(longStroke(4000));
  const samples: number[] = [];
  const prefix: [number, number, number][] = [];
  for (let offset = 0; offset + 3 <= input.length; offset += 3) {
    prefix.push([input[offset] ?? 0, input[offset + 1] ?? 0, input[offset + 2] ?? 0]);
    const start = performance.now();
    getStroke(prefix, {
      size: outline.size,
      thinning: outline.thinning,
      smoothing: outline.smoothing,
      streamline: outline.streamline,
      simulatePressure: false,
    });
    samples.push(performance.now() - start);
  }
  return samples;
}

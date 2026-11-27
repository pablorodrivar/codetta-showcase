// The bench's hot loops that also run on a worklet runtime (ADR-008 §7): the live stroke will
// run there. Every function is a worklet (see worklets.test.ts); in Node and the web the
// directive is an inert string. Inputs are plain arrays, which any runtime can receive.
import { POINT_STRIDE } from '../points';
import {
  addInputPoint,
  createOutlineBuilder,
  type OutlineOptions,
  tailPolygon,
  takeCommittedChunks,
} from '../smoothing/outline';
import {
  addSample,
  createStrokeCapture,
  finishStroke,
  finishStrokeParts,
  freehandOutline,
  type FreehandStyle,
} from '../smoothing/stroke';

/**
 * Every event of drawing one stroke: add the point, take the new pieces, rebuild the tail.
 * `input` is `[x, y, pressure, …]` in outline units. Returns one duration per event, in ms.
 */
export function liveEventSamples(input: readonly number[], options: OutlineOptions): number[] {
  'worklet';
  const builder = createOutlineBuilder(options);
  const samples: number[] = [];
  for (let offset = 0; offset + 3 <= input.length; offset += 3) {
    const start = performance.now();
    addInputPoint(builder, input[offset] ?? 0, input[offset + 1] ?? 0, input[offset + 2] ?? 0);
    takeCommittedChunks(builder);
    tailPolygon(builder, false);
    samples.push(performance.now() - start);
  }
  return samples;
}

/**
 * The finished outline of a stored stroke, `repeat` times after `warmup` unmeasured runs.
 * `points` is a point buffer as a plain array (`POINT_STRIDE` numbers per point).
 */
export function finishedOutlineSamples(
  style: FreehandStyle,
  points: readonly number[],
  aspect: number,
  warmup: number,
  repeat: number,
): number[] {
  'worklet';
  const buffer = new Float32Array(points.length - (points.length % POINT_STRIDE));
  for (let index = 0; index < buffer.length; index++) buffer[index] = points[index] ?? 0;
  for (let run = 0; run < warmup; run++) freehandOutline(style, buffer, aspect);
  const samples: number[] = [];
  for (let run = 0; run < repeat; run++) {
    const start = performance.now();
    freehandOutline(style, buffer, aspect);
    samples.push(performance.now() - start);
  }
  return samples;
}

/**
 * Pen up in the app's reader (ADR-008 §7): the stroke is drawn first, as the reader does (a
 * sample per event and the committed pieces taken each time), then its finishing is timed:
 * `finishStroke` (the whole polygon, on the runtime that calls it) or `finishStrokeParts` (the
 * parts packed for the JS thread and the tail of the live path). `points` is a point buffer as a
 * plain array (`POINT_STRIDE` numbers per point), `t` in ms.
 */
export function finishSamples(
  style: FreehandStyle,
  points: readonly number[],
  aspect: number,
  which: 'polygon' | 'parts',
  warmup: number,
  repeat: number,
): number[] {
  'worklet';
  const capture = createStrokeCapture(style, aspect);
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
  const finish = () => (which === 'parts' ? finishStrokeParts(capture) : finishStroke(capture));
  for (let run = 0; run < warmup; run++) finish();
  const samples: number[] = [];
  for (let run = 0; run < repeat; run++) {
    const start = performance.now();
    finish();
    samples.push(performance.now() - start);
  }
  return samples;
}

import { NO_PRESSURE, type Point, POINT_STRIDE, type PointBuffer, toPointBuffer } from '../points';

/**
 * Deterministic synthetic strokes that imitate score annotation on an A4 page with an Apple
 * Pencil at 240 Hz (or a finger at 120 Hz): fingerings, slurs, circles, hairpins, written
 * words and long scribbles, with hand tremor, sampling jitter and a pressure profile.
 *
 * They stand in for real captures until the device dev screen records some (ADR-008 §3);
 * `fixtures/strokes/` takes real ones in the same `Point[]` shape.
 */

const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;

/** Mulberry32: small, fast and good enough for test data. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticStroke {
  readonly name: string;
  readonly input: 'pen' | 'touch';
  readonly points: Point[];
}

interface PathOptions {
  readonly durationMs: number;
  readonly hz: number;
  readonly pen: boolean;
  /** Tremor amplitude in mm. */
  readonly tremor?: number;
}

/**
 * Samples `path(s)` (mm, s from 0 to 1) like a digitizer: jittered timestamps, tremor and a
 * pressure that rises at the start, wobbles and falls at the end.
 */
function sample(
  random: () => number,
  path: (s: number) => [number, number],
  options: PathOptions,
): Point[] {
  const points: Point[] = [];
  const period = 1000 / options.hz;
  const tremor = options.tremor ?? 0.04;
  const basePressure = 0.35 + random() * 0.3;
  let t = 0;
  while (t <= options.durationMs) {
    const s = t / options.durationMs;
    // Velocity is not uniform: slower at both ends, like a real hand.
    const eased = 0.5 - Math.cos(Math.PI * s) / 2;
    const [xMm, yMm] = path(eased);
    const rise = Math.min(1, s * 6) * Math.min(1, (1 - s) * 5);
    const pressure = options.pen
      ? Math.max(0.02, Math.min(1, basePressure * (0.4 + 0.6 * rise) + (random() - 0.5) * 0.06))
      : NO_PRESSURE;
    points.push([
      (xMm + (random() - 0.5) * tremor) / PAGE_WIDTH_MM,
      (yMm + (random() - 0.5) * tremor) / PAGE_HEIGHT_MM,
      pressure,
      t,
    ]);
    t += period * (0.92 + random() * 0.16);
  }
  return points;
}

/** A set of strokes a musician might draw on one page, from `seed`. */
export function syntheticStrokes(seed = 1): SyntheticStroke[] {
  const random = seededRandom(seed);
  const at = (): [number, number] => [20 + random() * 170, 30 + random() * 240];
  const strokes: SyntheticStroke[] = [];
  const pen = (name: string, path: (s: number) => [number, number], durationMs: number) => {
    strokes.push({
      name,
      input: 'pen',
      points: sample(random, path, { durationMs, hz: 240, pen: true }),
    });
  };

  for (let index = 0; index < 6; index++) {
    // Fingering "1": a short stem, 4 mm.
    const [x, y] = at();
    pen('fingering', (s) => [x + s * 0.6, y - s * 4], 110 + random() * 60);
  }
  for (let index = 0; index < 4; index++) {
    // Fingering "3": two bumps.
    const [x, y] = at();
    pen(
      'fingering-3',
      (s) => [x + 1.8 * Math.sin(s * 2 * Math.PI) ** 2 + 0.2, y - 4 + 4 * s],
      220 + random() * 80,
    );
  }
  for (let index = 0; index < 4; index++) {
    // Slur over a bar: an arc 25–60 mm wide.
    const [x, y] = at();
    const width = 25 + random() * 35;
    const height = width * (0.12 + random() * 0.1);
    pen('slur', (s) => [x + width * s, y - height * Math.sin(Math.PI * s)], 300 + width * 6);
  }
  for (let index = 0; index < 4; index++) {
    // Circle around a note, 8–14 mm, slightly more than one turn.
    const [x, y] = at();
    const radius = 4 + random() * 3;
    pen(
      'circle',
      (s) => [
        x + radius * Math.cos(s * 2.15 * Math.PI),
        y + radius * 0.8 * Math.sin(s * 2.15 * Math.PI),
      ],
      350 + random() * 150,
    );
  }
  for (let index = 0; index < 3; index++) {
    // Freehand hairpin: two lines from a point.
    const [x, y] = at();
    const length = 20 + random() * 25;
    pen('hairpin-upper', (s) => [x + length * s, y - 2.5 * s], 200 + length * 4);
    pen('hairpin-lower', (s) => [x + length * s, y + 2.5 * s], 200 + length * 4);
  }
  for (let index = 0; index < 3; index++) {
    // A written word ("rit.", "dolce"): a wavy line 15–30 mm with loops.
    const [x, y] = at();
    const length = 15 + random() * 15;
    pen(
      'word',
      (s) => [
        x + length * s + 1.2 * Math.cos(s * 18 * Math.PI),
        y + 2 * Math.sin(s * 18 * Math.PI) + 1.2 * Math.sin(s * 7 * Math.PI),
      ],
      900 + length * 40,
    );
  }
  {
    // A long scribble: about 8 s of continuous drawing (≈ 1,900 points).
    const [x, y] = at();
    pen(
      'scribble',
      (s) => [
        x + 15 * Math.sin(s * 23 * Math.PI) + s * 20,
        y + 12 * Math.sin(s * 31 * Math.PI + 1) + 6 * Math.cos(s * 5 * Math.PI),
      ],
      8000,
    );
  }
  for (let index = 0; index < 4; index++) {
    // Finger strokes at 120 Hz without pressure: a quick tick and a slur.
    const [x, y] = at();
    strokes.push({
      name: 'touch-slur',
      input: 'touch',
      points: sample(random, (s) => [x + 30 * s, y - 5 * Math.sin(Math.PI * s)], {
        durationMs: 350,
        hz: 120,
        pen: false,
        tremor: 0.15,
      }),
    });
  }
  return strokes;
}

/** A long pen stroke for benchmarks: `count` points at 240 Hz. */
export function longStroke(count: number, seed = 7): PointBuffer {
  const random = seededRandom(seed);
  // A little longer than needed: the jittered sampling may fall short of `count`.
  const durationMs = count * 1.1 * (1000 / 240);
  const points = sample(
    random,
    (s) => [
      105 + 80 * Math.sin(s * 40 * Math.PI) * Math.cos(s * 3 * Math.PI),
      148 + 110 * Math.sin(s * 29 * Math.PI + 0.5),
    ],
    { durationMs, hz: 240, pen: true },
  );
  return toPointBuffer(points.slice(0, count));
}

/**
 * A busy page: `count` pen strokes of 100 points spread over it in a 10-column grid. The
 * page of `perf-report`, the device bench and the web test reader (ADR-008 §7), so their
 * numbers compare.
 */
export function busyPageStrokes(count: number): PointBuffer[] {
  return Array.from({ length: count }, (_, index) => {
    const points = longStroke(100, index + 1);
    for (let offset = 0; offset < points.length; offset += POINT_STRIDE) {
      points[offset] = ((points[offset] ?? 0) * 0.2 + (index % 10) * 0.08) % 1;
      points[offset + 1] = ((points[offset + 1] ?? 0) * 0.1 + Math.floor(index / 10) * 0.018) % 1;
    }
    return points;
  });
}

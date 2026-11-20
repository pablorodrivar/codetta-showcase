import { OUTLINE_SCALE } from '../geometry/page-frame';
import { POINT_STRIDE } from '../points';
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
} from '../smoothing/outline';
import { outlineOptions } from '../smoothing/stroke';
import { longStroke } from './synthetic-strokes';

/**
 * Fingerprints of every outline the builder gives for a set of strokes, so a change to how it
 * stores its points can be checked to give the very same numbers (`outline.golden.json`,
 * `outline-golden.test.ts`). Each fingerprint hashes the IEEE 754 bytes of every value, in
 * order: any difference, even in the last bit, changes it.
 */

/** Stroke lengths of the check (ADR-008 §7): one and two points take the special cases. */
export const FINGERPRINT_LENGTHS = [1, 2, 100, 2000, 10_000] as const;

const TAPERED: OutlineOptions = {
  size: 3,
  thinning: 0.6,
  smoothing: 0.5,
  streamline: 0.35,
  simulatePressure: false,
  taperStart: 20,
  taperEnd: 20,
  capStart: true,
  capEnd: true,
};

/** The option sets: pen, finger (simulated pressure), highlighter, flat caps and tapers. */
export const FINGERPRINT_OPTIONS: Readonly<Record<string, OutlineOptions>> = {
  pen: outlineOptions({ type: 'stroke', input: 'pen', width: 0.003 }),
  touch: outlineOptions({ type: 'stroke', input: 'touch', width: 0.004 }),
  highlight: outlineOptions({ type: 'highlight', input: 'pen', width: 0.012 }),
  flat: outlineOptions({
    type: 'stroke',
    input: 'pen',
    width: 0.003,
    taperStart: false,
    taperEnd: false,
  }),
  tapered: TAPERED,
};

/** FNV-1a over bytes, 32 bits, as 8 hex digits, with the value count. */
class Fingerprint {
  #hash = 0x811c9dc5;
  #count = 0;
  readonly #view = new DataView(new ArrayBuffer(8));

  add(values: ArrayLike<number>): void {
    for (const value of Array.from(values)) {
      this.#view.setFloat64(0, value, true);
      for (let byte = 0; byte < 8; byte++) {
        this.#hash = Math.imul(this.#hash ^ this.#view.getUint8(byte), 0x01000193) >>> 0;
      }
    }
    this.#count += values.length;
  }

  /** Marks the end of a list, so [a, b][c] and [a][b, c] differ. */
  separate(): void {
    this.#hash = Math.imul(this.#hash ^ 0xff, 0x01000193) >>> 0;
  }

  toString(): string {
    return `${this.#hash.toString(16).padStart(8, '0')}:${String(this.#count)}`;
  }
}

/** `[x, y, pressure, …]` in outline units for a synthetic stroke of `count` points. */
function input(count: number): number[] {
  const points = longStroke(count, 11);
  const values: number[] = [];
  for (let offset = 0; offset < points.length; offset += POINT_STRIDE) {
    values.push(
      (points[offset] ?? 0) * OUTLINE_SCALE,
      (points[offset + 1] ?? 0) * 1.414 * OUTLINE_SCALE,
      points[offset + 2] ?? 0.5,
    );
  }
  return values;
}

export interface OutlineFingerprints {
  /** The finished outline in one go (`outlinePolygon`), as a stored stroke is prepared. */
  readonly prepared: string;
  /** The same outline assembled in parts of 7 points (`continueOutlinePolygon`, `PageJob`). */
  readonly inParts: string;
  /** Every event of drawing it: the committed chunks and the tail, then the final tail. */
  readonly live: string;
}

export function outlineFingerprints(): Record<string, OutlineFingerprints> {
  const result: Record<string, OutlineFingerprints> = {};
  for (const count of FINGERPRINT_LENGTHS) {
    const values = input(count);
    for (const [name, options] of Object.entries(FINGERPRINT_OPTIONS)) {
      const prepared = createOutlineBuilder(options);
      for (let offset = 0; offset < values.length; offset += 3) {
        addInputPoint(
          prepared,
          values[offset] ?? 0,
          values[offset + 1] ?? 0,
          values[offset + 2] ?? 0,
        );
      }
      const whole = new Fingerprint();
      whole.add(outlinePolygon(outlineParts(prepared, true)));

      const assembly = startOutlinePolygon(outlineParts(prepared, true));
      while (!continueOutlinePolygon(assembly, 7));
      const parts = new Fingerprint();
      parts.add(assembly.polygon ?? []);

      const live = new Fingerprint();
      const drawing = createOutlineBuilder(options);
      for (let offset = 0; offset < values.length; offset += 3) {
        addInputPoint(
          drawing,
          values[offset] ?? 0,
          values[offset + 1] ?? 0,
          values[offset + 2] ?? 0,
        );
        for (const chunk of takeCommittedChunks(drawing)) {
          live.add(chunk);
          live.separate();
        }
        live.add(tailPolygon(drawing, false));
        live.separate();
      }
      live.add(tailPolygon(drawing, true));

      result[`${name} ${String(count)}`] = {
        prepared: whole.toString(),
        inParts: parts.toString(),
        live: live.toString(),
      };
    }
  }
  return result;
}

import {
  addFreehandHitPoints,
  createFreehandHit,
  finishFreehandHit,
  type FreehandHitBuilder,
} from '../hit-test/eraser';
import { POINT_STRIDE } from '../points';
import type { Annotation } from '../schema/rows';
import { PACKED_HEADER } from '../smoothing/outline';
import { POINTS_PER_STEP } from './page-job';
import { type PreparedAnnotation, PreparedCache } from './prepare-page';

/** A stroke or a highlight, with its points decoded (as the reader keeps the one it just saved). */
export type FreehandAnnotation = Extract<Annotation, { type: 'stroke' | 'highlight' }>;

/**
 * One section of the packed outline, in polygon order: `outlinePolygon` is the committed left
 * side, the tail's left side and the end cap forwards, then the tail's right side and the
 * committed right side backwards (by points), then the start cap.
 */
interface Section {
  readonly offset: number;
  readonly length: number;
  readonly reversed: boolean;
}

function sectionsOf(packed: Float64Array): {
  readonly sections: readonly Section[];
  readonly dot: Section | null;
} {
  const lengths = Array.from(packed.subarray(0, PACKED_HEADER));
  const offsets: number[] = [];
  let offset = PACKED_HEADER;
  for (let index = 0; index < PACKED_HEADER; index++) {
    offsets.push(offset);
    offset += Math.max(0, lengths[index] ?? 0);
  }
  const at = (index: number, reversed: boolean): Section => ({
    offset: offsets[index] ?? PACKED_HEADER,
    length: Math.max(0, lengths[index] ?? 0),
    reversed,
  });
  const dotLength = lengths[6] ?? -1;
  return {
    // committed left, tail left, end cap, tail right (reversed), committed right (reversed),
    // start cap: the order of `outlinePolygon`.
    sections: [at(0, false), at(2, false), at(5, false), at(3, true), at(1, true), at(4, false)],
    dot: dotLength >= 0 ? at(6, false) : null,
  };
}

/**
 * The cache entry of a stroke just drawn in the app's reader (ADR-013 §5, ADR-008 §7), made
 * on the JS thread a few points at a time from what the UI runtime gave at pen up
 * (`finishStrokeParts`): the eraser box from the points, and the polygon from the packed outline
 * parts. Nothing is outlined again: the polygon is the live one, the same bit for bit as
 * `outlinePolygon` of those parts and as `freehandOutline` of the points. It is a frame task like
 * `PageJob`: `run` works until the budget is spent, at least one step, and true once the entry is
 * in the cache. The reader records the page again after that.
 */
export class FinishedStrokeJob {
  readonly #annotation: FreehandAnnotation;
  readonly #packed: Float64Array;
  readonly #aspect: number;
  readonly #cache: PreparedCache;
  readonly #stepPoints: number;
  readonly #hit: FreehandHitBuilder = createFreehandHit();
  readonly #sections: readonly Section[];
  #dot: Section | null;
  readonly #polygon: number[] = [];
  #hitNext = 0;
  #section = 0;
  /** Values of the current section already copied. */
  #copied = 0;
  #entry: { readonly key: string; readonly item: PreparedAnnotation } | null = null;

  constructor(
    annotation: FreehandAnnotation,
    parts: Float64Array,
    aspect: number,
    options: {
      readonly cache: PreparedCache;
      /** Points per step: {@link POINTS_PER_STEP} by default. */
      readonly stepPoints?: number;
    },
  ) {
    this.#annotation = annotation;
    this.#packed = parts;
    this.#aspect = aspect;
    this.#cache = options.cache;
    const step = options.stepPoints;
    this.#stepPoints = step !== undefined && step >= 1 ? Math.floor(step) : POINTS_PER_STEP;
    const { sections, dot } = sectionsOf(parts);
    this.#sections = sections;
    this.#dot = dot;
  }

  get done(): boolean {
    return this.#entry !== null;
  }

  /** The entry put in the cache, once done. */
  get entry(): { readonly key: string; readonly item: PreparedAnnotation } | null {
    return this.#entry;
  }

  run(budget: { readonly outOfTime: () => boolean }): boolean {
    let first = true;
    while (!this.done) {
      if (!first && budget.outOfTime()) break;
      first = false;
      this.#advance();
    }
    return this.done;
  }

  /** One step: points of the eraser box, then values of the polygon, then the entry. */
  #advance(): void {
    const points = this.#annotation.data.points;
    const count = Math.floor(points.length / POINT_STRIDE);
    if (this.#hitNext < count) {
      const to = Math.min(count, this.#hitNext + this.#stepPoints);
      addFreehandHitPoints(this.#hit, points, this.#hitNext, to, this.#aspect);
      this.#hitNext = to;
      return;
    }
    if (this.#dot) {
      const { offset, length } = this.#dot;
      for (let index = 0; index < length; index++) {
        this.#polygon.push(this.#packed[offset + index] ?? 0);
      }
      this.#dot = null;
      this.#section = this.#sections.length;
    }
    if (this.#section < this.#sections.length) {
      this.#copySome(this.#stepPoints * 2);
      return;
    }
    const annotation = this.#annotation;
    const key = PreparedCache.key(annotation.id, annotation.updated_at, this.#aspect);
    const item: PreparedAnnotation = {
      annotation,
      outline: this.#polygon,
      hit: finishFreehandHit(this.#hit, annotation),
    };
    this.#cache.set(key, item);
    this.#entry = { key, item };
  }

  /** Copies up to `values` values (whole points) of the sections, in polygon order. */
  #copySome(values: number): void {
    let left = values;
    const packed = this.#packed;
    const polygon = this.#polygon;
    while (left > 0 && this.#section < this.#sections.length) {
      const section = this.#sections[this.#section];
      if (!section) break;
      const take = Math.min(left, section.length - this.#copied);
      if (section.reversed) {
        // Pairs from the last one back, like `pushReversed`.
        for (let done = 0; done < take; done += 2) {
          const index = section.offset + section.length - 2 - (this.#copied + done);
          polygon.push(packed[index] ?? 0, packed[index + 1] ?? 0);
        }
      } else {
        const start = section.offset + this.#copied;
        for (let index = start; index < start + take; index++) polygon.push(packed[index] ?? 0);
      }
      this.#copied += take;
      left -= take;
      if (this.#copied >= section.length) {
        this.#section++;
        this.#copied = 0;
      }
    }
  }
}

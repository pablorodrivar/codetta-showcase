import { PointsDecoder } from '../codec/points-codec';
import { OUTLINE_SCALE } from '../geometry/page-frame';
import {
  addFreehandHitPoints,
  createFreehandHit,
  finishFreehandHit,
  type FreehandHitBuilder,
  hitTarget,
  type HitTestOptions,
} from '../hit-test/eraser';
import { NO_PRESSURE, POINT_STRIDE, type PointBuffer } from '../points';
import { type Annotation, type DeferredFreehand, parseAnnotationRowDeferred } from '../schema/rows';
import {
  addInputPoint,
  continueOutlinePolygon,
  createOutlineBuilder,
  type OutlineBuilder,
  outlineParts,
  type OutlinePolygonAssembly,
  outlinePolygonProgress,
  startOutlinePolygon,
} from '../smoothing/outline';
import { outlineOptions } from '../smoothing/stroke';
import { type PreparedAnnotation, PreparedCache } from './prepare-page';

/**
 * Preparing a page in two phases, never during a page turn (ADR-008 §7, ADR-013 §4–§5):
 *
 * 1. With only `id` and `updated_at` of the page's rows (a short query), `pageFromCache`
 *    builds the page from what is already prepared and lists the rows that are not.
 * 2. Only those rows are read in full, and a `PageJob` prepares them a few points at a time
 *    (validation, decoding, outline, eraser box), putting each into the cache as it finishes.
 *    It is a frame task: `run` stops when the frame's budget is spent, also in the middle of
 *    a long stroke, and goes on at the next call. Every part of a stroke goes by points (decode,
 *    outline and eraser box, then the polygon), so no step walks a whole long stroke, and each
 *    step takes as many points as fit in what is left of the chunk (ADR-008 §7, 15/11/2026).
 *
 * Then `pageFromCache` again gives the whole page. `preparePage` stays for the web test reader
 * and the bench: the same result in one go.
 */

/** What phase 1 reads of each row. */
export interface RowRef {
  readonly id: string;
  readonly updated_at: string;
}

/** Points per step without a clock (tests, or a caller without `now`); also the first guess. */
export const POINTS_PER_STEP = 256;
/** Bounds of a step with a clock, in points. */
const MIN_POINTS_PER_STEP = 16;
const MAX_POINTS_PER_STEP = 4096;
/**
 * Longest a step aims for, in ms. Short steps keep a chunk from overshooting its budget when a
 * guess is off, and leave room for the page turn's input between them.
 */
export const STEP_TARGET_MS = 1;
/**
 * Left unused at the end of a chunk, in ms: for the clock, a misjudged step and small collector
 * pauses, so a chunk ends a little before its budget instead of on it.
 */
export const CHUNK_RESERVE_MS = 1.5;

type Phase = 'decode' | 'feed' | 'polygon' | 'close';

/**
 * First guesses of the cost per point (and per character of a row), in ms, from Hermes on the
 * emulator (ADR-008 §7); each job learns its own from what it measures.
 */
const FIRST_GUESS: Readonly<Record<Phase | 'row', number>> = {
  decode: 0.006,
  feed: 0.012,
  polygon: 0.003,
  close: 0.001,
  row: 0.00004,
};
/** Rows shorter than this are counted as this long (the fixed part of JSON, Zod and the rest). */
const MIN_ROW_CHARS = 2000;

/**
 * The page from the cache: the prepared annotations of `refs` (in draw order: `z`, then id)
 * and the ids still to prepare. Costs a lookup per row.
 */
export function pageFromCache(
  refs: readonly RowRef[],
  aspect: number,
  cache: PreparedCache,
): { readonly items: PreparedAnnotation[]; readonly missing: string[] } {
  const items: PreparedAnnotation[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const item = cache.get(PreparedCache.key(ref.id, ref.updated_at, aspect));
    if (item) items.push(item);
    else missing.push(ref.id);
  }
  items.sort(
    (a, b) =>
      a.annotation.z - b.annotation.z ||
      (a.annotation.id < b.annotation.id ? -1 : a.annotation.id > b.annotation.id ? 1 : 0),
  );
  return { items, missing };
}

interface Stroke {
  readonly annotation: DeferredFreehand;
  readonly key: string;
  readonly decoder: PointsDecoder;
  points: PointBuffer | null;
  builder: OutlineBuilder | null;
  hit: FreehandHitBuilder | null;
  /** Next point to feed the outline builder and the eraser box. */
  next: number;
  /** The polygon being assembled, once every point is in the builder. */
  polygon: OutlinePolygonAssembly | null;
}

/**
 * Prepares rows a few points at a time (phase 2). `rows` are the full rows that were missing,
 * as SQLite returns them (objects, `data` as JSON text) or as JSON text. Each row it prepares
 * goes into `cache`; bad and unsupported rows are counted and left out, like `preparePage`.
 */
export class PageJob {
  readonly #rows: readonly unknown[];
  readonly #aspect: number;
  readonly #cache: PreparedCache;
  readonly #hitTest: HitTestOptions | undefined;
  readonly #reserveMs: number;
  #next = 0;
  #stroke: Stroke | null = null;
  /** Learned cost per point of each phase, and per character of a row, in ms. */
  readonly #cost: Record<Phase | 'row', number> = { ...FIRST_GUESS };
  readonly invalid: { readonly id: string | null; readonly issues: readonly string[] }[] = [];
  /**
   * Rows from a newer app (a type, version or anchor this one does not know): kept in the
   * database, never drawn. The caller leaves them out of the next `pageFromCache`, or they would
   * be read and validated again on every visit.
   */
  readonly unsupportedIds: string[] = [];
  unsupported = 0;
  prepared = 0;

  constructor(
    rows: readonly unknown[],
    aspect: number,
    options: {
      readonly cache: PreparedCache;
      readonly hitTest?: HitTestOptions;
      /**
       * What each chunk leaves unused, in ms; {@link CHUNK_RESERVE_MS} by default. A larger one
       * (3 ms) is for measuring whether the collector's pauses are what passes a chunk over its
       * budget (ADR-008 §7); the reader does not pass it yet.
       */
      readonly reserveMs?: number;
    },
  ) {
    this.#rows = rows;
    this.#aspect = aspect;
    this.#cache = options.cache;
    this.#hitTest = options.hitTest;
    const reserve = options.reserveMs;
    this.#reserveMs =
      reserve !== undefined && Number.isFinite(reserve) && reserve >= 0
        ? reserve
        : CHUNK_RESERVE_MS;
  }

  get done(): boolean {
    return this.#stroke === null && this.#next >= this.#rows.length;
  }

  /**
   * Works until the budget is spent (at least one step); true when every row is done. With the
   * scheduler's `now` and `remainingMs` (the app's `FrameBudget`), each step takes the
   * points that fit in what is left (up to {@link STEP_TARGET_MS}, keeping
   * the reserve, {@link CHUNK_RESERVE_MS} by default), and the job stops before a step that would not fit, so a chunk
   * stays within its 8 ms. Without `now`, a step is {@link POINTS_PER_STEP} points.
   */
  run(budget: {
    readonly outOfTime: () => boolean;
    readonly now?: () => number;
    readonly remainingMs?: () => number;
  }): boolean {
    const { now, remainingMs } = budget;
    let first = true;
    while (!this.done) {
      if (!first && budget.outOfTime()) break;
      const room = remainingMs ? remainingMs() - this.#reserveMs : STEP_TARGET_MS;
      const target = Math.min(STEP_TARGET_MS, room);
      const stroke = this.#stroke;
      let phase: Phase | 'row';
      let size: number;
      if (stroke) {
        phase = strokePhase(stroke);
        if (phase === 'close') {
          // Joining the polygon and finishing cannot be cut: like a row, it waits for room.
          size = stroke.polygon ? outlinePolygonProgress(stroke.polygon).total : 0;
          if (now && !first && !(size * this.#cost.close <= room)) break;
        } else {
          size = now
            ? Math.min(MAX_POINTS_PER_STEP, Math.floor(target / this.#cost[phase]))
            : POINTS_PER_STEP;
          // `!(… >= …)` also catches NaN (a clock or a budget that gives NaN).
          if (!(size >= MIN_POINTS_PER_STEP)) {
            if (!first) break;
            size = MIN_POINTS_PER_STEP;
          }
        }
      } else {
        phase = 'row';
        size = Math.max(MIN_ROW_CHARS, rowLength(this.#rows[this.#next]));
        // A row cannot be cut: do not start one that might not fit in what is left.
        if (now && !first && !(size * this.#cost.row <= room)) break;
      }
      first = false;
      const start = now?.() ?? 0;
      const done = stroke
        ? this.#advanceStroke(stroke, phase as Phase, size)
        : this.#startRow(this.#rows[this.#next++]);
      if (now && done > 0) this.#learn(phase, (now() - start) / done);
    }
    return this.done;
  }

  /**
   * A measured cost per unit: up quickly, so a slow step does not repeat at once, and down
   * slowly; a collector pause is forgotten after a few steps.
   */
  #learn(phase: Phase | 'row', perUnit: number): void {
    // A clock that went back or gave NaN teaches nothing.
    if (!Number.isFinite(perUnit) || perUnit < 0) return;
    const cost = this.#cost[phase];
    this.#cost[phase] = perUnit > cost ? (cost + perUnit) / 2 : cost * 0.8 + perUnit * 0.2;
  }

  /** Reads one row; returns its length in characters, the unit of its cost. */
  #startRow(value: unknown): number {
    const length = Math.max(MIN_ROW_CHARS, rowLength(value));
    let raw: unknown = value;
    if (typeof value === 'string') {
      try {
        raw = JSON.parse(value);
      } catch {
        this.invalid.push({ id: null, issues: ['row: not JSON'] });
        return length;
      }
    }
    const parsed = parseAnnotationRowDeferred(raw);
    if (parsed.status === 'invalid') {
      this.invalid.push({ id: parsed.id, issues: parsed.issues });
      return length;
    }
    if (parsed.status === 'unsupported') {
      this.unsupported++;
      this.unsupportedIds.push(parsed.row.id);
      return length;
    }
    const key = PreparedCache.key(parsed.annotation.id, parsed.annotation.updated_at, this.#aspect);
    if (parsed.status === 'ok') {
      this.#finish(key, parsed.annotation, null);
      return length;
    }
    const decoder = PointsDecoder.start(parsed.annotation.data.points);
    if (!(decoder instanceof PointsDecoder)) {
      this.invalid.push({ id: parsed.annotation.id, issues: [`data.points: ${decoder.error}`] });
      return length;
    }
    this.#stroke = {
      annotation: parsed.annotation,
      key,
      decoder,
      points: null,
      builder: null,
      hit: null,
      next: 0,
      polygon: null,
    };
    return length;
  }

  /**
   * One step of a stroke, `size` points of `phase`: decode; then feed the outline builder and the
   * eraser box; then assemble the polygon and finish. Returns the points it went through.
   */
  #advanceStroke(stroke: Stroke, phase: Phase, size: number): number {
    if (phase === 'decode') {
      const before = stroke.decoder.progress.done;
      const result = stroke.decoder.decodeMore(size);
      const decoded = stroke.decoder.progress.done - before;
      if (result === null) return decoded;
      if (!result.ok) {
        this.invalid.push({ id: stroke.annotation.id, issues: [`data.points: ${result.error}`] });
        this.#stroke = null;
        return decoded;
      }
      stroke.points = result.points;
      stroke.builder = createOutlineBuilder(
        outlineOptions({ ...stroke.annotation.data, type: stroke.annotation.type }),
      );
      stroke.hit = createFreehandHit();
      return decoded;
    }
    const points = stroke.points;
    const builder = stroke.builder;
    const hit = stroke.hit;
    if (!points || !builder || !hit) return 0;
    const aspect = this.#aspect;
    if (phase === 'feed') {
      const from = stroke.next;
      const to = Math.min(points.length / POINT_STRIDE, from + size);
      for (let offset = from * POINT_STRIDE; offset < to * POINT_STRIDE; offset += POINT_STRIDE) {
        addInputPoint(
          builder,
          (points[offset] ?? 0) * OUTLINE_SCALE,
          (points[offset + 1] ?? 0) * aspect * OUTLINE_SCALE,
          points[offset + 2] ?? NO_PRESSURE,
        );
      }
      addFreehandHitPoints(hit, points, from, to, aspect);
      stroke.next = to;
      return to - from;
    }
    if (phase === 'polygon') {
      // First the tail of the outline (`outlineParts`, a few points: not learned from), then the
      // right side reversed by parts.
      if (!stroke.polygon) {
        stroke.polygon = startOutlinePolygon(outlineParts(builder, true));
        return 0;
      }
      const before = stroke.polygon.reversed;
      continueOutlinePolygon(stroke.polygon, size);
      return stroke.polygon.reversed - before;
    }
    // 'close': the whole polygon in one `concat`, the eraser box and the cache.
    const assembly = stroke.polygon;
    if (!assembly) return 0;
    continueOutlinePolygon(assembly, size);
    const outline = assembly.polygon ?? [];
    const annotation = {
      ...stroke.annotation,
      data: { ...stroke.annotation.data, points },
    } as Extract<Annotation, { type: 'stroke' | 'highlight' }>;
    this.#cache.set(stroke.key, {
      annotation,
      outline,
      hit: finishFreehandHit(hit, annotation),
    });
    this.prepared++;
    this.#stroke = null;
    return Math.max(1, outline.length / 2);
  }

  #finish(key: string, annotation: Annotation, outline: readonly number[] | null): void {
    this.#cache.set(key, {
      annotation,
      outline,
      hit: hitTarget(annotation, this.#aspect, this.#hitTest),
    });
    this.prepared++;
  }
}

/** What a stroke does next: decode, feed the outline, reverse the polygon's side, or close. */
function strokePhase(stroke: Stroke): Phase {
  if (!stroke.points) return 'decode';
  if (stroke.next < stroke.points.length / POINT_STRIDE) return 'feed';
  if (!stroke.polygon || outlinePolygonProgress(stroke.polygon).toReverse > 0) return 'polygon';
  return 'close';
}

/** Characters of a row as it was read (JSON text, or the `data` text of a row object). */
function rowLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (typeof value === 'object' && value !== null) {
    const data = (value as { data?: unknown }).data;
    if (typeof data === 'string') return data.length;
  }
  return 0;
}

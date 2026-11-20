import { type HitTarget, hitTarget, type HitTestOptions } from '../hit-test/eraser';
import { type Annotation, parseAnnotationRow } from '../schema/rows';
import { freehandOutline } from '../smoothing/stroke';

/** One annotation ready to draw and to erase. */
export interface PreparedAnnotation {
  readonly annotation: Annotation;
  /** Outline polygon of a stroke or highlight, in outline units; null for other types. */
  readonly outline: readonly number[] | null;
  readonly hit: HitTarget;
}

export interface PreparationTimings {
  /** Reading the rows: JSON, Zod and decoding the points. */
  readonly read: number;
  readonly outlines: number;
  readonly hitTargets: number;
  readonly total: number;
}

export interface PreparedPage {
  readonly aspect: number;
  /** Drawable annotations by `z` (then id). */
  readonly items: readonly PreparedAnnotation[];
  readonly unsupported: number;
  readonly invalid: readonly { readonly id: string | null; readonly issues: readonly string[] }[];
  readonly timings: PreparationTimings;
  /** Annotations taken from the cache instead of prepared again. */
  readonly cached: number;
}

/**
 * Prepared annotations by `(id, updated_at)` and page aspect: a row is prepared again only
 * when it changes (ADR-008 §7), never on a page turn or a zoom.
 */
export class PreparedCache {
  readonly #items = new Map<string, PreparedAnnotation>();

  static key(id: string, updatedAt: string, aspect: number): string {
    return `${id}|${updatedAt}|${aspect}`;
  }

  get(key: string): PreparedAnnotation | undefined {
    return this.#items.get(key);
  }

  set(key: string, item: PreparedAnnotation): void {
    this.#items.set(key, item);
  }

  /** Drops the entries not in `keep` (rows changed or left the window of pages). */
  retain(keep: ReadonlySet<string>): void {
    for (const key of this.#items.keys()) if (!keep.has(key)) this.#items.delete(key);
  }

  get size(): number {
    return this.#items.size;
  }
}

function rowKey(raw: unknown, aspect: number): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { id, updated_at: updatedAt } = raw as { id?: unknown; updated_at?: unknown };
  return typeof id === 'string' && typeof updatedAt === 'string'
    ? PreparedCache.key(id, updatedAt, aspect)
    : null;
}

/**
 * Everything a page needs before it is shown (ADR-008 §7): read the rows, build the stroke
 * outlines and the eraser's hit targets. `rows` are objects, or JSON text as the local
 * SQLite returns them (the 300-stroke benchmark passes text to compare with `perf-report`).
 * The clock is injected so tests do not depend on time.
 */
export function preparePage(
  rows: readonly unknown[],
  aspect: number,
  options: {
    readonly now: () => number;
    readonly cache?: PreparedCache;
    readonly hitTest?: HitTestOptions;
  },
): PreparedPage {
  const { now, cache } = options;
  const start = now();
  const items: PreparedAnnotation[] = [];
  const fresh: { annotation: Annotation; key: string | null }[] = [];
  const invalid: { id: string | null; issues: readonly string[] }[] = [];
  let unsupported = 0;
  let cached = 0;
  for (const value of rows) {
    let raw: unknown = value;
    if (typeof value === 'string') {
      // A corrupt row is left out and reported like one that fails Zod, never breaking the page.
      try {
        raw = JSON.parse(value);
      } catch {
        invalid.push({ id: null, issues: ['row: not JSON'] });
        continue;
      }
    }
    const key = rowKey(raw, aspect);
    const hit = key && cache ? cache.get(key) : undefined;
    if (hit) {
      items.push(hit);
      cached++;
      continue;
    }
    const parsed = parseAnnotationRow(raw);
    if (parsed.status === 'ok') fresh.push({ annotation: parsed.annotation, key });
    else if (parsed.status === 'unsupported') unsupported++;
    else invalid.push({ id: parsed.id, issues: parsed.issues });
  }
  const afterRead = now();
  const outlines = fresh.map(({ annotation }) =>
    annotation.type === 'stroke' || annotation.type === 'highlight'
      ? freehandOutline(
          { ...annotation.data, type: annotation.type },
          annotation.data.points,
          aspect,
        )
      : null,
  );
  const afterOutlines = now();
  fresh.forEach(({ annotation, key }, index) => {
    const item = {
      annotation,
      outline: outlines[index] ?? null,
      hit: hitTarget(annotation, aspect, options.hitTest),
    };
    items.push(item);
    if (key && cache) cache.set(key, item);
  });
  const end = now();
  items.sort(
    (a, b) =>
      a.annotation.z - b.annotation.z ||
      (a.annotation.id < b.annotation.id ? -1 : a.annotation.id > b.annotation.id ? 1 : 0),
  );
  return {
    aspect,
    items,
    unsupported,
    invalid,
    cached,
    timings: {
      read: afterRead - start,
      outlines: afterOutlines - afterRead,
      hitTargets: end - afterOutlines,
      total: end - start,
    },
  };
}

/**
 * The cache entry of a stroke just drawn, with the outline `finishStroke` took from the live one
 * (ADR-013 §5): the page shows it from the cache at once, and it is never prepared again until
 * the row changes. `annotation` is the saved row with its points decoded.
 */
export function preparedFinishedStroke(
  annotation: Annotation,
  outline: readonly number[],
  aspect: number,
  hitTest?: HitTestOptions,
): { readonly key: string; readonly item: PreparedAnnotation } {
  return {
    key: PreparedCache.key(annotation.id, annotation.updated_at, aspect),
    item: { annotation, outline, hit: hitTarget(annotation, aspect, hitTest) },
  };
}

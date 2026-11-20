import { shapePolylines } from '../geometry/shapes';
import { TEXT_LINE_HEIGHT } from '../geometry/text-and-stamps';
import { POINT_STRIDE, type PointBuffer } from '../points';
import type { Annotation, LayerRow } from '../schema/rows';
import { outlineOptions } from '../smoothing/stroke';
import { STAMP_BASE_SIZE } from '../stamps/catalog';

/**
 * Whole-annotation eraser (ADR-008 §5). Everything is in width units (`x`, `y · aspect`),
 * where distances are the same across and down the page.
 *
 * The eraser moves as a capsule: each move event tests the segment from the previous
 * position to the current one, widened by the eraser's radius, so a fast swipe never skips
 * a stroke between two events. Freehand annotations test against their input polyline
 * widened by their drawn half width at full pressure; shapes against their centre lines; text and stamps against
 * their box. A cheap bounding-box check comes first.
 *
 * The partial eraser ("by area") arrives in 1.1: it will cut strokes into new
 * rows with `taperStart` / `taperEnd` false at the cuts.
 */

type Bounds = [minX: number, minY: number, maxX: number, maxY: number];

export interface HitTarget {
  readonly annotation: Annotation;
  readonly bounds: Bounds;
  /** Polylines in width units, or a filled box for text and stamps. */
  readonly polylines: readonly (readonly number[])[];
  readonly box: Bounds | null;
  /** Half the line thickness. */
  readonly radius: number;
}

export interface HitTestOptions {
  /**
   * Measured size of a text annotation in width units, when the renderer knows it. Without
   * it the box is estimated from the font size and the character count.
   */
  readonly measureText?: (annotation: Extract<Annotation, { type: 'text' }>) => {
    width: number;
    height: number;
  };
}

/** Average advance of a Latin character, in font sizes (Inter is about 0.55). */
const AVERAGE_CHARACTER_WIDTH = 0.6;

function emptyBounds(): Bounds {
  return [Infinity, Infinity, -Infinity, -Infinity];
}

function grow(bounds: Bounds, x: number, y: number): void {
  if (x < bounds[0]) bounds[0] = x;
  if (y < bounds[1]) bounds[1] = y;
  if (x > bounds[2]) bounds[2] = x;
  if (y > bounds[3]) bounds[3] = y;
}

function inflate(bounds: Bounds, by: number): Bounds {
  return [bounds[0] - by, bounds[1] - by, bounds[2] + by, bounds[3] + by];
}

function textBox(
  annotation: Extract<Annotation, { type: 'text' }>,
  aspect: number,
  options: HitTestOptions,
): Bounds {
  const { data } = annotation;
  let width: number;
  let height: number;
  if (options.measureText) {
    ({ width, height } = options.measureText(annotation));
  } else {
    const characterWidth = data.fontSize * AVERAGE_CHARACTER_WIDTH;
    const paragraphs = data.text.split('\n');
    const widest = Math.max(...paragraphs.map((paragraph) => paragraph.length)) * characterWidth;
    const lines = data.maxWidth
      ? paragraphs.reduce(
          (sum, paragraph) =>
            sum +
            Math.max(1, Math.ceil((paragraph.length * characterWidth) / (data.maxWidth ?? 1))),
          0,
        )
      : paragraphs.length;
    width = data.maxWidth ? Math.min(data.maxWidth, widest) : widest;
    height = lines * data.fontSize * TEXT_LINE_HEIGHT;
  }
  const x = data.x;
  const y = data.y * aspect;
  return [x, y, x + width, y + height];
}

/**
 * The hit target of a stroke or highlight, built a few points at a time so that preparing a long
 * stroke never walks all of it in one step (ADR-008 §7, 15/11/2026): `addFreehandHitPoints` for
 * each part of the points, then `finishFreehandHit`. `hitTarget` builds it the same way, in one go.
 */
export interface FreehandHitBuilder {
  readonly line: number[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function createFreehandHit(): FreehandHitBuilder {
  return { line: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

/** Adds the points `from` to `to` (point indexes, `to` clamped to the end) of `points`. */
export function addFreehandHitPoints(
  builder: FreehandHitBuilder,
  points: PointBuffer,
  from: number,
  to: number,
  aspect: number,
): void {
  const line = builder.line;
  let { minX, minY, maxX, maxY } = builder;
  const end = Math.min(Math.floor(points.length / POINT_STRIDE), to) * POINT_STRIDE;
  // In Hermes a call per point (`grow`) cost more than the point itself: the box is inline.
  for (let offset = from * POINT_STRIDE; offset < end; offset += POINT_STRIDE) {
    const x = points[offset] ?? 0;
    const y = (points[offset + 1] ?? 0) * aspect;
    line.push(x, y);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  builder.minX = minX;
  builder.minY = minY;
  builder.maxX = maxX;
  builder.maxY = maxY;
}

export function finishFreehandHit(
  builder: FreehandHitBuilder,
  annotation: Extract<Annotation, { type: 'stroke' | 'highlight' }>,
): HitTarget {
  // The drawn half width at full pressure: `size · (0.5 + thinning / 2)` (outline.ts), so the
  // visible edge of a heavy stroke erases too. The streamline lag between the drawn line and the
  // input is a fraction of that and is covered by the eraser radius.
  const { thinning } = outlineOptions({ ...annotation.data, type: annotation.type });
  const radius = (annotation.data.width / 2) * (1 + Math.abs(thinning));
  const bounds = inflate([builder.minX, builder.minY, builder.maxX, builder.maxY], radius);
  return { annotation, bounds, polylines: [builder.line], box: null, radius };
}

/** Precomputes what the eraser needs for one annotation (cache it with the page). */
export function hitTarget(
  annotation: Annotation,
  aspect: number,
  options: HitTestOptions = {},
): HitTarget {
  switch (annotation.type) {
    case 'stroke':
    case 'highlight': {
      const builder = createFreehandHit();
      addFreehandHitPoints(builder, annotation.data.points, 0, Infinity, aspect);
      return finishFreehandHit(builder, annotation);
    }
    case 'shape': {
      const { polylines } = shapePolylines(annotation.data, aspect);
      const bounds = emptyBounds();
      for (const line of polylines) {
        for (let index = 0; index + 1 < line.length; index += 2) {
          grow(bounds, line[index] ?? 0, line[index + 1] ?? 0);
        }
      }
      const radius = annotation.data.width / 2;
      return { annotation, bounds: inflate(bounds, radius), polylines, box: null, radius };
    }
    case 'stamp': {
      const half = (STAMP_BASE_SIZE * annotation.data.scale) / 2;
      const x = annotation.data.x;
      const y = annotation.data.y * aspect;
      const box: Bounds = [x - half, y - half, x + half, y + half];
      return { annotation, bounds: box, polylines: [], box, radius: 0 };
    }
    case 'text': {
      const box = textBox(annotation, aspect, options);
      return { annotation, bounds: box, polylines: [], box, radius: 0 };
    }
  }
}

function pointSegmentDistance2(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  let t = length2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / length2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx - px;
  const cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Squared distance between segments AB and CD. */
export function segmentDistance2(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    pointSegmentDistance2(ax, ay, cx, cy, dx, dy),
    pointSegmentDistance2(bx, by, cx, cy, dx, dy),
    pointSegmentDistance2(cx, cy, ax, ay, bx, by),
    pointSegmentDistance2(dx, dy, ax, ay, bx, by),
  );
}

function boxDistance2(box: Bounds, ax: number, ay: number, bx: number, by: number): number {
  const inside = (x: number, y: number) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
  if (inside(ax, ay) || inside(bx, by)) return 0;
  const [x0, y0, x1, y1] = box;
  return Math.min(
    segmentDistance2(ax, ay, bx, by, x0, y0, x1, y0),
    segmentDistance2(ax, ay, bx, by, x1, y0, x1, y1),
    segmentDistance2(ax, ay, bx, by, x1, y1, x0, y1),
    segmentDistance2(ax, ay, bx, by, x0, y1, x0, y0),
  );
}

/** Whether the eraser capsule from A to B (width units) with `radius` touches the target. */
export function eraserTouches(
  target: HitTarget,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): boolean {
  const [minX, minY, maxX, maxY] = target.bounds;
  if (
    Math.max(ax, bx) + radius < minX ||
    Math.min(ax, bx) - radius > maxX ||
    Math.max(ay, by) + radius < minY ||
    Math.min(ay, by) - radius > maxY
  ) {
    return false;
  }
  if (target.box) return boxDistance2(target.box, ax, ay, bx, by) <= radius * radius;
  const reach = radius + target.radius;
  const reach2 = reach * reach;
  for (const line of target.polylines) {
    if (line.length === 2) {
      if (pointSegmentDistance2(line[0] ?? 0, line[1] ?? 0, ax, ay, bx, by) <= reach2) return true;
      continue;
    }
    for (let index = 0; index + 3 < line.length; index += 2) {
      const distance = segmentDistance2(
        ax,
        ay,
        bx,
        by,
        line[index] ?? 0,
        line[index + 1] ?? 0,
        line[index + 2] ?? 0,
        line[index + 3] ?? 0,
      );
      if (distance <= reach2) return true;
    }
  }
  return false;
}

/**
 * The annotations an eraser move touches, in the order given. `from` and `to` are normalized
 * page points (the previous and current eraser positions); `radius` is in width units
 * (pixels / `View.scale`).
 */
export function eraseHits(
  targets: readonly HitTarget[],
  from: readonly [number, number],
  to: readonly [number, number],
  radius: number,
  aspect: number,
  isErasable: (annotation: Annotation) => boolean = () => true,
): string[] {
  const ax = from[0];
  const ay = from[1] * aspect;
  const bx = to[0];
  const by = to[1] * aspect;
  const hits: string[] = [];
  for (const target of targets) {
    if (isErasable(target.annotation) && eraserTouches(target, ax, ay, bx, by, radius)) {
      hits.push(target.annotation.id);
    }
  }
  return hits;
}

/**
 * The default eraser filter: live annotations on live, visible, unlocked layers. Hidden
 * layers are never erased by accident; locked ones are what locking is for.
 */
export function erasableOn(
  layers: readonly Pick<LayerRow, 'id' | 'visible' | 'locked' | 'deleted_at'>[],
): (annotation: Annotation) => boolean {
  const open = new Set(
    layers
      .filter((layer) => layer.visible && !layer.locked && layer.deleted_at === null)
      .map((layer) => layer.id),
  );
  return (annotation) => annotation.deleted_at === null && open.has(annotation.layer_id);
}

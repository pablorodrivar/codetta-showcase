import type { Matrix } from '../geometry/matrix';
import { OUTLINE_SCALE } from '../geometry/page-frame';
import { shapePolylines } from '../geometry/shapes';
import { STAMP_EM_PER_BOX, TEXT_BASELINE, TEXT_LINE_HEIGHT } from '../geometry/text-and-stamps';
import type { PreparedAnnotation } from '../page/prepare-page';
import { highlighterInkColor, penInkColor } from '../schema/ink';
import type { Annotation } from '../schema/rows';
import { type SmuflGlyph, STAMP_BASE_SIZE, stampSymbolDrawing } from '../stamps/catalog';
import { SMUFL_OUTLINES, SMUFL_UNITS_PER_EM } from '../stamps/generated/smufl-outlines';

/**
 * A page's annotations as a list of drawing operations, for the app's Skia layer (ADR-013 §5):
 * what to fill, stroke and write, in order, with the inks resolved. Pure, so what the reader draws
 * is tested in Node; the app turns each operation into Skia calls while recording the page's
 * picture.
 *
 * Everything is in outline units (page width = `OUTLINE_SCALE`, `y` down), the space of the
 * prepared outlines; the view's `outlineMatrix` places it on screen.
 *
 * Order: highlighters first, under the ink, in one group per ink (each painted opaque, the group
 * composited with the ink's opacity: overlaps of the same ink never darken, and a page has a
 * group per ink used instead of a layer per stroke; decided 14/11/2026); then pen strokes,
 * shapes, text and stamps in the order given (layer, then `z`).
 */

/**
 * A path as numbers: `0 x y` move, `1 x y` line, `2 x1 y1 x2 y2 x y` cubic, `3` close.
 */
export type PaintPath = readonly number[];

export const PATH_MOVE = 0;
export const PATH_LINE = 1;
export const PATH_CUBIC = 2;
export const PATH_CLOSE = 3;

export type PaintOp =
  /** A closed polygon `[x0, y0, x1, y1, …]`, filled nonzero (a stroke's outline). */
  | { readonly kind: 'fill'; readonly color: string; readonly polygon: readonly number[] }
  /** Polylines with round caps and joins (shapes, the symbol stamps). */
  | {
      readonly kind: 'stroke';
      readonly color: string;
      readonly width: number;
      readonly polylines: readonly (readonly number[])[];
      readonly closed: boolean;
    }
  /** A glyph's path in font units (`y` up), filled nonzero through `matrix`. */
  | {
      readonly kind: 'glyph';
      readonly color: string;
      readonly path: PaintPath;
      readonly matrix: Matrix;
    }
  /** Text in the UI font (Inter): each line at `x` and its baseline, `size` the font size. */
  | {
      readonly kind: 'text';
      readonly color: string;
      readonly size: number;
      readonly x: number;
      readonly lines: readonly { readonly text: string; readonly baseline: number }[];
    }
  /** Operations painted together and composited once with `opacity` (a highlighter ink). */
  | { readonly kind: 'group'; readonly opacity: number; readonly ops: readonly PaintOp[] };

const glyphPaths = new Map<SmuflGlyph, PaintPath>();

/**
 * A PDF path (`x y m`, `x y l`, `x1 y1 x2 y2 x y c`, `h`) as a `PaintPath`, unchanged in its
 * units. Throws on another operator: the generated outlines use only these.
 */
export function parsePdfPath(text: string): PaintPath {
  const path: number[] = [];
  const operands: number[] = [];
  for (const token of text.split(/\s+/)) {
    if (token === '') continue;
    switch (token) {
      case 'm':
      case 'l':
        if (operands.length !== 2) throw new Error(`${token} needs 2 operands`);
        path.push(token === 'm' ? PATH_MOVE : PATH_LINE, ...operands);
        break;
      case 'c':
        if (operands.length !== 6) throw new Error('c needs 6 operands');
        path.push(PATH_CUBIC, ...operands);
        break;
      case 'h':
        if (operands.length !== 0) throw new Error('h takes no operands');
        path.push(PATH_CLOSE);
        break;
      default: {
        const value = Number(token);
        if (!Number.isFinite(value)) throw new Error(`Unknown PDF path token ${token}`);
        operands.push(value);
        continue;
      }
    }
    operands.length = 0;
  }
  if (operands.length > 0) throw new Error('Operands left at the end of the path');
  return path;
}

/** The glyph's outline from Bravura (the same shapes as the annotated PDF), parsed once. */
export function smuflGlyphPath(glyph: SmuflGlyph): PaintPath {
  let path = glyphPaths.get(glyph);
  if (!path) {
    path = parsePdfPath(SMUFL_OUTLINES[glyph].path);
    glyphPaths.set(glyph, path);
  }
  return path;
}

function shapeOp(annotation: Extract<Annotation, { type: 'shape' }>, aspect: number): PaintOp {
  const { data } = annotation;
  const { polylines, closed } = shapePolylines(data, aspect);
  return {
    kind: 'stroke',
    color: penInkColor(data.ink),
    width: data.width * OUTLINE_SCALE,
    polylines: polylines.map((line) => line.map((value) => value * OUTLINE_SCALE)),
    closed,
  };
}

function textOp(annotation: Extract<Annotation, { type: 'text' }>, aspect: number): PaintOp {
  const { data } = annotation;
  const size = data.fontSize * OUTLINE_SCALE;
  const top = data.y * aspect * OUTLINE_SCALE;
  return {
    kind: 'text',
    color: penInkColor(data.ink),
    size,
    x: data.x * OUTLINE_SCALE,
    // Like the PDF export and the web reader's `textBaseline = 'top'` (TEXT_BASELINE).
    lines: data.text
      .split('\n')
      .flatMap((text, index) =>
        text.length === 0
          ? []
          : [{ text, baseline: top + size * (TEXT_BASELINE + index * TEXT_LINE_HEIGHT) }],
      ),
  };
}

function stampOp(annotation: Extract<Annotation, { type: 'stamp' }>, aspect: number): PaintOp {
  const { data } = annotation;
  const box = STAMP_BASE_SIZE * data.scale;
  const cx = data.x * OUTLINE_SCALE;
  const cy = data.y * aspect * OUTLINE_SCALE;
  const color = penInkColor(data.ink);
  if (data.kind === 'symbol') {
    const drawing = stampSymbolDrawing(data.symbol);
    const unit = box * OUTLINE_SCALE;
    return {
      kind: 'stroke',
      color,
      width: drawing.strokeWidth * unit,
      polylines: drawing.polylines.map((line) =>
        line.flatMap(([px, py]) => [cx + px * unit, cy + py * unit]),
      ),
      closed: false,
    };
  }
  // The glyph's ink box centred on the stamp's point, like the PDF export (font units are y up).
  const [x0, y0, x1, y1] = SMUFL_OUTLINES[data.glyph].box;
  const k = (box * STAMP_EM_PER_BOX * OUTLINE_SCALE) / SMUFL_UNITS_PER_EM;
  return {
    kind: 'glyph',
    color,
    path: smuflGlyphPath(data.glyph),
    matrix: [k, 0, 0, -k, cx - ((x0 + x1) / 2) * k, cy + ((y0 + y1) / 2) * k],
  };
}

/** A highlighter ink's strokes on a page, painted opaque together and composited once. */
export interface HighlightGroup {
  readonly color: string;
  readonly opacity: number;
  readonly items: readonly (PreparedAnnotation & { readonly outline: readonly number[] })[];
}

/**
 * The page's highlighters, one group per ink, in the order each ink first appears (decided
 * 14/11/2026, ADR-008 §4): crossings of the same ink never darken, as on paper with a marker
 * that has dried, and the app, the web reader and the annotated PDF compose them the same way.
 */
export function highlightGroups(items: readonly PreparedAnnotation[]): HighlightGroup[] {
  const groups = new Map<
    string,
    { color: string; opacity: number; items: HighlightGroup['items'][number][] }
  >();
  for (const item of items) {
    const { annotation, outline } = item;
    if (annotation.type !== 'highlight' || !outline) continue;
    const { color, opacity } = highlighterInkColor(annotation.data.ink);
    let group = groups.get(color);
    if (!group) {
      group = { color, opacity, items: [] };
      groups.set(color, group);
    }
    group.items.push({ ...item, outline });
  }
  return [...groups.values()];
}

/**
 * The operations for a page's items, prepared with `aspect` and already in draw order (visible
 * layers, then `z`: the app's `visibleAnnotations`).
 */
export function paintPage(items: readonly PreparedAnnotation[], aspect: number): PaintOp[] {
  const ops: PaintOp[] = [];
  for (const group of highlightGroups(items)) {
    ops.push({
      kind: 'group',
      opacity: group.opacity,
      ops: group.items.map(({ outline }) => ({
        kind: 'fill',
        color: group.color,
        polygon: outline,
      })),
    });
  }

  for (const { annotation, outline } of items) {
    switch (annotation.type) {
      case 'highlight':
        break;
      case 'stroke':
        if (outline)
          ops.push({ kind: 'fill', color: penInkColor(annotation.data.ink), polygon: outline });
        break;
      case 'shape':
        ops.push(shapeOp(annotation, aspect));
        break;
      case 'text': {
        const op = textOp(annotation, aspect);
        if (op.kind === 'text' && op.lines.length > 0) ops.push(op);
        break;
      }
      case 'stamp':
        ops.push(stampOp(annotation, aspect));
        break;
    }
  }
  return ops;
}

/** How many operations a list holds, groups included: for the HUD and the tests. */
export function countPaintOps(ops: readonly PaintOp[]): number {
  let count = 0;
  for (const op of ops) count += op.kind === 'group' ? 1 + countPaintOps(op.ops) : 1;
  return count;
}

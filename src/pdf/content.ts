import { chain, type Matrix, scaling } from '../geometry/matrix';
import { normalizedToPdf, OUTLINE_SCALE, type PageFrame } from '../geometry/page-frame';
import { shapePolylines } from '../geometry/shapes';
import { STAMP_EM_PER_BOX, TEXT_BASELINE, TEXT_LINE_HEIGHT } from '../geometry/text-and-stamps';
import type { PreparedAnnotation } from '../page/prepare-page';
import { highlighterInkColor, penInkColor } from '../schema/ink';
import type { Annotation } from '../schema/rows';
import { STAMP_BASE_SIZE, stampSymbolDrawing } from '../stamps/catalog';
import { SMUFL_OUTLINES, SMUFL_UNITS_PER_EM } from '../stamps/generated/smufl-outlines';
import { winAnsiHex } from './win-ansi';

/**
 * A page's annotations as PDF content operators (ADR-014): what the annotated-PDF export appends
 * to each page, drawn in the frame of ADR-008 §1 through `normalizedToPdf`. Pure, without
 * pdf-lib, so it is tested on its own and costs the same in every runtime.
 *
 * Highlights first, each filled once with the highlighter opacity (one fill never darkens its own
 * overlaps). The app and the web reader compose them one layer per ink (ADR-008 §4, decided
 * 14/11/2026); doing the same here, one transparency group per ink and page, is required for the
 * export (ADR-014),
 * then pen strokes, shapes, text and stamps in the order given (layer, then `z`). Everything is
 * written in outline units under one `cm`, one decimal (0.06 pt on an A4 page).
 */

/** Resource names the page gives the content, as `/Name`; each is asked for only if used. */
export interface PdfResourceNames {
  /** A Helvetica font with WinAnsiEncoding. */
  readonly textFont: () => string;
  /** An ExtGState with this fill opacity (`/ca`). */
  readonly fillOpacity: (opacity: number) => string;
}

export interface PdfPageContent {
  /** The content stream; empty when there is nothing to draw. */
  readonly content: string;
  /** Characters of text annotations Helvetica cannot show, drawn as "?". */
  readonly replacedCharacters: number;
}

/** One decimal, the precision of every coordinate in outline units. */
function n1(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/** Six decimals, for matrices. */
function n6(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

function matrix(m: Matrix): string {
  return `${n6(m[0])} ${n6(m[1])} ${n6(m[2])} ${n6(m[3])} ${n6(m[4])} ${n6(m[5])} cm`;
}

const rgbCache = new Map<string, string>();

/** `#RRGGBB` as PDF RGB components (0–1, three decimals). */
function rgb(hex: string): string {
  let result = rgbCache.get(hex);
  if (result === undefined) {
    const value = Number.parseInt(hex.slice(1), 16);
    result = [16, 8, 0]
      .map((shift) => String(Math.round((((value >> shift) & 0xff) / 255) * 1000) / 1000))
      .join(' ');
    rgbCache.set(hex, result);
  }
  return result;
}

/**
 * How far a stroke outline may move when it is simplified, in outline units: the precision the
 * coordinates are written with (0.06 pt on an A4 page, a pixel at 1200 dpi). It keeps about half
 * of the vertices of the synthetic strokes, and so halves what is written and compressed.
 */
export const SIMPLIFY_TOLERANCE = 0.1;

let keep = new Uint8Array(0);
let spans = new Int32Array(0);

/**
 * Marks in `keep` the vertices Ramer–Douglas–Peucker keeps within `SIMPLIFY_TOLERANCE`, with
 * an explicit stack (a long scribble would overflow recursion). Returns the vertex count.
 */
function simplify(points: readonly number[]): number {
  const count = points.length >> 1;
  if (keep.length < count) keep = new Uint8Array(count * 2);
  if (spans.length < count * 2) spans = new Int32Array(count * 4);
  keep.fill(0, 0, count);
  keep[0] = 1;
  keep[count - 1] = 1;
  let top = 0;
  spans[top++] = 0;
  spans[top++] = count - 1;
  const tolerance2 = SIMPLIFY_TOLERANCE * SIMPLIFY_TOLERANCE;
  while (top > 0) {
    const last = spans[--top] ?? 0;
    const first = spans[--top] ?? 0;
    const ax = points[first * 2] ?? 0;
    const ay = points[first * 2 + 1] ?? 0;
    const dx = (points[last * 2] ?? 0) - ax;
    const dy = (points[last * 2 + 1] ?? 0) - ay;
    const length2 = dx * dx + dy * dy;
    let farthest = -1;
    let farthest2 = tolerance2;
    for (let index = first + 1; index < last; index++) {
      const px = (points[index * 2] ?? 0) - ax;
      const py = (points[index * 2 + 1] ?? 0) - ay;
      // Distance to the chord as a segment, not a line: an outline starts and ends at the same
      // cap, and the line through two close points could run along the whole stroke.
      const t = length2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / length2)) : 0;
      const ex = px - t * dx;
      const ey = py - t * dy;
      const distance2 = ex * ex + ey * ey;
      if (distance2 > farthest2) {
        farthest = index;
        farthest2 = distance2;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      spans[top++] = first;
      spans[top++] = farthest;
      spans[top++] = farthest;
      spans[top++] = last;
    }
  }
  return count;
}

/** A closed polygon `[x0, y0, …]` as a path, simplified, filled nonzero. */
function polygon(parts: string[], points: readonly number[]): void {
  if (points.length < 6) return;
  const count = simplify(points);
  parts.push(`${n1(points[0] ?? 0)} ${n1(points[1] ?? 0)} m`);
  for (let index = 1; index < count; index++) {
    if (keep[index] !== 1) continue;
    parts.push(`${n1(points[index * 2] ?? 0)} ${n1(points[index * 2 + 1] ?? 0)} l`);
  }
  parts.push('h f');
}

/** Polylines `[x0, y0, …]` in width units, as one stroked path in outline units. */
function polylines(parts: string[], lines: readonly (readonly number[])[], closed: boolean): void {
  for (const line of lines) {
    if (line.length < 2) continue;
    parts.push(`${n1((line[0] ?? 0) * OUTLINE_SCALE)} ${n1((line[1] ?? 0) * OUTLINE_SCALE)} m`);
    for (let index = 2; index + 1 < line.length; index += 2) {
      parts.push(
        `${n1((line[index] ?? 0) * OUTLINE_SCALE)} ${n1((line[index + 1] ?? 0) * OUTLINE_SCALE)} l`,
      );
    }
    // A single point still shows as a dot with round caps.
    if (line.length === 2) {
      parts.push(`${n1((line[0] ?? 0) * OUTLINE_SCALE)} ${n1((line[1] ?? 0) * OUTLINE_SCALE)} l`);
    }
    if (closed) parts.push('h');
  }
  parts.push('S');
}

/** Stroke state: width in outline units, round caps and joins, colour. */
function strokeStyle(parts: string[], width: number, colour: string): void {
  // Two decimals: a hairline stays visible instead of rounding to 0 (the thinnest a device draws).
  const outlineWidth = Math.max(0.01, Math.round(width * OUTLINE_SCALE * 100) / 100);
  parts.push(`${String(outlineWidth)} w 1 J 1 j ${rgb(colour)} RG`);
}

function drawInk(
  parts: string[],
  item: PreparedAnnotation,
  aspect: number,
  names: PdfResourceNames,
): number {
  const { annotation, outline } = item;
  switch (annotation.type) {
    case 'highlight':
      return 0;
    case 'stroke':
      if (!outline) return 0;
      parts.push(`${rgb(penInkColor(annotation.data.ink))} rg`);
      polygon(parts, outline);
      return 0;
    case 'shape': {
      const { data } = annotation;
      const shape = shapePolylines(data, aspect);
      strokeStyle(parts, data.width, penInkColor(data.ink));
      polylines(parts, shape.polylines, shape.closed);
      return 0;
    }
    case 'text':
      return drawText(parts, annotation, aspect, names);
    case 'stamp':
      drawStamp(parts, annotation, aspect);
      return 0;
  }
}

function drawText(
  parts: string[],
  annotation: Extract<Annotation, { type: 'text' }>,
  aspect: number,
  names: PdfResourceNames,
): number {
  const { data } = annotation;
  const size = data.fontSize * OUTLINE_SCALE;
  const x = data.x * OUTLINE_SCALE;
  const top = data.y * aspect * OUTLINE_SCALE;
  let replaced = 0;
  parts.push(`${rgb(penInkColor(data.ink))} rg BT ${names.textFont()} 1 Tf`);
  data.text.split('\n').forEach((line, index) => {
    if (line.length === 0) return;
    const encoded = winAnsiHex(line);
    replaced += encoded.replaced;
    const baseline = top + size * (TEXT_BASELINE + index * TEXT_LINE_HEIGHT);
    // The outline space has `y` down: flip the text matrix so the glyphs stand upright.
    parts.push(`${n1(size)} 0 0 ${n1(-size)} ${n1(x)} ${n1(baseline)} Tm <${encoded.hex}> Tj`);
  });
  parts.push('ET');
  return replaced;
}

function drawStamp(
  parts: string[],
  annotation: Extract<Annotation, { type: 'stamp' }>,
  aspect: number,
): void {
  const { data } = annotation;
  const box = STAMP_BASE_SIZE * data.scale;
  const cx = data.x * OUTLINE_SCALE;
  const cy = data.y * aspect * OUTLINE_SCALE;
  const colour = penInkColor(data.ink);
  if (data.kind === 'symbol') {
    const drawing = stampSymbolDrawing(data.symbol);
    const unit = box * OUTLINE_SCALE;
    strokeStyle(parts, drawing.strokeWidth * box, colour);
    for (const line of drawing.polylines) {
      line.forEach(([px, py], index) => {
        parts.push(`${n1(cx + px * unit)} ${n1(cy + py * unit)} ${index === 0 ? 'm' : 'l'}`);
      });
    }
    parts.push('S');
    return;
  }
  // The glyph's ink box centred on the stamp's point, like the renderers; font units are `y` up.
  const outline = SMUFL_OUTLINES[data.glyph];
  const k = (box * STAMP_EM_PER_BOX * OUTLINE_SCALE) / SMUFL_UNITS_PER_EM;
  const [x0, y0, x1, y1] = outline.box;
  const glyphToOutline: Matrix = [k, 0, 0, -k, cx - ((x0 + x1) / 2) * k, cy + ((y0 + y1) / 2) * k];
  parts.push(`q ${rgb(colour)} rg ${matrix(glyphToOutline)} ${outline.path} f Q`);
}

/** Outline units → PDF user space of the page. */
export function outlineToPdf(frame: PageFrame): Matrix {
  return chain(
    scaling(1 / OUTLINE_SCALE, 1 / (OUTLINE_SCALE * frame.aspect)),
    normalizedToPdf(frame),
  );
}

/**
 * The content to append to a page with these annotations (in draw order) and this frame. The
 * items must have been prepared with `frame.aspect`.
 */
export function pdfPageContent(
  items: readonly PreparedAnnotation[],
  frame: PageFrame,
  names: PdfResourceNames,
): PdfPageContent {
  if (items.length === 0) return { content: '', replacedCharacters: 0 };
  const parts: string[] = ['q', matrix(outlineToPdf(frame))];
  let replacedCharacters = 0;

  const highlights = items.filter((item) => item.annotation.type === 'highlight' && item.outline);
  if (highlights.length > 0) {
    parts.push('q');
    let opacity: number | null = null;
    for (const { annotation, outline } of highlights) {
      if (annotation.type !== 'highlight' || !outline) continue;
      const ink = highlighterInkColor(annotation.data.ink);
      if (ink.opacity !== opacity) {
        parts.push(`${names.fillOpacity(ink.opacity)} gs`);
        opacity = ink.opacity;
      }
      parts.push(`${rgb(ink.color)} rg`);
      polygon(parts, outline);
    }
    parts.push('Q');
  }

  for (const item of items) {
    replacedCharacters += drawInk(parts, item, frame.aspect, names);
  }
  parts.push('Q');
  return { content: parts.join('\n'), replacedCharacters };
}

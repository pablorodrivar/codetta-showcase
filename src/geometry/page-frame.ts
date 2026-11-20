import { chain, type Matrix, scaling, translation } from './matrix';

/**
 * The page frame: the reference every annotation coordinate is normalized to (ADR-008 §1).
 *
 * It is the page as a PDF viewer shows it: the CropBox clipped to the MediaBox, with the
 * page's own `/Rotate` applied. It is taken *before* the user's crop and rotation
 * (`page_settings`), which are view transforms: changing them never moves an annotation.
 * Every renderer (PDFKit, `PdfRenderer`, pdf.js) and the flattening export must draw the
 * page in this same frame.
 *
 * Coordinate spaces used in this package:
 * - **normalized**: `x` and `y` in 0–1 of the frame's width and height, `y` down;
 * - **width units**: `(x, y · aspect)`, isotropic, where 1 is the frame's width. Widths, font
 *   sizes and distances are stored and computed in width units;
 * - **outline units**: width units × {@link OUTLINE_SCALE}, where stroke outlines are built.
 */

/** A PDF rectangle `[x0, y0, x1, y1]` in PDF user space (points, `y` up). */
export type PdfBox = readonly [x0: number, y0: number, x1: number, y1: number];

export type QuarterTurn = 0 | 90 | 180 | 270;

export interface PageFrame {
  /** The effective box, normalized so that `x0 < x1` and `y0 < y1`. */
  readonly box: PdfBox;
  /** The page's `/Rotate`, clockwise. */
  readonly rotation: QuarterTurn;
  /** Width and height of the frame in points, after `/Rotate`. */
  readonly width: number;
  readonly height: number;
  /** `height / width`: converts normalized `y` to width units. */
  readonly aspect: number;
}

/**
 * Outline units per width unit. The stroke outline algorithm has thresholds in absolute
 * units, tuned for screen pixels (ADR-008 §4): at this scale one unit is about 0.6 pt on
 * an A4 page, close to a pixel on a tablet.
 */
export const OUTLINE_SCALE = 1000;

/** Normalizes any multiple of 90° (negative included); anything else is ignored, like pdf.js. */
export function quarterTurn(degrees: number): QuarterTurn {
  'worklet';
  if (!Number.isInteger(degrees) || degrees % 90 !== 0) return 0;
  return (((degrees % 360) + 360) % 360) as QuarterTurn;
}

/** US Letter, what pdf.js and PDFium use for a missing or broken MediaBox. */
export const DEFAULT_MEDIA_BOX: PdfBox = [0, 0, 612, 792];

/** The box with `x0 < x1` and `y0 < y1`, or null if it is empty or not finite. */
function validBox(box: PdfBox | null | undefined): PdfBox | null {
  if (!box) return null;
  const normalized: PdfBox = [
    Math.min(box[0], box[2]),
    Math.min(box[1], box[3]),
    Math.max(box[0], box[2]),
    Math.max(box[1], box[3]),
  ];
  const usable =
    normalized.every(Number.isFinite) &&
    normalized[2] - normalized[0] > 0 &&
    normalized[3] - normalized[1] > 0;
  return usable ? normalized : null;
}

/**
 * Builds the frame from the page's boxes, as pdf.js does (`Page.view`), so a page every
 * renderer shows can always be annotated:
 * - the CropBox is clipped to the MediaBox (PDF 32000-1 §14.11.2);
 * - an empty or broken CropBox, or one outside the MediaBox, falls back to the MediaBox;
 * - an empty or broken MediaBox falls back to US Letter.
 */
export function pageFrame(page: {
  mediaBox: PdfBox | null;
  cropBox?: PdfBox | null;
  rotate?: number | null;
}): PageFrame {
  const media = validBox(page.mediaBox) ?? DEFAULT_MEDIA_BOX;
  const crop = validBox(page.cropBox);
  // Both boxes are normalized, so the intersection is empty when it ends before it starts.
  const intersection: PdfBox | null = crop
    ? [
        Math.max(media[0], crop[0]),
        Math.max(media[1], crop[1]),
        Math.min(media[2], crop[2]),
        Math.min(media[3], crop[3]),
      ]
    : null;
  const clipped =
    intersection && intersection[2] > intersection[0] && intersection[3] > intersection[1]
      ? intersection
      : null;
  const box = clipped ?? media;
  const boxWidth = box[2] - box[0];
  const boxHeight = box[3] - box[1];
  const rotation = quarterTurn(page.rotate ?? 0);
  const turned = rotation === 90 || rotation === 270;
  const width = turned ? boxHeight : boxWidth;
  const height = turned ? boxWidth : boxHeight;
  return { box, rotation, width, height, aspect: height / width };
}

/**
 * Turns the unit square clockwise by `rotation` (`y` down): maps a point of the square
 * before the turn to the same point after it.
 */
export function unitSquareTurn(rotation: QuarterTurn): Matrix {
  'worklet';
  switch (rotation) {
    case 0:
      return [1, 0, 0, 1, 0, 0];
    case 90:
      // (u, v) → (1 − v, u)
      return [0, 1, -1, 0, 1, 0];
    case 180:
      // (u, v) → (1 − u, 1 − v)
      return [-1, 0, 0, -1, 1, 1];
    case 270:
      // (u, v) → (v, 1 − u)
      return [0, -1, 1, 0, 0, 1];
  }
}

/**
 * Normalized frame coordinates → PDF user space of the page, for the flattening export
 * and for checking a renderer against pdf.js.
 */
export function normalizedToPdf(frame: PageFrame): Matrix {
  const [x0, , , y1] = frame.box;
  const boxWidth = frame.box[2] - frame.box[0];
  const boxHeight = frame.box[3] - frame.box[1];
  const undoTurn = unitSquareTurn(quarterTurn(360 - frame.rotation));
  // Unrotated normalized (u, v), y down → PDF (x0 + u·w, y1 − v·h), y up.
  return chain(undoTurn, scaling(boxWidth, -boxHeight), translation(x0, y1));
}

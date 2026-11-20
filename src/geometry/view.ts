import { applyToPoint, chain, invert, type Matrix, multiply, scaling, translation } from './matrix';
import { OUTLINE_SCALE, type QuarterTurn } from './page-frame';

/** A rectangle in normalized frame coordinates, like `page_settings.crop`. */
export interface NormalizedRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export const FULL_PAGE: NormalizedRect = { x: 0, y: 0, w: 1, h: 1 };

export interface ViewInput {
  /** `height / width` of the page frame. */
  readonly aspect: number;
  /** Visible part of the page (user crop, normalized to the frame). Defaults to the full page. */
  readonly crop?: NormalizedRect;
  /** User rotation (`page_settings.rotation`), clockwise, applied after the crop. */
  readonly rotation?: QuarterTurn;
  /** Size of the area the page is drawn in, in pixels (or points: any screen unit). */
  readonly viewport: { readonly width: number; readonly height: number };
  /** `contain` fits the whole page, centred; `width` fills the width, from the top. */
  readonly fit?: 'contain' | 'width';
  /** Extra scale over the fit, about the viewport's top-left corner, then `pan`. */
  readonly zoom?: number;
  readonly pan?: { readonly x: number; readonly y: number };
}

export interface View {
  /** Normalized frame coordinates → screen. */
  readonly matrix: Matrix;
  /** Screen → normalized frame coordinates (for touches). */
  readonly inverse: Matrix;
  /** Width units → screen, for shapes (`shapePolylines`) drawn with a uniform stroke width. */
  readonly widthMatrix: Matrix;
  /** Outline units → screen, to draw cached stroke outlines with a single transform. */
  readonly outlineMatrix: Matrix;
  /** Screen units per width unit: converts an eraser radius in pixels to width units. */
  readonly scale: number;
  /** Size of the visible page on screen at zoom 1, after crop and rotation. */
  readonly pageSize: { readonly width: number; readonly height: number };
}

/** Clockwise turn of a `width × height` rectangle at the origin, `y` down. */
function turn(rotation: QuarterTurn, width: number, height: number): Matrix {
  'worklet';
  switch (rotation) {
    case 0:
      return [1, 0, 0, 1, 0, 0];
    case 90:
      // (x, y) → (height − y, x)
      return [0, 1, -1, 0, height, 0];
    case 180:
      return [-1, 0, 0, -1, width, height];
    case 270:
      // (x, y) → (y, width − x)
      return [0, -1, 1, 0, 0, width];
  }
}

/**
 * The transform from the page frame to the screen (ADR-008 §1): the frame in width units,
 * the user crop, the user rotation, the fit to the viewport, then zoom and pan. The
 * annotation layer draws everything through `outlineMatrix` or `matrix`, so zooming never
 * recomputes an outline.
 *
 * Throws a RangeError for an empty crop or viewport. In a worklet, check the viewport first
 * (it is 0 × 0 until the first layout): an exception there is thrown on the UI runtime.
 */
export function viewTransform(input: ViewInput): View {
  'worklet';
  const crop = input.crop ?? FULL_PAGE;
  const rotation = input.rotation ?? 0;
  const zoom = input.zoom ?? 1;
  const pan = input.pan ?? { x: 0, y: 0 };
  const { width: viewportWidth, height: viewportHeight } = input.viewport;
  if (!(crop.w > 0 && crop.h > 0 && input.aspect > 0 && zoom > 0)) {
    throw new RangeError('Crop, aspect and zoom must be positive');
  }
  if (!(viewportWidth > 0 && viewportHeight > 0)) {
    throw new RangeError('Viewport must not be empty');
  }

  // Cropped page in width units: width w, height h · aspect.
  const croppedWidth = crop.w;
  const croppedHeight = crop.h * input.aspect;
  const turned = rotation === 90 || rotation === 270;
  const contentWidth = turned ? croppedHeight : croppedWidth;
  const contentHeight = turned ? croppedWidth : croppedHeight;

  const fitScale =
    input.fit === 'width'
      ? viewportWidth / contentWidth
      : Math.min(viewportWidth / contentWidth, viewportHeight / contentHeight);
  const pageWidth = contentWidth * fitScale;
  const pageHeight = contentHeight * fitScale;
  const offsetX = (viewportWidth - pageWidth) / 2;
  const offsetY = input.fit === 'width' ? 0 : (viewportHeight - pageHeight) / 2;

  const toWidthUnits = scaling(1, input.aspect);
  const matrix = chain(
    toWidthUnits,
    translation(-crop.x, -crop.y * input.aspect),
    turn(rotation, croppedWidth, croppedHeight),
    scaling(fitScale, fitScale),
    translation(offsetX, offsetY),
    scaling(zoom, zoom),
    translation(pan.x, pan.y),
  );
  // Width units → normalized undoes the stretch; outline units also divide by the scale.
  const widthMatrix = multiply(matrix, scaling(1, 1 / input.aspect));
  const outlineMatrix = multiply(widthMatrix, scaling(1 / OUTLINE_SCALE, 1 / OUTLINE_SCALE));
  return {
    matrix,
    inverse: invert(matrix),
    widthMatrix,
    outlineMatrix,
    scale: fitScale * zoom,
    pageSize: { width: pageWidth, height: pageHeight },
  };
}

/** Screen point → normalized frame point. */
export function viewToNormalized(view: View, x: number, y: number): [x: number, y: number] {
  'worklet';
  return applyToPoint(view.inverse, x, y);
}

/** Normalized frame point → screen point. */
export function normalizedToView(view: View, x: number, y: number): [x: number, y: number] {
  'worklet';
  return applyToPoint(view.matrix, x, y);
}

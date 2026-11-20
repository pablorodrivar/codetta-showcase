import { OUTLINE_SCALE } from '../geometry/page-frame';
import {
  MAX_STROKE_POINTS,
  NO_PRESSURE,
  POINT_STRIDE,
  type PointBuffer,
  quantizeCoordinate,
  quantizePressure,
  quantizeTime,
} from '../points';
import {
  addInputPoint,
  createOutlineBuilder,
  type OutlineBuilder,
  type OutlineOptions,
  outlineParts,
  outlinePolygon,
} from './outline';

/** What decides how a freehand annotation looks: its type, input and width. */
export interface FreehandStyle {
  readonly type: 'stroke' | 'highlight';
  readonly input: 'pen' | 'touch' | 'mouse';
  /** Width units (fraction of the page width). */
  readonly width: number;
  /** False for an end cut by the partial eraser (1.1): flat cap, never tapered. */
  readonly taperStart?: boolean;
  readonly taperEnd?: boolean;
}

/**
 * Tool presets (ADR-008 §4):
 * - pen with a stylus: the device pressure modulates the width;
 * - pen with finger or mouse: pressure simulated from speed, with less thinning;
 * - highlighter: constant width and flat caps, like a chisel marker.
 *
 * No preset tapers today, so the end flags only choose round or flat caps; they are stored
 * so a later preset can taper original ends without touching saved data.
 */
export function outlineOptions(style: FreehandStyle): OutlineOptions {
  'worklet';
  const size = style.width * OUTLINE_SCALE;
  const originalStart = style.taperStart !== false;
  const originalEnd = style.taperEnd !== false;
  if (style.type === 'highlight') {
    return {
      size,
      thinning: 0,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: false,
      taperStart: 0,
      taperEnd: 0,
      capStart: false,
      capEnd: false,
    };
  }
  const stylus = style.input === 'pen';
  return {
    size,
    thinning: stylus ? 0.6 : 0.35,
    smoothing: 0.5,
    streamline: stylus ? 0.35 : 0.5,
    simulatePressure: !stylus,
    taperStart: 0,
    taperEnd: 0,
    capStart: originalStart,
    capEnd: originalEnd,
  };
}

/**
 * Samples closer than this to the previous kept one (outline units, about 0.05 mm on A4) are
 * dropped: a resting pen at 240 Hz would otherwise pile up points that add bytes and keep
 * the outline's tail from committing.
 */
export const MIN_SAMPLE_DISTANCE = 0.25;

export interface StrokeCapture {
  readonly style: FreehandStyle;
  readonly aspect: number;
  readonly builder: OutlineBuilder;
  /** Kept samples, on the storage grid: `[x, y, pressure, t, …]`. */
  readonly points: number[];
  startTime: number;
  lastX: number;
  lastY: number;
}

/** Starts capturing a freehand annotation on a page of `aspect` (height / width). */
export function createStrokeCapture(style: FreehandStyle, aspect: number): StrokeCapture {
  'worklet';
  return {
    style,
    aspect,
    builder: createOutlineBuilder(outlineOptions(style)),
    points: [],
    startTime: 0,
    lastX: 0,
    lastY: 0,
  };
}

export type SampleResult = 'added' | 'skipped' | 'full';

/**
 * Adds an input sample: normalized `x` and `y` (clamped to the page), pressure 0–1 (ignored
 * for finger and mouse) and a timestamp in ms on any monotonic clock. Snaps it to the
 * storage grid first, so the live outline is exactly the one drawn after saving. Returns
 * `full` at {@link MAX_STROKE_POINTS}: finish this stroke and start another.
 */
export function addSample(
  capture: StrokeCapture,
  x: number,
  y: number,
  pressure: number,
  timestamp: number,
): SampleResult {
  'worklet';
  const count = capture.points.length / POINT_STRIDE;
  if (count >= MAX_STROKE_POINTS) return 'full';
  const qx = quantizeCoordinate(x);
  const qy = quantizeCoordinate(y);
  const ox = qx * OUTLINE_SCALE;
  const oy = qy * capture.aspect * OUTLINE_SCALE;
  if (count > 0) {
    const dx = ox - capture.lastX;
    const dy = oy - capture.lastY;
    if (dx * dx + dy * dy < MIN_SAMPLE_DISTANCE * MIN_SAMPLE_DISTANCE) return 'skipped';
  } else {
    capture.startTime = timestamp;
  }
  const previousT = count > 0 ? (capture.points[capture.points.length - 1] ?? 0) : 0;
  // Never back in time, even if the clock jitters.
  const t = Math.max(previousT, quantizeTime(timestamp - capture.startTime));
  const qp = quantizePressure(capture.style.input === 'pen' ? pressure : NO_PRESSURE);
  capture.points.push(qx, qy, qp, t);
  capture.lastX = ox;
  capture.lastY = oy;
  addInputPoint(capture.builder, ox, oy, qp);
  return 'added';
}

/** The captured points, ready for `encodePoints`. */
export function capturedPoints(capture: StrokeCapture): PointBuffer {
  'worklet';
  return Float32Array.from(capture.points);
}

/**
 * A stroke at pen up (ADR-008 §7, ADR-013 §5): the captured points, and the finished outline
 * taken from the live one (its committed pieces plus the final tail) instead of computing it
 * again from the points. Null for a stroke with no points. Runs where the live stroke runs, on
 * the UI thread; the outline equals `freehandOutline` of the same points (the quantization at
 * capture makes them identical).
 */
export function finishStroke(
  capture: StrokeCapture,
): { readonly points: PointBuffer; readonly outline: number[] } | null {
  'worklet';
  const points = capturedPoints(capture);
  if (points.length === 0) return null;
  return { points, outline: outlinePolygon(outlineParts(capture.builder, true)) };
}

/**
 * Builds the outline of a stored freehand annotation, finished, in outline units (draw it
 * with the view's `outlineMatrix`). Cache it per row and `updated_at`: it never depends
 * on zoom.
 */
export function freehandOutline(
  style: FreehandStyle,
  points: PointBuffer,
  aspect: number,
): number[] {
  'worklet';
  const builder = createOutlineBuilder(outlineOptions(style));
  for (let offset = 0; offset + POINT_STRIDE <= points.length; offset += POINT_STRIDE) {
    addInputPoint(
      builder,
      (points[offset] ?? 0) * OUTLINE_SCALE,
      (points[offset + 1] ?? 0) * aspect * OUTLINE_SCALE,
      points[offset + 2] ?? NO_PRESSURE,
    );
  }
  return outlinePolygon(outlineParts(builder, true));
}

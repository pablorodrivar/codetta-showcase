/**
 * Stroke points: `[x, y, pressure, t]`, with `x` and `y` normalized 0–1 to the page
 * frame, pressure 0–1 and `t` in milliseconds since the stroke started.
 *
 * In memory a stroke's points live in a {@link PointBuffer}, one `Float32Array` with the four
 * values of each point in a row: a 2,000-point stroke takes 32 KB instead of 2,000 arrays.
 * Every value is already on the storage grid ({@link quantizePoint}), so a stroke draws the
 * same live, after saving and on another device.
 */
export type Point = [x: number, y: number, pressure: number, t: number];

/** Four floats per point: x, y, pressure, t. */
export type PointBuffer = Float32Array;

export const POINT_STRIDE = 4;

/** At 240 Hz, about 42 s of continuous drawing; the capture starts a new stroke beyond it. */
export const MAX_STROKE_POINTS = 10_000;

/** `x` and `y` steps: below a pixel on a 2,732 px iPad screen at 8× zoom. */
export const COORDINATE_STEPS = 32_767;
export const PRESSURE_STEPS = 255;
/** One hour: keeps `t` exact in a float32 and bounds a corrupt value. */
export const MAX_POINT_TIME_MS = 3_600_000;

/** Pressure stored for input without it (finger, mouse): the middle of the range. */
export const NO_PRESSURE = 0.5;

/** NaN (a bad sample from the platform) becomes 0, so it can never reach the encoder. */
function clamp01(value: number): number {
  'worklet';
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function quantizeCoordinate(value: number): number {
  'worklet';
  return Math.fround(Math.round(clamp01(value) * COORDINATE_STEPS) / COORDINATE_STEPS);
}

/** A missing pressure (NaN) becomes {@link NO_PRESSURE}. */
export function quantizePressure(value: number): number {
  'worklet';
  // No recursion: a worklet calling itself is not supported everywhere.
  const pressure = Number.isNaN(value) ? NO_PRESSURE : clamp01(value);
  return Math.fround(Math.round(pressure * PRESSURE_STEPS) / PRESSURE_STEPS);
}

/** NaN becomes 0; the capture then keeps the previous point's time. */
export function quantizeTime(value: number): number {
  'worklet';
  if (Number.isNaN(value)) return 0;
  const rounded = Math.round(value);
  return rounded < 0 ? 0 : rounded > MAX_POINT_TIME_MS ? MAX_POINT_TIME_MS : rounded;
}

/** Snaps a point to the storage grid, clamping `x`, `y` and pressure to 0–1. */
export function quantizePoint(x: number, y: number, pressure: number, t: number): Point {
  'worklet';
  return [
    quantizeCoordinate(x),
    quantizeCoordinate(y),
    quantizePressure(pressure),
    quantizeTime(t),
  ];
}

export function pointCount(points: PointBuffer): number {
  'worklet';
  return Math.floor(points.length / POINT_STRIDE);
}

/** Copies tuples into a buffer, snapping them to the storage grid. */
export function toPointBuffer(points: readonly (readonly number[])[]): PointBuffer {
  const buffer = new Float32Array(points.length * POINT_STRIDE);
  points.forEach((point, index) => {
    buffer.set(
      quantizePoint(point[0] ?? 0, point[1] ?? 0, point[2] ?? NO_PRESSURE, point[3] ?? 0),
      index * POINT_STRIDE,
    );
  });
  return buffer;
}

export function toPoints(buffer: PointBuffer): Point[] {
  const points: Point[] = [];
  for (let offset = 0; offset + POINT_STRIDE <= buffer.length; offset += POINT_STRIDE) {
    points.push([
      buffer[offset] ?? 0,
      buffer[offset + 1] ?? 0,
      buffer[offset + 2] ?? 0,
      buffer[offset + 3] ?? 0,
    ]);
  }
  return points;
}

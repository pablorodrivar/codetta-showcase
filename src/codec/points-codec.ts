import {
  COORDINATE_STEPS,
  MAX_POINT_TIME_MS,
  MAX_STROKE_POINTS,
  POINT_STRIDE,
  type PointBuffer,
  PRESSURE_STEPS,
} from '../points';
import { base64urlByteLength, decodeBase64urlInto, encodeBase64url } from './base64url';

/**
 * Compact encoding of a stroke's points for `annotations.data` (ADR-008 §3).
 *
 * Bytes, then base64url:
 * - `0`: format version ({@link POINTS_FORMAT_VERSION});
 * - `1`: flags. Bit 0: one pressure for every point (finger, mouse), stored once;
 * - varint: point count, 1 to {@link MAX_STROKE_POINTS};
 * - with bit 0, one byte: the pressure, 0–255;
 * - per point, deltas from the previous point (the first from zero): `x` and `y` on a
 *   0–{@link COORDINATE_STEPS} grid and pressure on 0–{@link PRESSURE_STEPS}, as zigzag
 *   varints; `t` in whole milliseconds as an unsigned varint (it never decreases).
 *
 * About 6 characters per point, against about 31 as a JSON array of decimals (ADR-008 §3;
 * the sync spike measured 4.3 KB per stroke on the device with the latter).
 */
export const POINTS_FORMAT_VERSION = 1;

const FLAG_CONSTANT_PRESSURE = 1;
const KNOWN_FLAGS = FLAG_CONSTANT_PRESSURE;
/**
 * A varint of a 32-bit value takes at most 5 bytes: the encoder's buffer and the length bound
 * allow that many. The decoder accepts at most 4 (`slowVarint`), since every valid value fits.
 */
const MAX_VARINT_BYTES = 5;
/** Bytes a point can take in the decoder: four fields of at most four bytes. */
const MAX_POINT_BYTES = 16;
/** Characters that cover any header: version, flags, a count of up to 4 bytes and a pressure. */
const HEADER_CHARS = 12;
/** Upper bound of an encoded stroke, so a corrupt string is rejected before decoding it. */
export const MAX_ENCODED_POINTS_LENGTH = Math.ceil(
  ((3 + 1 + MAX_STROKE_POINTS * POINT_STRIDE * MAX_VARINT_BYTES) * 4) / 3,
);

export type DecodePointsResult =
  | { readonly ok: true; readonly points: PointBuffer }
  | { readonly ok: false; readonly error: string };

function zigzag(value: number): number {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

class ByteWriter {
  bytes: Uint8Array;
  length = 0;

  constructor(capacity: number) {
    this.bytes = new Uint8Array(capacity);
  }

  byte(value: number): void {
    this.bytes[this.length++] = value;
  }

  varint(value: number): void {
    let rest = value;
    while (rest >= 0x80) {
      this.bytes[this.length++] = (rest % 0x80) | 0x80;
      rest = Math.floor(rest / 0x80);
    }
    this.bytes[this.length++] = rest;
  }
}

/** Quantized integer values of the point at `index`. */
function quantized(points: PointBuffer, index: number): [number, number, number, number] {
  const offset = index * POINT_STRIDE;
  return [
    Math.round((points[offset] ?? 0) * COORDINATE_STEPS),
    Math.round((points[offset + 1] ?? 0) * COORDINATE_STEPS),
    Math.round((points[offset + 2] ?? 0) * PRESSURE_STEPS),
    Math.round(points[offset + 3] ?? 0),
  ];
}

/**
 * Encodes points already on the storage grid (see `quantizePoint`). Throws a RangeError for
 * an empty or oversized stroke, a value outside its range or a decreasing `t`: those are
 * bugs in the capture, never user input.
 */
export function encodePoints(points: PointBuffer): string {
  const count = Math.floor(points.length / POINT_STRIDE);
  if (count < 1 || count > MAX_STROKE_POINTS || points.length % POINT_STRIDE !== 0) {
    throw new RangeError(
      `A stroke has 1 to ${MAX_STROKE_POINTS} points, got ${points.length / POINT_STRIDE}`,
    );
  }
  const first = quantized(points, 0);
  let constantPressure = true;
  for (let index = 1; index < count && constantPressure; index++) {
    constantPressure = quantized(points, index)[2] === first[2];
  }

  const writer = new ByteWriter(3 + MAX_VARINT_BYTES + count * POINT_STRIDE * MAX_VARINT_BYTES);
  writer.byte(POINTS_FORMAT_VERSION);
  writer.byte(constantPressure ? FLAG_CONSTANT_PRESSURE : 0);
  writer.varint(count);
  if (constantPressure) writer.byte(first[2]);

  let previous = [0, 0, 0, 0];
  for (let index = 0; index < count; index++) {
    const current = quantized(points, index);
    const [x, y, pressure, t] = current;
    if (
      x < 0 ||
      x > COORDINATE_STEPS ||
      y < 0 ||
      y > COORDINATE_STEPS ||
      pressure < 0 ||
      pressure > PRESSURE_STEPS ||
      t < (previous[3] ?? 0) ||
      t > MAX_POINT_TIME_MS ||
      !current.every(Number.isFinite)
    ) {
      throw new RangeError(`Point ${index} is out of range or goes back in time`);
    }
    writer.varint(zigzag(x - (previous[0] ?? 0)));
    writer.varint(zigzag(y - (previous[1] ?? 0)));
    if (!constantPressure) writer.varint(zigzag(pressure - (previous[2] ?? 0)));
    writer.varint(t - (previous[3] ?? 0));
    previous = current;
  }
  return encodeBase64url(writer.bytes.subarray(0, writer.length));
}

/**
 * Each grid step as the decoder stores it, built once: `x / COORDINATE_STEPS` rounded to
 * float32 exactly as a per-point division would, but read from a table in the hot loop.
 */
let coordinateTable: Float32Array | null = null;
let pressureTable: Float32Array | null = null;

function gridTables(): { readonly coordinate: Float32Array; readonly pressure: Float32Array } {
  if (!coordinateTable || !pressureTable) {
    coordinateTable = new Float32Array(COORDINATE_STEPS + 1);
    for (let step = 0; step <= COORDINATE_STEPS; step++) {
      coordinateTable[step] = step / COORDINATE_STEPS;
    }
    pressureTable = new Float32Array(PRESSURE_STEPS + 1);
    for (let step = 0; step <= PRESSURE_STEPS; step++) pressureTable[step] = step / PRESSURE_STEPS;
  }
  return { coordinate: coordinateTable, pressure: pressureTable };
}

/** A malformed varint. */
const BAD = -1;

/** Position after the varint `slowVarint` last read (it avoids allocating a pair per call). */
let slowEnd = 0;

/**
 * A varint of up to four bytes at `position`, with its end in `slowEnd`; -1 if truncated, too
 * long or not canonical. Every valid value fits in four bytes (a 15-bit grid delta, a time of
 * up to one hour in ms): a fifth byte could only give a value the range checks reject.
 */
function slowVarint(bytes: Uint8Array, position: number): number {
  let value = 0;
  let at = position;
  for (let shift = 0; shift <= 21; shift += 7) {
    const byte = bytes[at++];
    if (byte === undefined) {
      slowEnd = at;
      return BAD;
    }
    value |= (byte & 0x7f) << shift;
    if (byte < 0x80) {
      slowEnd = at;
      // A redundant zero continuation byte would give a second encoding of the value.
      return shift > 0 && byte === 0 ? BAD : value;
    }
  }
  slowEnd = at;
  return BAD;
}

/**
 * A stroke being decoded a few points at a time, so preparing a long stroke can be cut into
 * frames of at most 8 ms (ADR-013 §4): call `decodeMore` until it returns the result.
 * `decodePoints` is the same in one go, with every check of the format (ADR-008 §3).
 *
 * The loop is written for Hermes, which has no JIT (ADR-013 §5): one-byte varints, almost all
 * of them, are read inline, and the grid values come from tables instead of divisions.
 */
export class PointsDecoder {
  readonly #text: string;
  /** The whole decoded length, filled a part at a time: up to `#decodedChars` of the text. */
  readonly #bytes: Uint8Array;
  #decodedChars: number;
  readonly #points: Float32Array;
  readonly #count: number;
  readonly #constantPressure: boolean;
  #position: number;
  #index = 0;
  #x = 0;
  #y = 0;
  #pressure: number;
  #t = 0;
  #result: DecodePointsResult | null = null;

  private constructor(
    text: string,
    bytes: Uint8Array,
    decodedChars: number,
    start: number,
    count: number,
    constantPressure: boolean,
    pressure: number,
  ) {
    this.#text = text;
    this.#bytes = bytes;
    this.#decodedChars = decodedChars;
    this.#position = start;
    this.#count = count;
    this.#constantPressure = constantPressure;
    this.#pressure = pressure;
    this.#points = new Float32Array(count * POINT_STRIDE);
  }

  /** Reads and checks the header; the points come with `decodeMore`. */
  static start(text: string): PointsDecoder | { readonly ok: false; readonly error: string } {
    if (text.length > MAX_ENCODED_POINTS_LENGTH) return fail('Encoded points are too long');
    const length = base64urlByteLength(text);
    if (length < 0) return fail('Not base64url');
    // Only the header now: the rest is decoded as the points are read, so a long stroke costs
    // nothing up front (ADR-013 §4).
    const bytes = new Uint8Array(length);
    const decodedChars = Math.min(text.length, HEADER_CHARS);
    if (!decodeBase64urlInto(text, bytes, 0, decodedChars)) return fail('Not base64url');
    if (bytes.length < 3) return fail('Truncated header');
    const version = bytes[0];
    if (version !== POINTS_FORMAT_VERSION) return fail(`Unknown points format ${String(version)}`);
    const flags = bytes[1] ?? 0;
    if ((flags & ~KNOWN_FLAGS) !== 0) return fail(`Unknown flags ${String(flags)}`);
    const count = slowVarint(bytes, 2);
    if (count < 1 || count > MAX_STROKE_POINTS) return fail('Bad point count');
    let position = slowEnd;
    const constantPressure = (flags & FLAG_CONSTANT_PRESSURE) !== 0;
    let pressure = 0;
    if (constantPressure) {
      if (position >= bytes.length) return fail('Truncated pressure');
      pressure = bytes[position++] ?? 0;
      if (pressure > PRESSURE_STEPS) return fail('Pressure out of range');
    }
    return new PointsDecoder(
      text,
      bytes,
      decodedChars,
      position,
      count,
      constantPressure,
      pressure,
    );
  }

  /** Decodes the base64url text far enough to hold `byteCount` bytes; false if it is invalid. */
  #decodeUpTo(byteCount: number): boolean {
    const text = this.#text;
    const needed = Math.min(text.length, Math.ceil(byteCount / 3) * 4);
    if (needed <= this.#decodedChars) return true;
    const ok = decodeBase64urlInto(text, this.#bytes, this.#decodedChars, needed);
    this.#decodedChars = needed;
    return ok;
  }

  /** Points decoded so far, and in all. */
  get progress(): { readonly done: number; readonly total: number } {
    return { done: this.#index, total: this.#count };
  }

  /**
   * Decodes up to `maxPoints` more points. Returns null while points remain, and the result
   * (the points, or why they are invalid) once the stroke is done or found broken.
   */
  decodeMore(maxPoints = Infinity): DecodePointsResult | null {
    if (this.#result) return this.#result;
    const { coordinate, pressure: pressures } = gridTables();
    const bytes = this.#bytes;
    const points = this.#points;
    const constant = this.#constantPressure;
    // NaN, zero or a negative count still make progress, one point at a time.
    const step = maxPoints >= 1 ? Math.floor(maxPoints) : 1;
    const end = Math.min(this.#count, this.#index + step);
    if (!this.#decodeUpTo(this.#position + (end - this.#index) * MAX_POINT_BYTES)) {
      this.#result = fail('Not base64url');
      return this.#result;
    }
    let position = this.#position;
    let x = this.#x;
    let y = this.#y;
    let pressure = this.#pressure;
    let t = this.#t;
    let index = this.#index;
    let error: string | null = null;
    // Imported constants are a property read on another module per use in Metro's bundle: read
    // them once (ADR-008 §7, 15/11/2026).
    const maxStep = COORDINATE_STEPS;
    const maxPressure = PRESSURE_STEPS;
    const maxTime = MAX_POINT_TIME_MS;
    const stride = POINT_STRIDE;

    // Out of range, a typed array gives undefined, which takes the slow path and fails there.
    // The loop is checked in Hermes bytecode (a test of the app's compiled bundle): no
    // property read, call or closure read outside the lines marked `cold`.
    // hermes-hot-loop: decodeMore
    for (; index < end; index++) {
      let byte = bytes[position++];
      let dx: number;
      if (byte !== undefined && byte < 0x80) dx = byte;
      else {
        dx = slowVarint(bytes, position - 1); // cold
        position = slowEnd; // cold
      }
      byte = bytes[position++];
      let dy: number;
      if (byte !== undefined && byte < 0x80) dy = byte;
      else {
        dy = slowVarint(bytes, position - 1); // cold
        position = slowEnd; // cold
      }
      let dp = 0;
      if (!constant) {
        byte = bytes[position++];
        if (byte !== undefined && byte < 0x80) dp = byte;
        else {
          dp = slowVarint(bytes, position - 1); // cold
          position = slowEnd; // cold
        }
      }
      byte = bytes[position++];
      let dt: number;
      if (byte !== undefined && byte < 0x80) dt = byte;
      else {
        dt = slowVarint(bytes, position - 1); // cold
        position = slowEnd; // cold
      }
      if (dx < 0 || dy < 0 || dp < 0 || dt < 0) {
        error = `Truncated point ${String(index)}`; // cold
        break;
      }
      // Zigzag for the signed deltas; `t` never decreases.
      x += (dx >>> 1) ^ -(dx & 1);
      y += (dy >>> 1) ^ -(dy & 1);
      pressure += (dp >>> 1) ^ -(dp & 1);
      t += dt;
      if (x < 0 || x > maxStep || y < 0 || y > maxStep) {
        error = `Point ${String(index)} is outside the page`; // cold
        break;
      }
      if (pressure < 0 || pressure > maxPressure) {
        error = `Point ${String(index)} has a bad pressure`; // cold
        break;
      }
      if (t > maxTime) {
        error = `Point ${String(index)} is too late`; // cold
        break;
      }
      // The table indexes were just checked, so the `??` never apply.
      const offset = index * stride;
      points[offset] = coordinate[x] ?? 0;
      points[offset + 1] = coordinate[y] ?? 0;
      points[offset + 2] = pressures[pressure] ?? 0;
      points[offset + 3] = t;
    }
    // hermes-hot-loop-end

    this.#position = position;
    this.#x = x;
    this.#y = y;
    this.#pressure = pressure;
    this.#t = t;
    this.#index = index;
    if (error !== null) this.#result = fail(error);
    else if (index === this.#count) {
      this.#result = position === bytes.length ? { ok: true, points } : fail('Trailing bytes');
    }
    return this.#result;
  }
}

/** Decodes and validates; never throws. */
export function decodePoints(text: string): DecodePointsResult {
  const decoder = PointsDecoder.start(text);
  return decoder instanceof PointsDecoder
    ? (decoder.decodeMore() ?? fail('Not finished'))
    : decoder;
}

function fail(error: string): { readonly ok: false; readonly error: string } {
  return { ok: false, error };
}

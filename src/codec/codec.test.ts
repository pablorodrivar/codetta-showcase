import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COORDINATE_STEPS,
  MAX_POINT_TIME_MS,
  MAX_STROKE_POINTS,
  NO_PRESSURE,
  POINT_STRIDE,
  type PointBuffer,
  pointCount,
  PRESSURE_STEPS,
  quantizePoint,
  toPointBuffer,
  toPoints,
} from '../points';
import { firstDifference } from '../test/compare';
import { longStroke, seededRandom, syntheticStrokes } from '../test/synthetic-strokes';
import { decodeBase64url, encodeBase64url } from './base64url';
import {
  decodePoints,
  encodePoints,
  MAX_ENCODED_POINTS_LENGTH,
  PointsDecoder,
} from './points-codec';

function decodeOk(text: string): PointBuffer {
  const result = decodePoints(text);
  if (!result.ok) throw new Error(result.error);
  return result.points;
}

/** Header + varints, as raw bytes, for hand-made corrupt inputs. */
function bytesToText(bytes: number[]): string {
  return encodeBase64url(Uint8Array.from(bytes));
}

describe('base64url', () => {
  it('round-trips every length and byte value', () => {
    const random = seededRandom(3);
    for (let length = 0; length < 64; length++) {
      const bytes = Uint8Array.from({ length }, () => Math.floor(random() * 256));
      const text = encodeBase64url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(decodeBase64url(text)).toEqual(bytes);
    }
  });

  it('matches RFC 4648 test vectors without padding', () => {
    const encode = (text: string) => encodeBase64url(new TextEncoder().encode(text));
    expect(encode('')).toBe('');
    expect(encode('f')).toBe('Zg');
    expect(encode('fo')).toBe('Zm8');
    expect(encode('foo')).toBe('Zm9v');
    expect(encode('foob')).toBe('Zm9vYg');
    expect(encode('fooba')).toBe('Zm9vYmE');
    expect(encode('foobar')).toBe('Zm9vYmFy');
    expect(encodeBase64url(Uint8Array.from([0xfb, 0xff]))).toBe('-_8');
  });

  // Characters outside ASCII take several UTF-8 bytes in `TextEncoder`: each must still be
  // rejected wherever it falls in a group, and must not shift the characters after it.
  const BAD = [
    'Zg==',
    'Z',
    'Zm9v!',
    'Zm9+',
    'Zm9/',
    'é',
    'Zh',
    'Zm9vé',
    'éZm9v',
    'Zmé9',
    'Zm9v\uD800',
    '\u0100AAA',
    'Zm9v Zm9v',
    'Zm9v\u0000',
  ];

  it.each(BAD)('rejects %j', (text) => {
    // 'Zh' has non-zero trailing bits: a second spelling of 'f'.
    expect(decodeBase64url(text)).toBeNull();
  });

  describe('without TextEncoder (character by character)', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.resetModules();
    });

    it('decodes and rejects the same', async () => {
      vi.stubGlobal('TextEncoder', undefined);
      vi.resetModules();
      const fallback = await import('./base64url');
      const random = seededRandom(5);
      for (let length = 0; length < 40; length++) {
        const bytes = Uint8Array.from({ length }, () => Math.floor(random() * 256));
        expect(fallback.decodeBase64url(encodeBase64url(bytes))).toEqual(bytes);
      }
      for (const text of BAD) expect(fallback.decodeBase64url(text)).toBeNull();
    });
  });
});

describe('quantizePoint', () => {
  it('clamps to the page and to 0–1 pressure', () => {
    expect(quantizePoint(-0.1, 1.2, 1.5, -3)).toEqual([0, 1, 1, 0]);
    expect(quantizePoint(0.5, 0.5, -1, MAX_POINT_TIME_MS + 10)[2]).toBe(0);
    expect(quantizePoint(0, 0, 0, MAX_POINT_TIME_MS + 10)[3]).toBe(MAX_POINT_TIME_MS);
  });

  it('turns NaN into safe values', () => {
    const [x, y, pressure, t] = quantizePoint(Number.NaN, Number.NaN, Number.NaN, Number.NaN);
    expect([x, y, t]).toEqual([0, 0, 0]);
    expect(pressure).toBeCloseTo(NO_PRESSURE, 2);
    expect(() =>
      encodePoints(toPointBuffer([[Number.NaN, 0.5, Number.NaN, Number.NaN]])),
    ).not.toThrow();
  });

  it('snaps to the grid within half a step', () => {
    // One check for the 1,000 points, not six expects each: the points that break a rule.
    const random = seededRandom(5);
    const wrong: string[] = [];
    for (let index = 0; index < 1000; index++) {
      const [x, y, p, t] = [random(), random(), random(), random() * 10_000];
      const quantized = quantizePoint(x, y, p, t);
      const [qx, qy, qp, qt] = quantized;
      const broken = [
        Math.abs(qx - x) <= 0.5 / COORDINATE_STEPS + 1e-7 ? null : 'x off the grid',
        Math.abs(qy - y) <= 0.5 / COORDINATE_STEPS + 1e-7 ? null : 'y off the grid',
        Math.abs(qp - p) <= 0.5 / PRESSURE_STEPS + 1e-7 ? null : 'pressure off the grid',
        Object.is(qt, Math.round(t)) ? null : 't not rounded',
        // Quantizing twice changes nothing: live and stored strokes match.
        firstDifference(quantizePoint(qx, qy, qp, qt), quantized) === undefined
          ? null
          : 'not stable when quantized again',
      ].filter((rule) => rule !== null);
      if (broken.length > 0) {
        wrong.push(`point ${String(index)} [${String([x, y, p, t])}]: ${broken.join(', ')}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('converts between tuples and buffers', () => {
    const buffer = toPointBuffer([[0.25, 0.5, 0.75, 12]]);
    expect(pointCount(buffer)).toBe(1);
    expect(toPoints(buffer)).toEqual([quantizePoint(0.25, 0.5, 0.75, 12)]);
    // The grid is not binary: 0.25 is stored as 8192 / 32767.
    expect(buffer[0]).toBe(Math.fround(8192 / COORDINATE_STEPS));
    expect(toPoints(toPointBuffer([[0.1, 0.2]]))[0]?.[2]).toBeCloseTo(NO_PRESSURE, 2);
  });
});

describe('points codec', () => {
  it('round-trips the synthetic strokes exactly', () => {
    for (const stroke of syntheticStrokes(11)) {
      const buffer = toPointBuffer(stroke.points);
      expect(firstDifference(decodeOk(encodePoints(buffer)), buffer)).toBeUndefined();
    }
  });

  it('round-trips random strokes, including large jumps and the page edges', () => {
    const random = seededRandom(13);
    for (let round = 0; round < 200; round++) {
      const count = 1 + Math.floor(random() * 300);
      let t = 0;
      const points = Array.from({ length: count }, () => {
        t += Math.floor(random() * (random() < 0.05 ? 5000 : 10));
        const edge = random() < 0.1;
        return [edge ? Math.round(random()) : random(), random(), random(), t];
      });
      const buffer = toPointBuffer(points);
      expect(
        firstDifference(decodeOk(encodePoints(buffer)), buffer),
        `round ${String(round)}`,
      ).toBeUndefined();
    }
  });

  it('stores one pressure for input without it', () => {
    const points = Array.from({ length: 100 }, (_, index) => [
      index / 200,
      0.5,
      NO_PRESSURE,
      index * 8,
    ]);
    const constant = encodePoints(toPointBuffer(points));
    const varying = encodePoints(
      toPointBuffer(
        points.map((point, index) => [point[0] ?? 0, 0.5, index % 2 ? 0.4 : 0.6, index * 8]),
      ),
    );
    expect(constant.length).toBeLessThan(varying.length);
    expect(toPoints(decodeOk(constant)).every((point) => point[2] === Math.fround(128 / 255))).toBe(
      true,
    );
  });

  it('encodes the extremes of every channel', () => {
    const buffer = toPointBuffer([
      [0, 0, 0, 0],
      [1, 1, 1, MAX_POINT_TIME_MS],
      [0, 1, 0, MAX_POINT_TIME_MS],
    ]);
    expect(decodeOk(encodePoints(buffer))).toEqual(buffer);
  });

  it('accepts the maximum number of points and no more', () => {
    const points = Array.from({ length: MAX_STROKE_POINTS }, (_, index) => [
      (index % 100) / 100,
      0.5,
      0.5,
      index,
    ]);
    const text = encodePoints(toPointBuffer(points));
    expect(text.length).toBeLessThanOrEqual(MAX_ENCODED_POINTS_LENGTH);
    expect(pointCount(decodeOk(text))).toBe(MAX_STROKE_POINTS);
    expect(() => encodePoints(toPointBuffer([...points, [0, 0, 0, MAX_STROKE_POINTS]]))).toThrow(
      RangeError,
    );
  });

  it('refuses to encode what it could not decode', () => {
    expect(() => encodePoints(new Float32Array(0))).toThrow(RangeError);
    expect(() => encodePoints(new Float32Array(POINT_STRIDE + 1))).toThrow(RangeError);
    // t going back in time.
    expect(() =>
      encodePoints(
        toPointBuffer([
          [0, 0, 0, 10],
          [0, 0, 0, 5],
        ]),
      ),
    ).toThrow(RangeError);
    // Off the page (a buffer that skipped quantizePoint).
    expect(() => encodePoints(Float32Array.from([1.5, 0, 0, 0]))).toThrow(RangeError);
    expect(() => encodePoints(Float32Array.from([Number.NaN, 0, 0, 0]))).toThrow(RangeError);
  });

  it('keeps a 50-point stroke well under 1 KB', () => {
    const stroke = syntheticStrokes(1).find((candidate) => candidate.points.length >= 50);
    const text = encodePoints(toPointBuffer(stroke?.points.slice(0, 50) ?? []));
    expect(text.length).toBeLessThan(500);
  });

  describe('rejects corrupt input', () => {
    const valid = encodePoints(
      toPointBuffer([
        [0.1, 0.2, 0.3, 0],
        [0.11, 0.21, 0.31, 4],
      ]),
    );

    it.each([
      ['empty', ''],
      ['not base64url', '!!!!'],
      ['too short', bytesToText([1, 0])],
      ['unknown version', bytesToText([2, 0, 1, 0, 0, 0, 0])],
      ['unknown flags', bytesToText([1, 2, 1, 0, 0, 0, 0])],
      ['zero points', bytesToText([1, 0, 0])],
      ['too many points', bytesToText([1, 0, 0x91, 0x4e])], // 10,001
      ['truncated point', bytesToText([1, 0, 1, 0, 0])],
      ['truncated constant pressure', bytesToText([1, 1, 1])],
      ['trailing bytes', bytesToText([1, 0, 1, 0, 0, 0, 0, 0])],
      ['negative x', bytesToText([1, 0, 1, 1, 0, 0, 0])],
      ['x beyond the page', bytesToText([1, 0, 1, 0x80, 0x80, 0x04, 0, 0, 0])], // 65536 → 32768
      ['bad pressure', bytesToText([1, 0, 1, 0, 0, 0x80, 0x04, 0])], // 512 → 256
      ['t later than one hour', bytesToText([1, 0, 1, 0, 0, 0, 0x81, 0xee, 0xdb, 0x01])],
      ['non-canonical varint', bytesToText([1, 0, 1, 0x80, 0x00, 0, 0, 0])],
      ['overlong varint', bytesToText([1, 0, 1, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0, 0, 0])],
      ['too long', 'A'.repeat(MAX_ENCODED_POINTS_LENGTH + 4)],
      ['truncated valid string', valid.slice(0, -2)],
    ])('%s', (_name, text) => {
      expect(decodePoints(text).ok).toBe(false);
    });

    it('decodes the untouched valid string', () => {
      expect(decodePoints(valid).ok).toBe(true);
    });

    it('never throws on random bytes', () => {
      // One check for the 2,000 inputs: the ones that throw, if any, with the error.
      const random = seededRandom(17);
      const threw: string[] = [];
      for (let round = 0; round < 2000; round++) {
        const length = Math.floor(random() * 40);
        const bytes = Array.from({ length }, () => Math.floor(random() * 256));
        if (random() < 0.5 && bytes.length > 0) bytes[0] = 1;
        const text = bytesToText(bytes);
        try {
          decodePoints(text);
        } catch (error) {
          threw.push(`${text}: ${String(error)}`);
        }
      }
      expect(threw).toEqual([]);
    });
  });
});

describe('PointsDecoder', () => {
  it('decodes in steps exactly what decodePoints decodes at once', () => {
    for (const stroke of syntheticStrokes(19)) {
      const text = encodePoints(toPointBuffer(stroke.points));
      const decoder = PointsDecoder.start(text);
      if (!(decoder instanceof PointsDecoder)) throw new Error(decoder.error);
      let result = decoder.decodeMore(7);
      while (result === null) result = decoder.decodeMore(7);
      expect(result.ok).toBe(true);
      expect(decoder.progress.done).toBe(decoder.progress.total);
      const once = decodePoints(text);
      expect(
        result.ok && once.ok ? firstDifference(result.points, once.points) : 'failed',
        stroke.name,
      ).toBeUndefined();
    }
  });

  it('finds a broken point in a later step and keeps the result', () => {
    const points = toPointBuffer(
      Array.from({ length: 50 }, (_, index) => [index / 100, 0.5, 0.5, index]),
    );
    const text = encodePoints(points);
    // Cut the string: the last points are truncated.
    const cut = text.slice(0, text.length - 8);
    const decoder = PointsDecoder.start(cut);
    if (!(decoder instanceof PointsDecoder)) throw new Error(decoder.error);
    expect(decoder.decodeMore(10)).toBeNull();
    let result = decoder.decodeMore(10);
    while (result === null) result = decoder.decodeMore(10);
    expect(result.ok).toBe(false);
    expect(decoder.decodeMore(10)).toBe(result);
  });

  it('finds a bad character or trailing bits past the header while decoding in steps', () => {
    const text = encodePoints(longStroke(400));
    const run = (broken: string) => {
      const decoder = PointsDecoder.start(broken);
      if (!(decoder instanceof PointsDecoder)) return decoder;
      let result = decoder.decodeMore(7);
      while (result === null) result = decoder.decodeMore(7);
      return result;
    };
    const middle = Math.floor(text.length / 2);
    expect(run(`${text.slice(0, middle)}!${text.slice(middle + 1)}`)).toMatchObject({ ok: false });
    // Right after the header: start passes, the steps fail.
    const early = `${text.slice(0, 12)}!${text.slice(13)}`;
    expect(PointsDecoder.start(early)).toBeInstanceOf(PointsDecoder);
    expect(run(early)).toMatchObject({ ok: false });
    // The last character with trailing bits set: a stroke whose text ends in a partial group.
    const partial = [400, 401, 402, 403]
      .map((count) => encodePoints(longStroke(count)))
      .find((candidate) => candidate.length % 4 !== 0);
    expect(partial).toBeDefined();
    const ending = partial ?? '';
    const tweaked = ending.at(-1) === 'B' ? 'C' : 'B';
    expect(run(`${ending.slice(0, -1)}${tweaked}`)).toMatchObject({ ok: false });
  });
});

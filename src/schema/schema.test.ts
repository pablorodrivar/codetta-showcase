import { describe, expect, it } from 'vitest';

import { encodePoints, MAX_ENCODED_POINTS_LENGTH, PointsDecoder } from '../codec/points-codec';
import { toPointBuffer } from '../points';
import { ShapeDataSchema, StampDataSchema, StrokeDataSchema, TextDataSchema } from './data';
import { highlighterInkColor, penInkColor } from './ink';
import {
  encodeAnnotationData,
  parseAnnotationHead,
  parseAnnotationRow,
  parseAnnotationRowDeferred,
  parseLayerRow,
} from './rows';

const ID = '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0b';
const OTHER = '019a7a2e-1c2d-7e3f-8a4b-5c6d7e8f9a0c';
const points = toPointBuffer([
  [0.1, 0.2, 0.3, 0],
  [0.12, 0.21, 0.4, 4],
]);
const encoded = encodePoints(points);

function row(type: string, data: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: ID,
    owner_id: OTHER,
    score_id: OTHER,
    layer_id: OTHER,
    page_index: 2,
    type,
    data,
    z: 0,
    created_at: '2026-11-10T10:00:00.000Z',
    updated_at: '2026-11-10T10:00:00.000Z',
    deleted_at: null,
    ...extra,
  };
}

const strokeData = { v: 1, ink: 'red', width: 0.003, input: 'pen', points: encoded } as const;

/** Rows both parsers reject; the deferred one leaves `corrupt points` to the decoder. */
const REJECTED = [
  ['bad id', row('stroke', strokeData, { id: 'nope' })],
  ['negative page', row('stroke', strokeData, { page_index: -1 })],
  ['fractional page', row('stroke', strokeData, { page_index: 1.5 })],
  ['unknown type', row('scribble', strokeData)],
  ['data not an object', row('stroke', [1, 2])],
  ['data null', row('stroke', null)],
  ['missing version', row('stroke', { ...strokeData, v: undefined })],
  ['old version', row('stroke', { ...strokeData, v: 0 })],
  ['highlighter ink on a pen stroke', row('stroke', { ...strokeData, ink: 'yellow' })],
  ['pen ink on a highlight', row('highlight', { ...strokeData, ink: 'red' })],
  ['hex colour', row('stroke', { ...strokeData, ink: '#C23A2E' })],
  ['zero width', row('stroke', { ...strokeData, width: 0 })],
  ['huge width', row('stroke', { ...strokeData, width: 0.5 })],
  ['bad input', row('stroke', { ...strokeData, input: 'pencil' })],
  ['corrupt points', row('stroke', { ...strokeData, points: 'AAAA' })],
  ['points as an array', row('stroke', { ...strokeData, points: [[0.1, 0.2, 0.5, 0]] })],
  ['taper flag not boolean', row('stroke', { ...strokeData, taperStart: 'no' })],
] as const;

describe('parseAnnotationRow', () => {
  it('decodes a stroke with its points', () => {
    const parsed = parseAnnotationRow(row('stroke', strokeData));
    expect(parsed.status).toBe('ok');
    if (parsed.status !== 'ok' || parsed.annotation.type !== 'stroke') throw new Error('stroke');
    expect(parsed.annotation.data.points).toEqual(points);
    expect(parsed.annotation.page_index).toBe(2);
  });

  it('reads data stored as JSON text (SQLite)', () => {
    expect(parseAnnotationRow(row('stroke', JSON.stringify(strokeData))).status).toBe('ok');
    expect(parseAnnotationRow(row('stroke', '{not json')).status).toBe('invalid');
  });

  it('round-trips through encodeAnnotationData', () => {
    const parsed = parseAnnotationRow(row('stroke', { ...strokeData, taperEnd: false }));
    if (parsed.status !== 'ok') throw new Error('stroke');
    const data = encodeAnnotationData(parsed.annotation);
    expect(data).toEqual({ ...strokeData, taperEnd: false });
    expect(parseAnnotationRow(row('stroke', JSON.parse(JSON.stringify(data)))).status).toBe('ok');
  });

  it('keeps unknown optional fields of a known version, also when writing back', () => {
    const parsed = parseAnnotationRow(row('stroke', { ...strokeData, tilt: 'AQID' }));
    if (parsed.status !== 'ok') throw new Error('stroke');
    expect(parsed.annotation.data).toHaveProperty('tilt', 'AQID');
    expect(encodeAnnotationData(parsed.annotation)).toEqual({ ...strokeData, tilt: 'AQID' });
  });

  it.each([
    ['type', row('link', { from: { x: 0, y: 0 }, to: { page: 3, y: 0 } })],
    ['type', row('marker', {})],
    ['type', row('button', {})],
    ['version', row('stroke', { ...strokeData, v: 2, points: 'anything' })],
    ['anchor', row('text', { v: 1, text: 'rit.', anchor: { kind: 'measure', measure: 12 } })],
  ] as const)('keeps a row it cannot draw as unsupported (%s)', (reason, raw) => {
    const parsed = parseAnnotationRow(raw);
    expect(parsed).toMatchObject({ status: 'unsupported', reason });
  });

  it('accepts an explicit page anchor', () => {
    expect(
      parseAnnotationRow(row('stroke', { ...strokeData, anchor: { kind: 'page' } })).status,
    ).toBe('ok');
  });

  it.each(REJECTED)('rejects %s', (_name, raw) => {
    const parsed = parseAnnotationRow(raw);
    expect(parsed.status).toBe('invalid');
    if (parsed.status === 'invalid') expect(parsed.issues.length).toBeGreaterThan(0);
  });

  it('reports the id of an invalid row when it has one', () => {
    expect(parseAnnotationRow(row('stroke', { ...strokeData, width: -1 }))).toMatchObject({
      id: ID,
    });
    expect(parseAnnotationRow({ nothing: true })).toMatchObject({ status: 'invalid', id: null });
    expect(parseAnnotationRow(null)).toMatchObject({ status: 'invalid', id: null });
  });

  it('reads every supported type', () => {
    const cases = [
      row('highlight', { ...strokeData, ink: 'yellow', width: 0.02 }),
      row('text', {
        v: 1,
        text: 'dolce',
        x: 0.1,
        y: 0.1,
        fontSize: 0.02,
        ink: 'blue',
        maxWidth: 0.3,
      }),
      row('stamp', {
        v: 1,
        kind: 'smufl',
        glyph: 'fingering3',
        x: 0.5,
        y: 0.5,
        scale: 1,
        ink: 'graphite',
      }),
      row('stamp', {
        v: 1,
        kind: 'symbol',
        symbol: 'glasses',
        x: 0.5,
        y: 0.5,
        scale: 1.5,
        ink: 'red',
      }),
      row('shape', { v: 1, kind: 'line', from: [0, 0], to: [1, 1], ink: 'red', width: 0.002 }),
      row('shape', {
        v: 1,
        kind: 'slur',
        from: [0.1, 0.5],
        to: [0.4, 0.5],
        bulge: 0.2,
        ink: 'red',
        width: 0.002,
      }),
      row('shape', {
        v: 1,
        kind: 'hairpin',
        apex: [0.1, 0.5],
        end: [0.4, 0.5],
        opening: 0.03,
        ink: 'red',
        width: 0.002,
      }),
      row('shape', {
        v: 1,
        kind: 'rect',
        x: 0.1,
        y: 0.1,
        w: 0.2,
        h: 0.1,
        ink: 'green',
        width: 0.002,
      }),
    ];
    for (const raw of cases) {
      const parsed = parseAnnotationRow(raw);
      expect(parsed.status, JSON.stringify(parsed)).toBe('ok');
      if (parsed.status === 'ok') {
        expect(encodeAnnotationData(parsed.annotation)).toEqual(raw.data);
      }
    }
  });
});

describe('parseAnnotationHead', () => {
  it('reads every column but data, without looking at data', () => {
    const parsed = parseAnnotationHead(row('stroke', '{not json'));
    expect(parsed).toEqual({
      status: 'ok',
      head: expect.objectContaining({ id: ID, page_index: 2, z: 0, deleted_at: null }) as unknown,
    });
    expect(parsed.status === 'ok' && 'data' in parsed.head).toBe(false);
  });

  it('rejects a bad head column with its id', () => {
    expect(parseAnnotationHead(row('stroke', strokeData, { page_index: -1 }))).toMatchObject({
      status: 'invalid',
      id: ID,
    });
    expect(parseAnnotationHead(null)).toMatchObject({ status: 'invalid', id: null });
  });
});

describe('data schemas', () => {
  it.each([
    [{ v: 1, text: '   ', x: 0, y: 0, fontSize: 0.02, ink: 'red' }],
    [{ v: 1, text: 'a'.repeat(2001), x: 0, y: 0, fontSize: 0.02, ink: 'red' }],
    [{ v: 1, text: 'a', x: 1.1, y: 0, fontSize: 0.02, ink: 'red' }],
    [{ v: 1, text: 'a', x: 0, y: 0, fontSize: 0.001, ink: 'red' }],
    [{ v: 1, text: 'a', x: 0, y: 0, fontSize: 0.02, ink: 'red', maxWidth: 0 }],
  ])('rejects text %j', (data) => {
    expect(TextDataSchema.safeParse(data).success).toBe(false);
  });

  it.each([
    [{ v: 1, kind: 'smufl', glyph: 'gClef', x: 0.5, y: 0.5, scale: 1, ink: 'red' }],
    [{ v: 1, kind: 'smufl', glyph: 'U+E522', x: 0.5, y: 0.5, scale: 1, ink: 'red' }],
    [{ v: 1, kind: 'symbol', symbol: 'heart', x: 0.5, y: 0.5, scale: 1, ink: 'red' }],
    [{ v: 1, kind: 'smufl', glyph: 'dynamicForte', x: 0.5, y: 0.5, scale: 0.1, ink: 'red' }],
    [{ v: 1, kind: 'emoji', glyph: 'dynamicForte', x: 0.5, y: 0.5, scale: 1, ink: 'red' }],
  ])('rejects stamp %j', (data) => {
    expect(StampDataSchema.safeParse(data).success).toBe(false);
  });

  it.each([
    [{ v: 1, kind: 'line', from: [0, 0], to: [1, 1.2], ink: 'red', width: 0.002 }],
    [{ v: 1, kind: 'slur', from: [0, 0], to: [1, 1], bulge: 2, ink: 'red', width: 0.002 }],
    [{ v: 1, kind: 'hairpin', apex: [0, 0], end: [1, 1], opening: 0, ink: 'red', width: 0.002 }],
    [{ v: 1, kind: 'rect', x: 0, y: 0, w: 0, h: 0.1, ink: 'red', width: 0.002 }],
    [{ v: 1, kind: 'circle', x: 0, y: 0, ink: 'red', width: 0.002 }],
    [{ v: 1, kind: 'line', from: [0, 0, 0], to: [1, 1], ink: 'red', width: 0.002 }],
  ])('rejects shape %j', (data) => {
    expect(ShapeDataSchema.safeParse(data).success).toBe(false);
  });

  it('decodes points through the codec', () => {
    const result = StrokeDataSchema.safeDecode(strokeData);
    expect(result.success && result.data.points).toEqual(points);
  });
});

describe('parseLayerRow', () => {
  const layer = {
    id: ID,
    owner_id: OTHER,
    score_id: OTHER,
    name: 'Digitaciones',
    color: 'blue',
    visible: 1,
    locked: 0,
    kind: 'personal',
    position: 'a0',
    created_at: '2026-11-10T10:00:00.000Z',
    updated_at: '2026-11-10T10:00:00.000Z',
    deleted_at: null,
  };

  it('reads SQLite booleans and defaults purpose to null', () => {
    const parsed = parseLayerRow(layer);
    expect(parsed).toMatchObject({
      status: 'ok',
      layer: { visible: true, locked: false, purpose: null, color: 'blue' },
    });
  });

  it('reads the analysis purpose', () => {
    expect(parseLayerRow({ ...layer, purpose: 'analysis' })).toMatchObject({
      layer: { purpose: 'analysis' },
    });
  });

  it('falls back to the default ink for an unknown colour', () => {
    expect(parseLayerRow({ ...layer, color: '#ff0000' })).toMatchObject({ layer: { color: null } });
    expect(parseLayerRow({ ...layer, color: null })).toMatchObject({ layer: { color: null } });
  });

  it('measures the name like the database', () => {
    // 100 code points, 200 UTF-16 units.
    expect(parseLayerRow({ ...layer, name: '🎻'.repeat(100) }).status).toBe('ok');
    // btrim only strips spaces.
    expect(parseLayerRow({ ...layer, name: 'Arcos\n' }).status).toBe('ok');
  });

  it('reads an unknown purpose as none', () => {
    expect(parseLayerRow({ ...layer, purpose: 'harmony' })).toMatchObject({
      layer: { purpose: null },
    });
  });

  it.each([
    ['blank name', { name: '' }],
    ['untrimmed name', { name: ' Arcos' }],
    ['long name', { name: 'a'.repeat(101) }],
    ['long name in code points', { name: '🎻'.repeat(101) }],
    ['bad kind', { kind: 'shared' }],
    ['bad position', { position: 'a-0' }],
    ['boolean as 2', { visible: 2 }],
  ])('rejects %s', (_name, change) => {
    expect(parseLayerRow({ ...layer, ...change }).status).toBe('invalid');
  });
});

describe('inks', () => {
  it('resolves pen and highlighter keys separately', () => {
    expect(penInkColor('green')).toMatch(/^#[0-9A-F]{6}$/i);
    expect(highlighterInkColor('green').color).not.toBe(penInkColor('green'));
    expect(highlighterInkColor('yellow').opacity).toBeLessThan(1);
  });
});

describe('parseAnnotationRowDeferred', () => {
  it('rejects the same rows, and leaves corrupt points to the decoder', () => {
    for (const [name, raw] of REJECTED) {
      const parsed = parseAnnotationRowDeferred(raw);
      if (name === 'corrupt points') {
        expect(parsed.status, name).toBe('points');
        if (parsed.status === 'points') {
          expect(PointsDecoder.start(parsed.annotation.data.points)).toMatchObject({ ok: false });
        }
      } else {
        expect(parsed.status, name).toBe('invalid');
      }
    }
  });

  it('keeps strokes and highlights encoded, with their unknown fields', () => {
    for (const type of ['stroke', 'highlight'] as const) {
      const data = { ...strokeData, ink: type === 'stroke' ? 'red' : 'yellow', tilt: 'AQID' };
      const parsed = parseAnnotationRowDeferred(row(type, data));
      expect(parsed.status).toBe('points');
      if (parsed.status === 'points') {
        expect(parsed.annotation.type).toBe(type);
        expect(parsed.annotation.data.points).toBe(strokeData.points);
        expect(parsed.annotation.data.tilt).toBe('AQID');
      }
    }
  });

  it('decodes the other types at once, and rejects points that are too long to be valid', () => {
    expect(
      parseAnnotationRowDeferred(
        row('text', { v: 1, text: 'rit.', x: 0.1, y: 0.1, fontSize: 0.02, ink: 'red' }),
      ).status,
    ).toBe('ok');
    const long = 'A'.repeat(MAX_ENCODED_POINTS_LENGTH + 1);
    expect(parseAnnotationRowDeferred(row('stroke', { ...strokeData, points: long })).status).toBe(
      'invalid',
    );
  });
});

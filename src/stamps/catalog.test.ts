/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SMUFL_GLYPH_NAMES,
  SMUFL_GLYPHS,
  smuflCharacter,
  STAMP_CATEGORIES,
  STAMP_SYMBOLS,
  stampSymbolDrawing,
} from './catalog';

/** Codepoints mapped by an OpenType font's `cmap` (formats 4 and 12). */
function cmapCodepoints(font: Buffer): Set<number> {
  const tables = font.readUInt16BE(4);
  let cmap = -1;
  for (let index = 0; index < tables; index++) {
    const record = 12 + index * 16;
    if (font.toString('latin1', record, record + 4) === 'cmap')
      cmap = font.readUInt32BE(record + 8);
  }
  if (cmap < 0) throw new Error('No cmap table');
  const codepoints = new Set<number>();
  const subtables = font.readUInt16BE(cmap + 2);
  for (let index = 0; index < subtables; index++) {
    const offset = cmap + font.readUInt32BE(cmap + 4 + index * 8 + 4);
    const format = font.readUInt16BE(offset);
    if (format === 4) {
      const segments = font.readUInt16BE(offset + 6) / 2;
      const ends = offset + 14;
      const starts = ends + segments * 2 + 2;
      for (let segment = 0; segment < segments; segment++) {
        const end = font.readUInt16BE(ends + segment * 2);
        const start = font.readUInt16BE(starts + segment * 2);
        if (start === 0xffff) continue;
        for (let code = start; code <= end; code++) codepoints.add(code);
      }
    } else if (format === 12) {
      const groups = font.readUInt32BE(offset + 12);
      for (let group = 0; group < groups; group++) {
        const start = font.readUInt32BE(offset + 16 + group * 12);
        const end = font.readUInt32BE(offset + 20 + group * 12);
        for (let code = start; code <= end; code++) codepoints.add(code);
      }
    }
  }
  return codepoints;
}

describe('stamp catalog', () => {
  it('only lists glyphs that Bravura has', () => {
    const fonts = join(import.meta.dirname, '..', '..', 'fonts');
    const codepoints = cmapCodepoints(readFileSync(join(fonts, 'bravura/Bravura.otf')));
    const missing = SMUFL_GLYPH_NAMES.filter((name) => !codepoints.has(SMUFL_GLYPHS[name]));
    expect(missing).toEqual([]);
  });

  it('uses SMuFL private-use codepoints', () => {
    for (const codepoint of Object.values(SMUFL_GLYPHS)) {
      expect(codepoint).toBeGreaterThanOrEqual(0xe000);
      expect(codepoint).toBeLessThanOrEqual(0xf8ff);
    }
    expect(smuflCharacter('dynamicForte')).toBe('');
  });

  it('puts every glyph in exactly one category, without repeats', () => {
    const listed = STAMP_CATEGORIES.flatMap((category) =>
      category.stamps.flatMap((stamp) => (stamp.kind === 'smufl' ? [stamp.glyph] : [])),
    );
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...SMUFL_GLYPH_NAMES].sort());
    expect(new Set(STAMP_CATEGORIES.map((category) => category.id)).size).toBe(
      STAMP_CATEGORIES.length,
    );
  });
});

describe('stamp symbol drawings', () => {
  it.each(STAMP_SYMBOLS)('%s stays inside the stamp box, stroke included', (symbol) => {
    const { strokeWidth, polylines } = stampSymbolDrawing(symbol);
    expect(strokeWidth).toBeGreaterThan(0);
    expect(polylines.length).toBeGreaterThan(0);
    for (const line of polylines) {
      expect(line.length).toBeGreaterThanOrEqual(2);
      for (const [x, y] of line) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        expect(Math.abs(x) + strokeWidth / 2).toBeLessThanOrEqual(0.5);
        expect(Math.abs(y) + strokeWidth / 2).toBeLessThanOrEqual(0.5);
      }
    }
  });

  it('draws the glasses as two closed lenses, a bridge and two temples', () => {
    const { polylines } = stampSymbolDrawing('glasses');
    expect(polylines).toHaveLength(5);
    for (const lens of polylines.slice(0, 2)) {
      const first = lens[0];
      const last = lens.at(-1);
      expect(last?.[0]).toBeCloseTo(first?.[0] ?? Number.NaN, 12);
      expect(last?.[1]).toBeCloseTo(first?.[1] ?? Number.NaN, 12);
    }
  });
});

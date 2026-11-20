import { describe, expect, it } from 'vitest';

import { applyToPoint, chain, invert, scaling } from '../geometry/matrix';
import { normalizedToPdf, type PageFrame, pageFrame } from '../geometry/page-frame';
import { STAMP_EM_PER_BOX, TEXT_BASELINE, TEXT_LINE_HEIGHT } from '../geometry/text-and-stamps';
import { preparePage } from '../page/prepare-page';
import { toPointBuffer } from '../points';
import type { encodeAnnotationData } from '../schema/rows';
import { STAMP_BASE_SIZE } from '../stamps/catalog';
import { SMUFL_OUTLINES } from '../stamps/generated/smufl-outlines';
import { centre, interpretContent } from '../test/pdf-content';
import { storedRow } from '../test/stored-row';
import { longStroke } from '../test/synthetic-strokes';
import { pdfPageContent, type PdfResourceNames, SIMPLIFY_TOLERANCE } from './content';
import { winAnsiByte, winAnsiHex } from './win-ansi';

type Data = Parameters<typeof encodeAnnotationData>[0];

const A4 = pageFrame({ mediaBox: [0, 0, 595, 842] });
/** CropBox inside the MediaBox and a quarter turn: the frame is 600 wide, 500 tall. */
const TURNED = pageFrame({ mediaBox: [0, 0, 600, 800], cropBox: [50, 100, 550, 700], rotate: 90 });

const names: PdfResourceNames = {
  textFont: () => '/CodettaText',
  fillOpacity: (opacity) => `/CodettaAlpha${String(opacity * 10)}`,
};

function draw(frame: PageFrame, annotations: readonly Data[]) {
  const rows = annotations.map((annotation, z) => storedRow(z, annotation));
  const { items, invalid } = preparePage(rows, frame.aspect, { now: () => 0 });
  expect(invalid).toEqual([]);
  return pdfPageContent(items, frame, names);
}

function toPdf(frame: PageFrame, x: number, y: number): [number, number] {
  const [px, py] = applyToPoint(normalizedToPdf(frame), x, y);
  return [px, py];
}

/** 21 points on a straight line, a mouse stroke's worth. */
const linePoints = (from: [number, number], to: [number, number]) =>
  toPointBuffer(
    Array.from({ length: 21 }, (_, index) => [
      from[0] + ((to[0] - from[0]) * index) / 20,
      from[1] + ((to[1] - from[1]) * index) / 20,
      0.5,
      index * 8,
    ]),
  );

const line = (from: [number, number], to: [number, number]): Data => ({
  type: 'stroke',
  data: { v: 1, ink: 'red', width: 0.004, input: 'mouse', points: linePoints(from, to) },
});

describe('pdfPageContent', () => {
  it('writes nothing for a page without annotations', () => {
    expect(pdfPageContent([], A4, names)).toEqual({ content: '', replacedCharacters: 0 });
  });

  it.each([
    ['an A4 page', A4],
    ['a cropped page turned a quarter', TURNED],
  ])('puts a stroke where its normalized points are, on %s', (_, frame) => {
    const { content } = draw(frame, [line([0.2, 0.3], [0.6, 0.5])]);
    const [stroke] = interpretContent(content).paths;
    expect(stroke?.paint).toBe('f');
    const [x, y] = centre(stroke?.points ?? []);
    const [ex, ey] = toPdf(frame, 0.4, 0.4);
    expect(x).toBeCloseTo(ex, 0);
    expect(y).toBeCloseTo(ey, 0);
  });

  it('simplifies a stroke outline within SIMPLIFY_TOLERANCE of every vertex', () => {
    const row = storedRow(0, {
      type: 'stroke',
      data: { v: 1, ink: 'red', width: 0.003, input: 'pen', points: longStroke(500) },
    });
    const [item] = preparePage([row], A4.aspect, { now: () => 0 }).items;
    const outline = item?.outline ?? [];
    // In outline units: a frame 1000 wide, so the interpreter's points are outline units.
    const unit = pageFrame({ mediaBox: [0, 0, 1000, 1000 * A4.aspect] });
    const [path] = interpretContent(pdfPageContent(item ? [item] : [], unit, names).content).paths;
    const kept = (path?.points ?? []).map(([x, y]) => [x, 1000 * A4.aspect - y] as const);
    expect(kept.length).toBeLessThan((outline.length / 2) * 0.9);
    let worst = 0;
    for (let index = 0; index < outline.length; index += 2) {
      const px = outline[index] ?? 0;
      const py = outline[index + 1] ?? 0;
      let nearest = Number.POSITIVE_INFINITY;
      for (let edge = 0; edge < kept.length; edge++) {
        const [ax, ay] = kept[edge] ?? [0, 0];
        const [bx, by] = kept[(edge + 1) % kept.length] ?? [0, 0];
        const dx = bx - ax;
        const dy = by - ay;
        const length2 = dx * dx + dy * dy;
        const t =
          length2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / length2)) : 0;
        nearest = Math.min(nearest, Math.hypot(px - ax - t * dx, py - ay - t * dy));
      }
      worst = Math.max(worst, nearest);
    }
    // Plus the rounding to one decimal of both ends of an edge.
    expect(worst).toBeLessThanOrEqual(SIMPLIFY_TOLERANCE + 0.05 * Math.SQRT2);
  });

  it('draws the highlights first, translucent, then the ink in the order given', () => {
    const highlight: Data = {
      type: 'highlight',
      data: {
        v: 1,
        ink: 'yellow',
        width: 0.02,
        input: 'mouse',
        points: linePoints([0.1, 0.1], [0.5, 0.1]),
      },
    };
    const { content } = draw(A4, [line([0.1, 0.5], [0.5, 0.5]), highlight]);
    const [first, second] = interpretContent(content).paths;
    expect(first?.graphicsState).toBe('/CodettaAlpha4');
    expect(first?.fill).toBe('0.929 0.714 0'); // #EDB600
    expect(second?.graphicsState).toBeNull();
    expect(second?.fill).toBe('0.761 0.227 0.18'); // #C23A2E
  });

  it.each([
    ['an A4 page', A4],
    ['a cropped page turned a quarter', TURNED],
  ])(
    'draws a SMuFL glyph upright, its ink box centred on the stamp, at its size, on %s',
    (_, frame) => {
      const { content } = draw(frame, [
        {
          type: 'stamp',
          data: {
            v: 1,
            kind: 'smufl',
            glyph: 'dynamicForte',
            x: 0.3,
            y: 0.7,
            scale: 2,
            ink: 'red',
          },
        },
      ]);
      const [glyph] = interpretContent(content).paths;
      // Back to the frame, in width units (`y` down), where the page shows it.
      const toFrame = chain(invert(normalizedToPdf(frame)), scaling(1, frame.aspect));
      const points = (glyph?.points ?? []).map(([px, py]) => applyToPoint(toFrame, px, py));
      const [x0, y0, x1, y1] = SMUFL_OUTLINES.dynamicForte.box;
      const k = (STAMP_BASE_SIZE * 2 * STAMP_EM_PER_BOX) / 1000;
      const xs = points.map(([px]) => px);
      const ys = points.map(([, py]) => py);
      // The curves' end points reach the ink box here, so their extent is the glyph's.
      expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo((x1 - x0) * k, 3);
      expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo((y1 - y0) * k, 3);
      const [cx, cy] = centre(points);
      expect(cx).toBeCloseTo(0.3, 3);
      expect(cy).toBeCloseTo(0.7 * frame.aspect, 3);
      // The outline's first point, from font units (`y` up): upright, not turned or mirrored.
      const [fx = 0, fy = 0] = SMUFL_OUTLINES.dynamicForte.path.split(' ').map(Number);
      expect(points[0]?.[0]).toBeCloseTo(0.3 + (fx - (x0 + x1) / 2) * k, 3);
      expect(points[0]?.[1]).toBeCloseTo(0.7 * frame.aspect - (fy - (y0 + y1) / 2) * k, 3);
    },
  );

  it('draws the glasses with their stroke, centred on the stamp', () => {
    const { content } = draw(A4, [
      {
        type: 'stamp',
        data: { v: 1, kind: 'symbol', symbol: 'glasses', x: 0.5, y: 0.5, scale: 1, ink: 'blue' },
      },
    ]);
    const [glasses] = interpretContent(content).paths;
    expect(glasses?.paint).toBe('S');
    expect(glasses?.lineWidth).toBeCloseTo(0.07 * STAMP_BASE_SIZE * 595, 1);
    const [x] = centre(glasses?.points ?? []);
    expect(x).toBeCloseTo(595 / 2, 0);
  });

  it('strokes shapes with their width, through their corners', () => {
    const { content } = draw(A4, [
      {
        type: 'shape',
        data: { v: 1, kind: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.1, ink: 'green', width: 0.002 },
      },
    ]);
    const [rect] = interpretContent(content).paths;
    expect(rect?.paint).toBe('S');
    expect(rect?.lineWidth).toBeCloseTo(0.002 * 595, 2);
    expect(rect?.stroke).toBe('0.137 0.502 0.29'); // #23804A
    const [x0, y0] = toPdf(A4, 0.1, 0.2);
    const [x1, y1] = toPdf(A4, 0.4, 0.3);
    expect(rect?.points[0]?.[0]).toBeCloseTo(x0, 1);
    expect(rect?.points[0]?.[1]).toBeCloseTo(y0, 1);
    expect(rect?.points[2]?.[0]).toBeCloseTo(x1, 1);
    expect(rect?.points[2]?.[1]).toBeCloseTo(y1, 1);
  });

  it.each([
    ['an A4 page', A4],
    ['a cropped page turned a quarter', TURNED],
  ])('writes text upright, one line per paragraph, from its top-left corner, on %s', (_, frame) => {
    const fontSize = 0.03;
    const { content, replacedCharacters } = draw(frame, [
      {
        type: 'text',
        data: { v: 1, text: 'rit. ♩\n\nTempo I', x: 0.1, y: 0.2, fontSize, ink: 'blue' },
      },
    ]);
    expect(replacedCharacters).toBe(1);
    const texts = interpretContent(content).texts;
    expect(texts.map((text) => text.hex)).toEqual([
      winAnsiHex('rit. ?').hex,
      winAnsiHex('Tempo I').hex,
    ]);
    expect(texts.every((text) => text.font === '/CodettaText')).toBe(true);
    const size = fontSize * frame.width;
    const baseline = (line: number) =>
      toPdf(
        frame,
        0.1,
        0.2 + ((TEXT_BASELINE + line * TEXT_LINE_HEIGHT) * fontSize) / frame.aspect,
      );
    // The empty paragraph keeps its line.
    for (const [text, lineIndex] of [
      [texts[0], 0],
      [texts[1], 2],
    ] as const) {
      expect(text?.size).toBeCloseTo(size, 1);
      expect(text?.origin[0]).toBeCloseTo(baseline(lineIndex)[0], 1);
      expect(text?.origin[1]).toBeCloseTo(baseline(lineIndex)[1], 1);
      // Up in the frame is towards smaller normalized y.
      const [ux, uy] = toPdf(frame, 0, 0);
      const [vx, vy] = toPdf(frame, 0, -1 / frame.aspect);
      expect(text?.up[0]).toBeCloseTo((vx - ux) / frame.width, 5);
      expect(text?.up[1]).toBeCloseTo((vy - uy) / frame.width, 5);
    }
  });

  it('never writes an exponent or a negative zero', () => {
    const { content } = draw(TURNED, [line([0, 0], [1e-7, 1e-7]), line([0.99, 0.99], [1, 1])]);
    expect(content).not.toMatch(/e-|e\+|-0(?![.\d])/);
  });
});

describe('winAnsi', () => {
  it('maps Latin-1 as is, the WinAnsi extras to their bytes, and a tab to a space', () => {
    expect(
      ['A', 'é', 'ß', 'ñ', '¿', '€', '—', '“', '\t'].map((c) => winAnsiByte(c.codePointAt(0) ?? 0)),
    ).toEqual([0x41, 0xe9, 0xdf, 0xf1, 0xbf, 0x80, 0x97, 0x93, 0x20]);
  });

  it('draws anything else as one "?" per character, and counts it', () => {
    expect(winAnsiHex('a♩𝄞b')).toEqual({ hex: '613f3f62', replaced: 2 });
    expect(winAnsiHex('\u0001')).toEqual({ hex: '3f', replaced: 1 });
  });
});

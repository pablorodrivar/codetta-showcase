import { describe, expect, it } from 'vitest';

import {
  applyToPoint,
  chain,
  IDENTITY,
  invert,
  type Matrix,
  multiply,
  scaling,
  toSkiaMatrix,
  translation,
} from './matrix';
import {
  DEFAULT_MEDIA_BOX,
  normalizedToPdf,
  OUTLINE_SCALE,
  pageFrame,
  type QuarterTurn,
  quarterTurn,
  unitSquareTurn,
} from './page-frame';
import { normalizedToView, viewToNormalized, viewTransform } from './view';

const TURNS: QuarterTurn[] = [0, 90, 180, 270];

function expectPoint(actual: readonly number[], expected: readonly number[]): void {
  expect(actual[0]).toBeCloseTo(expected[0] ?? Number.NaN, 9);
  expect(actual[1]).toBeCloseTo(expected[1] ?? Number.NaN, 9);
}

function expectMatrix(actual: Matrix, expected: Matrix): void {
  actual.forEach((value, index) => {
    expect(value).toBeCloseTo(expected[index] ?? Number.NaN, 9);
  });
}

describe('matrix', () => {
  const m: Matrix = [2, 0.5, -1, 3, 10, -4];

  it('applies the DOMMatrix layout', () => {
    expect(applyToPoint(m, 1, 2)).toEqual([2 * 1 - 1 * 2 + 10, 0.5 * 1 + 3 * 2 - 4]);
  });

  it('multiplies right to left and chains left to right', () => {
    const t = translation(5, 7);
    const s = scaling(2, 3);
    expect(applyToPoint(multiply(t, s), 1, 1)).toEqual([7, 10]);
    expect(applyToPoint(chain(s, t), 1, 1)).toEqual([7, 10]);
    expect(chain()).toEqual(IDENTITY);
  });

  it('inverts', () => {
    expectMatrix(multiply(m, invert(m)), IDENTITY);
    expectMatrix(multiply(invert(m), m), IDENTITY);
  });

  it('rejects a singular matrix', () => {
    expect(() => invert([1, 2, 2, 4, 0, 0])).toThrow(RangeError);
    expect(() => invert([0, 0, 0, 0, 1, 1])).toThrow(RangeError);
  });

  it('converts to Skia row-major', () => {
    expect(toSkiaMatrix(m)).toEqual([2, -1, 10, 0.5, 3, -4, 0, 0, 1]);
  });
});

describe('quarterTurn', () => {
  it.each([
    [0, 0],
    [90, 90],
    [180, 180],
    [270, 270],
    [360, 0],
    [450, 90],
    [-90, 270],
    [-180, 180],
    [45, 0],
    [Number.NaN, 0],
    [90.5, 0],
  ])('%s → %s', (degrees, expected) => {
    expect(quarterTurn(degrees)).toBe(expected);
  });
});

describe('unitSquareTurn', () => {
  it.each(TURNS)('turns the corners clockwise by %s°', (rotation) => {
    const corners: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const steps = rotation / 90;
    corners.forEach((corner, index) => {
      const expected = corners[(index + steps) % 4] ?? [Number.NaN, Number.NaN];
      expectPoint(applyToPoint(unitSquareTurn(rotation), ...corner), expected);
    });
  });
});

describe('pageFrame', () => {
  const a4: [number, number, number, number] = [0, 0, 595, 842];

  it('uses the MediaBox when there is no CropBox', () => {
    expect(pageFrame({ mediaBox: a4 })).toEqual({
      box: a4,
      rotation: 0,
      width: 595,
      height: 842,
      aspect: 842 / 595,
    });
  });

  it('clips the CropBox to the MediaBox', () => {
    const frame = pageFrame({ mediaBox: a4, cropBox: [-20, 40, 500, 900] });
    expect(frame.box).toEqual([0, 40, 500, 842]);
    expect(frame.width).toBe(500);
    expect(frame.height).toBe(802);
  });

  it('normalizes reversed boxes', () => {
    expect(pageFrame({ mediaBox: [595, 842, 0, 0] }).box).toEqual(a4);
  });

  it('swaps width and height for 90° and 270°', () => {
    for (const rotate of [90, 270, -90, 450]) {
      const frame = pageFrame({ mediaBox: a4, rotate });
      expect(frame.width).toBe(842);
      expect(frame.height).toBe(595);
      expect(frame.aspect).toBeCloseTo(595 / 842, 12);
    }
    expect(pageFrame({ mediaBox: a4, rotate: 180 }).width).toBe(595);
  });

  it('falls back to the MediaBox for an empty, broken or disjoint CropBox, like pdf.js', () => {
    expect(pageFrame({ mediaBox: a4, cropBox: [0, 0, 0, 0] }).box).toEqual(a4);
    expect(pageFrame({ mediaBox: a4, cropBox: [600, 0, 700, 842] }).box).toEqual(a4);
    expect(pageFrame({ mediaBox: a4, cropBox: [0, 0, Number.NaN, 842] }).box).toEqual(a4);
    // Touching only along an edge is empty too.
    expect(pageFrame({ mediaBox: a4, cropBox: [595, 0, 700, 842] }).box).toEqual(a4);
  });

  it('falls back to US Letter for an empty or broken MediaBox', () => {
    expect(pageFrame({ mediaBox: [0, 0, 0, 842] }).box).toEqual(DEFAULT_MEDIA_BOX);
    expect(pageFrame({ mediaBox: [0, 0, Number.POSITIVE_INFINITY, 842] }).box).toEqual(
      DEFAULT_MEDIA_BOX,
    );
    expect(pageFrame({ mediaBox: null }).width).toBe(612);
    // A valid CropBox still clips the fallback.
    expect(pageFrame({ mediaBox: null, cropBox: [10, 10, 300, 400] }).box).toEqual([
      10, 10, 300, 400,
    ]);
  });
});

describe('normalizedToPdf', () => {
  // A cropped page whose box does not start at the origin, to catch a missing offset.
  const mediaBox: [number, number, number, number] = [10, 20, 610, 820];
  const cropBox: [number, number, number, number] = [50, 100, 550, 800];

  it('maps the corners without rotation', () => {
    const frame = pageFrame({ mediaBox, cropBox });
    const m = normalizedToPdf(frame);
    expectPoint(applyToPoint(m, 0, 0), [50, 800]); // top-left → (x0, y1)
    expectPoint(applyToPoint(m, 1, 0), [550, 800]);
    expectPoint(applyToPoint(m, 1, 1), [550, 100]);
    expectPoint(applyToPoint(m, 0.5, 0.5), [300, 450]);
  });

  // The displayed top-left corner comes from a different PDF corner for each /Rotate,
  // as pdf.js and every viewer show it.
  it.each([
    [90, [50, 100]], // turned clockwise: the PDF's bottom-left is now top-left
    [180, [550, 100]],
    [270, [550, 800]],
  ] as const)('maps the displayed top-left corner with /Rotate %s', (rotate, expected) => {
    const frame = pageFrame({ mediaBox, cropBox, rotate });
    expectPoint(applyToPoint(normalizedToPdf(frame), 0, 0), expected);
  });

  it.each(TURNS)('keeps the page area with /Rotate %s', (rotate) => {
    const frame = pageFrame({ mediaBox, cropBox, rotate });
    const m = normalizedToPdf(frame);
    // |det| of the normalized → PDF map is the box area.
    expect(Math.abs(m[0] * m[3] - m[1] * m[2])).toBeCloseTo(500 * 700, 6);
    // The normalized width spans the displayed width in points.
    const [x0, y0] = applyToPoint(m, 0, 0.5);
    const [x1, y1] = applyToPoint(m, 1, 0.5);
    expect(Math.hypot(x1 - x0, y1 - y0)).toBeCloseTo(frame.width, 9);
  });
});

describe('viewTransform', () => {
  const aspect = 842 / 595;
  const viewport = { width: 820, height: 1180 };

  it('fits the page centred with contain', () => {
    // A tall viewport: the page is limited by the height and centred across.
    const tall = { width: 900, height: 1180 };
    const view = viewTransform({ aspect, viewport: tall });
    const width = 1180 / aspect;
    expectPoint(normalizedToView(view, 0, 0), [(900 - width) / 2, 0]);
    expectPoint(normalizedToView(view, 1, 1), [(900 + width) / 2, 1180]);
    expect(view.scale).toBeCloseTo(width, 9);
    expect(view.pageSize.width).toBeCloseTo(width, 9);
    // A wide one: limited by the width and centred down.
    const wide = viewTransform({ aspect, viewport: { width: 820, height: 1400 } });
    expectPoint(normalizedToView(wide, 0, 0), [0, (1400 - 820 * aspect) / 2]);
  });

  it('fills the width from the top', () => {
    const view = viewTransform({ aspect, viewport, fit: 'width' });
    expectPoint(normalizedToView(view, 0, 0), [0, 0]);
    expectPoint(normalizedToView(view, 1, 1), [820, 820 * aspect]);
  });

  it('maps the crop rectangle onto the page area', () => {
    const crop = { x: 0.1, y: 0.05, w: 0.8, h: 0.9 };
    const view = viewTransform({ aspect, viewport, crop, fit: 'width' });
    expectPoint(normalizedToView(view, 0.1, 0.05), [0, 0]);
    expectPoint(normalizedToView(view, 0.9, 0.05), [820, 0]);
    // A crop changes the scale, not the stored coordinates.
    expect(view.scale).toBeCloseTo(820 / 0.8, 9);
  });

  it.each(TURNS)('rotates the page clockwise by %s°', (rotation) => {
    const view = viewTransform({ aspect: 1, viewport: { width: 100, height: 100 }, rotation });
    const corners: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    const steps = rotation / 90;
    // The page's top-left corner moves one screen corner clockwise per quarter turn.
    expectPoint(normalizedToView(view, 0, 0), corners[steps % 4] ?? []);
    expectPoint(normalizedToView(view, 1, 0), corners[(steps + 1) % 4] ?? []);
  });

  it('swaps the content size for a quarter turn', () => {
    const view = viewTransform({ aspect, viewport, rotation: 90 });
    // Turned A4 is landscape: limited by the width.
    expect(view.pageSize.width).toBeCloseTo(820, 9);
    expect(view.pageSize.height).toBeCloseTo(820 / aspect, 9);
  });

  it('applies zoom and pan last', () => {
    const base = viewTransform({ aspect, viewport });
    const zoomed = viewTransform({ aspect, viewport, zoom: 3, pan: { x: -40, y: 25 } });
    const [x, y] = normalizedToView(base, 0.3, 0.7);
    expectPoint(normalizedToView(zoomed, 0.3, 0.7), [x * 3 - 40, y * 3 + 25]);
    expect(zoomed.scale).toBeCloseTo(base.scale * 3, 9);
  });

  it('round-trips screen and normalized points for every combination', () => {
    for (const rotation of TURNS) {
      for (const fit of ['contain', 'width'] as const) {
        const view = viewTransform({
          aspect,
          viewport,
          rotation,
          fit,
          crop: { x: 0.07, y: 0.11, w: 0.81, h: 0.73 },
          zoom: 2.5,
          pan: { x: 13, y: -17 },
        });
        for (const [nx, ny] of [
          [0, 0],
          [0.25, 0.75],
          [1, 1],
          [0.5, 0.125],
        ] as const) {
          const [sx, sy] = normalizedToView(view, nx, ny);
          expectPoint(viewToNormalized(view, sx, sy), [nx, ny]);
        }
      }
    }
  });

  it('draws outline units at the same place as normalized points', () => {
    const view = viewTransform({ aspect, viewport, rotation: 270, zoom: 1.5 });
    const [nx, ny] = [0.42, 0.66];
    const outline = [nx * OUTLINE_SCALE, ny * aspect * OUTLINE_SCALE] as const;
    expectPoint(applyToPoint(view.outlineMatrix, ...outline), normalizedToView(view, nx, ny));
    expectPoint(applyToPoint(view.widthMatrix, nx, ny * aspect), normalizedToView(view, nx, ny));
  });

  it('keeps distances isotropic in width units', () => {
    const view = viewTransform({ aspect, viewport });
    // 0.1 width units across and 0.1 width units down are the same length on screen.
    const [x0, y0] = normalizedToView(view, 0.5, 0.5);
    const [x1] = normalizedToView(view, 0.6, 0.5);
    const [, y1] = normalizedToView(view, 0.5, 0.5 + 0.1 / aspect);
    expect(x1 - x0).toBeCloseTo(y1 - y0, 9);
    expect(x1 - x0).toBeCloseTo(0.1 * view.scale, 9);
  });

  it('rejects empty inputs', () => {
    expect(() => viewTransform({ aspect, viewport: { width: 0, height: 10 } })).toThrow(RangeError);
    expect(() => viewTransform({ aspect, viewport, crop: { x: 0, y: 0, w: 0, h: 1 } })).toThrow(
      RangeError,
    );
    expect(() => viewTransform({ aspect: 0, viewport })).toThrow(RangeError);
    expect(() => viewTransform({ aspect, viewport, zoom: 0 })).toThrow(RangeError);
  });
});

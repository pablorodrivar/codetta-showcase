import { describe, expect, it } from 'vitest';

import { ShapeDataSchema } from '../schema/data';
import { MIN_SHAPE_LENGTH, shapeFromDrag, SLUR_BULGE } from './drag-shapes';

const style = { ink: 'red', width: 0.003, aspect: 1.414 } as const;

describe('shapeFromDrag', () => {
  it('draws a line from the press to the release', () => {
    expect(shapeFromDrag('line', [0.1, 0.2], [0.4, 0.2], style)).toMatchObject({
      kind: 'line',
      from: [0.1, 0.2],
      to: [0.4, 0.2],
    });
  });

  it('curves a slur above, or below with flip', () => {
    expect(shapeFromDrag('slur', [0.1, 0.2], [0.4, 0.2], style)).toMatchObject({
      bulge: SLUR_BULGE,
    });
    expect(shapeFromDrag('slur', [0.1, 0.2], [0.4, 0.2], { ...style, flip: true })).toMatchObject({
      bulge: -SLUR_BULGE,
    });
  });

  it('opens a hairpin towards the release: right is a crescendo, left a diminuendo', () => {
    const crescendo = shapeFromDrag('hairpin', [0.1, 0.5], [0.3, 0.5], style);
    expect(crescendo).toMatchObject({ apex: [0.1, 0.5], end: [0.3, 0.5] });
    const diminuendo = shapeFromDrag('hairpin', [0.3, 0.5], [0.1, 0.5], style);
    expect(diminuendo).toMatchObject({ apex: [0.3, 0.5], end: [0.1, 0.5] });
  });

  it('boxes a rectangle from either corner', () => {
    expect(shapeFromDrag('rect', [0.5, 0.6], [0.2, 0.3], style)).toMatchObject({
      x: 0.2,
      y: 0.3,
    });
  });

  it('clamps to the page', () => {
    expect(shapeFromDrag('line', [-0.2, 0.5], [1.3, 0.5], style)).toMatchObject({
      from: [0, 0.5],
      to: [1, 0.5],
    });
  });

  it.each(['line', 'slur', 'hairpin', 'rect'] as const)('ignores a tap (%s)', (kind) => {
    expect(shapeFromDrag(kind, [0.5, 0.5], [0.5 + MIN_SHAPE_LENGTH / 2, 0.5], style)).toBeNull();
  });

  it('ignores a flat rectangle', () => {
    expect(shapeFromDrag('rect', [0.1, 0.5], [0.4, 0.5], style)).toBeNull();
  });

  it.each([
    ['line', [0, 0], [1, 1]],
    ['slur', [0.9, 0.1], [0.1, 0.9]],
    ['hairpin', [0, 0], [1, 1]],
    ['hairpin', [0.5, 0.5], [0.51, 0.5]],
    ['rect', [1, 1], [0, 0]],
  ] as const)('always gives data the schema accepts (%s)', (kind, from, to) => {
    const shape = shapeFromDrag(kind, from, to, style);
    expect(shape).not.toBeNull();
    expect(ShapeDataSchema.safeParse(shape).success).toBe(true);
  });
});

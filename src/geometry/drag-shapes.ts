import type { ShapeData } from '../schema/data';
import type { PenInk } from '../schema/ink';

export type ShapeKind = ShapeData['kind'];

/** Default bulge of a slur: its apex at 15 % of the chord, above when drawn left to right. */
export const SLUR_BULGE = 0.15;

/** A drag shorter than this (width units, about 0.6 mm on A4) is a tap, not a shape. */
export const MIN_SHAPE_LENGTH = 0.003;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * The shape a drag from `from` to `to` (normalized page points) draws, or null for a tap:
 * - `line`: from the press to the release;
 * - `slur`: the same chord, curved by {@link SLUR_BULGE} (`flip`, e.g. Alt, curves it the
 *   other way);
 * - `hairpin`: opens from the press towards the release, so dragging right draws a
 *   crescendo and dragging left a diminuendo; its opening grows with the length;
 * - `rect`: the box between both corners.
 */
export function shapeFromDrag(
  kind: ShapeKind,
  from: readonly [number, number],
  to: readonly [number, number],
  style: {
    readonly ink: PenInk;
    readonly width: number;
    readonly aspect: number;
    readonly flip?: boolean;
  },
): ShapeData | null {
  const a: [number, number] = [clamp01(from[0]), clamp01(from[1])];
  const b: [number, number] = [clamp01(to[0]), clamp01(to[1])];
  const dx = b[0] - a[0];
  const dy = (b[1] - a[1]) * style.aspect;
  const length = Math.hypot(dx, dy);
  const base = { v: 1 as const, ink: style.ink, width: style.width };
  switch (kind) {
    case 'line':
      return length < MIN_SHAPE_LENGTH ? null : { ...base, kind, from: a, to: b };
    case 'slur':
      return length < MIN_SHAPE_LENGTH
        ? null
        : { ...base, kind, from: a, to: b, bulge: style.flip ? -SLUR_BULGE : SLUR_BULGE };
    case 'hairpin':
      return length < MIN_SHAPE_LENGTH
        ? null
        : {
            ...base,
            kind,
            apex: a,
            end: b,
            opening: Math.min(0.2, Math.max(0.006, length * 0.12)),
          };
    case 'rect': {
      const w = Math.abs(b[0] - a[0]);
      const h = Math.abs(b[1] - a[1]);
      if (w * w + (h * style.aspect) ** 2 < MIN_SHAPE_LENGTH ** 2 || w === 0 || h === 0) {
        return null;
      }
      return { ...base, kind, x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w, h };
    }
  }
}

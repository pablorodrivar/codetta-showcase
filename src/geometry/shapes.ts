import type { ShapeData } from '../schema/data';

/**
 * Centre lines of the shapes (ADR-008 §2), in width units (`x`, `y · aspect`): the renderer
 * strokes them with the shape's width through `View.widthMatrix`, and the eraser tests
 * against them. Each polyline is `[x0, y0, x1, y1, …]`.
 */
export interface ShapePolylines {
  readonly polylines: number[][];
  /** True when the last point joins the first (rectangles). */
  readonly closed: boolean;
}

/** Segments of a flattened slur: smooth at any zoom a reader uses. */
export const SLUR_SEGMENTS = 32;

export function shapePolylines(shape: ShapeData, aspect: number): ShapePolylines {
  switch (shape.kind) {
    case 'line':
      return {
        polylines: [[shape.from[0], shape.from[1] * aspect, shape.to[0], shape.to[1] * aspect]],
        closed: false,
      };
    case 'slur': {
      const x0 = shape.from[0];
      const y0 = shape.from[1] * aspect;
      const x2 = shape.to[0];
      const y2 = shape.to[1] * aspect;
      // Normal to the left of from → to on a y-down screen: (dy, −dx) / length. The apex of a
      // quadratic curve is halfway to its control point, so the control sits at 2 · bulge.
      const dx = x2 - x0;
      const dy = y2 - y0;
      const cx = (x0 + x2) / 2 + dy * 2 * shape.bulge;
      const cy = (y0 + y2) / 2 - dx * 2 * shape.bulge;
      const line: number[] = [];
      for (let step = 0; step <= SLUR_SEGMENTS; step++) {
        const t = step / SLUR_SEGMENTS;
        const u = 1 - t;
        line.push(
          u * u * x0 + 2 * u * t * cx + t * t * x2,
          u * u * y0 + 2 * u * t * cy + t * t * y2,
        );
      }
      return { polylines: [line], closed: false };
    }
    case 'hairpin': {
      const ax = shape.apex[0];
      const ay = shape.apex[1] * aspect;
      const ex = shape.end[0];
      const ey = shape.end[1] * aspect;
      const length = Math.hypot(ex - ax, ey - ay);
      // A zero-length hairpin opens across the page.
      const nx = length > 0 ? -(ey - ay) / length : 0;
      const ny = length > 0 ? (ex - ax) / length : 1;
      const half = shape.opening / 2;
      return {
        polylines: [
          [ax, ay, ex + nx * half, ey + ny * half],
          [ax, ay, ex - nx * half, ey - ny * half],
        ],
        closed: false,
      };
    }
    case 'rect': {
      const x0 = shape.x;
      const y0 = shape.y * aspect;
      const x1 = shape.x + shape.w;
      const y1 = (shape.y + shape.h) * aspect;
      return { polylines: [[x0, y0, x1, y0, x1, y1, x0, y1, x0, y0]], closed: true };
    }
  }
}

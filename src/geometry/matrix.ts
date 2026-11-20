/**
 * 2D affine matrices as `[a, b, c, d, e, f]`, the layout of `DOMMatrix` and canvas
 * `setTransform`: a point maps to `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
 *
 * Every function is a worklet so the gesture handler can convert touches on the UI thread
 * (ADR-008 §4); in plain JS the directive is an inert string.
 */
export type Matrix = readonly [a: number, b: number, c: number, d: number, e: number, f: number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function translation(x: number, y: number): Matrix {
  'worklet';
  return [1, 0, 0, 1, x, y];
}

export function scaling(x: number, y: number): Matrix {
  'worklet';
  return [x, 0, 0, y, 0, 0];
}

/** `multiply(m, n)` applies `n` first, then `m`. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  'worklet';
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Composes left to right in the order they are applied: `chain(a, b)` applies `a`, then `b`. */
export function chain(...matrices: readonly Matrix[]): Matrix {
  'worklet';
  let result: Matrix = IDENTITY;
  for (const matrix of matrices) {
    result = multiply(matrix, result);
  }
  return result;
}

/**
 * Throws a RangeError for a singular matrix (a zero-sized page or viewport); in a worklet,
 * rule that out before calling.
 */
export function invert(m: Matrix): Matrix {
  'worklet';
  const determinant = m[0] * m[3] - m[1] * m[2];
  if (determinant === 0 || !Number.isFinite(determinant)) {
    throw new RangeError('Matrix is not invertible');
  }
  return [
    m[3] / determinant,
    -m[1] / determinant,
    -m[2] / determinant,
    m[0] / determinant,
    (m[2] * m[5] - m[3] * m[4]) / determinant,
    (m[1] * m[4] - m[0] * m[5]) / determinant,
  ];
}

export function applyToPoint(m: Matrix, x: number, y: number): [x: number, y: number] {
  'worklet';
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Skia's 3×3 row-major layout, for `Skia.Matrix(...)` or a `matrix` prop. */
export function toSkiaMatrix(
  m: Matrix,
): [number, number, number, number, number, number, number, number, number] {
  'worklet';
  return [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1];
}

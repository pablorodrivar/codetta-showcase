/**
 * Where two long sequences of numbers differ, for tests: `undefined` when they are equal, or a
 * message with the first index that differs, both values and how many differ. One check per
 * buffer instead of a deep `toEqual`, which compares element by element through the matcher and
 * dominated the time of the tests on long strokes (on a loaded CI runner, past Vitest's 5 s).
 *
 * Values are compared with `Object.is`, like `toEqual` does for numbers: `NaN` equals `NaN`, and
 * `0` and `-0` differ. Use it as `expect(firstDifference(actual, expected)).toBeUndefined()`.
 */
export function firstDifference(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
): string | undefined {
  const kind = (value: ArrayLike<number>) => Object.prototype.toString.call(value);
  if (kind(actual) !== kind(expected)) return `${kind(actual)} vs ${kind(expected)}`;
  const common = Math.min(actual.length, expected.length);
  const lengths =
    actual.length === expected.length
      ? ''
      : `length ${String(actual.length)} vs ${String(expected.length)}`;
  let first = -1;
  let count = 0;
  for (let index = 0; index < common; index++) {
    if (Object.is(actual[index], expected[index])) continue;
    if (first < 0) first = index;
    count++;
  }
  if (first < 0)
    return lengths === '' ? undefined : `${lengths}; the first ${String(common)} match`;
  // String(-0) is "0": show the sign, or a 0 against -0 would read as equal.
  const show = (value: number | undefined) => (Object.is(value, -0) ? '-0' : String(value));
  const difference =
    `index ${String(first)}: ${show(actual[first])} vs ${show(expected[first])}; ` +
    `${String(count)} of ${String(common)} values differ`;
  return lengths === '' ? difference : `${lengths}; ${difference}`;
}

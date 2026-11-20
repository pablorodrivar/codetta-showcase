import { describe, expect, it } from 'vitest';

import { firstDifference } from './compare';

describe('firstDifference', () => {
  it('is undefined for equal sequences, also with NaN', () => {
    expect(
      firstDifference(Float32Array.of(1, 2, Number.NaN), Float32Array.of(1, 2, Number.NaN)),
    ).toBeUndefined();
    expect(firstDifference([], [])).toBeUndefined();
  });

  it('names the first index that differs and how many do', () => {
    expect(firstDifference([1, 2, 3, 4], [1, 5, 3, 6])).toBe(
      'index 1: 2 vs 5; 2 of 4 values differ',
    );
  });

  it('tells 0 from -0, like toEqual', () => {
    expect(firstDifference([0], [-0])).toBe('index 0: 0 vs -0; 1 of 1 values differ');
  });

  it('reports a different length or kind of sequence', () => {
    expect(firstDifference([1, 2], [1])).toBe('length 2 vs 1; the first 1 match');
    expect(firstDifference([1, 9, 3], [1, 2])).toBe(
      'length 3 vs 2; index 1: 9 vs 2; 1 of 2 values differ',
    );
    expect(firstDifference(Float32Array.of(1), [1])).toBe(
      '[object Float32Array] vs [object Array]',
    );
  });
});

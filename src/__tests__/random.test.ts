import { gen, mkStr, choose, shuffle } from '../random';

describe('mkStr', () => {
  it('returns a non-empty string', () => {
    const result = mkStr();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns strings of 1-10 code points', () => {
    for (let i = 0; i < 20; i++) {
      const result = mkStr();
      // .length may exceed 10 due to surrogate pairs, but code point count is 1-10
      const codePointCount = [...result].length;
      expect(codePointCount).toBeGreaterThanOrEqual(1);
      expect(codePointCount).toBeLessThanOrEqual(10);
    }
  });

  it('produces different strings on repeated calls', () => {
    const results = new Set<string>();
    for (let i = 0; i < 20; i++) {
      results.add(mkStr());
    }
    // With random unicode, collisions are extremely unlikely
    expect(results.size).toBeGreaterThan(1);
  });
});

describe('gen', () => {
  it('returns a valid JavaScript variable name', () => {
    const isVarName = require('is-valid-var-name').es5;
    for (let i = 0; i < 10; i++) {
      const name = gen();
      expect(isVarName(name)).toBe(true);
    }
  });

  it('returns a non-empty string', () => {
    const name = gen();
    expect(name.length).toBeGreaterThan(0);
  });
});

describe('choose', () => {
  it('returns an element from the array', () => {
    const arr = [1, 2, 3, 4, 5];
    for (let i = 0; i < 20; i++) {
      expect(arr).toContain(choose(arr));
    }
  });

  it('works with a single-element array', () => {
    expect(choose(['only'])).toBe('only');
  });
});

describe('shuffle', () => {
  it('returns the same array reference', () => {
    const arr = [1, 2, 3];
    expect(shuffle(arr)).toBe(arr);
  });

  it('preserves all elements', () => {
    const arr = [1, 2, 3, 4, 5];
    const copy = [...arr];
    shuffle(arr);
    expect(arr.sort()).toEqual(copy.sort());
  });

  it('handles empty array', () => {
    const arr: number[] = [];
    expect(shuffle(arr)).toEqual([]);
  });

  it('handles single-element array', () => {
    expect(shuffle([42])).toEqual([42]);
  });
});

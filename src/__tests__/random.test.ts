import {
  gen,
  mkStr,
  choose,
  shuffle,
  resetIssuedNames,
  resetFragments,
  generateSharedNamePool,
  setSharedNamePool,
  clearSharedNamePool,
} from '../random';

describe('mkStr', () => {
  it('returns a non-empty string', () => {
    const result = mkStr();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns strings of 6-20 code points', () => {
    resetFragments();
    for (let i = 0; i < 20; i++) {
      const result = mkStr();
      const codePointCount = [...result].length;
      expect(codePointCount).toBeGreaterThanOrEqual(6);
      expect(codePointCount).toBeLessThanOrEqual(20);
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

  it('never returns the same name twice within a run', () => {
    resetIssuedNames();
    const seen = new Set<string>();
    const N = 5000;
    for (let i = 0; i < N; i++) seen.add(gen());
    expect(seen.size).toBe(N);
  });

  it('resetIssuedNames clears the tracked set', () => {
    resetIssuedNames();
    const first = gen();
    resetIssuedNames();
    // After reset, the same name could in theory be re-issued. We can't
    // prove it by observing collisions directly (name space is huge), but
    // we can verify the reset at least doesn't throw and gen still works.
    expect(typeof first).toBe('string');
    expect(gen().length).toBeGreaterThan(0);
  });
});

describe('fragment reuse', () => {
  // Collect every length-5 substring across a list of names, mapping each to
  // the set of names it appears in and the set of offsets it appears at.
  const indexSubstrings = (names: string[]) => {
    const inNames = new Map<string, Set<number>>();
    const atOffsets = new Map<string, Set<number>>();
    names.forEach((name, idx) => {
      const chars = [...name];
      for (let s = 0; s + 5 <= chars.length; s++) {
        const sub = chars.slice(s, s + 5).join('');
        (inNames.get(sub) ?? inNames.set(sub, new Set()).get(sub)!).add(idx);
        (atOffsets.get(sub) ?? atOffsets.set(sub, new Set()).get(sub)!).add(s);
      }
    });
    return { inNames, atOffsets };
  };

  it('reuses >4-char substrings across subsequently generated names', () => {
    resetIssuedNames();
    const names: string[] = [];
    for (let i = 0; i < 200; i++) names.push(gen());

    // Random characters come from huge Unicode ranges, so an accidental
    // shared 5-gram across two names is astronomically unlikely — any shared
    // substring is the fragment-reuse mechanism at work.
    const { inNames } = indexSubstrings(names);
    const shared = [...inNames.values()].filter((set) => set.size >= 2);
    expect(shared.length).toBeGreaterThan(5);
  });

  it('places reused substrings at varying offsets', () => {
    resetIssuedNames();
    const names: string[] = [];
    for (let i = 0; i < 400; i++) names.push(gen());

    // A reused fragment is spliced in at a random offset each time, so the
    // same substring should surface at more than one distinct start index.
    const { atOffsets } = indexSubstrings(names);
    const multiOffset = [...atOffsets.values()].filter((set) => set.size >= 2);
    expect(multiOffset.length).toBeGreaterThan(0);
  });

  it('keeps every name a valid identifier despite reuse', () => {
    const isVarName = require('is-valid-var-name').es5;
    resetIssuedNames();
    for (let i = 0; i < 300; i++) {
      expect(isVarName(gen())).toBe(true);
    }
  });

  it('resetFragments clears reuse state without breaking generation', () => {
    resetIssuedNames();
    for (let i = 0; i < 50; i++) gen(); // prime the store
    resetFragments();
    expect(gen().length).toBeGreaterThanOrEqual(6);
  });
});

describe('shared name pool', () => {
  const isVarName = require('is-valid-var-name').es5;

  afterEach(() => {
    clearSharedNamePool();
  });

  describe('generateSharedNamePool', () => {
    it('returns the requested number of names', () => {
      resetIssuedNames();
      const pool = generateSharedNamePool(64);
      expect(pool).toHaveLength(64);
    });

    it('returns only unique names', () => {
      resetIssuedNames();
      const pool = generateSharedNamePool(200);
      expect(new Set(pool).size).toBe(pool.length);
    });

    it('returns only valid identifiers', () => {
      resetIssuedNames();
      const pool = generateSharedNamePool(100);
      expect(pool.every((n) => isVarName(n))).toBe(true);
    });

    it('returns an empty pool for size 0', () => {
      resetIssuedNames();
      expect(generateSharedNamePool(0)).toEqual([]);
    });
  });

  describe('setSharedNamePool / gen draw order', () => {
    it('draws names from the pool in order', () => {
      resetIssuedNames();
      const pool = generateSharedNamePool(10);
      resetIssuedNames();
      setSharedNamePool(pool);
      expect(gen()).toBe(pool[0]);
      expect(gen()).toBe(pool[1]);
      expect(gen()).toBe(pool[2]);
    });

    it('yields identical sequences across files when the index is reset per file', () => {
      // This is the cross-file collision property: the Nth gen() in file A
      // returns the same identifier as the Nth gen() in file B.
      resetIssuedNames();
      const pool = generateSharedNamePool(20);

      resetIssuedNames();
      setSharedNamePool(pool);
      const fileA = [gen(), gen(), gen(), gen()];

      resetIssuedNames();
      setSharedNamePool(pool);
      const fileB = [gen(), gen(), gen(), gen()];

      expect(fileA).toEqual(fileB);
      expect(fileA).toEqual(pool.slice(0, 4));
    });

    it('falls back to fresh random generation once the pool is exhausted', () => {
      resetIssuedNames();
      const pool = generateSharedNamePool(3);
      resetIssuedNames();
      setSharedNamePool(pool);
      const drawn = [gen(), gen(), gen()];
      expect(drawn).toEqual(pool);
      // Fourth draw exhausts the pool and falls through to random generation.
      const overflow = gen();
      expect(isVarName(overflow)).toBe(true);
      expect(pool).not.toContain(overflow);
    });

    it('skips pool entries already issued in the current run', () => {
      resetIssuedNames();
      const pool = generateSharedNamePool(5);
      resetIssuedNames();
      setSharedNamePool(pool);
      // Issue the first entry directly, then start drawing — gen() should
      // skip the already-issued pool[0] and return pool[1] first.
      const first = gen();
      expect(first).toBe(pool[0]);
      // Re-installing the same pool resets the draw index, but pool[0] is now
      // in the issued set, so the next gen() skips it.
      setSharedNamePool(pool);
      expect(gen()).toBe(pool[1]);
    });
  });

  describe('clearSharedNamePool', () => {
    it('reverts gen() to fresh random generation', () => {
      resetIssuedNames();
      const pool = generateSharedNamePool(10);
      resetIssuedNames();
      setSharedNamePool(pool);
      expect(gen()).toBe(pool[0]);
      clearSharedNamePool();
      // After clearing, gen() rolls a fresh name rather than pool[1].
      const afterClear = gen();
      expect(isVarName(afterClear)).toBe(true);
      // Astronomically unlikely to equal a specific pool entry by chance.
      expect(afterClear).not.toBe(pool[1]);
    });
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

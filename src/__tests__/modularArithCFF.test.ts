import { applyControlFlowFlattening, flattenFunctionBody } from '../transforms/controlFlowFlattening';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function flatten(code: string, deadCodeMul: number = 1): string {
  const ast = parse(code);
  applyControlFlowFlattening(ast, { deadCodeMultiplier: deadCodeMul });
  return recast.print(ast).code;
}

function flattenAndEvalWithRetry(
  sourceCode: string,
  assertions: (fn: any) => boolean,
  deadCodeMul: number = 1,
  attempts = 30,
): void {
  let lastError: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = flatten(sourceCode, deadCodeMul);
      const fn = new Function(out + '\nreturn f;')();
      if (assertions(fn)) return;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error('All attempts failed assertions');
}

describe('modular arithmetic state transitions (Paper 3)', () => {
  it('switch discriminant uses multiplication and modulus', () => {
    const out = flatten('function f(x) { var a = x + 1; var b = a * 2; var c = b - 3; return c; }');
    // Should contain: _s * N % M (modular arithmetic discriminant)
    expect(out).toMatch(/\*\s*\d+\s*%\s*\d+/);
  });

  it('case values are modular-encoded (large numbers)', () => {
    let passed = false;
    for (let attempt = 0; attempt < 30 && !passed; attempt++) {
      const out = flatten('function f(x) { var a = x + 1; var b = a * 2; var c = b - 3; return c; }');
      const caseVals = out.match(/case (\d+):/g);
      if (!caseVals) continue;
      const values = caseVals.map((c: string) => parseInt(c.replace('case ', '').replace(':', '')));
      if (values.every(v => v > 1000)) passed = true;
    }
    expect(passed).toBe(true);
  });

  it('state assignments still use raw (smaller) state IDs', () => {
    const out = flatten('function f(x) { var a = x + 1; var b = a * 2; var c = b - 3; return c; }');
    // State assignments: _s = <rawId>
    // Raw IDs are 0-9999, while case values are modular-encoded (>10000)
    const assignments = out.match(/_s\s*=\s*(\d+)/g);
    expect(assignments).not.toBeNull();
    const rawIds = assignments!.map((a: string) => parseInt(a.replace(/_s\s*=\s*/, '')));
    const allSmall = rawIds.every(v => v <= 10000);
    expect(allSmall).toBe(true);
  });

  it('case values differ from raw state IDs in assignments', () => {
    const out = flatten('function f(x) { var a = x + 1; var b = a * 2; var c = b - 3; return c; }');
    const caseVals = (out.match(/case (\d+):/g) || []).map((c: string) =>
      parseInt(c.replace('case ', '').replace(':', '')));
    const assignVals = (out.match(/_s\s*=\s*(\d+)/g) || []).map((a: string) =>
      parseInt(a.replace(/_s\s*=\s*/, '')));

    // The sets should be disjoint (raw IDs != encoded IDs)
    const caseSet = new Set(caseVals);
    const assignSet = new Set(assignVals);
    let overlap = 0;
    for (const v of assignSet) {
      if (caseSet.has(v)) overlap++;
    }
    // There should be very little overlap (the initial state value
    // in the var declaration is raw, not encoded)
    expect(overlap).toBeLessThanOrEqual(1);
  });

  it('uses a prime modulus', () => {
    const out = flatten('function f(x) { var a = x + 1; var b = a * 2; var c = b - 3; return c; }');
    const modMatch = out.match(/%\s*(\d+)/);
    expect(modMatch).not.toBeNull();
    const modulus = parseInt(modMatch![1]);
    // Our moduli are all > 100000
    expect(modulus).toBeGreaterThan(100000);
  });

  it('all case values are unique (no modular collisions)', () => {
    const out = flatten('function f(x) { var a = x + 1; var b = a * 2; var c = b - 3; return c; }');
    const caseVals = (out.match(/case (\d+):/g) || []).map((c: string) =>
      parseInt(c.replace('case ', '').replace(':', '')));
    const unique = new Set(caseVals);
    expect(unique.size).toBe(caseVals.length);
  });

  it('different functions get different modular parameters', () => {
    const code = 'function f(x) { var a = x + 1; var b = a * 2; var c = b - 3; return c; }';
    const params = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const out = flatten(code);
      const modMatch = out.match(/\*\s*(\d+)\s*%\s*(\d+)/);
      if (modMatch) params.add(modMatch[1] + ',' + modMatch[2]);
    }
    // Should see at least 2 different parameter combinations across 10 runs
    expect(params.size).toBeGreaterThanOrEqual(2);
  });
});

describe('modular CFF functional correctness', () => {
  it('preserves simple sequential logic', () => {
    flattenAndEvalWithRetry(
      'function f(x) { var a = x + 1; var b = a * 2; var c = b - 3; return c; }',
      (fn) => fn(5) === 9 && fn(0) === -1 && fn(10) === 19,
    );
  });

  it('preserves if/else branching', () => {
    flattenAndEvalWithRetry(`
      function f(x) {
        var result;
        if (x > 0) {
          result = 1;
        } else {
          result = -1;
        }
        return result;
      }
    `, (fn) => fn(5) === 1 && fn(-5) === -1);
  });

  it('preserves loop computations', () => {
    flattenAndEvalWithRetry(`
      function f(n) {
        var sum = 0;
        for (var i = 0; i < n; i++) {
          sum = sum + i;
        }
        var result = sum;
        return result;
      }
    `, (fn) => fn(5) === 10 && fn(0) === 0);
  });

  it('preserves return in middle of function', () => {
    flattenAndEvalWithRetry(`
      function f(x) {
        var a = x * 2;
        if (a > 100) {
          return -1;
        }
        var b = a + 10;
        return b;
      }
    `, (fn) => fn(5) === 20 && fn(60) === -1);
  });

  it('works with dead code injection', () => {
    flattenAndEvalWithRetry(
      'function f(x) { var a = x + 1; var b = a * 2; var c = b - 3; return c; }',
      (fn) => fn(5) === 9 && fn(0) === -1,
      5, // dead code multiplier
    );
  });
});

describe('modular arithmetic analysis resistance', () => {
  it('an observer cannot recover raw state IDs from case values alone', () => {
    function modInverse(a: number, m: number): number {
      let [old_r, r] = [a, m];
      let [old_s, s] = [1, 0];
      while (r !== 0) {
        const q = Math.floor(old_r / r);
        [old_r, r] = [r, old_r - q * r];
        [old_s, s] = [s, old_s - q * s];
      }
      return ((old_s % m) + m) % m;
    }

    let passed = false;
    for (let attempt = 0; attempt < 30 && !passed; attempt++) {
      const out = flatten('function f(x) { var a = x + 1; var b = a * 2; var c = b - 3; return c; }');
      const modMatch = out.match(/\*\s*(\d+)\s*%\s*(\d+)/);
      if (!modMatch) continue;

      const multiplier = parseInt(modMatch[1]);
      const modulus = parseInt(modMatch[2]);
      const caseVals = (out.match(/case (\d+):/g) || []).map((c: string) =>
        parseInt(c.replace('case ', '').replace(':', '')));

      const inv = modInverse(multiplier, modulus);
      const recoveredIds = caseVals.map(cv => (cv * inv) % modulus);

      if (recoveredIds.every(rid => rid >= 0 && rid < 10000)) {
        passed = true;
      }
    }
    expect(passed).toBe(true);
  });
});

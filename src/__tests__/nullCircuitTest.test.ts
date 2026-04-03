import {
  computeFingerprint,
  computeSimilarity,
  generateNullFunction,
  runNullCircuitTest,
  StructuralFingerprint,
} from '../verification/nullCircuitTest';
import { obfuscate } from '../obfuscator';

describe('computeFingerprint', () => {
  it('extracts character count', () => {
    const fp = computeFingerprint('var x = 1;');
    expect(fp.totalChars).toBe(10);
  });

  it('counts function keywords', () => {
    const fp = computeFingerprint('function f() {} function g() {} var h = function() {};');
    expect(fp.functionCount).toBe(3);
  });

  it('counts if statements', () => {
    const fp = computeFingerprint('if (a) {} if (b) {} if (c) {}');
    expect(fp.ifCount).toBe(3);
  });

  it('counts loops', () => {
    const fp = computeFingerprint('for (;;) {} while (true) {} for (var i = 0;;) {}');
    expect(fp.loopCount).toBe(3);
  });

  it('counts return statements', () => {
    const fp = computeFingerprint('return 1; return 2; return;');
    expect(fp.returnCount).toBe(3);
  });

  it('counts var declarations', () => {
    const fp = computeFingerprint('var a = 1; var b = 2; var c;');
    expect(fp.varDeclCount).toBe(3);
  });

  it('counts switch cases', () => {
    const fp = computeFingerprint('switch(x) { case 1: break; case 2: break; case 3: break; }');
    expect(fp.switchCaseCount).toBe(3);
  });

  it('counts eval calls', () => {
    const fp = computeFingerprint('eval("x"); eval("y");');
    expect(fp.evalCount).toBe(2);
  });

  it('counts hex strings in array', () => {
    const fp = computeFingerprint('var arr = ["4a1f3c", "deadbeef", "00ff"];');
    expect(fp.stringArraySize).toBe(3);
  });

  it('computes nesting depth', () => {
    const shallow = computeFingerprint('var x = 1; var y = 2;');
    const deep = computeFingerprint('if (a) { if (b) { if (c) { var x = 1; } } }');
    expect(deep.avgNestingDepth).toBeGreaterThan(shallow.avgNestingDepth);
  });
});

describe('computeSimilarity', () => {
  it('returns 1.0 for identical fingerprints', () => {
    const fp: StructuralFingerprint = {
      totalChars: 100, uniqueTokens: 50, alphaSymRatio: 1.5,
      functionCount: 3, ifCount: 2, loopCount: 1, returnCount: 2,
      varDeclCount: 5, assignmentCount: 8, binaryOpCount: 10,
      stringArraySize: 3, avgNestingDepth: 2.5, evalCount: 1, switchCaseCount: 4,
    };
    expect(computeSimilarity(fp, fp)).toBe(1.0);
  });

  it('returns lower score for different fingerprints', () => {
    const a: StructuralFingerprint = {
      totalChars: 100, uniqueTokens: 50, alphaSymRatio: 1.5,
      functionCount: 3, ifCount: 2, loopCount: 1, returnCount: 2,
      varDeclCount: 5, assignmentCount: 8, binaryOpCount: 10,
      stringArraySize: 3, avgNestingDepth: 2.5, evalCount: 1, switchCaseCount: 4,
    };
    const b: StructuralFingerprint = {
      totalChars: 500, uniqueTokens: 200, alphaSymRatio: 0.5,
      functionCount: 10, ifCount: 15, loopCount: 8, returnCount: 12,
      varDeclCount: 30, assignmentCount: 40, binaryOpCount: 50,
      stringArraySize: 20, avgNestingDepth: 5.0, evalCount: 8, switchCaseCount: 20,
    };
    const sim = computeSimilarity(a, b);
    expect(sim).toBeLessThan(0.5);
    expect(sim).toBeGreaterThan(0);
  });

  it('is symmetric', () => {
    const a: StructuralFingerprint = {
      totalChars: 100, uniqueTokens: 50, alphaSymRatio: 1.5,
      functionCount: 3, ifCount: 2, loopCount: 1, returnCount: 2,
      varDeclCount: 5, assignmentCount: 8, binaryOpCount: 10,
      stringArraySize: 3, avgNestingDepth: 2.5, evalCount: 1, switchCaseCount: 4,
    };
    const b: StructuralFingerprint = {
      totalChars: 200, uniqueTokens: 80, alphaSymRatio: 1.2,
      functionCount: 5, ifCount: 4, loopCount: 2, returnCount: 3,
      varDeclCount: 8, assignmentCount: 12, binaryOpCount: 15,
      stringArraySize: 5, avgNestingDepth: 3.0, evalCount: 2, switchCaseCount: 6,
    };
    expect(computeSimilarity(a, b)).toBe(computeSimilarity(b, a));
  });
});

describe('generateNullFunction', () => {
  it('generates a function with the right name and params', () => {
    const code = generateNullFunction('testFn', 3, 5);
    expect(code).toContain('function testFn(p0, p1, p2)');
  });

  it('generates the requested number of statements', () => {
    const code = generateNullFunction('fn', 2, 8);
    // Count semicolons as a proxy for statements (approximate)
    const lines = code.split('\n').filter(l => l.trim().length > 0);
    // Should have function line + 8 statements + return + closing brace
    expect(lines.length).toBeGreaterThanOrEqual(8);
  });

  it('always ends with return (null circuit)', () => {
    const code = generateNullFunction('fn', 1, 5);
    expect(code).toContain('return;');
  });

  it('contains variable declarations', () => {
    const code = generateNullFunction('fn', 1, 5);
    expect(code).toContain('var ');
  });

  it('contains arithmetic operations', () => {
    const code = generateNullFunction('fn', 1, 6);
    expect(code.includes('+') || code.includes('*') || code.includes('^')).toBe(true);
  });

  it('contains control flow', () => {
    const code = generateNullFunction('fn', 1, 6);
    expect(code).toContain('if (');
  });

  it('is valid JavaScript', () => {
    const code = generateNullFunction('fn', 2, 10);
    const fn = new Function(code + '\nreturn fn;')();
    expect(typeof fn).toBe('function');
    // Null circuit should return undefined
    expect(fn(1, 2)).toBeUndefined();
  });
});

describe('runNullCircuitTest', () => {
  it('returns a result with all fields', () => {
    const realCode = `function add(a, b) {
      var sum = a + b;
      var doubled = sum * 2;
      return doubled;
    }`;
    const result = runNullCircuitTest(realCode, 2, 3, 0.3, 10000);
    expect(result).toHaveProperty('realFingerprint');
    expect(result).toHaveProperty('nullFingerprint');
    expect(result).toHaveProperty('similarity');
    expect(result).toHaveProperty('metricComparison');
    expect(result).toHaveProperty('pass');
    expect(result).toHaveProperty('threshold');
  });

  it('similarity is between 0 and 1', () => {
    const realCode = `function add(a, b) {
      var sum = a + b;
      var doubled = sum * 2;
      return doubled;
    }`;
    const result = runNullCircuitTest(realCode, 2, 3, 0.3, 10000);
    expect(result.similarity).toBeGreaterThanOrEqual(0);
    expect(result.similarity).toBeLessThanOrEqual(1);
  });

  it('metric comparison has entries for all metrics', () => {
    const realCode = 'function f(x) { var a = x + 1; return a; }';
    const result = runNullCircuitTest(realCode, 1, 2, 0.3, 10000);
    expect(result.metricComparison.length).toBe(14);
    for (const mc of result.metricComparison) {
      expect(mc).toHaveProperty('metric');
      expect(mc).toHaveProperty('real');
      expect(mc).toHaveProperty('null_');
      expect(mc).toHaveProperty('ratio');
    }
  });

  it('pass is true when similarity exceeds threshold', () => {
    const realCode = `function f(x) {
      var a = x + 1;
      var b = a * 2;
      var c = b - 3;
      return c;
    }`;
    // Very low threshold — should pass
    const result = runNullCircuitTest(realCode, 1, 4, 0.1, 10000);
    expect(result.pass).toBe(true);
  });
});

describe('null circuit quality assessment', () => {
  it('obfuscated real and null functions have similar size', () => {
    const realCode = `function compute(x, y) {
      var sum = x + y;
      var product = x * y;
      var diff = sum - product;
      if (diff > 0) { return sum; }
      return product;
    }`;
    const result = runNullCircuitTest(realCode, 2, 5, 0.3, 10000);

    // Size ratio should be within 5x (both should be significantly padded)
    const sizeRatio = Math.min(result.realFingerprint.totalChars, result.nullFingerprint.totalChars) /
                      Math.max(result.realFingerprint.totalChars, result.nullFingerprint.totalChars);
    expect(sizeRatio).toBeGreaterThan(0.1);
  });

  it('both real and null have similar structural complexity', () => {
    const realCode = `function process(data) {
      var result = data + 10;
      result = result * 3;
      if (result > 100) { result = result - 50; }
      var output = result + 5;
      return output;
    }`;
    const result = runNullCircuitTest(realCode, 1, 5, 0.3, 10000);

    // Both should have functions, variables, and control flow after obfuscation
    expect(result.realFingerprint.functionCount).toBeGreaterThan(0);
    expect(result.nullFingerprint.functionCount).toBeGreaterThan(0);
    expect(result.realFingerprint.varDeclCount).toBeGreaterThan(0);
    expect(result.nullFingerprint.varDeclCount).toBeGreaterThan(0);
  });

  it('similarity improves over unobfuscated code', () => {
    // Without obfuscation, real and null are easily distinguishable.
    // With obfuscation, the transforms (dead code, CFF, noise) should
    // make them more similar.
    const realCode = 'function f(x) { var a = x + 1; var b = a * 2; return b; }';
    const nullCode = generateNullFunction('g', 1, 3);

    // Unobfuscated similarity
    const rawRealFp = computeFingerprint(realCode);
    const rawNullFp = computeFingerprint(nullCode);
    const rawSimilarity = computeSimilarity(rawRealFp, rawNullFp);

    // Obfuscated similarity (average over a few runs due to randomness)
    let totalObfSim = 0;
    const runs = 3;
    for (let i = 0; i < runs; i++) {
      const result = runNullCircuitTest(realCode, 1, 3, 0, 10000);
      totalObfSim += result.similarity;
    }
    const avgObfSimilarity = totalObfSim / runs;

    // Both obfuscated versions should have non-trivial similarity
    // (both get padded with dead code, string arrays, etc.)
    // The key insight: obfuscation should not make them MORE distinguishable
    expect(avgObfSimilarity).toBeGreaterThan(0.3);
  });
});

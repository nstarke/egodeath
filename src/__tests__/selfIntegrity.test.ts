import { applySelfIntegrity } from '../transforms/selfIntegrity';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function transform(code: string): string {
  const ast = parse(code);
  applySelfIntegrity(ast);
  return recast.print(ast).code;
}

describe('applySelfIntegrity', () => {
  it('injects integrity check IIFEs into the program', () => {
    const code = 'function f() { return 1; } var x = f();';
    const out = transform(code);
    // Should have try/catch wrapped IIFEs
    expect(out).toContain('try');
    expect(out).toContain('catch');
  });

  it('adds 2-4 integrity checks', () => {
    const code = 'function f() { return 1; } function g() { return 2; }';
    let minChecks = Infinity;
    let maxChecks = 0;
    for (let i = 0; i < 10; i++) {
      const out = transform(code);
      const tryCount = (out.match(/\btry\s*\{/g) || []).length;
      minChecks = Math.min(minChecks, tryCount);
      maxChecks = Math.max(maxChecks, tryCount);
    }
    expect(minChecks).toBeGreaterThanOrEqual(2);
    expect(maxChecks).toBeLessThanOrEqual(4);
  });

  it('includes eval integrity check', () => {
    let found = false;
    for (let i = 0; i < 15; i++) {
      const out = transform('function f() { return 1; }');
      if (out.includes('eval') && out.includes('native code')) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('includes Function.prototype.toString check', () => {
    let found = false;
    for (let i = 0; i < 15; i++) {
      const out = transform('function f() { return 1; }');
      if (out.includes('Function.prototype.toString')) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('includes timing check', () => {
    let found = false;
    for (let i = 0; i < 20; i++) {
      const out = transform('function f() { return 1; }');
      if (out.includes('Date.now')) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('includes toString length check for named functions', () => {
    let found = false;
    for (let i = 0; i < 15; i++) {
      const out = transform('function myFunc() { return 1; } function other() { return 2; }');
      if (out.includes('.toString()') && out.includes('.match')) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('wraps checks in try/catch for safety', () => {
    const out = transform('function f() { return 1; }');
    // Every check should be in a try/catch so it doesn't crash
    // in environments where APIs aren't available
    const tryCount = (out.match(/\btry\s*\{/g) || []).length;
    const catchCount = (out.match(/\bcatch\s*\(/g) || []).length;
    expect(tryCount).toBe(catchCount);
    expect(tryCount).toBeGreaterThanOrEqual(2);
  });
});

describe('self-integrity functional safety', () => {
  it('does not break normal function execution', () => {
    for (let i = 0; i < 10; i++) {
      const out = transform(`
        function add(a, b) { return a + b; }
        function mul(a, b) { return a * b; }
      `);
      const fn = new Function(out + '\nreturn [add(3,4), mul(5,6)];');
      expect(fn()).toEqual([7, 30]);
    }
  });

  it('does not throw in normal execution', () => {
    for (let i = 0; i < 10; i++) {
      const out = transform('function f(x) { return x * 2; }');
      expect(() => {
        const fn = new Function(out + '\nreturn f(5);');
        fn();
      }).not.toThrow();
    }
  });

  it('passes integrity checks in a normal environment', () => {
    // In a normal Node.js environment, eval and Function.prototype.toString
    // should report "native code", so checks should pass
    for (let i = 0; i < 10; i++) {
      const out = transform(`
        function compute(x) { return x + 1; }
      `);
      const fn = new Function(out + '\nreturn compute(5);');
      // Should return correct result (checks passed, no tampering)
      expect(fn()).toBe(6);
    }
  });
});

describe('self-integrity tamper detection', () => {
  it('embeds eval native-code check that would detect replacement', () => {
    // Verify the check code is present — it compares eval.toString()
    // against "native code". If eval is replaced with a non-native
    // function, the check fails and triggers the anti-tamper response.
    let found = false;
    for (let i = 0; i < 20; i++) {
      const out = transform('function f() { return 42; }');
      // The eval check: eval.toString().indexOf("native code") === -1
      if (out.includes('.toString()') && out.includes('native code') && out.includes('=== -1')) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('detects debugger timing anomalies via threshold', () => {
    // The timing check compares elapsed time against 500ms
    // In normal execution, a 100-iteration empty loop takes <1ms
    // This test just verifies the timing code exists and is syntactically valid
    let hasTimingCode = false;
    for (let i = 0; i < 15; i++) {
      const out = transform('function f() { return 1; }');
      if (out.includes('Date.now') && out.includes('500')) {
        hasTimingCode = true;
        break;
      }
    }
    expect(hasTimingCode).toBe(true);
  });
});

describe('self-integrity diversity', () => {
  it('uses different check combinations across runs', () => {
    const patterns = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const out = transform('function f() { return 1; } function g() { return 2; }');
      let pattern = '';
      if (out.includes('eval') && out.includes('native code') && !out.includes('Function.prototype.toString.toString')) pattern += 'E';
      if (out.includes('Function.prototype.toString.toString')) pattern += 'F';
      if (out.includes('Date.now')) pattern += 'T';
      if (out.includes('.match(')) pattern += 'S';
      patterns.add(pattern);
    }
    // Should see at least 2 different check combinations
    expect(patterns.size).toBeGreaterThanOrEqual(2);
  });

  it('uses different tamper responses', () => {
    const responses = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const out = transform('function f() { return 1; }');
      if (out.includes('throw new')) responses.add('throw');
      if (out.match(/while\s*\(/)) responses.add('busy');
    }
    expect(responses.size).toBeGreaterThanOrEqual(2);
  });
});

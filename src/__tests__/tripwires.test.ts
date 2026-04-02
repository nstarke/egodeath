import { applyTripwires } from '../transforms/tripwires';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function transform(code: string): string {
  const ast = parse(code);
  applyTripwires(ast);
  return recast.print(ast).code;
}

describe('applyTripwires', () => {
  it('injects tripwires into functions with parameters', () => {
    let injected = false;
    for (let i = 0; i < 30; i++) {
      const out = transform('function f(x) { var a = x + 1; return a; }');
      if (out.includes('===') && out.length > 60) {
        injected = true;
        break;
      }
    }
    expect(injected).toBe(true);
  });

  it('does not inject into functions without parameters', () => {
    // No params means no target for the tripwire hash
    for (let i = 0; i < 20; i++) {
      const out = transform('function f() { return 42; }');
      // Should never grow significantly (no tripwire possible)
      expect(out.length).toBeLessThan(100);
    }
  });

  it('does not inject into arrow functions without block body', () => {
    const code = 'var f = (x) => x + 1;';
    for (let i = 0; i < 20; i++) {
      const out = transform(code);
      // Expression-body arrows don't have a BlockStatement
      expect(out).toBe(code);
    }
  });

  it('uses unique secrets for each injection', () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const out = transform('function f(x, y) { var a = x + y; var b = a * 2; return b; }');
      const match = out.match(/===\s*(\d+)/g);
      if (match) {
        match.forEach(m => secrets.add(m));
      }
    }
    // Should see multiple different secret values across runs
    expect(secrets.size).toBeGreaterThan(3);
  });

  it('contains hash computation setup variables', () => {
    let foundSetup = false;
    for (let i = 0; i < 30; i++) {
      const out = transform('function f(input) { var r = input * 2; return r; }');
      // Look for hash-like operations (XOR, shift, multiply by large prime)
      if (out.includes('>>>') || out.includes('0x') || out.includes('^') ||
          out.includes('charCodeAt') || out.includes('typeof')) {
        foundSetup = true;
        break;
      }
    }
    expect(foundSetup).toBe(true);
  });

  it('contains a payload in the if-body', () => {
    let foundPayload = false;
    for (let i = 0; i < 30; i++) {
      const out = transform('function f(x, y) { var a = x + y; return a; }');
      // Payloads include: null assignment, throw, while loop, return, XOR corruption
      if (out.includes('= null') || out.includes('throw') ||
          out.includes('while') || out.includes('return') && out.split('return').length > 2) {
        foundPayload = true;
        break;
      }
    }
    expect(foundPayload).toBe(true);
  });
});

describe('tripwire functional safety', () => {
  it('does not trigger on normal numeric inputs', () => {
    // Run many times with normal inputs — tripwires should never fire
    for (let run = 0; run < 20; run++) {
      const out = transform(`
        function add(a, b) { var s = a + b; return s; }
      `);
      const fn = new Function(out + '\nreturn add;')();
      // Normal inputs should always produce correct results
      expect(fn(3, 4)).toBe(7);
      expect(fn(0, 0)).toBe(0);
      expect(fn(-1, 1)).toBe(0);
      expect(fn(100, 200)).toBe(300);
    }
  });

  it('does not trigger on normal string inputs', () => {
    for (let run = 0; run < 20; run++) {
      const out = transform(`
        function greet(name) { var msg = "hi " + name; return msg; }
      `);
      const fn = new Function(out + '\nreturn greet;')();
      expect(fn("world")).toBe("hi world");
      expect(fn("")).toBe("hi ");
      expect(fn("test")).toBe("hi test");
    }
  });

  it('preserves function behavior with multiple parameters', () => {
    for (let run = 0; run < 20; run++) {
      const out = transform(`
        function compute(x, y, z) {
          var sum = x + y + z;
          var product = x * y * z;
          return sum + product;
        }
      `);
      const fn = new Function(out + '\nreturn compute;')();
      // compute(2,3,4) = (2+3+4) + (2*3*4) = 9 + 24 = 33
      expect(fn(2, 3, 4)).toBe(33);
    }
  });
});

describe('tripwire diversity', () => {
  it('uses different hash patterns across injections', () => {
    const patterns = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const out = transform('function f(x) { var a = x + 1; var b = a * 2; return b; }');
      if (out.includes('typeof')) patterns.add('typeof');
      if (out.includes('charCodeAt')) patterns.add('charCodeAt');
      if (out.includes('>>>')) patterns.add('bitwise');
      if (out.match(/%\s*\d+/)) patterns.add('modular');
    }
    // Should see at least 2 different pattern types across 50 runs
    expect(patterns.size).toBeGreaterThanOrEqual(2);
  });

  it('uses different payloads across injections', () => {
    const payloads = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const out = transform('function f(x, y) { var a = x + y; return a; }');
      if (out.includes('= null')) payloads.add('nullify');
      if (out.includes('throw')) payloads.add('throw');
      if (out.includes('while')) payloads.add('loop');
      // Check for XOR corruption (param ^ number)
      if (out.match(/\w+\s*=\s*\w+\s*\^\s*\d+/)) payloads.add('corrupt');
    }
    expect(payloads.size).toBeGreaterThanOrEqual(2);
  });
});

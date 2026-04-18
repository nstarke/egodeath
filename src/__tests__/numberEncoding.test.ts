import { applyNumberEncoding } from '../transforms/numberEncoding';
import { obfuscate } from '../obfuscator';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function transform(code: string): string {
  const ast = parse(code);
  applyNumberEncoding(ast);
  return recast.print(ast).code;
}

function evalTransformed(code: string, returnExpr: string): any {
  const out = transform(code);
  return new Function(out + '\nreturn ' + returnExpr + ';')();
}

describe('applyNumberEncoding', () => {
  it('replaces numeric literals with expressions', () => {
    const out = transform('var x = 42;');
    // Should not contain a plain 42 as the only thing on the right side
    // The expression will contain operators
    expect(out).toMatch(/[<<>>|^~*\/+-]/);
  });

  it('produces diverse expressions for the same number', () => {
    // Encoding is randomized: each call picks one of ~11 strategies and
    // fills in random constants. Across many samples we should see many
    // distinct outputs. Asserting strict uniqueness of just 3 samples is
    // flaky — the space is large but not so large that every 3-tuple
    // avoids collisions. Instead, assert meaningful variety over a much
    // larger sample so independent collisions don't fail the test.
    const samples = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const out = transform('var x = 42;');
      const m = out.match(/=\s*(.+?);/);
      if (m) samples.add(m[1]);
    }
    expect(samples.size).toBeGreaterThanOrEqual(10);
  });

  it('does not encode 0', () => {
    const out = transform('var x = 0;');
    expect(out).toBe('var x = 0;');
  });

  it('does not encode 1', () => {
    const out = transform('var x = 1;');
    expect(out).toBe('var x = 1;');
  });

  it('does not encode -1', () => {
    const out = transform('var x = -1;');
    expect(out).toBe('var x = -1;');
  });

  it('does not encode floating point numbers', () => {
    const out = transform('var x = 3.14;');
    expect(out).toContain('3.14');
  });

  it('encodes negative integers', () => {
    const result = evalTransformed('var x = -42;', 'x');
    expect(result).toBe(-42);
  });

  it('encodes large numbers within int32 range', () => {
    const result = evalTransformed('var x = 100000;', 'x');
    expect(result).toBe(100000);
  });

  it('uses bitwise operators', () => {
    // Run many times and check that at least some use bitwise ops
    let hasBitwise = false;
    for (let i = 0; i < 20; i++) {
      const out = transform('var x = 42;');
      if (/[<<>>|^~]/.test(out)) {
        hasBitwise = true;
        break;
      }
    }
    expect(hasBitwise).toBe(true);
  });

  it('sometimes uses hex notation', () => {
    let hasHex = false;
    for (let i = 0; i < 30; i++) {
      const out = transform('var x = 255;');
      if (out.includes('0x')) {
        hasHex = true;
        break;
      }
    }
    expect(hasHex).toBe(true);
  });
});

describe('number encoding correctness', () => {
  const testNumbers = [2, 3, 5, 7, 10, 13, 42, 64, 99, 100, 127, 128, 255, 256, 500, 1000, 9999];

  for (const n of testNumbers) {
    it(`correctly encodes ${n}`, () => {
      const result = evalTransformed(`var x = ${n};`, 'x');
      expect(result).toBe(n);
    });
  }

  it('correctly encodes negative numbers', () => {
    for (const n of [-2, -10, -42, -100, -255]) {
      const result = evalTransformed(`var x = ${n};`, 'x');
      expect(result).toBe(n);
    }
  });

  it('preserves arithmetic with encoded numbers', () => {
    const result = evalTransformed('var x = 10 + 20 + 30;', 'x');
    expect(result).toBe(60);
  });

  it('preserves comparisons with encoded numbers', () => {
    const result = evalTransformed('var x = 42 > 10;', 'x');
    expect(result).toBe(true);
  });

  it('preserves array indexing with encoded numbers', () => {
    const result = evalTransformed('var arr = [10, 20, 30]; var x = arr[2];', 'x');
    expect(result).toBe(30);
  });

  it('handles many numbers in one expression', () => {
    const result = evalTransformed(
      'var x = 5 * 10 + 3 * 7 - 2 * 4;',
      'x',
    );
    expect(result).toBe(63);
  });

  // Brute-force: test 50 random numbers
  it('correctly encodes 50 random integers', () => {
    for (let i = 0; i < 50; i++) {
      const n = Math.floor(Math.random() * 10000) + 2;
      const result = evalTransformed(`var x = ${n};`, 'x');
      expect(result).toBe(n);
    }
  });
});

describe('full pipeline with number encoding', () => {
  it('no plain numeric literals in obfuscated output (except 0 and 1)', () => {
    const code = 'var x = 42; var y = 100; var z = 255;';
    const out = obfuscate(code, { targetTokens: 10000 });
    // The specific numbers 42, 100, 255 should not appear as plain literals
    // (they'll be encoded as expressions)
    // Note: they might appear as parts of encoding expressions (e.g., 42 ^ key)
    // but not as standalone assignments
    expect(out).not.toMatch(/=\s*42\s*;/);
    expect(out).not.toMatch(/=\s*100\s*;/);
    expect(out).not.toMatch(/=\s*255\s*;/);
  });
});

describe('regression: adjacent unary minus does not decay to decrement', () => {
  // Two adjacent unary minus operators (e.g. inside complementNeg when the
  // intermediate value is negative) used to render as `--4` in the output,
  // which tokenizes as the decrement operator and fails with
  // "Invalid left-hand side expression in prefix operation".
  // Negative values must round-trip as parenthesized unary expressions.

  for (const n of [-2, -10, -42, -100, -128, -1000]) {
    it(`encodes ${n} without producing a '--' token`, () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const out = transform(`var x = ${n};`);
        expect(out).not.toMatch(/--(?=\d|\()/);
        // The encoded form must also evaluate back to n.
        const result = new Function(out + '\nreturn x;')();
        expect(result).toBe(n);
      }
    });
  }

  it('does not emit `--` in a full obfuscation pass on a negative-heavy input', () => {
    const code = `
      function f() {
        var a = -42, b = -100, c = -255, d = -1000;
        var e = a - b + c - d;
        return e + (-7) - (-3);
      }
    `;
    for (let attempt = 0; attempt < 10; attempt++) {
      const out = obfuscate(code, { targetTokens: 10000 });
      // Decrement-without-target should never appear in the output.
      expect(out).not.toMatch(/[^\-]--\d/);
      // And the output must still parse as a program.
      expect(() => new Function(out)).not.toThrow();
    }
  });
});

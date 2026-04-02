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

  it('produces unique expressions for the same number', () => {
    const out = transform('var a = 42; var b = 42; var c = 42;');
    const matches = out.match(/=\s*(.+?);/g)!;
    const unique = new Set(matches);
    expect(unique.size).toBe(matches.length);
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
  it('obfuscated code with encoded numbers works correctly', () => {
    const code = `
      function fibonacci(n) {
        if (n <= 1) return n;
        var a = 0, b = 1, temp;
        for (var i = 2; i <= n; i++) {
          temp = a + b;
          a = b;
          b = temp;
        }
        return b;
      }
      module.exports = fibonacci;
    `;
    const out = obfuscate(code, { targetTokens: 10000 });
    const fs = require('fs'), os = require('os'), path = require('path');
    const tmp = path.join(os.tmpdir(), 'numenc_full_' + Date.now() + '.js');
    fs.writeFileSync(tmp, out);
    const fib = require(tmp);
    expect(fib(0)).toBe(0);
    expect(fib(1)).toBe(1);
    expect(fib(10)).toBe(55);
    expect(fib(20)).toBe(6765);
  });

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

import { applyNoiseInjection } from '../transforms/noiseInjection';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function transform(code: string): string {
  const ast = parse(code);
  applyNoiseInjection(ast);
  return recast.print(ast).code;
}

describe('applyNoiseInjection', () => {
  it('injects noise into arithmetic var declarations', () => {
    const code = `function f(x) {
      var a = x + 10;
      var b = a * 3;
      var c = b - 5;
      var d = c + a;
      var e = d * 2;
      var g = e - b;
      return g;
    }`;
    let injected = false;
    for (let i = 0; i < 30; i++) {
      const out = transform(code);
      // Noise injection adds extra var declarations for noise variables
      if (out.split('var ').length > code.split('var ').length + 1) {
        injected = true;
        break;
      }
    }
    expect(injected).toBe(true);
  });

  it('injects noise into expression assignments', () => {
    const code = `function f(x) {
      var a;
      a = x + 10;
      a = a * 3;
      a = a - 5;
      a = a + 1;
      return a;
    }`;
    let injected = false;
    for (let i = 0; i < 30; i++) {
      const out = transform(code);
      if (out.split('var ').length > code.split('var ').length + 1) {
        injected = true;
        break;
      }
    }
    expect(injected).toBe(true);
  });

  it('does not inject into non-arithmetic assignments', () => {
    const code = `function f(x) {
      var a = "hello";
      var b = true;
      return a;
    }`;
    // Non-arithmetic — should never add extra variables
    for (let i = 0; i < 20; i++) {
      const out = transform(code);
      // No noise variables should be added
      expect(out.split('var ').length).toBe(code.split('var ').length);
    }
  });

  it('does not inject into very short function bodies', () => {
    const code = 'function f(x) { return x; }';
    for (let i = 0; i < 20; i++) {
      expect(transform(code)).toBe(code);
    }
  });

  it('uses different noise patterns across injections', () => {
    const code = `function f(x) {
      var a = x + 10;
      var b = a * 3;
      var c = b - 5;
      var d = c + a;
      var e = d * 2;
      var g = e - b;
      return g;
    }`;
    const patterns = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const out = transform(code);
      if (out.includes('^ ')) patterns.add('xor');
      if (out.includes('<< ')) patterns.add('shift');
      if (out.includes('/ ')) patterns.add('div');
      if (out.includes('& 65535') || out.includes('& 0xFFFF')) patterns.add('computed');
    }
    expect(patterns.size).toBeGreaterThanOrEqual(2);
  });
});

describe('noise injection correctness', () => {
  it('preserves addition results', () => {
    const code = `function f(x) {
      var a = x + 10;
      var b = a + 20;
      var c = b + 30;
      return c;
    }`;
    for (let i = 0; i < 20; i++) {
      const out = transform(code);
      const fn = new Function(out + '\nreturn f;')();
      expect(fn(5)).toBe(65);
      expect(fn(0)).toBe(60);
      expect(fn(-10)).toBe(50);
    }
  });

  it('preserves multiplication results', () => {
    const code = `function f(x) {
      var a = x * 2;
      var b = a * 3;
      var c = b * 4;
      return c;
    }`;
    for (let i = 0; i < 20; i++) {
      const out = transform(code);
      const fn = new Function(out + '\nreturn f;')();
      expect(fn(5)).toBe(120);
      expect(fn(1)).toBe(24);
      expect(fn(0)).toBe(0);
    }
  });

  it('preserves subtraction results', () => {
    const code = `function f(x) {
      var a = x - 5;
      var b = a - 3;
      var c = b - 1;
      return c;
    }`;
    for (let i = 0; i < 20; i++) {
      const out = transform(code);
      const fn = new Function(out + '\nreturn f;')();
      expect(fn(20)).toBe(11);
      expect(fn(9)).toBe(0);
    }
  });

  it('preserves mixed arithmetic results', () => {
    const code = `function f(x) {
      var a = x + 10;
      var b = a * 3;
      var c = b - 5;
      return c;
    }`;
    for (let i = 0; i < 20; i++) {
      const out = transform(code);
      const fn = new Function(out + '\nreturn f;')();
      // f(5) = (5+10)*3-5 = 40
      expect(fn(5)).toBe(40);
      expect(fn(0)).toBe(25);
    }
  });

  it('preserves expression assignment results', () => {
    const code = `function f(x) {
      var a;
      a = x + 5;
      a = a * 2;
      a = a - 3;
      return a;
    }`;
    for (let i = 0; i < 20; i++) {
      const out = transform(code);
      const fn = new Function(out + '\nreturn f;')();
      // f(10) = (10+5)*2-3 = 27
      expect(fn(10)).toBe(27);
    }
  });

  it('preserves bitwise operation results', () => {
    const code = `function f(x) {
      var a = x | 3;
      var b = a & 255;
      var c = b ^ 42;
      return c;
    }`;
    for (let i = 0; i < 20; i++) {
      const out = transform(code);
      const fn = new Function(out + '\nreturn f;')();
      expect(fn(100)).toBe((100 | 3) & 255 ^ 42);
      expect(fn(0)).toBe((0 | 3) & 255 ^ 42);
    }
  });
});

describe('noise injection diversity', () => {
  it('generates unique noise values per injection', () => {
    const code = `function f(x) {
      var a = x + 10;
      var b = a * 3;
      var c = b - 5;
      var d = c + a;
      var e = d * 2;
      var g = e - b;
      return g;
    }`;
    const noiseVals = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const out = transform(code);
      // Extract numeric literals that look like noise values (>100)
      const nums = out.match(/= (\d{3,})/g);
      if (nums) nums.forEach(n => noiseVals.add(n));
    }
    // Should see many different noise values
    expect(noiseVals.size).toBeGreaterThan(5);
  });

  it('noise variables have unique generated names', () => {
    const code = `function f(x) {
      var a = x + 10;
      var b = a * 3;
      var c = b - 5;
      var d = c + a;
      var e = d * 2;
      var g = e - b;
      return g;
    }`;
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const out = transform(code);
      // Extract var declarations that aren't the original variables
      const varDecls = out.match(/var\s+(\S+)\s*[=;]/g);
      if (varDecls) {
        for (const d of varDecls) {
          const name = d.replace(/var\s+/, '').replace(/\s*[=;]/, '');
          if (!['a', 'b', 'c', 'd', 'e', 'g'].includes(name)) {
            names.add(name);
          }
        }
      }
    }
    expect(names.size).toBeGreaterThan(3);
  });
});

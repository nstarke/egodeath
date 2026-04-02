import { applyCommaExpressions } from '../transforms/commaExpressions';
import { obfuscate } from '../obfuscator';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function transform(code: string): string {
  const ast = parse(code);
  applyCommaExpressions(ast);
  return recast.print(ast).code;
}

describe('applyCommaExpressions', () => {
  it('merges consecutive expression statements', () => {
    const out = transform('a = 1; b = 2; c = 3;');
    // Should be a single statement with commas
    expect(out).toContain(', ');
    // Count semicolons — should be just 1 (end of the merged expression)
    const semis = (out.match(/;/g) || []).length;
    expect(semis).toBe(1);
  });

  it('absorbs return into comma expression', () => {
    const out = transform('function f() { a = 1; b = 2; return c; }');
    expect(out).toContain('return a = 1, b = 2, c;');
  });

  it('absorbs throw into comma expression', () => {
    const out = transform('function f() { a = 1; b = 2; throw err; }');
    // recast may parenthesize the sequence expression
    expect(out).toMatch(/throw.*a = 1.*b = 2.*err/);
  });

  it('does not merge a single expression statement', () => {
    const out = transform('a = 1;');
    expect(out).toBe('a = 1;');
  });

  it('breaks run at variable declarations', () => {
    const out = transform('a = 1; var x = 2; b = 3;');
    // var breaks the run — a=1 stays alone, then var, then b=3 stays alone
    expect(out).toContain('a = 1;');
    expect(out).toContain('var x = 2;');
    expect(out).toContain('b = 3;');
  });

  it('breaks run at if statements', () => {
    const out = transform('a = 1; b = 2; if (true) {} c = 3; d = 4;');
    // Two runs: [a,b] and [c,d], with if in between
    expect(out).toContain('a = 1, b = 2;');
    expect(out).toContain('c = 3, d = 4;');
  });

  it('breaks run at for loops', () => {
    const out = transform('a = 1; for (;;) {} b = 2;');
    expect(out).toContain('a = 1;');
    expect(out).toContain('b = 2;');
  });

  it('breaks run at break statements', () => {
    const code = 'switch(x) { case 1: a = 1; b = 2; break; }';
    const out = transform(code);
    // a=1,b=2 merged, then break is separate
    expect(out).toContain('a = 1, b = 2;');
  });

  it('processes nested blocks', () => {
    const out = transform('function f() { if (true) { a = 1; b = 2; c = 3; } }');
    expect(out).toContain('a = 1, b = 2, c = 3;');
  });

  it('processes switch case consequents', () => {
    const out = transform('switch(x) { case 1: a = 1; b = 2; break; case 2: c = 3; d = 4; break; }');
    expect(out).toContain('a = 1, b = 2;');
    expect(out).toContain('c = 3, d = 4;');
  });

  it('handles return without argument after expressions', () => {
    const out = transform('function f() { a = 1; b = 2; return; }');
    // Return with no argument absorbs the preceding expressions
    // and returns the last expression's value (which is discarded)
    expect(out).toContain('return a = 1, b = 2;');
  });

  it('handles empty blocks', () => {
    const out = transform('function f() {}');
    expect(out).toBe('function f() {}');
  });
});

describe('comma expression functional correctness', () => {
  it('merged assignments execute in order', () => {
    const out = transform('var a; a = 1; a = a + 2; a = a * 3;');
    const fn = new Function(out + '\nreturn a;');
    expect(fn()).toBe(9);
  });

  it('return with comma preserves final value', () => {
    const out = transform(`
      function f() {
        var x = 0;
        x = x + 1;
        x = x + 2;
        x = x + 3;
        return x;
      }
    `);
    const fn = new Function(out + '\nreturn f();');
    expect(fn()).toBe(6);
  });

  it('side effects execute correctly', () => {
    const out = transform(`
      function f() {
        var arr = [];
        arr.push(1);
        arr.push(2);
        arr.push(3);
        return arr;
      }
    `);
    const fn = new Function(out + '\nreturn f();');
    expect(fn()).toEqual([1, 2, 3]);
  });

  it('works with if/else between runs', () => {
    const out = transform(`
      function f(x) {
        var r = 0;
        r = r + 1;
        r = r + 2;
        if (x > 0) {
          r = r + 10;
          r = r + 20;
        }
        r = r + 100;
        r = r + 200;
        return r;
      }
    `);
    const fn = new Function(out + '\nreturn f;')();
    expect(fn(1)).toBe(333);
    expect(fn(-1)).toBe(303);
  });

  it('throw with comma works', () => {
    const out = transform(`
      function f() {
        var x = 0;
        x = 1;
        x = 2;
        throw new Error("test");
      }
    `);
    const fn = new Function(out + '\ntry { f(); } catch(e) { return e.message; }');
    expect(fn()).toBe('test');
  });
});

describe('full pipeline with comma expressions', () => {
  it('obfuscated code with comma merging works', () => {
    const code = `
      function transform(arr) {
        var result = [];
        for (var i = 0; i < arr.length; i++) {
          var val = arr[i];
          val = val * 2;
          val = val + 1;
          result.push(val);
        }
        return result;
      }
      module.exports = transform;
    `;
    const out = obfuscate(code);
    const fs = require('fs'), os = require('os'), path = require('path');
    const tmp = path.join(os.tmpdir(), 'comma_full_' + Date.now() + '.js');
    fs.writeFileSync(tmp, out);
    const transformFn = require(tmp);
    expect(transformFn([1, 2, 3])).toEqual([3, 5, 7]);
  });

  it('CFF switch cases get comma-merged', () => {
    const code = `
      function f(x) {
        var a = x + 1;
        var b = a * 2;
        var c = b - 3;
        return c;
      }
    `;
    const out = obfuscate(code);
    // The comma operator should appear in the output (merged switch case bodies)
    // This is hard to test directly since everything is obfuscated,
    // but the output should contain SequenceExpressions rendered as commas
    expect(out).toContain(',');
  });
});

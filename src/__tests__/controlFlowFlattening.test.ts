import { flattenFunctionBody } from '../transforms/controlFlowFlattening';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function parseFunction(code: string): any {
  const ast = parse(code);
  return ast.program.body[0];
}

function flattenAndPrint(code: string): string {
  const ast = parse(code);
  const fn = ast.program.body[0];
  const flattened = flattenFunctionBody(fn.body.body);
  if (flattened) {
    fn.body.body = flattened;
  }
  return recast.print(ast).code;
}

function evalFunction(code: string): any {
  // Eval the function declaration, then return it by name
  const match = code.match(/function\s+(\w+)/);
  if (!match) throw new Error('No function found in code');
  const name = match[1];
  return new Function(code + '\nreturn ' + name + ';')();
}

describe('flattenFunctionBody', () => {
  it('returns null for functions with fewer than 3 statements', () => {
    const fn = parseFunction('function f() { var a = 1; return a; }');
    expect(flattenFunctionBody(fn.body.body)).toBeNull();
  });

  it('returns null for functions with imports/exports', () => {
    const ast = parse('import x from "y"; var a = 1; var b = 2; var c = 3;');
    expect(flattenFunctionBody(ast.program.body)).toBeNull();
  });

  it('flattens a function with 3+ simple statements', () => {
    const fn = parseFunction('function f() { var a = 1; var b = 2; var c = 3; return c; }');
    const result = flattenFunctionBody(fn.body.body);
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
  });

  it('produces output containing a WhileStatement', () => {
    const output = flattenAndPrint('function f() { var a = 1; var b = 2; var c = 3; return c; }');
    expect(output).toContain('while');
    expect(output).toContain('switch');
  });

  it('hoists variable declarations', () => {
    const fn = parseFunction('function f() { var x = 1; var y = 2; var z = x + y; return z; }');
    const result = flattenFunctionBody(fn.body.body)!;
    // First entries should be hoisted var declarations
    const varDecls = result.filter((s: any) => s.type === 'VariableDeclaration');
    // At least the hoisted vars + the state var
    expect(varDecls.length).toBeGreaterThanOrEqual(4); // x, y, z, _s
  });

  it('uses randomized non-sequential state IDs', () => {
    const output = flattenAndPrint('function f() { var a = 1; var b = 2; var c = 3; return c; }');
    const caseMatches = output.match(/case\s+(\d+)/g);
    expect(caseMatches).not.toBeNull();
    const ids = caseMatches!.map((m: string) => parseInt(m.replace('case ', '')));
    // Should not be sequential (0,1,2,3...)
    const isSequential = ids.every((id: number, i: number) => id === i);
    expect(isSequential).toBe(false);
    // IDs should be unique
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shuffles case order (non-deterministic, check structure)', () => {
    // Run multiple times — at least one should have non-ascending order
    let foundShuffled = false;
    for (let i = 0; i < 10; i++) {
      const output = flattenAndPrint('function f() { var a = 1; var b = 2; var c = 3; return c; }');
      const caseMatches = output.match(/case\s+(\d+)/g);
      const ids = caseMatches!.map((m: string) => parseInt(m.replace('case ', '')));
      const sorted = [...ids].sort((a, b) => a - b);
      if (JSON.stringify(ids) !== JSON.stringify(sorted)) {
        foundShuffled = true;
        break;
      }
    }
    expect(foundShuffled).toBe(true);
  });
});

describe('flattened function correctness', () => {
  it('preserves simple sequential logic', () => {
    const code = flattenAndPrint('function f(x) { var a = x + 1; var b = a * 2; var c = b - 3; return c; }');
    const f = evalFunction(code);
    expect(f(5)).toBe(9);  // (5+1)*2-3 = 9
    expect(f(0)).toBe(-1); // (0+1)*2-3 = -1
  });

  it('preserves if/else branching', () => {
    const code = flattenAndPrint(`
      function f(x) {
        var result;
        if (x > 0) {
          result = 1;
        } else {
          result = -1;
        }
        return result;
      }
    `);
    const f = evalFunction(code);
    expect(f(5)).toBe(1);
    expect(f(-5)).toBe(-1);
  });

  it('preserves if without else', () => {
    const code = flattenAndPrint(`
      function f(x) {
        var result = 0;
        if (x > 10) {
          result = x;
        }
        return result;
      }
    `);
    const f = evalFunction(code);
    expect(f(20)).toBe(20);
    expect(f(5)).toBe(0);
  });

  it('preserves loops within cases', () => {
    const code = flattenAndPrint(`
      function f(n) {
        var sum = 0;
        for (var i = 0; i < n; i++) {
          sum = sum + i;
        }
        var result = sum;
        return result;
      }
    `);
    const f = evalFunction(code);
    expect(f(5)).toBe(10);  // 0+1+2+3+4
    expect(f(0)).toBe(0);
  });

  it('preserves return in middle of function', () => {
    const code = flattenAndPrint(`
      function f(x) {
        var a = x * 2;
        if (a > 100) {
          return -1;
        }
        var b = a + 10;
        return b;
      }
    `);
    const f = evalFunction(code);
    expect(f(5)).toBe(20);   // 5*2+10
    expect(f(60)).toBe(-1);  // 60*2=120>100
  });

  it('handles functions with only variable declarations and return', () => {
    const code = flattenAndPrint(`
      function f() {
        var a = 10;
        var b = 20;
        var c = a + b;
        return c;
      }
    `);
    const f = evalFunction(code);
    expect(f()).toBe(30);
  });
});

import { generatePredicate, applyOpaquePredicates } from '../transforms/opaquePredicates';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function evalExpr(predicateCode: string, probeValue: number): any {
  // Build: var <probeVar> = <probeValue>; return <expr>;
  return new Function(predicateCode)();
}

describe('generatePredicate', () => {
  it('generates always-true predicates that evaluate to true', () => {
    for (let i = 0; i < 50; i++) {
      const pred = generatePredicate(true);
      expect(pred.alwaysTrue).toBe(true);

      // Build evaluable code: init probe, then test predicate
      const initCode = recast.print({ type: 'File', program: {
        type: 'Program', body: [pred.probeInit],
      }}).code;
      const exprCode = recast.print({ type: 'File', program: {
        type: 'Program', body: [{
          type: 'ReturnStatement',
          argument: pred.expr,
        }],
      }}).code;

      const fn = new Function(initCode + '\n' + exprCode);
      expect(fn()).toBe(true);
    }
  });

  it('generates always-false predicates that evaluate to false', () => {
    for (let i = 0; i < 50; i++) {
      const pred = generatePredicate(false);
      expect(pred.alwaysTrue).toBe(false);

      const initCode = recast.print({ type: 'File', program: {
        type: 'Program', body: [pred.probeInit],
      }}).code;
      const exprCode = recast.print({ type: 'File', program: {
        type: 'Program', body: [{
          type: 'ReturnStatement',
          argument: pred.expr,
        }],
      }}).code;

      const fn = new Function(initCode + '\n' + exprCode);
      expect(fn()).toBe(false);
    }
  });

  it('generates different predicates across calls', () => {
    const exprs = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const pred = generatePredicate();
      const code = recast.print({ type: 'File', program: {
        type: 'Program', body: [{
          type: 'ExpressionStatement', expression: pred.expr,
        }],
      }}).code;
      exprs.add(code);
    }
    // Should see multiple distinct predicates
    expect(exprs.size).toBeGreaterThan(3);
  });

  it('uses different probe variable names', () => {
    const names = new Set<string>();
    for (let i = 0; i < 10; i++) {
      names.add(generatePredicate().probeVar);
    }
    expect(names.size).toBeGreaterThan(1);
  });

  it('probe init produces a valid integer', () => {
    for (let i = 0; i < 20; i++) {
      const pred = generatePredicate(true);
      const initCode = recast.print({ type: 'File', program: {
        type: 'Program', body: [pred.probeInit],
      }}).code;

      // Execute the init and return the probe value
      const fn = new Function(initCode + '\nreturn ' + pred.probeVar + ';');
      const val = fn();
      expect(typeof val).toBe('number');
      expect(Number.isInteger(val)).toBe(true);
      expect(val).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('always-true predicates hold for many inputs', () => {
  it('are true across 1000 random probe values', () => {
    for (let i = 0; i < 30; i++) {
      const pred = generatePredicate(true);
      const varName = pred.probeVar;

      const exprCode = recast.print({ type: 'File', program: {
        type: 'Program', body: [{
          type: 'ReturnStatement',
          argument: pred.expr,
        }],
      }}).code;

      // Test with many different integer values
      const testFn = new Function(varName, exprCode);
      for (let v = 0; v < 1000; v++) {
        expect(testFn(v)).toBe(true);
      }
    }
  });
});

describe('always-false predicates hold for many inputs', () => {
  it('are false across 1000 random probe values', () => {
    for (let i = 0; i < 30; i++) {
      const pred = generatePredicate(false);
      const varName = pred.probeVar;

      const exprCode = recast.print({ type: 'File', program: {
        type: 'Program', body: [{
          type: 'ReturnStatement',
          argument: pred.expr,
        }],
      }}).code;

      const testFn = new Function(varName, exprCode);
      for (let v = 0; v < 1000; v++) {
        expect(testFn(v)).toBe(false);
      }
    }
  });
});

describe('applyOpaquePredicates', () => {
  it('injects predicates into function bodies', () => {
    const code = `function f(x) {
      var a = x + 1;
      a = a * 2;
      a = a + 3;
      a = a - 1;
      a = a * 4;
      return a;
    }`;
    const ast = parse(code);
    applyOpaquePredicates(ast);
    const out = recast.print(ast).code;

    // Should have probe inits (Math.random)
    expect(out).toContain('Math.random()');
  });

  it('preserves functional correctness', () => {
    const code = `function f(x) {
      var a = x + 1;
      a = a * 2;
      a = a + 3;
      a = a - 1;
      return a;
    }`;
    const ast = parse(code);
    applyOpaquePredicates(ast);
    const out = recast.print(ast).code;

    const fn = new Function(out + '\nreturn f;')();
    // f(5) = ((5+1)*2+3-1) = 14
    expect(fn(5)).toBe(14);
    expect(fn(0)).toBe(4);
    expect(fn(10)).toBe(24);
  });

  it('does not inject into very short functions', () => {
    const code = 'function f() { return 1; }';
    const ast = parse(code);
    const original = recast.print(ast).code;
    applyOpaquePredicates(ast);
    const after = recast.print(ast).code;
    // Should be unchanged (only 1 statement)
    expect(after).toBe(original);
  });

  it('does not wrap variable declarations or return statements', () => {
    const code = `function f() {
      var a = 1;
      var b = 2;
      a = a + b;
      b = b * a;
      return a + b;
    }`;
    const ast = parse(code);
    applyOpaquePredicates(ast);
    const out = recast.print(ast).code;

    // Should still work
    const fn = new Function(out + '\nreturn f;')();
    // a=1, b=2, a=3, b=6, return 9
    expect(fn()).toBe(9);
  });
});

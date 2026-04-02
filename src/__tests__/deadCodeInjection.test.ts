import {
  generateDeadCode,
  generateDeadCaseBody,
  collectScopeVars,
} from '../transforms/deadCodeInjection';
import * as recast from 'recast';
import { obfuscate } from '../obfuscator';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function stmtsToCode(stmts: any[]): string {
  const ast = { type: 'File', program: { type: 'Program', body: stmts } };
  return recast.print(ast).code;
}

describe('collectScopeVars', () => {
  it('collects variable names from declarations', () => {
    const ast = parse('var x = 1; var y = 2; var z = 3;');
    const vars = collectScopeVars(ast.program.body);
    expect(vars).toContain('x');
    expect(vars).toContain('y');
    expect(vars).toContain('z');
  });

  it('collects names from assignment expressions', () => {
    const ast = parse('a = 1; b = 2;');
    const vars = collectScopeVars(ast.program.body);
    expect(vars).toContain('a');
    expect(vars).toContain('b');
  });

  it('returns empty array for empty body', () => {
    expect(collectScopeVars([])).toEqual([]);
  });
});

describe('generateDeadCode', () => {
  it('returns valid AST statements', () => {
    for (let i = 0; i < 20; i++) {
      const stmts = generateDeadCode();
      const code = stmtsToCode(stmts);
      // Should be non-empty
      expect(code.length).toBeGreaterThan(0);
      // Should be parseable (valid JS)
      expect(() => parse(code)).not.toThrow();
    }
  });

  it('produces different code across calls', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 15; i++) {
      codes.add(stmtsToCode(generateDeadCode()));
    }
    expect(codes.size).toBeGreaterThan(3);
  });

  it('references scope variables when provided', () => {
    const scopeVars = ['myData', 'counter', 'result'];
    let foundRef = false;
    // Run many times since reference is probabilistic
    for (let i = 0; i < 30; i++) {
      const code = stmtsToCode(generateDeadCode(scopeVars));
      if (scopeVars.some((v) => code.includes(v))) {
        foundRef = true;
        break;
      }
    }
    expect(foundRef).toBe(true);
  });

  it('generates valid code even without scope vars', () => {
    for (let i = 0; i < 10; i++) {
      const stmts = generateDeadCode([]);
      const code = stmtsToCode(stmts);
      expect(() => parse(code)).not.toThrow();
    }
  });

  it('respects count parameter', () => {
    // count=1 should produce fewer statements on average than count=3
    let singleTotal = 0;
    let tripleTotal = 0;
    for (let i = 0; i < 10; i++) {
      singleTotal += generateDeadCode([], 1).length;
      tripleTotal += generateDeadCode([], 3).length;
    }
    expect(tripleTotal).toBeGreaterThan(singleTotal);
  });
});

describe('generateDeadCaseBody', () => {
  it('ends with state assignment and break', () => {
    const stmts = generateDeadCaseBody('_s', [100, 200, 300], []);
    // Last two statements should be assignment and break
    const last = stmts[stmts.length - 1];
    const secondLast = stmts[stmts.length - 2];
    expect(last.type).toBe('BreakStatement');
    expect(secondLast.type).toBe('ExpressionStatement');
    expect(secondLast.expression.type).toBe('AssignmentExpression');
    expect(secondLast.expression.left.name).toBe('_s');
  });

  it('transitions to one of the real state IDs', () => {
    const realIds = [100, 200, 300];
    for (let i = 0; i < 10; i++) {
      const stmts = generateDeadCaseBody('_s', realIds, []);
      const assignStmt = stmts[stmts.length - 2];
      const targetId = assignStmt.expression.right.value;
      expect(realIds).toContain(targetId);
    }
  });

  it('generates valid parseable code', () => {
    for (let i = 0; i < 10; i++) {
      const stmts = generateDeadCaseBody('_s', [1, 2, 3], ['x', 'y']);
      const code = 'switch(0) { case 0: ' + stmtsToCode(stmts) + ' }';
      expect(() => parse(code)).not.toThrow();
    }
  });
});

describe('dead cases in CFF state machine', () => {
  it('CFF output has more cases than original statements', () => {
    const code = `function f(x) {
      var a = x + 1;
      var b = a * 2;
      var c = b - 3;
      return c;
    }`;
    const ast = parse(code);
    const { applyControlFlowFlattening } = require('../transforms/controlFlowFlattening');
    applyControlFlowFlattening(ast);
    const out = recast.print(ast).code;
    const caseCount = (out.match(/\bcase\s+\d+/g) || []).length;
    // 4 statements = ~5 real cases + exit case + at least 2 dead cases
    expect(caseCount).toBeGreaterThanOrEqual(7);
  });

  it('dead cases do not break functional correctness', () => {
    const code = `function f(x) {
      var a = x + 1;
      var b = a * 2;
      var c = b - 3;
      return c;
    }`;
    const ast = parse(code);
    const { applyControlFlowFlattening } = require('../transforms/controlFlowFlattening');
    applyControlFlowFlattening(ast);
    const out = recast.print(ast).code;
    const fn = new Function(out + '\nreturn f;')();
    expect(fn(5)).toBe(9);
    expect(fn(0)).toBe(-1);
    expect(fn(10)).toBe(19);
  });
});

describe('full pipeline correctness with dead code', () => {
  it('obfuscated code with dead code still works', () => {
    const code = `
      function calculate(x, y) {
        var sum = x + y;
        var product = x * y;
        if (sum > product) {
          return sum;
        } else {
          return product;
        }
      }
      module.exports = calculate;
    `;
    const out = obfuscate(code, { targetTokens: 10000 });
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const tmp = path.join(os.tmpdir(), 'dead_test_' + Date.now() + '.js');
    fs.writeFileSync(tmp, out);
    const calculate = require(tmp);
    // sum=7, product=12 → product wins
    expect(calculate(3, 4)).toBe(12);
    // sum=11, product=10 → sum wins
    expect(calculate(1, 10)).toBe(11);
    // sum=0, product=0 → product (else branch)
    expect(calculate(0, 0)).toBe(0);
  });
});

import * as recast from 'recast';
import { analyzeScopes, setScopeAnalysis, resetScopeAnalysis } from '../scopeAnalysis';
import { resetIssuedNames } from '../random';
import { obfuscate } from '../obfuscator';

function parse(code: string): any {
  return recast.parse(code, { parser: require('recast/parsers/babel') });
}

/** Collect every Identifier node in the AST so tests can assert on them directly. */
function collectIdentifiers(node: any, out: any[] = [], seen = new WeakSet()): any[] {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (node.type === 'Identifier') out.push(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((vv) => collectIdentifiers(vv, out, seen));
    else if (v && typeof v === 'object') collectIdentifiers(v, out, seen);
  }
  return out;
}

function identsByName(ast: any, name: string): any[] {
  return collectIdentifiers(ast.program).filter((n) => n.name === name);
}

beforeEach(() => {
  resetIssuedNames();
  resetScopeAnalysis();
});

describe('analyzeScopes', () => {
  it('assigns the same rename to a binding and all its references', () => {
    const ast = parse('var x = 1; x + 2; x * 3;');
    const a = analyzeScopes(ast.program);
    const xs = identsByName(ast, 'x');
    expect(xs.length).toBe(3);
    const names = new Set(xs.map((n) => a.resolvedNames.get(n)));
    expect(names.size).toBe(1);
    expect(xs.every((n) => a.resolvedNames.has(n))).toBe(true);
  });

  it('picks different renames for same-named bindings in sibling scopes', () => {
    const ast = parse('function a(x) { return x; } function b(x) { return x; }');
    const a = analyzeScopes(ast.program);
    const xs = identsByName(ast, 'x');
    // 4 occurrences: two params, two return references.
    expect(xs.length).toBe(4);
    const inA = xs.slice(0, 2).map((n) => a.resolvedNames.get(n));
    const inB = xs.slice(2, 4).map((n) => a.resolvedNames.get(n));
    expect(inA[0]).toBe(inA[1]);
    expect(inB[0]).toBe(inB[1]);
    expect(inA[0]).not.toBe(inB[0]);
  });

  it('marks free references', () => {
    const ast = parse('var x = 1; console.log(y);');
    const a = analyzeScopes(ast.program);
    const ys = identsByName(ast, 'y');
    expect(ys.length).toBe(1);
    expect(a.freeReferences.has(ys[0])).toBe(true);
    expect(a.resolvedNames.has(ys[0])).toBe(false);
  });

  it('handles var hoisting through nested blocks', () => {
    const ast = parse('function f() { { var x = 1; } return x; }');
    const a = analyzeScopes(ast.program);
    const xs = identsByName(ast, 'x');
    expect(xs.length).toBe(2);
    expect(a.resolvedNames.get(xs[0])).toBe(a.resolvedNames.get(xs[1]));
  });

  it('scopes let to its enclosing block', () => {
    const ast = parse('let x = 1; { let x = 2; x; } x;');
    const a = analyzeScopes(ast.program);
    const xs = identsByName(ast, 'x');
    // 4 occurrences: outer decl, inner decl, inner ref, outer ref.
    expect(xs.length).toBe(4);
    const outer = a.resolvedNames.get(xs[0]);
    const inner = a.resolvedNames.get(xs[1]);
    expect(outer).not.toBe(inner);
    expect(a.resolvedNames.get(xs[2])).toBe(inner);
    expect(a.resolvedNames.get(xs[3])).toBe(outer);
  });

  it('binds catch params in the catch scope', () => {
    const ast = parse('let e = 1; try {} catch (e) { e; } e;');
    const a = analyzeScopes(ast.program);
    const es = identsByName(ast, 'e');
    expect(es.length).toBe(4);
    // Outer decl and outer tail reference share a render; catch param
    // and its body use differ from the outer.
    const outer = a.resolvedNames.get(es[0]);
    const catchParam = a.resolvedNames.get(es[1]);
    expect(outer).not.toBe(catchParam);
    expect(a.resolvedNames.get(es[2])).toBe(catchParam);
    expect(a.resolvedNames.get(es[3])).toBe(outer);
  });

  it('binds destructured patterns', () => {
    // Intentionally avoid names that happen to be on the keyword list
    // (e.g. `rest`, `length`, `body`) — those get left at their source
    // spelling on purpose, so they're never in resolvedNames.
    const ast = parse('const {alpha, beta: [gamma, ...delta]} = srcObj; alpha; gamma; delta;');
    const a = analyzeScopes(ast.program);
    for (const name of ['alpha', 'gamma', 'delta']) {
      const nodes = identsByName(ast, name);
      expect(nodes.length).toBeGreaterThanOrEqual(2);
      const first = a.resolvedNames.get(nodes[0]);
      expect(first).toBeDefined();
      expect(nodes.every((n) => a.resolvedNames.get(n) === first)).toBe(true);
    }
    // `srcObj` is free, `beta` is a non-computed property key (skip).
    const objNodes = identsByName(ast, 'srcObj');
    expect(a.freeReferences.has(objNodes[0])).toBe(true);
    const bNodes = identsByName(ast, 'beta');
    expect(a.skipNodes.has(bNodes[0])).toBe(true);
  });

  it('leaves non-computed MemberExpression property names unclassified as references', () => {
    const ast = parse('var o = 1; o.foo.bar;');
    const a = analyzeScopes(ast.program);
    const fooNodes = identsByName(ast, 'foo');
    const barNodes = identsByName(ast, 'bar');
    expect(a.skipNodes.has(fooNodes[0])).toBe(true);
    expect(a.skipNodes.has(barNodes[0])).toBe(true);
  });

  it('marks labels, not references', () => {
    const ast = parse('L: for (;;) { break L; continue L; }');
    const a = analyzeScopes(ast.program);
    const ls = identsByName(ast, 'L');
    expect(ls.length).toBe(3);
    expect(ls.every((n) => a.skipNodes.has(n))).toBe(true);
  });

  it('exposes live-names sets per function scope', () => {
    const ast = parse('function outer() { let x = 1; function inner() { let y = 2; return x + y; } }');
    const a = analyzeScopes(ast.program);
    const outer = ast.program.body[0];
    const inner = outer.body.body[1];
    const outerLive = a.liveNamesByScope.get(outer);
    const innerLive = a.liveNamesByScope.get(inner);
    expect(outerLive).toBeDefined();
    expect(innerLive).toBeDefined();
    // inner's live set is a superset of outer's (includes ancestors).
    for (const v of outerLive!) expect(innerLive!.has(v)).toBe(true);
  });
});

describe('obfuscate integration (scope analysis)', () => {
  beforeAll(() => {
    (global as any).setInterval = () => 0;
  });

  // Low ratio so heavy transforms stay off and semantics are easy to
  // verify — we're proving scope analysis didn't break rename, not
  // exercising the full pipeline.
  const OPTS = { targetTokens: 2000 };

  it('preserves semantics for same-named params in sibling functions', () => {
    const code = `
      function adder(x) { return x + 1; }
      function doubler(x) { return x * 2; }
      module.exports = { tot: adder(3) + doubler(4) };
    `;
    const out = obfuscate(code, OPTS);
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    expect(mod.exports.tot).toBe(4 + 8);
  });

  it('preserves semantics for nested let shadowing', () => {
    const code = `
      function run() {
        let x = 10;
        { let x = 20; var inner = x; }
        return x + inner;
      }
      module.exports = { tot: run() };
    `;
    const out = obfuscate(code, OPTS);
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    expect(mod.exports.tot).toBe(30);
  });

  it('preserves semantics with destructuring bindings', () => {
    const code = `
      function run(src) {
        const {alpha, beta: [gamma, delta]} = src;
        return alpha + gamma + delta;
      }
      module.exports = { tot: run({ alpha: 1, beta: [2, 3] }) };
    `;
    const out = obfuscate(code, OPTS);
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    expect(mod.exports.tot).toBe(6);
  });

  it('preserves semantics for shorthand properties (both in patterns and literals)', () => {
    const code = `
      function run() {
        const x = 7, y = 9;
        const obj = { x, y };
        const { x: xx, y: yy } = obj;
        return xx + yy;
      }
      module.exports = { tot: run() };
    `;
    const out = obfuscate(code, OPTS);
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    expect(mod.exports.tot).toBe(16);
  });

  it('preserves semantics for catch clauses', () => {
    const code = `
      function run() {
        let msg = 'outer';
        try { throw new Error('boom'); }
        catch (msg) { return String(msg.message || msg); }
      }
      module.exports = { msg: run() };
    `;
    const out = obfuscate(code, OPTS);
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    expect(mod.exports.msg).toBe('boom');
  });
});

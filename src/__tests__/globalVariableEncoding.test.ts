import { applyGlobalVariableEncoding } from '../transforms/globalVariableEncoding';
import { obfuscate } from '../obfuscator';
import { resetCapturedGlobals, flushCapturedGlobals } from '../capturedGlobals';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function transform(code: string): string {
  resetCapturedGlobals();
  const ast = parse(code);
  applyGlobalVariableEncoding(ast);
  flushCapturedGlobals(ast);
  return recast.print(ast).code;
}

describe('applyGlobalVariableEncoding', () => {
  it('replaces Math with eval/replace expression', () => {
    const out = transform('var x = Math.random();');
    expect(out).toContain('eval(');
    expect(out).toContain('.replace(');
    expect(out).not.toMatch(/\bMath\b(?!.*replace)/);
  });

  it('replaces Array with eval/replace expression', () => {
    const out = transform('var x = new Array(3);');
    expect(out).toContain('eval(');
  });

  it('replaces Object with eval/replace expression', () => {
    const out = transform('var x = Object.keys({});');
    expect(out).toContain('eval(');
  });

  it('replaces JSON with eval/replace expression', () => {
    const out = transform('var x = JSON.stringify({});');
    expect(out).toContain('eval(');
  });

  it('uses unique suffixes for each instance', () => {
    const out = transform('var a = Math.random(); var b = Math.floor(1.5);');
    // Extract the strings inside quotes (the "Math<suffix>" values)
    const matches = out.match(/"Math[a-zA-Z0-9]+"/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);
    // They should be different
    expect(matches![0]).not.toBe(matches![1]);
  });

  it('does not encode property accesses named after globals', () => {
    const out = transform('var obj = {}; obj.Math = 1;');
    // obj.Math should remain as a property, not eval-encoded
    expect(out).not.toContain('eval(');
  });

  it('does not encode variable declarations shadowing globals', () => {
    const out = transform('var Math = 42;');
    expect(out).not.toContain('eval(');
  });

  it('does not encode function parameters named after globals', () => {
    const out = transform('function f(Array) { return Array; }');
    // The parameter should not be encoded, but the body reference
    // is ambiguous — we encode identifier references
    // Actually the parameter itself shouldn't be encoded
    expect(out).toContain('function f(Array)');
  });

  it('does not encode object literal keys', () => {
    const out = transform('var x = { Math: 1, Object: 2 };');
    expect(out).not.toContain('eval(');
  });

  it('handles multiple different globals', () => {
    const out = transform('var a = Math.PI; var b = Array.isArray([]); var c = Object.keys({});');
    // Should have 3 eval calls
    const evalCount = (out.match(/eval\(/g) || []).length;
    expect(evalCount).toBe(3);
  });
});

describe('global encoding functional correctness', () => {
  it('eval/replace resolves Math correctly', () => {
    const out = transform('var x = Math.floor(1.7);');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe(1);
  });

  it('eval/replace resolves Array correctly', () => {
    const out = transform('var x = Array.isArray([1, 2, 3]);');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe(true);
  });

  it('eval/replace resolves Object correctly', () => {
    const out = transform('var x = Object.keys({a: 1, b: 2});');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toEqual(['a', 'b']);
  });

  it('eval/replace resolves JSON correctly', () => {
    const out = transform('var x = JSON.stringify({a: 1});');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe('{"a":1}');
  });

  it('eval/replace resolves String correctly', () => {
    const out = transform('var x = String(42);');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe('42');
  });

  it('eval/replace resolves Number correctly', () => {
    const out = transform('var x = Number("42");');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe(42);
  });

  it('eval/replace works with new keyword', () => {
    const out = transform('var x = new RegExp("abc");');
    const fn = new Function(out + '\nreturn x.test("xabcx");');
    expect(fn()).toBe(true);
  });

  it('works with chained member access', () => {
    const out = transform('var x = Math.floor(Math.random() * 100);');
    const fn = new Function(out + '\nreturn x;');
    const result = fn();
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(100);
  });
});

describe('full pipeline with global encoding', () => {
  it('no readable global names in obfuscated output', () => {
    const code = 'var x = Math.floor(1.5); var y = JSON.stringify({a:1});';
    const out = obfuscate(code, { targetTokens: 10000 });
    // Global names should not appear as readable identifiers
    expect(out).not.toMatch(/\bMath\b/);
    expect(out).not.toMatch(/\bJSON\b/);
  });

  it('strings used in global encoding go into the string array', () => {
    const code = 'var x = Math.PI;';
    const out = obfuscate(code, { targetTokens: 10000 });
    // The output should NOT contain any "Math..." string literal directly
    // because it should be in the jsfuck-encoded string array
    expect(out).not.toMatch(/"Math/);
  });
});

import { applyPropertyKeyEncoding } from '../transforms/propertyKeyEncoding';
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
  applyPropertyKeyEncoding(ast);
  flushCapturedGlobals(ast);
  return recast.print(ast).code;
}

describe('applyPropertyKeyEncoding', () => {
  it('converts dot access to computed access', () => {
    const out = transform('obj.foo;');
    expect(out).toContain('[');
    expect(out).toContain('.replace(');
    expect(out).not.toMatch(/obj\.foo/);
  });

  it('converts object literal keys to computed keys', () => {
    const out = transform('var x = {foo: 1};');
    expect(out).toContain('[');
    expect(out).toContain('.replace(');
  });

  it('reuses same variable for same property name in same scope', () => {
    const out = transform('obj.foo; obj.foo;');
    // Same property name gets the same variable (deduplicated)
    const matches = out.match(/"foo[a-zA-Z0-9]+"/g);
    expect(matches).not.toBeNull();
    // Only one declaration for "foo" (deduped)
    expect(matches!.length).toBe(1);
  });

  it('generates unique suffix for different properties', () => {
    const out = transform('obj.foo; obj.bar;');
    const fooMatch = out.match(/"foo[a-zA-Z0-9]+"/g);
    const barMatch = out.match(/"bar[a-zA-Z0-9]+"/g);
    expect(fooMatch).not.toBeNull();
    expect(barMatch).not.toBeNull();
  });

  it('handles multiple different properties', () => {
    const out = transform('obj.foo; obj.bar; obj.baz;');
    expect(out).toContain('"foo');
    expect(out).toContain('"bar');
    expect(out).toContain('"baz');
  });

  it('converts method call property to computed', () => {
    const out = transform('obj.method();');
    // Should become obj[var]()
    expect(out).toContain('[');
    expect(out).toContain('.replace(');
  });

  it('handles chained property access', () => {
    const out = transform('obj.foo.bar;');
    // Both .foo and .bar should be converted
    const replaceCount = (out.match(/\.replace\(/g) || []).length;
    expect(replaceCount).toBe(2);
  });

  it('encodes single-character properties too', () => {
    const out = transform('obj.x = 1;');
    // All properties get encoded, including short ones
    expect(out).toContain('.replace(');
  });

  it('does not encode constructor/prototype', () => {
    const out = transform('obj.constructor; obj.prototype;');
    expect(out).not.toContain('.replace(');
  });

  it('handles assignment to property', () => {
    const out = transform('obj.foo = 42;');
    expect(out).toContain('[');
    expect(out).toContain('.replace(');
  });

  it('handles class method definitions', () => {
    const out = transform('class Foo { myMethod() {} }');
    expect(out).toContain('[');
    expect(out).toContain('.replace(');
  });
});

describe('property encoding functional correctness', () => {
  it('dot access resolves correctly', () => {
    const out = transform('var obj = {foo: 42}; var x = obj.foo;');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe(42);
  });

  it('property assignment works', () => {
    const out = transform('var obj = {}; obj.foo = 99; var x = obj.foo;');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe(99);
  });

  it('method calls work', () => {
    const out = transform('var arr = [3,1,2]; arr.sort(); var x = arr[0];');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe(1);
  });

  it('object literal with multiple keys works', () => {
    const out = transform('var obj = {name: "Alice", age: 30}; var x = obj.name + obj.age;');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe('Alice30');
  });

  it('nested property access works', () => {
    const out = transform('var obj = {inner: {value: 7}}; var x = obj.inner.value;');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe(7);
  });

  it('method chaining works', () => {
    const out = transform('var x = [1,2,3].concat([4,5]).length;');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe(5);
  });

  it('works with built-in methods like push, toString', () => {
    const out = transform('var arr = []; arr.push(1); arr.push(2); var x = arr.toString();');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe('1,2');
  });
});

describe('full pipeline with property encoding', () => {
  it('no readable property names in final output', () => {
    const code = 'var obj = {secret: 42, password: "abc"};';
    const out = obfuscate(code, { targetTokens: 10000 });
    expect(out).not.toContain('"secret"');
    expect(out).not.toContain('"password"');
    expect(out).not.toMatch(/\.secret/);
    expect(out).not.toMatch(/\.password/);
  });

});

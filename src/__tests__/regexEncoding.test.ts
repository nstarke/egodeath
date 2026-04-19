import { applyRegexEncoding } from '../transforms/regexEncoding';
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
  applyRegexEncoding(ast);
  flushCapturedGlobals(ast);
  return recast.print(ast).code;
}

describe('applyRegexEncoding', () => {
  it('converts regex literals to new-expressions backed by a RegExp capture', () => {
    const out = transform('var x = /test/;');
    // The transform captures `RegExp` at program level under a fresh
    // name to survive `var RegExp = ...` shadowing inside nested
    // scopes (see lodash runInContext). The rewritten literal should
    // still be a `new`-expression of that capture.
    expect(out).toMatch(/var\s+\S+\s*=\s*RegExp\s*;/);
    expect(out).toMatch(/new\s+\S+\s*\(\s*"test"/);
    expect(out).not.toContain('/test/');
  });

  it('preserves regex flags', () => {
    const out = transform('var x = /pattern/gi;');
    expect(out).toContain('"gi"');
    expect(out).toContain('"pattern"');
  });

  it('handles regex without flags', () => {
    const out = transform('var x = /simple/;');
    expect(out).toMatch(/new\s+\S+\s*\(\s*"simple"\s*\)/);
    // No flags argument
    expect(out).not.toMatch(/"simple"\s*,/);
  });

  it('preserves backslash sequences in patterns', () => {
    const code = String.raw`var x = /^\d+$/;`;
    const out = transform(code);
    expect(out).toMatch(/new\s+\S+\s*\(/);
    // The pattern should still contain \d
    expect(out).toContain('\\d');
  });

  it('converts multiple regex literals', () => {
    const code = 'var a = /foo/; var b = /bar/g; var c = /baz/i;';
    const out = transform(code);
    const newCount = (out.match(/\bnew\s+\S+\s*\(/g) || []).length;
    expect(newCount).toBe(3);
  });

  it('handles complex regex patterns', () => {
    const code = String.raw`var x = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;`;
    const out = transform(code);
    expect(out).toMatch(/new\s+\S+\s*\(/);
    expect(out).not.toMatch(/\/\^/); // No regex literal start
  });
});

describe('regex encoding correctness', () => {
  it('simple regex test still works', () => {
    const out = transform('var x = /hello/; var result = x.test("hello world");');
    const fn = new Function(out + '\nreturn result;');
    expect(fn()).toBe(true);
  });

  it('regex with flags works', () => {
    const out = transform('var x = /hello/i; var result = x.test("HELLO");');
    const fn = new Function(out + '\nreturn result;');
    expect(fn()).toBe(true);
  });

  it('regex with global flag works', () => {
    const code = 'var x = /a/g; var result = "banana".match(x);';
    const out = transform(code);
    const fn = new Function(out + '\nreturn result;');
    expect(fn()).toEqual(['a', 'a', 'a']);
  });

  it('regex with special characters works', () => {
    const code = String.raw`var x = /^\d{3}-\d{4}$/; var result = x.test("123-4567");`;
    const out = transform(code);
    const fn = new Function(out + '\nreturn result;');
    expect(fn()).toBe(true);
  });

  it('regex used in string replace works', () => {
    const code = 'var x = /world/; var result = "hello world".replace(x, "earth");';
    const out = transform(code);
    const fn = new Function(out + '\nreturn result;');
    expect(fn()).toBe('hello earth');
  });

  it('regex used in string split works', () => {
    const code = String.raw`var x = /\s+/; var result = "hello world foo".split(x);`;
    const out = transform(code);
    const fn = new Function(out + '\nreturn result;');
    expect(fn()).toEqual(['hello', 'world', 'foo']);
  });

  it('regex with capture groups works', () => {
    const code = String.raw`var x = /(\d+)-(\d+)/; var m = "123-456".match(x); var result = [m[1], m[2]];`;
    const out = transform(code);
    const fn = new Function(out + '\nreturn result;');
    expect(fn()).toEqual(['123', '456']);
  });
});

describe('regex encoding in full pipeline', () => {
  it('regex patterns are hidden in obfuscated output', () => {
    const code = String.raw`
      var emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      var result = emailRegex.test("user@example.com");
    `;
    const out = obfuscate(code, { targetTokens: 10000 });
    // The regex pattern should not be visible
    expect(out).not.toContain('[a-zA-Z0-9');
    expect(out).not.toContain('_%+-');
    expect(out).not.toContain('/^[a-zA-Z');
  });

  it('no regex literal syntax in obfuscated output', () => {
    const code = 'var x = /secret_pattern/gi; var y = /another_regex/;';
    const out = obfuscate(code, { targetTokens: 10000 });
    expect(out).not.toContain('secret_pattern');
    expect(out).not.toContain('another_regex');
    expect(out).not.toContain('/secret_pattern/');
  });
});

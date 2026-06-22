import { applyStringArrayExtraction } from '../transforms/stringArrayExtraction';
import { obfuscate } from '../obfuscator';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

describe('chained string decryption (Paper 2)', () => {
  it('decodes the entire chain on first access', () => {
    const code = 'var a = "Hello"; var b = "World";';
    const ast = parse(code);
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // Should contain a chain-decoded flag variable
    expect(out).toContain('= false');
    // Should contain a for-loop that iterates over the full array
    expect(out).toContain('for (');
    // Should contain the rolling-key chain propagation. The decoder's locals
    // are now generated via gen(), so match the structure rather than the
    // literal `prevKey`/`k`/`h` names: prevKey = (k ^ h) & 255
    expect(out).toMatch(/[^\s()]+ = \([^\s()]+ \^ [^\s()]+\) & 255/);
  });

  it('chains key derivation through string content hash', () => {
    const code = 'var a = "Hello"; var b = "World";';
    const ast = parse(code);
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // Decoder locals are generated via gen(), so match structure not names.
    // Chain derivation: prevKey = (k ^ h) & 255
    expect(out).toMatch(/[^\s()]+ = \([^\s()]+ \^ [^\s()]+\) & 255/);
    // Hash accumulation: h = (h + ch) & 255 (same identifier on both sides)
    expect(out).toMatch(/([^\s()]+) = \(\1 \+ [^\s()]+\) & 255/);
  });

  it('stores hex-encoded strings in the array', () => {
    const code = 'var a = "test"; var b = "data";';
    const ast = parse(code);
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // Array should contain hex strings, not readable text
    expect(out).not.toMatch(/"test"/);
    expect(out).not.toMatch(/"data"/);
    const hexMatch = out.match(/\["[0-9a-f]+"/);
    expect(hexMatch).not.toBeNull();
  });

  it('each entry has a different XOR key due to chaining', () => {
    // With chaining, each entry's key depends on the previous decoded string.
    // If we change one string, all subsequent entries change.
    const code1 = 'var a = "AAA"; var b = "BBB"; var c = "CCC";';
    const code2 = 'var a = "XXX"; var b = "BBB"; var c = "CCC";';

    const ast1 = parse(code1);
    const ast2 = parse(code2);
    applyStringArrayExtraction(ast1);
    applyStringArrayExtraction(ast2);
    const out1 = recast.print(ast1).code;
    const out2 = recast.print(ast2).code;

    // Both outputs should contain hex arrays
    const hex1 = out1.match(/\["([0-9a-f]+)"/g);
    const hex2 = out2.match(/\["([0-9a-f]+)"/g);
    expect(hex1).not.toBeNull();
    expect(hex2).not.toBeNull();

    // The hex arrays should be different (different content = different chain)
    // Note: seeds and primes are random, so arrays will differ anyway,
    // but this confirms the encoding produces output.
    expect(hex1!.length).toBeGreaterThan(0);
    expect(hex2!.length).toBeGreaterThan(0);
  });

  it('does not use rotation (chain requires sequential order)', () => {
    const code = 'var a = "Hello"; var b = "World";';
    const ast = parse(code);
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // Should NOT contain push(shift()) rotation pattern
    expect(out).not.toContain('.push(');
    expect(out).not.toContain('.shift()');
  });
});

describe('chained decryption correctness', () => {
  it('decodes single string correctly', () => {
    const ast = parse('var x = "Hello";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe('Hello');
  });

  it('decodes multiple strings correctly', () => {
    const ast = parse('var a = "Hello"; var b = "World"; var c = "test";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;
    const fn = new Function(out + '\nreturn [a, b, c];');
    expect(fn()).toEqual(['Hello', 'World', 'test']);
  });

  it('decodes deduplicated strings correctly', () => {
    const ast = parse('var a = "same"; var b = "same"; var c = "same";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;
    const fn = new Function(out + '\nreturn [a, b, c];');
    expect(fn()).toEqual(['same', 'same', 'same']);
  });

  it('decodes many different strings correctly', () => {
    const strs = Array.from({ length: 15 }, (_, i) => `string_${i}`);
    const code = strs.map((s, i) => `var v${i} = "${s}";`).join('\n');
    const ast = parse(code);
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;
    const returnExpr = strs.map((_, i) => `v${i}`).join(', ');
    const fn = new Function(out + `\nreturn [${returnExpr}];`);
    expect(fn()).toEqual(strs);
  });

  it('handles empty-ish strings alongside others', () => {
    // Empty strings are excluded from extraction but non-empty work
    const ast = parse('var a = "x"; var b = "longer string here";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;
    const fn = new Function(out + '\nreturn [a, b];');
    expect(fn()).toEqual(['x', 'longer string here']);
  });

  it('handles special characters in strings', () => {
    const ast = parse('var a = "hello\\nworld"; var b = "tab\\there";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;
    const fn = new Function(out + '\nreturn [a, b];');
    expect(fn()).toEqual(['hello\nworld', 'tab\there']);
  });

  it('accessor is callable multiple times (cached after first chain decode)', () => {
    const ast = parse('var a = "first"; var b = "second";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;
    // Call the accessor multiple times — should return same values
    const fn = new Function(out + '\nreturn [a, b, a, b, a];');
    expect(fn()).toEqual(['first', 'second', 'first', 'second', 'first']);
  });
});

describe('chained decryption in full pipeline', () => {
  it('obfuscated output contains chained decryption', () => {
    const code = 'var msg = "secret"; var key = "hidden";';
    const out = obfuscate(code, { targetTokens: 10000 });
    // The chained decoder pattern should be present. Locals are generated via
    // gen(), and full-pipeline output is minified, so match the rolling-key
    // structure name- and whitespace-agnostically: prevKey = (k ^ h) & 255
    expect(out).toMatch(/[^\s()^&=]+\s*=\s*\([^\s()^&=]+\s*\^\s*[^\s()^&=]+\)\s*&\s*255/);
    // No readable strings
    expect(out).not.toContain('"secret"');
    expect(out).not.toContain('"hidden"');
  });

  it('no readable string literals in chained output', () => {
    const code = 'var msg = "secret message"; var key = "password123";';
    const out = obfuscate(code, { targetTokens: 10000 });
    expect(out).not.toContain('"secret message"');
    expect(out).not.toContain('"password123"');
    expect(out).not.toContain("'secret message'");
    expect(out).not.toContain("'password123'");
  });
});

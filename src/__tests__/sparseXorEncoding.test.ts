import { applyStringArrayExtraction } from '../transforms/stringArrayExtraction';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function extract(code: string): string {
  const ast = parse(code);
  applyStringArrayExtraction(ast);
  return recast.print(ast).code;
}

describe('sparse XOR encoding (Paper 9)', () => {
  it('accessor contains position-dependent key computation', () => {
    const out = extract('var x = "Hello"; var y = "World";');
    // The accessor should compute posKey using position: cpos * 7 + cpos * cpos * 3
    expect(out).toContain('cpos * 7');
    expect(out).toContain('cpos * cpos * 3');
  });

  it('accessor contains sparse error conditional', () => {
    const out = extract('var x = "Hello"; var y = "World";');
    // The sparse error pattern: if ((cpos * P) % M < threshold)
    expect(out).toMatch(/cpos \* \d+\) % \d+ < \d+/);
  });

  it('accessor contains error seed XOR', () => {
    const out = extract('var x = "Hello"; var y = "World";');
    // The error XOR: posKey ^ ((errorSeed + cpos * 13) & 255)
    expect(out).toContain('cpos * 13');
  });

  it('hex-encoded strings differ from uniform XOR', () => {
    // With position-dependent keys, each character in the same string
    // is encoded with a different key. This means the hex pairs in
    // the encoded string should show more variety than uniform XOR.
    const out = extract('var x = "aaaaaa";');
    const hexMatch = out.match(/"([0-9a-f]{12})"/);
    expect(hexMatch).not.toBeNull();

    // In uniform XOR, "aaaaaa" would produce 6 identical hex pairs.
    // With position-dependent keys, they should differ.
    const hex = hexMatch![1];
    const pairs = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6),
                   hex.slice(6, 8), hex.slice(8, 10), hex.slice(10, 12)];
    const unique = new Set(pairs);
    // At least 2 different hex pairs (position-dependent makes them vary)
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });

  it('uses different error parameters across runs', () => {
    const params = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const out = extract('var x = "test";');
      // Extract the error prime and mod from the accessor code
      const match = out.match(/cpos \* (\d+)\) % (\d+) < (\d+)/);
      if (match) params.add(match[1] + ',' + match[2] + ',' + match[3]);
    }
    // Should see at least 2 different parameter sets
    expect(params.size).toBeGreaterThanOrEqual(2);
  });
});

describe('sparse XOR decoding correctness', () => {
  it('decodes single string correctly', () => {
    const out = extract('var x = "Hello";');
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe('Hello');
  });

  it('decodes multiple strings correctly', () => {
    const out = extract('var a = "Hello"; var b = "World"; var c = "test";');
    const fn = new Function(out + '\nreturn [a, b, c];');
    expect(fn()).toEqual(['Hello', 'World', 'test']);
  });

  it('decodes strings with special characters', () => {
    const out = extract('var a = "hello\\nworld"; var b = "tab\\there";');
    const fn = new Function(out + '\nreturn [a, b];');
    expect(fn()).toEqual(['hello\nworld', 'tab\there']);
  });

  it('decodes long strings correctly', () => {
    const longStr = 'A'.repeat(100);
    const out = extract(`var x = "${longStr}";`);
    const fn = new Function(out + '\nreturn x;');
    expect(fn()).toBe(longStr);
  });

  it('decodes mixed-length strings correctly', () => {
    const out = extract('var a = "x"; var b = "longer string here"; var c = "medium str";');
    const fn = new Function(out + '\nreturn [a, b, c];');
    expect(fn()).toEqual(['x', 'longer string here', 'medium str']);
  });

  it('handles deduplicated strings', () => {
    const out = extract('var a = "same"; var b = "same"; var c = "same";');
    const fn = new Function(out + '\nreturn [a, b, c];');
    expect(fn()).toEqual(['same', 'same', 'same']);
  });

  it('handles many strings (15+)', () => {
    const strs = Array.from({ length: 15 }, (_, i) => `str_${i}`);
    const code = strs.map((s, i) => `var v${i} = "${s}";`).join('\n');
    const out = extract(code);
    const returnExpr = strs.map((_, i) => `v${i}`).join(', ');
    const fn = new Function(out + `\nreturn [${returnExpr}];`);
    expect(fn()).toEqual(strs);
  });

  it('accessor is idempotent (cached after chain decode)', () => {
    const out = extract('var a = "first"; var b = "second";');
    const fn = new Function(out + '\nreturn [a, b, a, b, a];');
    expect(fn()).toEqual(['first', 'second', 'first', 'second', 'first']);
  });
});

describe('sparse XOR analysis resistance', () => {
  it('same plaintext character at different positions produces different ciphertext', () => {
    // "aaaa" should NOT produce 4 identical hex pairs
    let foundVariation = false;
    for (let run = 0; run < 10; run++) {
      const out = extract('var x = "aaaaaaaaaa";');
      const hexMatch = out.match(/"([0-9a-f]{20})"/);
      if (!hexMatch) continue;
      const hex = hexMatch[1];
      const pairs: string[] = [];
      for (let i = 0; i < hex.length; i += 2) {
        pairs.push(hex.slice(i, i + 2));
      }
      const unique = new Set(pairs);
      if (unique.size >= 3) {
        foundVariation = true;
        break;
      }
    }
    expect(foundVariation).toBe(true);
  });

  it('same string encoded differently across runs (different error params)', () => {
    const encodings = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const out = extract('var x = "Hello";');
      const hexMatch = out.match(/"([0-9a-f]{10})"/);
      if (hexMatch) encodings.add(hexMatch[1]);
    }
    // Different runs should produce different hex encodings
    expect(encodings.size).toBeGreaterThanOrEqual(2);
  });

  it('no readable string content in output', () => {
    const out = extract('var a = "secret password"; var b = "api key 12345";');
    expect(out).not.toContain('"secret password"');
    expect(out).not.toContain('"api key 12345"');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('password');
    expect(out).not.toContain('api key');
  });
});

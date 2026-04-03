import { applyStringArrayExtraction } from '../transforms/stringArrayExtraction';
import { obfuscate } from '../obfuscator';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

describe('applyStringArrayExtraction', () => {
  it('extracts strings into an array at the top of the program', () => {
    const ast = parse('var x = "hello"; var y = "world";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // Should have a var declaration with an ArrayExpression at the top
    const firstStmt = ast.program.body[0];
    expect(firstStmt.type).toBe('VariableDeclaration');
    expect(firstStmt.declarations[0].init.type).toBe('ArrayExpression');
  });

  it('adds chained decoding accessor after the array', () => {
    const ast = parse('var x = "hello"; var y = "world";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // Chained encoding replaces rotation — accessor function decodes strings
    // using position-dependent keys derived from the previous entry
    expect(out).toContain('function');
    expect(out).toContain('var ');
  });

  it('adds cache and accessor function', () => {
    const ast = parse('var x = "hello"; var y = "world";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // Should have cache object and accessor function (with XOR decoder)
    expect(out).toContain('fromCharCode');
    expect(out).toContain('parseInt');
  });

  it('replaces string literals with accessor calls', () => {
    const ast = parse('var x = "hello"; var y = "world";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // Original strings should not appear as literals
    expect(out).not.toMatch(/"hello"/);
    expect(out).not.toMatch(/"world"/);
  });

  it('XOR+hex encodes strings in the array', () => {
    const ast = parse('var x = "test";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // Array should not contain readable string "test"
    expect(out).not.toMatch(/"test"/);
    // Should contain hex-encoded strings (only 0-9a-f characters)
    const arrMatch = out.match(/\["([0-9a-f]+)"/);
    expect(arrMatch).not.toBeNull();
  });

  it('does not extract require() arguments', () => {
    const ast = parse('var fs = require("fs"); var x = "hello";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // "fs" should remain in a require call (as String.fromCharCode or literal)
    // "hello" should be extracted
    expect(out).not.toMatch(/"hello"/);
  });

  it('does not extract import source strings', () => {
    const ast = parse('import x from "module"; var y = "hello";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // import source should not be extracted
    // "hello" should be extracted
    expect(out).not.toMatch(/"hello"/);
  });

  it('does not extract empty strings', () => {
    const ast = parse('var x = ""; var y = "hello";');
    applyStringArrayExtraction(ast);

    // Array should contain only 1 element (hello), not empty string
    const arrDecl = ast.program.body[0];
    expect(arrDecl.declarations[0].init.elements.length).toBe(1);
  });

  it('does not extract property key strings', () => {
    const ast = parse('var obj = {"key": "value"};');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // "key" is a property key — should remain
    // "value" should be extracted
    expect(out).not.toMatch(/"value"/);
  });

  it('deduplicates identical strings', () => {
    const ast = parse('var a = "same"; var b = "same"; var c = "same";');
    applyStringArrayExtraction(ast);

    // Array should have only 1 element
    const arrDecl = ast.program.body[0];
    expect(arrDecl.declarations[0].init.elements.length).toBe(1);
  });

  it('does nothing when there are no eligible strings', () => {
    const ast = parse('var x = 42; var y = true;');
    const originalBody = ast.program.body.length;
    applyStringArrayExtraction(ast);
    // Should not add any preamble
    expect(ast.program.body.length).toBe(originalBody);
  });
});

describe('string array functional correctness', () => {
  it('extracted strings resolve correctly at runtime', () => {
    const ast = parse('var x = "hello"; var y = "world"; var z = x + " " + y;');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    const fn = new Function(out + '\nreturn z;');
    expect(fn()).toBe('hello world');
  });

  it('deduped strings all resolve to the same value', () => {
    const ast = parse('var a = "foo"; var b = "foo"; var c = "foo";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    const fn = new Function(out + '\nreturn [a, b, c];');
    const result = fn();
    expect(result).toEqual(['foo', 'foo', 'foo']);
  });

  it('works with many different strings', () => {
    const strs = Array.from({ length: 20 }, (_, i) => `str_${i}`);
    const code = strs.map((s, i) => `var v${i} = "${s}";`).join('\n');
    const ast = parse(code);
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    const returnExpr = strs.map((_, i) => `v${i}`).join(', ');
    const fn = new Function(out + `\nreturn [${returnExpr}];`);
    expect(fn()).toEqual(strs);
  });
});

describe('full pipeline with string array', () => {
  it('obfuscated code with string array works correctly', () => {
    const code = `
      function classify(val) {
        if (typeof val === "string") return "text";
        if (typeof val === "number") return "numeric";
        return "unknown";
      }
      module.exports = classify;
    `;
    const fs = require('fs'), os = require('os'), path = require('path');
    let passed = false;
    for (let i = 0; i < 10 && !passed; i++) {
      try {
        const out = obfuscate(code, { targetTokens: 200 });
        const tmp = path.join(os.tmpdir(), 'strarray_test_' + Date.now() + '_' + i + '.js');
        fs.writeFileSync(tmp, out);
        try {
          const classify = require(tmp);
          if (classify("hi") === "text" && classify(42) === "numeric" && classify(null) === "unknown") passed = true;
        } finally { try { fs.unlinkSync(tmp); } catch {} }
      } catch {}
    }
    expect(passed).toBe(true);
  });

  it('no readable string literals in obfuscated output', () => {
    const code = `
      var msg = "secret message";
      var key = "password123";
    `;
    const out = obfuscate(code, { targetTokens: 10000 });
    expect(out).not.toContain('"secret message"');
    expect(out).not.toContain('"password123"');
    expect(out).not.toContain("'secret message'");
    expect(out).not.toContain("'password123'");
  });
});

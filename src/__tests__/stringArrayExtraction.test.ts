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

  it('adds a rotation IIFE after the array', () => {
    const ast = parse('var x = "hello"; var y = "world";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // Second statement should be the rotation IIFE
    expect(out).toContain('.push(');
    expect(out).toContain('.shift()');
  });

  it('adds an accessor function', () => {
    const ast = parse('var x = "hello"; var y = "world";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // Third statement should be accessor function declaration
    const accessorStmt = ast.program.body[2];
    expect(accessorStmt.type).toBe('VariableDeclaration');
    expect(accessorStmt.declarations[0].init.type).toBe('FunctionExpression');
  });

  it('replaces string literals with accessor calls', () => {
    const ast = parse('var x = "hello"; var y = "world";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // Original strings should not appear as literals
    expect(out).not.toMatch(/"hello"/);
    expect(out).not.toMatch(/"world"/);
  });

  it('jsfuck-encodes strings in the array', () => {
    const ast = parse('var x = "test";');
    applyStringArrayExtraction(ast);
    const out = recast.print(ast).code;

    // Array should not contain readable string "test"
    expect(out).not.toMatch(/"test"/);
    // Should contain jsfuck-style expressions (lots of brackets and plus)
    expect(out).toContain('[]');
    expect(out).toContain('+');
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
    const out = obfuscate(code);
    const fs = require('fs'), os = require('os'), path = require('path');
    const tmp = path.join(os.tmpdir(), 'strarray_test_' + Date.now() + '.js');
    fs.writeFileSync(tmp, out);
    const classify = require(tmp);
    expect(classify("hi")).toBe("text");
    expect(classify(42)).toBe("numeric");
    expect(classify(null)).toBe("unknown");
  });

  it('no readable string literals in obfuscated output', () => {
    const code = `
      var msg = "secret message";
      var key = "password123";
    `;
    const out = obfuscate(code);
    expect(out).not.toContain('"secret message"');
    expect(out).not.toContain('"password123"');
    expect(out).not.toContain("'secret message'");
    expect(out).not.toContain("'password123'");
  });
});

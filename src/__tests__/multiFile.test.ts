import { obfuscate, obfuscateMultiple } from '../obfuscator';
import { generateDeadCode, setDonorStatements, clearDonorStatements, getDonorStatements } from '../transforms/deadCodeInjection';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function stmtsToCode(stmts: any[]): string {
  const ast = { type: 'File', program: { type: 'Program', body: stmts } };
  return recast.print(ast).code;
}

// --- Donor pool management ---

describe('donor statement pool', () => {
  afterEach(() => {
    clearDonorStatements();
  });

  it('setDonorStatements populates the pool', () => {
    const ast = parse('var a = 1; var b = a + 2;');
    setDonorStatements(ast.program.body);
    expect(getDonorStatements().length).toBe(2);
  });

  it('clearDonorStatements empties the pool', () => {
    const ast = parse('var a = 1;');
    setDonorStatements(ast.program.body);
    clearDonorStatements();
    expect(getDonorStatements().length).toBe(0);
  });

  it('generateDeadCode uses donor pool when no local realStatements', () => {
    const donorAst = parse('var total = price * qty; var tax = total * 0.08;');
    setDonorStatements(donorAst.program.body);

    let usedMutation = false;
    for (let i = 0; i < 40; i++) {
      const dead = generateDeadCode([]);
      const code = stmtsToCode(dead);
      if ((code.match(/var\s/g) || []).length >= 2 &&
          (code.includes('*') || code.includes('+') || code.includes('-'))) {
        usedMutation = true;
        break;
      }
    }
    expect(usedMutation).toBe(true);
  });

  it('donor pool merges with local realStatements', () => {
    const donorAst = parse('var total = price * qty;');
    setDonorStatements(donorAst.program.body);

    const localAst = parse('var x = a + b;');
    const localStmts = localAst.program.body;

    let produced = false;
    for (let i = 0; i < 40; i++) {
      const dead = generateDeadCode([], 1, localStmts);
      if (dead.length > 0) {
        produced = true;
        break;
      }
    }
    expect(produced).toBe(true);
  });
});

// --- obfuscateMultiple ---

describe('obfuscateMultiple', () => {
  // Use minimal targetTokens to keep tests fast
  const FAST_OPTS = { targetTokens: 500 };

  it('returns one result per input file', () => {
    const files = [
      { filename: 'a.js', code: 'var x = 1;' },
      { filename: 'b.js', code: 'var y = 2;' },
      { filename: 'c.js', code: 'var z = 3;' },
    ];
    const results = obfuscateMultiple(files, FAST_OPTS);
    expect(results.length).toBe(3);
    expect(results[0].filename).toBe('a.js');
    expect(results[1].filename).toBe('b.js');
    expect(results[2].filename).toBe('c.js');
  });

  it('each output is non-empty obfuscated code', () => {
    const files = [
      { filename: 'a.js', code: 'var x = 1; var y = x + 2;' },
      { filename: 'b.js', code: 'var a = 10; var b = a * 3;' },
    ];
    const results = obfuscateMultiple(files, FAST_OPTS);
    for (const r of results) {
      expect(r.code.length).toBeGreaterThan(0);
      // Original source should not appear verbatim
      expect(r.code).not.toContain('var x = 1');
      expect(r.code).not.toContain('var a = 10');
    }
  });

  it('clears the donor pool after processing', () => {
    const files = [
      { filename: 'a.js', code: 'var x = 1;' },
      { filename: 'b.js', code: 'var y = 2;' },
    ];
    obfuscateMultiple(files, FAST_OPTS);
    expect(getDonorStatements().length).toBe(0);
  });

  it('clears donor pool even if obfuscation throws', () => {
    const files = [
      { filename: 'bad.js', code: '%%%invalid%%%' },
    ];
    expect(() => obfuscateMultiple(files, FAST_OPTS)).toThrow();
    expect(getDonorStatements().length).toBe(0);
  });

  it('produces non-trivial output for all files', () => {
    const results = obfuscateMultiple([
      { filename: 'a.js', code: 'var x = 1; var y = x + 2; var z = y * 3;' },
      { filename: 'b.js', code: 'var a = 10; var b = a - 5; var c = b / 2;' },
    ], FAST_OPTS);

    for (const r of results) {
      expect(r.code.length).toBeGreaterThan(50);
    }
  });

});

// --- Cross-file dead code mutation evidence ---

describe('cross-file dead code mutation', () => {
  afterEach(() => {
    clearDonorStatements();
  });

  it('dead code generation uses cross-file donors', () => {
    const donorAst = parse(`
      var prefix = "Hello";
      var msg = prefix + " world";
      var len = msg.length;
    `);
    setDonorStatements(donorAst.program.body);

    let usedDonors = false;
    for (let i = 0; i < 50; i++) {
      const dead = generateDeadCode([]);
      const code = stmtsToCode(dead);
      // Mutation of string donors will produce var decls with string concat patterns
      if (code.includes('var ') && code.includes('+') && code.includes('"')) {
        usedDonors = true;
        break;
      }
    }
    expect(usedDonors).toBe(true);
  });

  it('single-file obfuscate does not use stale donor pool', () => {
    const result = obfuscate('var a = 1;', { targetTokens: 500 });
    expect(getDonorStatements().length).toBe(0);
    expect(result.length).toBeGreaterThan(0);
  });

  it('obfuscateMultiple collects donors from function bodies', () => {
    const files = [
      { filename: 'a.js', code: 'var x = 1;' },
      {
        filename: 'b.js',
        code: `function compute(n) {
          var result = n * 2;
          var adjusted = result + 10;
          return adjusted;
        }`,
      },
    ];

    const results = obfuscateMultiple(files, { targetTokens: 500 });
    expect(results.length).toBe(2);
    expect(results[0].code.length).toBeGreaterThan(0);
    expect(results[1].code.length).toBeGreaterThan(0);
  });
});

// --- Donor pool size regression ---

describe('donor pool rejects oversized statements', () => {
  // An earlier version of collectDonorStatements used recast.parse and
  // collected every VariableDeclaration/ExpressionStatement regardless
  // of subtree size. A single webpack-bundled 3000-node IIFE would end
  // up in the pool, and generateMutatedCode would deep-clone it on
  // every dead-case injection. For 8 modest bundles this turned
  // obfuscateMultiple into a ~60 s operation vs ~0.7 s for the same
  // files run through obfuscate() individually.
  //
  // The fix: (a) parse with @babel/parser (recast is ~10x slower and
  // we don't need position preservation), (b) reject donors whose
  // subtrees exceed MAX_DONOR_NODES while continuing traversal so
  // small statements nested inside a giant IIFE are still reachable.
  it('obfuscateMultiple completes in bounded time given a pathological giant donor', () => {
    // Build a file with a massive object literal at top level —
    // exactly the shape that tanked performance before the fix.
    const huge: string[] = [];
    for (let i = 0; i < 600; i++) huge.push(`k${i}:${i}*${i % 7}+${i}`);
    const files = [
      { filename: 'huge.js', code: `var payload = {${huge.join(',')}};` },
      { filename: 'consumer.js', code: 'function run(n){var x = n * 2; var y = x + 10; return y;} module.exports = run;' },
      { filename: 'another.js', code: 'var a = 1; var b = a + 2; var c = b * 3;' },
    ];
    const t = Date.now();
    const results = obfuscateMultiple(files, { targetTokens: 2000 });
    const elapsed = Date.now() - t;
    expect(results.length).toBe(3);
    // 10 s is already catastrophic; the threshold is intentionally
    // lax so the test is stable on loaded CI machines, while still
    // catching the 60 s regression class.
    expect(elapsed).toBeLessThan(10_000);
  });
});

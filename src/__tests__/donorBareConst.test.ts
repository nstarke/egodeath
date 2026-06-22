import { obfuscateMultiple } from '../obfuscator';

// Regression test for the cross-file dead-code donor pool emitting bare
// `const` declarations.
//
// collectDonorStatements() traverses each input file and collects every
// VariableDeclaration as potential donor material for mutation-based dead
// code. A `for (const k of …)` / `for (const k in …)` loop head IS a
// VariableDeclaration whose declarator has `init: null` — legal there, but
// `SyntaxError: Missing initializer in const declaration` when emitted as a
// standalone statement. Such heads must not enter the donor pool.
describe('donor pool does not emit bare const declarations', () => {
  // File A contributes for-of / for-in `const` heads (init: null) to the
  // cross-file donor pool; file B receives dead code mutated from that pool.
  const donor = `
    function walk(o) {
      const out = [];
      for (const k of Object.keys(o)) { out.push(k); }
      for (const key in o) { out.push(key); }
      const a = 1, b = 2, c = a + b;
      return out.length + c;
    }
    module.exports = walk;
  `;
  const target = `
    function compute(n) {
      const base = n * 2;
      const factor = base + 7;
      const result = factor * factor - base;
      return result;
    }
    module.exports = compute;
  `;

  it('never produces `const <id>;` without an initializer', () => {
    // Dead-code mutation is randomized (≈50% per site, random donor pick), so
    // run many iterations to exercise the donor path repeatedly.
    let bareConsts = 0;
    for (let i = 0; i < 25; i++) {
      const results = obfuscateMultiple(
        [
          { filename: 'a.js', code: donor },
          { filename: 'b.js', code: target },
        ],
        { targetTokens: 60_000 },
      );
      for (const r of results) {
        // `const … ;` with no `=` (and no call paren) between keyword and the
        // terminating semicolon — i.e. a const declarator with no initializer.
        const matches = r.code.match(/const\s+[^=;(]+;/g);
        if (matches) bareConsts += matches.length;
      }
    }
    expect(bareConsts).toBe(0);
  });
});

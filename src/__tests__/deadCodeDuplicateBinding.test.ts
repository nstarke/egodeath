import { generateDeadCode } from '../transforms/deadCodeInjection';
import * as recast from 'recast';

const babelParser = require('recast/parsers/babel');

function parse(code: string): any {
  return recast.parse(code, { parser: babelParser });
}

function print(stmts: any[]): string {
  return recast.print({ type: 'File', program: { type: 'Program', body: stmts } }).code;
}

/**
 * Names introduced by top-level lexical declarations (let/const/class/
 * function) of a statement list — the bindings that trigger "Identifier 'X'
 * has already been declared" if duplicated in one block.
 */
function topLevelLexicalNames(stmts: any[]): string[] {
  const names: string[] = [];
  for (const s of stmts) {
    if (s.type === 'VariableDeclaration' && (s.kind === 'let' || s.kind === 'const')) {
      for (const d of s.declarations) {
        if (d.id && d.id.type === 'Identifier') names.push(d.id.name);
      }
    }
    if ((s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id) {
      names.push(s.id.name);
    }
  }
  return names;
}

// Build a donor list whose statements repeatedly declare the SAME short names.
// In a real minified bundle `e`, `t`, `n` are distinct bindings in hundreds of
// separate scopes; collectDonorStatements flattens them all into one pool, so
// a mutated slice routinely contains two statements that originally shared a
// name. Each snippet here is an independently-valid declaration.
function repeatedNameDonors(): any[] {
  const snippets = [
    'const e = 1;', 'const t = 2;', 'const n = 3;',
    'const e = 4;', 'const t = 5;', 'const n = 6;',
    'const e = 7;', 'const t = 8;', 'const n = 9;',
  ];
  return snippets.flatMap(s => parse(s).program.body);
}

// Regression test for the cross-file dead-code mutator emitting duplicate
// declarations. generateMutatedCode used to mutate a 2-4 statement donor slice
// with ONE shared name map, collapsing two same-named donors onto a single
// fresh name and emitting two `const X`/`let X` in one block.
describe('dead code never duplicates a block-scoped binding', () => {
  it('emits no duplicate top-level lexical bindings and always parses', () => {
    const donors = repeatedNameDonors();

    let sawVarDecls = false;
    for (let i = 0; i < 200; i++) {
      const dead = generateDeadCode(['e', 't', 'n'], 1, donors);

      const names = topLevelLexicalNames(dead);
      expect(new Set(names).size).toBe(names.length); // no duplicate declarations

      // The emitted block must be valid JavaScript on its own.
      expect(() => parse(print(dead))).not.toThrow();

      if (dead.some(s => s.type === 'VariableDeclaration')) sawVarDecls = true;
    }
    // Sanity: the variable-declaration mutation path was actually exercised.
    expect(sawVarDecls).toBe(true);
  });
});

import * as recast from 'recast';
import * as crypto from 'crypto';

const recastBabel = require('recast/parsers/babel');
const babelParser = require('@babel/parser');

/**
 * Cross-file transplant: prepend each sibling file's top-level source
 * and literal set to the current file, guarded by opaque-false
 * predicates so the transplanted code never executes at runtime.
 *
 * This is a detection-hardening pass — when obfuscating a batch of
 * files together, a static reader (human or LLM) can usually tell
 * "these two outputs came from different source modules" by looking
 * at invariants the normal obfuscator can't touch: the set of reachable
 * string literals, the set of function declarations, and the call
 * graph topology. Sharing the donor pool and padding the string array
 * only mask the dead-code layer — the live code still encodes each
 * module's unique semantics.
 *
 * By source-level injecting a sibling's function declarations and
 * literal references before the obfuscator runs, both files in a pair
 * end up carrying the UNION of both sources' semantic surface. The
 * transplanted code is unreachable (opaque-false `if`) but syntactically
 * live: function bodies are present, string literals index into the
 * shared array from a live call site, and the downstream renamer
 * mangles everything uniformly with the real code. A reverse engineer
 * trying to separate "file A's logic" from "file B's logic" now sees
 * both in both files.
 */

/** Cap on bytes transplanted from any one sibling into any one target. */
const MAX_BYTES_PER_SIBLING = 30_000;

/**
 * Cap on the total transplanted-literal block size. Each literal
 * costs ~30 chars in the bucket-var prelude (`var __x_NNN = "...";`)
 * so 200 strings is ~6KB — enough to materially shift the reachable-
 * literal set without blowing up output size.
 */
const MAX_TRANSPLANTED_LITERALS = 200;

/**
 * Parse a sibling's source with @babel/parser and return the list of
 * top-level statements safe to drop into an IIFE body. Filters:
 *
 *   - `import` / `export *` / `export { ... }` / `export default`:
 *     module-level directives, illegal anywhere except a program's
 *     top level. Re-emitting them inside `(function(){ ... })()` is
 *     a parse error. `export Foo` forms that carry a declaration
 *     keep the declaration only.
 *
 *   - Unparseable siblings: return an empty list rather than
 *     surfacing the parse error — the transplant is a best-effort
 *     defence, not a correctness guarantee.
 */
function extractTransplantableStatements(code: string): any[] {
  let ast: any;
  try {
    ast = babelParser.parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: [],
    });
  } catch {
    return [];
  }
  const kept: any[] = [];
  for (const stmt of ast.program.body || []) {
    switch (stmt.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
        continue;
      case 'ExportNamedDeclaration':
        if (stmt.declaration) kept.push(stmt.declaration);
        continue;
      case 'ExportDefaultDeclaration':
        if (
          stmt.declaration &&
          (stmt.declaration.type === 'FunctionDeclaration' ||
            stmt.declaration.type === 'ClassDeclaration')
        ) {
          kept.push(stmt.declaration);
        }
        continue;
      default:
        kept.push(stmt);
    }
  }
  return kept;
}

/**
 * Render a statement list back to source using recast. Babel-parsed
 * nodes carry enough structure for recast to emit them; we wrap in a
 * fresh File/Program envelope because recast's printer expects it.
 */
function printStatements(stmts: any[]): string {
  if (stmts.length === 0) return '';
  const fileAst = {
    type: 'File',
    program: { type: 'Program', body: stmts, sourceType: 'script' },
  };
  try {
    return recast.print(fileAst as any).code;
  } catch {
    // Fall back: print each statement individually; drop the ones
    // that don't round-trip rather than losing the whole block.
    const chunks: string[] = [];
    for (const s of stmts) {
      try {
        const one = {
          type: 'File',
          program: { type: 'Program', body: [s], sourceType: 'script' },
        };
        chunks.push(recast.print(one as any).code);
      } catch {
        // skip
      }
    }
    return chunks.join('\n');
  }
}

/**
 * Collect every string literal value (source-level) from a sibling.
 * Uses @babel/parser directly — the values feed into the literal-
 * reference block, we don't need source positions.
 *
 * Mirrors the exclusions `stringArrayExtraction` uses when deciding
 * which literals to pull into the array: require() arguments,
 * import/export sources, property keys, and directive prologues stay
 * out so the transplanted references don't accidentally push
 * non-array-eligible strings through a position where the array
 * extractor would later skip them.
 */
function collectStringLiterals(code: string): string[] {
  let ast: any;
  try {
    ast = babelParser.parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: [],
    });
  } catch {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => {
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };
  const walk = (node: any, parent: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, parent);
      return;
    }
    if (node.type === 'StringLiteral' || (node.type === 'Literal' && typeof node.value === 'string')) {
      let skip = false;
      if (parent) {
        if (
          parent.type === 'CallExpression' &&
          parent.callee &&
          parent.callee.type === 'Identifier' &&
          parent.callee.name === 'require'
        ) skip = true;
        else if (parent.type === 'CallExpression' && parent.callee && parent.callee.type === 'Import') skip = true;
        else if (
          parent.type === 'ImportDeclaration' ||
          parent.type === 'ExportNamedDeclaration' ||
          parent.type === 'ExportAllDeclaration'
        ) skip = true;
        else if ((parent.type === 'Property' || parent.type === 'ObjectProperty') && parent.key === node) skip = true;
        else if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) skip = true;
        else if (parent.type === 'ExpressionStatement' && parent.directive != null) skip = true;
      }
      if (!skip && typeof node.value === 'string') push(node.value);
    } else if (node.type === 'TemplateElement') {
      const cooked = node.value && typeof node.value.cooked === 'string' ? node.value.cooked : '';
      if (cooked) push(cooked);
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'range' || key === 'extra') continue;
      walk(node[key], node);
    }
  };
  walk(ast.program, null);
  return out;
}

/**
 * JS-escape a string value for embedding in double-quoted source.
 * We emit at source level — the recast/babel parser the obfuscator
 * uses next will normalize escapes however it likes.
 */
function encodeString(s: string): string {
  return (
    '"' +
    s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')) +
    '"'
  );
}

/**
 * Pick an opaque-false probe name with enough entropy to avoid
 * colliding with source identifiers. The downstream rename pass will
 * replace these names with `gen()` output anyway; we just need
 * uniqueness at the source-merge step.
 */
function makeProbeName(): string {
  return '_egd' + crypto.randomBytes(6).toString('hex');
}

/**
 * Build a prelude source string to prepend to `ownCode` before
 * obfuscation. Carries two payloads:
 *
 *   A. Literal cross-pollination — every sibling's source strings
 *      (capped) are referenced inside an opaque-false branch as
 *      live array reads, so after string-array extraction those
 *      indexes point to live accesses rather than inert array
 *      entries. A reader counting "which array slots are actually
 *      indexed from live code" can no longer separate "own vs
 *      sibling strings" by that signal.
 *
 *   B. Function/class/statement transplants — each sibling's
 *      top-level body (sans import/export) drops into its own IIFE
 *      inside a second opaque-false branch. Function declarations
 *      land as live bindings inside that IIFE's scope; renaming,
 *      proxy functions, CFF, dead-code injection and every other
 *      downstream pass processes them the same way as real code.
 *      A call-graph analysis over the merged AST now sees both
 *      files' functions in both outputs.
 *
 * Both branches are guarded by `(probe ^ probe) !== 0`, which is
 * always false for any integer, with `probe` initialised from
 * Math.random() so a partial evaluator can't fold the guard away.
 * Wrapping in an IIFE also guarantees sibling declarations live in
 * their own scope — no duplicate-binding errors even when the two
 * files define identically-named exports.
 */
export function buildCrossFilePrelude(siblingCodes: string[]): string {
  if (siblingCodes.length === 0) return '';

  const probe = makeProbeName();

  // Payload A: literal cross-pollination.
  const allLiterals: string[] = [];
  const seen = new Set<string>();
  for (const sib of siblingCodes) {
    for (const lit of collectStringLiterals(sib)) {
      if (seen.has(lit)) continue;
      seen.add(lit);
      allLiterals.push(lit);
      if (allLiterals.length >= MAX_TRANSPLANTED_LITERALS) break;
    }
    if (allLiterals.length >= MAX_TRANSPLANTED_LITERALS) break;
  }

  const literalBlock: string[] = [];
  if (allLiterals.length > 0) {
    const bagName = '_egdBag_' + crypto.randomBytes(4).toString('hex');
    const bucketDecls: string[] = [];
    const bucketNames: string[] = [];
    allLiterals.forEach((lit, i) => {
      const name = `_egdBkt_${i}_${crypto.randomBytes(2).toString('hex')}`;
      bucketDecls.push(`    var ${name} = ${encodeString(lit)};`);
      bucketNames.push(name);
    });
    literalBlock.push(
      `  if ((${probe} ^ ${probe}) !== 0) {`,
      ...bucketDecls,
      `    var ${bagName} = [${bucketNames.join(', ')}];`,
      `    var _egdSink_${crypto.randomBytes(2).toString('hex')} = ${bagName}[${probe} % ${bagName}.length];`,
      `  }`,
    );
  }

  // Payload B: function/statement transplants.
  const transplantBlocks: string[] = [];
  for (const sib of siblingCodes) {
    const stmts = extractTransplantableStatements(sib);
    if (stmts.length === 0) continue;
    let printed = printStatements(stmts);
    if (!printed) continue;
    if (printed.length > MAX_BYTES_PER_SIBLING) {
      // Truncate at a statement boundary to avoid leaving half-parsed
      // code. Walk backwards from the cap until we find a newline
      // followed by a likely statement start (`\n` + whitespace +
      // keyword); if nothing obvious, drop the whole block — an
      // unparseable transplant would crash obfuscate().
      const cut = printed.lastIndexOf('\n', MAX_BYTES_PER_SIBLING);
      if (cut > 0) {
        printed = printed.slice(0, cut);
      } else {
        continue;
      }
      // Validate the truncated slice still parses. If it doesn't,
      // drop this sibling entirely rather than breaking the whole
      // prelude.
      try {
        babelParser.parse(printed, { sourceType: 'unambiguous', errorRecovery: true });
      } catch {
        continue;
      }
    }
    transplantBlocks.push(
      `  (function() {`,
      printed,
      `  })();`,
    );
  }

  const bodyLines: string[] = [];
  // Probe var — initialised to a fresh integer each program start
  // so a partial evaluator can't prove the downstream guards dead.
  bodyLines.push(`var ${probe} = (Math.random() * 256) | 0;`);
  if (literalBlock.length > 0) bodyLines.push(...literalBlock);
  if (transplantBlocks.length > 0) {
    bodyLines.push(`if ((${probe} ^ ${probe}) !== 0) {`);
    bodyLines.push(...transplantBlocks);
    bodyLines.push(`}`);
  }

  // Only emit a prelude if at least one payload landed. Otherwise
  // returning the probe-var alone is pure overhead.
  if (literalBlock.length === 0 && transplantBlocks.length === 0) return '';

  return bodyLines.join('\n') + '\n';
}

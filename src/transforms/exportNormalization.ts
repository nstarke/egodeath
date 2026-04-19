import * as recast from 'recast';
import * as crypto from 'crypto';

const recastBabel = require('recast/parsers/babel');
const babelParser = require('@babel/parser');

/**
 * API surface normalization: rewrite a file's CommonJS exports into
 * a fixed-shape dispatch object whose key set is shared across every
 * file in a batch. A reader comparing two outputs can't separate
 * "module A" from "module B" using the export surface — both end
 * with `module.exports = { <same N keys> }`.
 *
 * The `DispatchPlan` is produced once by `makeDispatchPlan()` and
 * reused for every file in the batch. Per-file, the plan's
 * `slotForDefault` is reshuffled so each file's real default export
 * lands at a different slot — the key set stays byte-identical, but
 * the file's semantics are preserved at one specific lookup.
 */

/**
 * Default number of dispatch slots. Large enough that "pick a random
 * slot for the real export" gives meaningfully different positions
 * across files (so the real-value slot isn't always the same
 * position); small enough not to blow up output size. Each slot
 * costs ~20 chars of source (key name + dummy function) before
 * obfuscation.
 */
export const DEFAULT_DISPATCH_SIZE = 12;

export interface DispatchPlan {
  /** Shared dispatch keys — same set, same order, across every file. */
  keys: string[];
  /** Shared dummy-body builder so every non-real slot has identical text. */
  dummyValueSource: string;
}

/**
 * Generate a dispatch plan suitable for a whole batch. Caller
 * invokes once per `obfuscateMultiple` call and hands the same plan
 * (plus a per-file `slotForDefault`) to `normalizeFileExports`.
 *
 * Key names use a reserved `_ed` prefix + hex suffix so they can't
 * collide with any source identifier the user might realistically
 * write. The prefix leaks the intent to a reader, but the renamer
 * / property-key-encoder will encode these strings into the array
 * anyway — what survives to a static reader is the *shape*, not the
 * names.
 */
export function makeDispatchPlan(size: number = DEFAULT_DISPATCH_SIZE): DispatchPlan {
  const keys: string[] = [];
  const used = new Set<string>();
  while (keys.length < size) {
    const k = '_ed' + crypto.randomBytes(3).toString('hex');
    if (used.has(k)) continue;
    used.add(k);
    keys.push(k);
  }
  // Dummy body — a function returning a small integer. Using the
  // same source text for every dummy slot keeps the surface
  // byte-identical between files at the positions that don't hold a
  // real export.
  const dummyValueSource = 'function() { return 0; }';
  return { keys, dummyValueSource };
}

/**
 * Detect whether the source is an ES module. Mixing ESM
 * `import`/`export` with CJS `module.exports = ...` is a syntax
 * error, and rewriting ESM to CJS changes module semantics in ways
 * unrelated to detection-hardening. We skip normalization for ESM
 * sources and let the caller decide how to proceed (the current
 * caller, `obfuscateMultiple`, falls back to the unmodified source).
 */
function isESModule(ast: any): boolean {
  for (const stmt of ast.program.body || []) {
    if (
      stmt.type === 'ImportDeclaration' ||
      stmt.type === 'ExportNamedDeclaration' ||
      stmt.type === 'ExportDefaultDeclaration' ||
      stmt.type === 'ExportAllDeclaration'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Match `module.exports = <expr>` at top-level. We capture the RHS
 * expression into a `var` binding and emit a normalized dispatch
 * assignment at end-of-file that points at the captured binding
 * from exactly one slot.
 *
 * `exports = <expr>` (without `module.`) is technically legal but
 * doesn't export anything in CommonJS (reassigns the local
 * `exports` binding, doesn't touch `module.exports`), so we leave it
 * alone. `module['exports'] = <expr>` (computed access) is the same
 * assignment but trips the heuristic; we match both forms.
 */
function isModuleExportsAssignment(stmt: any): boolean {
  if (stmt.type !== 'ExpressionStatement') return false;
  const expr = stmt.expression;
  if (!expr || expr.type !== 'AssignmentExpression' || expr.operator !== '=') return false;
  const left = expr.left;
  if (!left || left.type !== 'MemberExpression') return false;
  const obj = left.object;
  if (!obj || obj.type !== 'Identifier' || obj.name !== 'module') return false;
  // identifier form: module.exports
  if (!left.computed && left.property && left.property.type === 'Identifier' && left.property.name === 'exports') {
    return true;
  }
  // string form: module["exports"]
  if (left.computed && left.property && (
    (left.property.type === 'StringLiteral' && left.property.value === 'exports') ||
    (left.property.type === 'Literal' && left.property.value === 'exports')
  )) {
    return true;
  }
  return false;
}

/**
 * Match `exports.X = <expr>` or `module.exports.X = <expr>` at
 * top-level. Normalization drops these in favour of the dispatch
 * block at end-of-file, on the grounds that the caller opted into a
 * destructive export contract by enabling this flag.
 */
function isNamedExportAssignment(stmt: any): boolean {
  if (stmt.type !== 'ExpressionStatement') return false;
  const expr = stmt.expression;
  if (!expr || expr.type !== 'AssignmentExpression' || expr.operator !== '=') return false;
  const left = expr.left;
  if (!left || left.type !== 'MemberExpression' || left.computed) return false;
  // exports.X = ...
  if (left.object.type === 'Identifier' && left.object.name === 'exports') return true;
  // module.exports.X = ...
  if (
    left.object.type === 'MemberExpression' &&
    !left.object.computed &&
    left.object.object.type === 'Identifier' &&
    left.object.object.name === 'module' &&
    left.object.property.type === 'Identifier' &&
    left.object.property.name === 'exports'
  ) {
    return true;
  }
  return false;
}

/**
 * Print an AST via recast. Wrapped in try/catch so a
 * round-trip failure on a weird source (babel-vs-recast node shape
 * mismatch in some edge corner) degrades to "return the original
 * source unchanged" rather than surfacing a crash into the
 * obfuscate() caller.
 */
function safePrint(ast: any, fallback: string): string {
  try {
    return recast.print(ast).code;
  } catch {
    return fallback;
  }
}

/**
 * Rewrite `code` into its normalized form:
 *
 *   1. Scan the top-level body for `module.exports = <expr>` assignments.
 *      Capture the LAST such assignment's RHS into a local
 *      `var _egdDefault_XXX = <expr>`. Drop every earlier top-level
 *      `module.exports = ...` (they'd be overridden anyway).
 *
 *   2. Drop every `exports.X = ...` / `module.exports.X = ...`
 *      assignment — the caller opted in, and named exports don't
 *      slot into v1's dispatch.
 *
 *   3. Append:
 *        module.exports = {
 *          <key0>: function(){return 0;},
 *          ...
 *          <slotForDefault>: _egdDefault_XXX,
 *          ...
 *        };
 *      where the key list is taken from `plan.keys` (shared across
 *      every file in the batch) and the real default export lands
 *      at `slotForDefault`.
 *
 * If the source is an ES module, or if it fails to parse, the
 * function returns the original code unchanged so normalization is
 * best-effort rather than a correctness hazard.
 */
export function normalizeFileExports(
  code: string,
  plan: DispatchPlan,
  slotForDefault: number,
): string {
  let ast: any;
  try {
    ast = recast.parse(code, { parser: recastBabel });
  } catch {
    return code;
  }
  if (isESModule(ast)) return code;

  const body: any[] = ast.program.body || [];
  // Walk the body: collect export writes, keep everything else.
  let defaultExpr: any = null;
  const kept: any[] = [];
  for (const stmt of body) {
    if (isModuleExportsAssignment(stmt)) {
      // Only the last wins in CJS semantics; earlier ones are
      // dead code once we rewrite.
      defaultExpr = stmt.expression.right;
      continue;
    }
    if (isNamedExportAssignment(stmt)) {
      continue;
    }
    kept.push(stmt);
  }

  // Emit the capture var only when we actually found a default
  // export. For bare scripts (no exports), the dispatch slot still
  // exists but holds the dummy value — the output has the same
  // shape as a file with real exports.
  const captureName = '_egdDefault_' + crypto.randomBytes(3).toString('hex');
  if (defaultExpr) {
    kept.push({
      type: 'VariableDeclaration',
      kind: 'var',
      declarations: [
        {
          type: 'VariableDeclarator',
          id: { type: 'Identifier', name: captureName },
          init: defaultExpr,
        },
      ],
    });
  }

  // Build the dispatch object: every key in plan.keys, with the
  // real default (if any) at slotForDefault, and a shared dummy
  // everywhere else.
  const dispatchProps: any[] = [];
  for (let i = 0; i < plan.keys.length; i++) {
    const keyNode = { type: 'Identifier', name: plan.keys[i] };
    let valueNode: any;
    if (defaultExpr && i === slotForDefault) {
      valueNode = { type: 'Identifier', name: captureName };
    } else {
      // Parse the dummy value source once per slot so the AST has
      // a fresh node (recast won't re-use a single node across
      // multiple parents without confusion).
      const parsedDummy = babelParser.parseExpression(plan.dummyValueSource);
      valueNode = parsedDummy;
    }
    dispatchProps.push({
      type: 'ObjectProperty',
      key: keyNode,
      value: valueNode,
      computed: false,
      shorthand: false,
    });
  }

  const dispatchAssignment: any = {
    type: 'ExpressionStatement',
    expression: {
      type: 'AssignmentExpression',
      operator: '=',
      left: {
        type: 'MemberExpression',
        object: { type: 'Identifier', name: 'module' },
        property: { type: 'Identifier', name: 'exports' },
        computed: false,
      },
      right: {
        type: 'ObjectExpression',
        properties: dispatchProps,
      },
    },
  };
  kept.push(dispatchAssignment);

  ast.program.body = kept;
  return safePrint(ast, code);
}

/**
 * Produce a deterministic-per-file but batch-varying slot
 * assignment. Given a plan of N keys and the file index within its
 * batch, pick a slot that rotates through the N positions as the
 * index grows, so a 2-file batch puts the two files' default
 * exports at DIFFERENT slots (the whole point of normalization is
 * that the values move, the shape stays fixed). A small random jog
 * prevents two consecutive `obfuscateMultiple` calls with the same
 * inputs from always picking the same slots.
 */
export function pickSlotForFile(plan: DispatchPlan, fileIndex: number): number {
  const jog = crypto.randomBytes(1)[0] % plan.keys.length;
  return (fileIndex + jog) % plan.keys.length;
}

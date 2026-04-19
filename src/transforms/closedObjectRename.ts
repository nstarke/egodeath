import * as estraverse from 'estraverse';
import { gen } from '../random';
import { ScopeAnalysis } from '../scopeAnalysis';

/**
 * Closed-object literal key rename.
 *
 * For a binding of the form `const obj = { a: ..., b: ... }` where every
 * reference to `obj` outside the declaration is of the form `obj.X`
 * (read, write, call, update, optional chain — all non-computed
 * MemberExpressions), the object cannot be observed from the outside:
 * nothing iterates its keys, nothing serializes it, nothing passes it
 * around. That means the property names are an internal convention,
 * and we can replace every key (and every access) with a fresh random
 * Unicode identifier with no runtime effect.
 *
 * Payoff: what were meaningful names in the source (`apiKey`,
 * `ROLE_ADMIN`, `retryCount`) come out as opaque gen()-style renders,
 * both in the object literal AND in the stringArray pool that
 * propertyKeyEncoding feeds into — so key-name searches across the
 * final output find nothing.
 *
 * Preconditions the analyzer enforces before renaming:
 *   - Declaration is a VariableDeclarator with a simple Identifier id
 *     and an ObjectExpression initializer.
 *   - Every property of the object literal is an ObjectProperty with a
 *     non-computed simple key (Identifier or StringLiteral of a string
 *     value) — no SpreadElement, no ObjectMethod, no computed keys.
 *   - No property value contains a FunctionExpression or ObjectMethod;
 *     those carry their own `this` binding, so renaming `obj.a` would
 *     silently also need to rename `this.a` inside the method body,
 *     and analyzing that is deferred. ArrowFunctionExpression values
 *     are fine (arrows have no own `this`) — any `obj`-by-closure
 *     reference inside an arrow goes through the normal escape check.
 *   - Every reference to the binding is the `.object` of a non-computed
 *     MemberExpression / OptionalMemberExpression. Anything else —
 *     return statement, call argument, aliasing assignment, spread,
 *     truthiness check, reassignment, etc. — disqualifies the
 *     candidate.
 *   - No accessed property name (declaration side or access side) is
 *     on the SKIP_PROPS list below.
 *
 * Runs before firstPass so the renamed keys are absorbed by the
 * normal identifier machinery: non-computed property positions stay
 * skipped by secondPass, and propertyKeyEncoding / stringArrayExtraction
 * pick up the Unicode renders when they do their usual post-pass work.
 */

/** estraverse visitor keys for modern + babel node shapes. */
const EXTRA_VISITOR_KEYS: { [key: string]: string[] } = {
  ArrowFunctionExpression: ['params', 'body'],
  SpreadElement: ['argument'],
  RestElement: ['argument'],
  TemplateLiteral: ['quasis', 'expressions'],
  TaggedTemplateExpression: ['tag', 'quasi'],
  TemplateElement: [],
  ObjectPattern: ['properties'],
  ArrayPattern: ['elements'],
  AssignmentPattern: ['left', 'right'],
  ClassDeclaration: ['id', 'superClass', 'body'],
  ClassExpression: ['id', 'superClass', 'body'],
  ClassBody: ['body'],
  MethodDefinition: ['key', 'value'],
  ImportDeclaration: ['specifiers', 'source'],
  ImportSpecifier: ['imported', 'local'],
  ImportDefaultSpecifier: ['local'],
  ImportNamespaceSpecifier: ['local'],
  ExportNamedDeclaration: ['declaration', 'specifiers', 'source'],
  ExportDefaultDeclaration: ['declaration'],
  ExportAllDeclaration: ['source'],
  ExportSpecifier: ['exported', 'local'],
  ForOfStatement: ['left', 'right', 'body'],
  YieldExpression: ['argument'],
  AwaitExpression: ['argument'],
  ChainExpression: ['expression'],
  OptionalMemberExpression: ['object', 'property'],
  OptionalCallExpression: ['callee', 'arguments'],
  PropertyDefinition: ['key', 'value'],
  StaticBlock: ['body'],
  PrivateIdentifier: [],
  ObjectProperty: ['key', 'value'],
  ObjectMethod: ['key', 'params', 'body'],
  ClassMethod: ['key', 'params', 'body'],
  StringLiteral: [],
  NumericLiteral: [],
  BooleanLiteral: [],
  NullLiteral: [],
  RegExpLiteral: [],
};

/**
 * Property names we refuse to rename even when the binding is
 * formally closed. These are Object.prototype members or names that
 * duck-typed APIs inspect (thenables, iterables) — renaming them
 * produces silent behavior changes: suddenly `obj.toString()` returns
 * Object.prototype.toString instead of the user's, or `await obj`
 * stops seeing the `then` handler.
 */
const SKIP_PROPS = new Set<string>([
  'constructor', 'prototype', '__proto__',
  'hasOwnProperty', 'toString', 'valueOf', 'propertyIsEnumerable',
  'isPrototypeOf', 'toLocaleString',
  'length', 'name',
  'then', 'catch', 'finally',
]);

interface Candidate {
  declarator: any;    // VariableDeclarator whose .init is the object literal
  objExpr: any;       // the ObjectExpression
  accesses: Array<{ memberNode: any; propName: string }>;
  safe: boolean;
}

/**
 * Return true if the subtree contains a FunctionExpression or
 * ObjectMethod — i.e. a function form that carries its own `this`.
 * ArrowFunctionExpression is NOT a hit: arrows have no own `this`, so
 * any `this` inside an arrow resolves to the enclosing scope, not to
 * the object being defined.
 */
function containsOwnThisFunction(root: any): boolean {
  let found = false;
  estraverse.traverse(root, {
    keys: EXTRA_VISITOR_KEYS,
    enter(n: any): any {
      if (n.type === 'FunctionExpression' || n.type === 'ObjectMethod') {
        found = true;
        return (estraverse as any).VisitorOption.Break;
      }
    },
    fallback: 'iteration',
  } as any);
  return found;
}

/** Extract the property key as a string when it's a simple non-computed key; otherwise null. */
function extractKeyName(prop: any): string | null {
  if (!prop || prop.computed) return null;
  if (!prop.key) return null;
  if (prop.key.type === 'Identifier') return prop.key.name || null;
  if (prop.key.type === 'StringLiteral') {
    return typeof prop.key.value === 'string' ? prop.key.value : null;
  }
  // ESTree Literal (espree/acorn shape); babel uses StringLiteral.
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value;
  return null;
}

/** Disqualify an ObjectExpression for rename; return its set of key names if accepted. */
function collectDeclarationKeys(objExpr: any): Set<string> | null {
  const keys = new Set<string>();
  const props = objExpr.properties || [];
  for (const p of props) {
    if (!p) continue;
    if (p.type === 'SpreadElement') return null;
    if (p.type === 'ObjectMethod') return null;
    if (p.type !== 'ObjectProperty' && p.type !== 'Property') return null;
    const name = extractKeyName(p);
    if (name === null) return null;
    if (SKIP_PROPS.has(name)) return null;
    if (p.value && containsOwnThisFunction(p.value)) return null;
    keys.add(name);
  }
  return keys;
}

/**
 * Run the closed-object rename pass over the program. Returns the
 * number of bindings whose keys were renamed (useful for tests and
 * debug output; the obfuscator itself ignores the return value).
 */
export function applyClosedObjectRename(ast: any, analysis: ScopeAnalysis): number {
  const candidates = new Map<string, Candidate>();

  // Step 1: collect declarations that look eligible on their face.
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any) {
      if (node.type !== 'VariableDeclarator') return;
      if (!node.id || node.id.type !== 'Identifier') return;
      if (!node.init || node.init.type !== 'ObjectExpression') return;
      const render = analysis.resolvedNames.get(node.id);
      if (!render) return; // unresolved bindings (keyword names) never make it into our map

      // Duplicate VariableDeclarators for the same binding (var hoisting
      // with re-declaration) defeat the "we know the full shape" claim.
      if (candidates.has(render)) {
        candidates.get(render)!.safe = false;
        return;
      }
      const keys = collectDeclarationKeys(node.init);
      if (!keys) return;
      candidates.set(render, {
        declarator: node,
        objExpr: node.init,
        accesses: [],
        safe: true,
      });
    },
    fallback: 'iteration',
  } as any);

  if (candidates.size === 0) return 0;

  // Step 2: examine every reference. Any non-`obj.X` context disqualifies.
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any, parent: any) {
      if (node.type !== 'Identifier') return;
      const render = analysis.resolvedNames.get(node);
      if (!render) return;
      const cand = candidates.get(render);
      if (!cand) return;
      if (node === cand.declarator.id) return; // the declaration itself

      const isMember =
        parent &&
        (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression');
      if (
        isMember &&
        parent.object === node &&
        !parent.computed &&
        parent.property &&
        parent.property.type === 'Identifier'
      ) {
        const pname = parent.property.name;
        if (SKIP_PROPS.has(pname)) {
          cand.safe = false;
          return;
        }
        cand.accesses.push({ memberNode: parent, propName: pname });
        return;
      }

      // Any other parent context: call argument, return, assignment
      // target, spread source, truthiness check, etc. Conservatively
      // treat as an escape.
      cand.safe = false;
    },
    fallback: 'iteration',
  } as any);

  // Step 3: rewrite keys + accesses for surviving candidates.
  let renamedCount = 0;
  for (const cand of candidates.values()) {
    if (!cand.safe) continue;

    const allNames = new Set<string>();
    for (const p of cand.objExpr.properties) {
      const k = extractKeyName(p);
      if (k !== null) allNames.add(k);
    }
    for (const a of cand.accesses) allNames.add(a.propName);
    if (allNames.size === 0) continue;

    // One more SKIP_PROPS sweep — an access to a protected property
    // may have slipped past the earlier check if the declaration
    // didn't define it (e.g., `obj.toString`).
    let bail = false;
    for (const n of allNames) if (SKIP_PROPS.has(n)) { bail = true; break; }
    if (bail) continue;

    const rename = new Map<string, string>();
    for (const n of allNames) rename.set(n, gen());

    // Declaration side.
    for (const p of cand.objExpr.properties) {
      const kname = extractKeyName(p);
      if (kname === null) continue;
      const newName = rename.get(kname);
      if (!newName) continue;
      p.key = { type: 'Identifier', name: newName };
      // Shorthand keeps key.name === value.name in sync. After rename
      // they diverge, so drop shorthand so the printer emits both
      // sides explicitly. (secondPass also does this, but doing it
      // here keeps the tree internally consistent between passes.)
      if (p.shorthand) p.shorthand = false;
    }

    // Access side.
    for (const a of cand.accesses) {
      a.memberNode.property = { type: 'Identifier', name: rename.get(a.propName)! };
    }

    renamedCount++;
  }

  return renamedCount;
}

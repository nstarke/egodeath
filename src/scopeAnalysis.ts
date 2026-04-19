import * as estraverse from 'estraverse';
import { ASTNode } from './types';
import { gen } from './random';
import { isKeyword } from './keywords';

/**
 * Scope analysis for identifier renaming.
 *
 * Builds a lexical scope tree from the program's AST, collects every
 * binding with correct hoisting (var/function decls → nearest function
 * scope, let/const/class → nearest block scope), then resolves every
 * Identifier reference to the binding that declares it. The output lets
 * the rename pass assign each *binding* (not each spelling) its own
 * obfuscated name, so two `x` parameters in different functions can pick
 * different renders — and any reference that doesn't resolve (a real
 * global) is marked free and left alone.
 *
 * Not handled:
 *  - `with` blocks and direct `eval` defeat static scope resolution.
 *  - TypeScript/JSX node types (the obfuscator doesn't ingest them).
 *
 * Output is consumed through `substitute()` in the second rename pass,
 * and through `thirdPass` for dummy-param shadow avoidance.
 */

/**
 * estraverse's default visitor keys don't cover modern ESTree + Babel
 * shapes — without these the walker skips ArrowFunction bodies,
 * destructuring patterns, ObjectMethod params, etc., and the analyzer
 * silently misses whole swathes of the tree.
 */
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

type ScopeKind = 'module' | 'function' | 'block' | 'catch' | 'class';

interface Scope {
  parent: Scope | null;
  kind: ScopeKind;
  node: ASTNode;
  /** original name → obfuscated name for bindings declared *in this scope*. */
  bindings: Map<string, string>;
}

export interface ScopeAnalysis {
  /** Identifier nodes (bindings or bound references) → scope-resolved name. */
  resolvedNames: WeakMap<ASTNode, string>;
  /** Identifier nodes that reference a name with no matching binding. */
  freeReferences: WeakSet<ASTNode>;
  /** Identifier nodes that are not variable positions (property keys, labels). */
  skipNodes: WeakSet<ASTNode>;
  /**
   * For each scope-creating node, the set of obfuscated names that are
   * visible from inside (this scope + all ancestors). Used by
   * thirdPass to pick dummy-param names that don't shadow body refs.
   */
  liveNamesByScope: WeakMap<ASTNode, Set<string>>;
}

function newScope(parent: Scope | null, kind: ScopeKind, node: ASTNode): Scope {
  return { parent, kind, node, bindings: new Map() };
}

/**
 * Walk up to the first function/module scope. var and function
 * declarations hoist here, skipping any intervening block/catch/class
 * scopes.
 */
function nearestVarScope(s: Scope): Scope {
  let cur: Scope | null = s;
  while (cur && cur.kind !== 'function' && cur.kind !== 'module') cur = cur.parent;
  return cur || s;
}

function declareIn(
  scope: Scope,
  id: ASTNode | null | undefined,
  resolvedNames: WeakMap<ASTNode, string>,
): void {
  if (!id || id.type !== 'Identifier' || !id.name) return;
  // Keyword-named bindings are deliberately skipped: the rest of the
  // pipeline (substitute's legacy path, globalVariableEncoding's skip
  // list, tests that round-trip obfuscated output) all assume a
  // keyword-named identifier survives unchanged. Renaming a `let store`
  // or `var total` here would be formally correct, but it regresses
  // code that stakes its correctness on the invariant that nothing on
  // the keyword list ever changes. Pass 2 still resolves *references*
  // to such names through the scope chain by resolving to undefined
  // and falling into the free/keyword-skip branch, which leaves them
  // at their original spelling too — consistent with the declaration.
  if (isKeyword(id.name)) return;
  let obf = scope.bindings.get(id.name);
  if (obf === undefined) {
    obf = gen();
    scope.bindings.set(id.name, obf);
  }
  resolvedNames.set(id, obf);
}

/**
 * Leaf identifiers of a destructuring pattern. Each becomes a
 * binding. The rhs of AssignmentPattern (`= default`) is NOT collected
 * here — that's a reference expression, handled by the normal walker.
 */
function collectPatternIds(n: any): any[] {
  if (!n) return [];
  switch (n.type) {
    case 'Identifier':
      return [n];
    case 'RestElement':
      return collectPatternIds(n.argument);
    case 'AssignmentPattern':
      return collectPatternIds(n.left);
    case 'ArrayPattern': {
      const out: any[] = [];
      for (const el of n.elements || []) if (el) out.push(...collectPatternIds(el));
      return out;
    }
    case 'ObjectPattern': {
      const out: any[] = [];
      for (const p of n.properties || []) {
        if (!p) continue;
        if (p.type === 'RestElement') out.push(...collectPatternIds(p.argument));
        else if (p.value) out.push(...collectPatternIds(p.value));
      }
      return out;
    }
    default:
      return [];
  }
}

function scopeKindFor(n: any, parent: any): ScopeKind | null {
  switch (n.type) {
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
    case 'ObjectMethod':
    case 'ClassMethod':
      return 'function';
    case 'ClassDeclaration':
    case 'ClassExpression':
      return 'class';
    case 'CatchClause':
      return 'catch';
    case 'BlockStatement': {
      // A BlockStatement that *is* a function body shares its function's
      // scope — pushing a new block scope here would make params invisible
      // to the body. Catch and static-block bodies also merge with their
      // enclosing scope so the param/static context is visible.
      if (!parent) return 'block';
      const pt = parent.type;
      const isFuncBody =
        (pt === 'FunctionDeclaration' ||
          pt === 'FunctionExpression' ||
          pt === 'ArrowFunctionExpression' ||
          pt === 'ObjectMethod' ||
          pt === 'ClassMethod') && parent.body === n;
      if (isFuncBody) return null;
      if (pt === 'CatchClause' && parent.body === n) return null;
      if (pt === 'StaticBlock') return null;
      return 'block';
    }
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement':
    case 'StaticBlock':
      return 'block';
    default:
      return null;
  }
}

export function analyzeScopes(program: ASTNode): ScopeAnalysis {
  const resolvedNames = new WeakMap<ASTNode, string>();
  const freeReferences = new WeakSet<ASTNode>();
  const skipNodes = new WeakSet<ASTNode>();
  const liveNamesByScope = new WeakMap<ASTNode, Set<string>>();
  const scopeOfNode = new WeakMap<ASTNode, Scope>();
  const allScopes: Scope[] = [];

  const moduleScope = newScope(null, 'module', program);
  scopeOfNode.set(program, moduleScope);
  allScopes.push(moduleScope);

  // --- Pass 1: build scope tree + collect declarations ---
  const stack: Scope[] = [moduleScope];

  estraverse.traverse(program as any, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any, parent: any) {
      const kind = scopeKindFor(node, parent);
      if (kind) {
        const parentScope = stack[stack.length - 1];
        const s = newScope(parentScope, kind, node);
        scopeOfNode.set(node, s);
        allScopes.push(s);
        stack.push(s);
      }

      const scope = stack[stack.length - 1];
      const enclosing = stack.length >= 2 ? stack[stack.length - 2] : moduleScope;

      switch (node.type) {
        case 'VariableDeclaration': {
          const target = node.kind === 'var' ? nearestVarScope(scope) : scope;
          for (const decl of node.declarations || []) {
            for (const id of collectPatternIds(decl.id)) {
              declareIn(target, id, resolvedNames);
            }
          }
          break;
        }

        case 'FunctionDeclaration': {
          // Name hoists to the enclosing function/module scope.
          const target = nearestVarScope(enclosing);
          if (node.id) declareIn(target, node.id, resolvedNames);
          // Params bind in the new function scope (just pushed).
          for (const p of node.params || []) {
            for (const id of collectPatternIds(p)) declareIn(scope, id, resolvedNames);
          }
          break;
        }

        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
        case 'ObjectMethod':
        case 'ClassMethod': {
          // FunctionExpression.id is bound *only inside* the function body
          // (named function expression self-reference). Arrow, ObjectMethod,
          // ClassMethod don't carry an id that bind anywhere meaningful.
          if (node.type === 'FunctionExpression' && node.id) {
            declareIn(scope, node.id, resolvedNames);
          }
          for (const p of node.params || []) {
            for (const id of collectPatternIds(p)) declareIn(scope, id, resolvedNames);
          }
          break;
        }

        case 'ClassDeclaration': {
          if (node.id) {
            const outer = nearestVarScope(enclosing);
            declareIn(outer, node.id, resolvedNames);
            // Mirror the SAME binding into the class scope so inside-the-body
            // self-references (e.g. `this.constructor`, recursive `new Foo`)
            // resolve to the same render. A second declareIn() would have
            // called gen() again and overwritten resolvedNames[classId] with
            // a fresh name, leaving the declaration out of sync with every
            // outer `new ClassName(...)` reference.
            const mirrored = outer.bindings.get(node.id.name);
            if (mirrored !== undefined) scope.bindings.set(node.id.name, mirrored);
          }
          break;
        }

        case 'ClassExpression': {
          if (node.id) declareIn(scope, node.id, resolvedNames);
          break;
        }

        case 'CatchClause': {
          if (node.param) {
            for (const id of collectPatternIds(node.param)) declareIn(scope, id, resolvedNames);
          }
          break;
        }

        case 'ImportDeclaration': {
          for (const spec of node.specifiers || []) {
            if (spec && spec.local) declareIn(moduleScope, spec.local, resolvedNames);
          }
          break;
        }
      }
    },
    leave(node: any) {
      if (stack.length > 0 && stack[stack.length - 1].node === node) stack.pop();
    },
    fallback: 'iteration',
  } as any);

  // --- Pass 2: classify non-reference positions and resolve references ---
  function resolveName(s: Scope, name: string): string | null {
    let cur: Scope | null = s;
    while (cur) {
      const v = cur.bindings.get(name);
      if (v !== undefined) return v;
      cur = cur.parent;
    }
    return null;
  }

  function markSkipIfIdent(n: any): void {
    if (n && n.type === 'Identifier') skipNodes.add(n);
  }

  stack.length = 0;
  stack.push(moduleScope);

  estraverse.traverse(program as any, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any, parent: any) {
      const kind = scopeKindFor(node, parent);
      if (kind) {
        const s = scopeOfNode.get(node);
        if (s) stack.push(s);
      }

      // Positions that look like Identifier but aren't variable references.
      switch (node.type) {
        case 'Property':
        case 'ObjectProperty':
          // Shorthand (`{foo}`) parses as `key` and `value` pointing at
          // the SAME Identifier — marking the key as skip would clobber
          // the value's renaming too. Leave shorthand keys alone and
          // let the Identifier visitor classify them via context.
          if (!node.computed && !node.shorthand) markSkipIfIdent(node.key);
          break;
        case 'ObjectMethod':
          if (!node.computed) markSkipIfIdent(node.key);
          break;
        case 'MethodDefinition':
        case 'PropertyDefinition':
        case 'ClassMethod':
          if (!node.computed) markSkipIfIdent(node.key);
          break;
        case 'MemberExpression':
        case 'OptionalMemberExpression':
          if (!node.computed) markSkipIfIdent(node.property);
          break;
        case 'LabeledStatement':
          markSkipIfIdent(node.label);
          break;
        case 'BreakStatement':
        case 'ContinueStatement':
          markSkipIfIdent(node.label);
          break;
        case 'ImportSpecifier':
          // `imported` is a name in the foreign module (a property key).
          // `local` is the binding — already declared above, don't treat
          // it as a free reference when the walker visits it.
          markSkipIfIdent(node.imported);
          break;
        case 'ExportSpecifier':
          markSkipIfIdent(node.exported);
          // Re-export (`export { foo } from 'mod'`) — the `local` name
          // refers to a property of the foreign module, NOT a local
          // binding, so don't try to rename it either.
          if (parent && parent.type === 'ExportNamedDeclaration' && parent.source) {
            markSkipIfIdent(node.local);
          }
          break;
        case 'ExportAllDeclaration':
          // `exported` (when present, e.g. `export * as ns from 'mod'`)
          // is a public alias — not a local binding.
          markSkipIfIdent(node.exported);
          break;
      }

      if (node.type === 'Identifier') {
        if (skipNodes.has(node) || resolvedNames.has(node)) return;
        if (!node.name) {
          skipNodes.add(node);
          return;
        }
        // Scope resolution happens BEFORE the keyword check so locally
        // bound names that happen to collide with a global property
        // (e.g. `let rest = ...`) still resolve to their declaration
        // instead of being abandoned to the keyword skip list.
        const s = stack[stack.length - 1];
        const resolved = resolveName(s, node.name);
        if (resolved !== null) {
          resolvedNames.set(node, resolved);
          return;
        }
        if (isKeyword(node.name)) {
          skipNodes.add(node);
          return;
        }
        freeReferences.add(node);
      }
    },
    leave(node: any) {
      if (stack.length > 0 && stack[stack.length - 1].node === node) stack.pop();
    },
    fallback: 'iteration',
  } as any);

  // --- Precompute live-name sets per scope (for shadow avoidance) ---
  for (const s of allScopes) {
    const live = new Set<string>();
    let cur: Scope | null = s;
    while (cur) {
      for (const v of cur.bindings.values()) live.add(v);
      cur = cur.parent;
    }
    liveNamesByScope.set(s.node, live);
  }

  return { resolvedNames, freeReferences, skipNodes, liveNamesByScope };
}

// ---- Module-level state: current analysis for the running obfuscate() ----

let current: ScopeAnalysis | null = null;

export function setScopeAnalysis(a: ScopeAnalysis | null): void {
  current = a;
}

export function getScopeAnalysis(): ScopeAnalysis | null {
  return current;
}

export function resetScopeAnalysis(): void {
  current = null;
}

/**
 * Copy a node's scope-analysis classification (resolved name, free,
 * or skip) onto a freshly cloned identifier node. secondPass rewrites
 * shorthand properties by building a brand-new Identifier for the
 * value side — without this helper the clone has no scope entry, so
 * substitute() falls through to the flat globals map and picks a
 * render that disagrees with every other reference to the binding.
 */
export function copyScopeClassification(from: ASTNode, to: ASTNode): void {
  if (!current || !from || !to) return;
  const r = current.resolvedNames.get(from);
  if (r !== undefined) {
    current.resolvedNames.set(to, r);
    return;
  }
  if (current.freeReferences.has(from)) {
    current.freeReferences.add(to);
    return;
  }
  if (current.skipNodes.has(from)) {
    current.skipNodes.add(to);
  }
}

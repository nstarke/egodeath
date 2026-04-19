import * as estraverse from 'estraverse';
import { gen } from '../random';
import { ScopeAnalysis } from '../scopeAnalysis';

/**
 * Closed-class method rename.
 *
 * Renames instance methods and instance fields of a class whose
 * binding demonstrably never escapes the module. A class method is a
 * prominent landmark during reverse-engineering ("this is the
 * `verifyLicense` call"); renaming it to a random Unicode render
 * strips that hint.
 *
 * Safety model in three layers:
 *
 *   1. The class binding `Foo` is *closed* — every reference to `Foo`
 *      outside the declaration itself is either `new Foo(...)` or
 *      `x instanceof Foo`. Any other use — exported, aliased,
 *      Foo.prototype, `class Bar extends Foo`, passed as an argument —
 *      disqualifies the class. This rules out the external world ever
 *      touching Foo's methods.
 *
 *   2. For each method name `M` defined on Foo, every `.M` access in
 *      the program must be on a receiver we can statically prove is
 *      a Foo instance:
 *        - `this.M` inside a Foo method body
 *        - `new Foo(...).M` directly chained
 *        - `v.M` where `v` is a "proven Foo" (a const/let bound to
 *          exactly `new Foo(...)` whose every other reference is a
 *          non-computed member access — same escape shape as the
 *          class binding)
 *        - `super.M` is skipped (targets the parent class, not Foo,
 *          so rename is orthogonal)
 *      Any other receiver context disqualifies the method.
 *
 *   3. A sweeping SKIP_PROPS list refuses rename for any method name
 *      that could plausibly alias a standard prototype method (map,
 *      push, toString, then, …). This is the backstop: even if
 *      receiver analysis wrongly classifies something, we never
 *      collide with a built-in.
 *
 * Multi-candidate conflicts: if two closed classes define the same
 * method name, we give up on that name (ambiguous dispatch — we can't
 * tell from `.M` alone which class it's on).
 *
 * `this` context is tracked with a stack: regular functions reset it
 * (their `this` depends on the call site), arrows inherit, class
 * methods keep the class's context. So `this.M` inside a nested
 * `function() { ... }` or `ObjectMethod` does NOT count as a Foo-
 * instance access.
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

/**
 * Names we refuse to rename under any circumstance. A mix of:
 *   - Object.prototype / language-level hooks (constructor, then, toString, …)
 *   - Standard Array/String/Map/Set/Promise/Function/Number/Date/RegExp
 *     prototype members that real code often calls through `.x` sites
 *     that COULD have been receiver-misclassified
 *   - Common DOM event-shape names
 *
 * This list is the safety backstop: even if our receiver analysis has
 * an oversight and classifies some `[].push(…)` as a Foo access, we
 * still won't rename because `push` is on this list.
 */
const SKIP_PROPS = new Set<string>([
  // Object.prototype + language hooks
  'constructor', 'prototype', '__proto__',
  'hasOwnProperty', 'toString', 'valueOf', 'propertyIsEnumerable',
  'isPrototypeOf', 'toLocaleString',
  'length', 'name',
  'then', 'catch', 'finally',
  // Iterator protocol
  'next', 'return', 'throw', 'done', 'value',
  // Array.prototype
  'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat',
  'join', 'reverse', 'sort', 'map', 'filter', 'reduce', 'reduceRight',
  'forEach', 'every', 'some', 'find', 'findIndex', 'findLast', 'findLastIndex',
  'includes', 'indexOf', 'lastIndexOf', 'fill', 'copyWithin',
  'entries', 'keys', 'values', 'flat', 'flatMap', 'at', 'group', 'groupBy',
  // String.prototype
  'charAt', 'charCodeAt', 'codePointAt', 'startsWith', 'endsWith',
  'padStart', 'padEnd', 'replace', 'replaceAll', 'split', 'trim',
  'trimStart', 'trimEnd', 'toLowerCase', 'toUpperCase', 'normalize',
  'repeat', 'match', 'matchAll', 'search', 'substring', 'substr',
  'localeCompare', 'anchor', 'link',
  // Object static + common
  'assign', 'create', 'freeze', 'defineProperty', 'defineProperties',
  'getPrototypeOf', 'setPrototypeOf', 'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors', 'getOwnPropertyNames', 'getOwnPropertySymbols',
  'fromEntries', 'is', 'seal', 'isSealed', 'isFrozen', 'isExtensible',
  // Promise static
  'all', 'allSettled', 'race', 'reject', 'resolve', 'any', 'withResolvers',
  // Map/Set
  'get', 'set', 'has', 'delete', 'clear', 'size',
  // Function.prototype
  'apply', 'call', 'bind',
  // Number / Date / RegExp
  'toFixed', 'toPrecision', 'toExponential',
  'getTime', 'getFullYear', 'getMonth', 'getDate', 'getDay',
  'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds',
  'setTime', 'setFullYear', 'setMonth', 'setDate',
  'exec', 'test',
  // Common DOM/event names
  'addEventListener', 'removeEventListener', 'dispatchEvent',
  'target', 'currentTarget', 'type', 'source', 'message',
  'preventDefault', 'stopPropagation',
  // Iteration symbols (by name)
  'iterator', 'asyncIterator',
]);

interface ClassCandidate {
  decl: any;                          // ClassDeclaration node
  bindingRender: string;              // obfuscated binding name from scope analysis
  members: Map<string, any[]>;        // instance member name → [MethodDefinition/ClassMethod/PropertyDefinition nodes]
  safe: boolean;                      // false once any escape or disqualifying shape is observed
}

interface ProvenInstance {
  bindingRender: string;              // variable's obfuscated name
  classRender: string;                // the class it's an instance of
  declarator: any;                    // the VariableDeclarator node
}

interface AccessSite {
  memberNode: any;                    // MemberExpression / OptionalMemberExpression
  receiverKind: 'this-class' | 'super' | 'new' | 'var-proven' | 'unknown';
  classRender: string | null;         // the class that the receiver resolves to, if known
}

function collectClassMembers(classDecl: any): Map<string, any[]> | null {
  const members = new Map<string, any[]>();
  const body = classDecl.body && classDecl.body.body;
  if (!Array.isArray(body)) return null;

  for (const m of body) {
    if (!m) continue;
    // Static initializer blocks can run arbitrary code, including
    // Foo.prototype[x] = ... shenanigans. Too hard to reason about.
    if (m.type === 'StaticBlock') return null;

    if (m.type === 'MethodDefinition' || m.type === 'ClassMethod') {
      if (m.computed) return null;
      if (m.kind === 'constructor') continue;     // rename would break `new Foo()` semantics
      if (m.static) continue;                     // static access is Foo.X — escape path
      if (!m.key || m.key.type !== 'Identifier') return null;
      const name = m.key.name;
      if (SKIP_PROPS.has(name)) return null;      // refuse the whole class if it defines a skip-name
      const list = members.get(name) || [];
      list.push(m);
      members.set(name, list);
    } else if (m.type === 'PropertyDefinition' || m.type === 'ClassProperty') {
      if (m.computed) return null;
      if (m.static) continue;
      if (!m.key || m.key.type !== 'Identifier') return null;
      const name = m.key.name;
      if (SKIP_PROPS.has(name)) return null;
      const list = members.get(name) || [];
      list.push(m);
      members.set(name, list);
    }
    // TSAbstractMethodDefinition / PrivateIdentifier members / etc.
    // are left alone. Private identifiers are already syntactically
    // private; we don't rename them here.
  }
  return members;
}

/**
 * Find variables whose sole initialization is `new <Candidate>(...)`
 * and whose only later uses are non-computed member accesses —
 * mirroring the escape shape of the class binding itself. Such a
 * variable's `.M` accesses are safe to treat as "definitely on a Foo
 * instance" for the purpose of method renaming.
 */
function findProvenInstances(
  ast: any,
  analysis: ScopeAnalysis,
  candidates: Map<string, ClassCandidate>,
): Map<string, ProvenInstance> {
  const potential = new Map<string, ProvenInstance>();

  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any) {
      if (node.type !== 'VariableDeclarator') return;
      if (!node.id || node.id.type !== 'Identifier') return;
      if (!node.init || node.init.type !== 'NewExpression') return;
      if (!node.init.callee || node.init.callee.type !== 'Identifier') return;

      const varRender = analysis.resolvedNames.get(node.id);
      if (!varRender) return;
      const calleeRender = analysis.resolvedNames.get(node.init.callee);
      if (!calleeRender || !candidates.has(calleeRender)) return;

      if (potential.has(varRender)) {
        // A second declaration (var hoisting redeclaration, or reuse
        // across scopes sharing a render name somehow) defeats the
        // "only one definition" guarantee.
        potential.delete(varRender);
        return;
      }
      potential.set(varRender, {
        bindingRender: varRender,
        classRender: calleeRender,
        declarator: node,
      });
    },
    fallback: 'iteration',
  } as any);

  if (potential.size === 0) return potential;

  // Verify each potential's other references are all non-computed
  // member accesses. Any other context (call arg, return, alias,
  // computed access, reassignment) removes it from the set.
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any, parent: any) {
      if (node.type !== 'Identifier') return;
      const render = analysis.resolvedNames.get(node);
      if (!render) return;
      const inst = potential.get(render);
      if (!inst) return;
      if (node === inst.declarator.id) return;

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
        return;
      }
      // `w instanceof SomeClass` is a pure type check — it reads the
      // binding but doesn't hand the instance to anyone. Treat as
      // non-escaping so patterns like `if (w instanceof Widget) w.X()`
      // still qualify `w` as a proven instance.
      if (
        parent &&
        parent.type === 'BinaryExpression' &&
        parent.operator === 'instanceof' &&
        parent.left === node
      ) {
        return;
      }
      potential.delete(render);
    },
    fallback: 'iteration',
  } as any);

  return potential;
}

/**
 * Classify every `.X` access whose property name is defined on some
 * candidate class. Classification uses the current `this` context
 * stack — see the comment on the stack inside for the shape rules.
 */
function collectMethodAccesses(
  ast: any,
  analysis: ScopeAnalysis,
  candidates: Map<string, ClassCandidate>,
  provenInstances: Map<string, ProvenInstance>,
  methodToClass: Map<string, string | null>,
): Map<string, AccessSite[]> {
  const accesses = new Map<string, AccessSite[]>();

  // `thisStack` tracks the `this` binding that applies at a given AST
  // position. Entries are pushed when we enter a new `this` scope and
  // popped on leave.
  //   - ClassDeclaration/ClassExpression enters a class context: `this`
  //     inside the class body is an instance of that class.
  //   - Regular FunctionDeclaration/FunctionExpression/ObjectMethod
  //     (NOT a class method) enters a detached context: `this` depends
  //     on call site, so we can't claim it's a Foo instance.
  //   - ArrowFunctionExpression is transparent (arrows don't bind
  //     `this`).
  //   - ClassMethod (Babel's flat shape) is transparent — the class's
  //     context still applies in the method body.
  //   - FunctionExpression that's the `.value` of a MethodDefinition
  //     (ESTree shape) is also transparent for the same reason.
  const thisStack: Array<{ classRender: string | null }> = [];
  const pushedNodes = new WeakSet<any>();

  function currentThisClass(): string | null {
    return thisStack.length ? thisStack[thisStack.length - 1].classRender : null;
  }

  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any, parent: any) {
      // --- this-context bookkeeping ---
      if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
        let classRender: string | null = null;
        if (node.id && node.id.type === 'Identifier') {
          const r = analysis.resolvedNames.get(node.id);
          if (r) classRender = r;
        }
        thisStack.push({ classRender });
        pushedNodes.add(node);
      } else if (node.type === 'FunctionExpression') {
        const isClassMethod =
          parent && parent.type === 'MethodDefinition' && parent.value === node;
        if (!isClassMethod) {
          thisStack.push({ classRender: null });
          pushedNodes.add(node);
        }
      } else if (node.type === 'FunctionDeclaration' || node.type === 'ObjectMethod') {
        thisStack.push({ classRender: null });
        pushedNodes.add(node);
      }
      // ClassMethod (Babel): no push — class context carries through.
      // ArrowFunctionExpression: no push — inherits `this`.

      // --- classify .X accesses ---
      if (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression') return;
      if (node.computed) return;
      if (!node.property || node.property.type !== 'Identifier') return;
      const methodName = node.property.name;
      if (!methodToClass.has(methodName)) return;
      const classRender = methodToClass.get(methodName);
      if (!classRender) return; // null marks a cross-candidate name conflict

      const receiver = node.object;
      let kind: AccessSite['receiverKind'] = 'unknown';
      let rClassRender: string | null = null;

      if (receiver.type === 'ThisExpression') {
        const t = currentThisClass();
        if (t === classRender) {
          kind = 'this-class';
          rClassRender = classRender;
        }
      } else if (receiver.type === 'Super') {
        kind = 'super';
      } else if (
        receiver.type === 'NewExpression' &&
        receiver.callee &&
        receiver.callee.type === 'Identifier'
      ) {
        const calleeRender = analysis.resolvedNames.get(receiver.callee);
        if (calleeRender === classRender) {
          kind = 'new';
          rClassRender = classRender;
        }
      } else if (receiver.type === 'Identifier') {
        const recRender = analysis.resolvedNames.get(receiver);
        if (recRender) {
          const inst = provenInstances.get(recRender);
          if (inst && inst.classRender === classRender) {
            kind = 'var-proven';
            rClassRender = classRender;
          }
        }
      }

      const list = accesses.get(methodName) || [];
      list.push({ memberNode: node, receiverKind: kind, classRender: rClassRender });
      accesses.set(methodName, list);
    },
    leave(node: any) {
      if (pushedNodes.has(node)) thisStack.pop();
    },
    fallback: 'iteration',
  } as any);

  return accesses;
}

export function applyClosedClassRename(ast: any, analysis: ScopeAnalysis): number {
  // --- Step 1: find candidate class declarations ---
  const candidates = new Map<string, ClassCandidate>();
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any) {
      if (node.type !== 'ClassDeclaration') return;
      if (!node.id || node.id.type !== 'Identifier') return;
      const render = analysis.resolvedNames.get(node.id);
      if (!render) return;
      if (candidates.has(render)) {
        candidates.get(render)!.safe = false;
        return;
      }
      const members = collectClassMembers(node);
      if (!members || members.size === 0) return;
      candidates.set(render, { decl: node, bindingRender: render, members, safe: true });
    },
    fallback: 'iteration',
  } as any);
  if (candidates.size === 0) return 0;

  // --- Step 2: escape-check every reference to a candidate binding ---
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any, parent: any) {
      if (node.type !== 'Identifier') return;
      const render = analysis.resolvedNames.get(node);
      if (!render) return;
      const cand = candidates.get(render);
      if (!cand) return;
      if (node === cand.decl.id) return;

      // Allowed shapes:
      //   new Foo(...)                        Foo is callee of NewExpression
      //   x instanceof Foo                    Foo is .right of a BinaryExpression with operator 'instanceof'
      if (parent && parent.type === 'NewExpression' && parent.callee === node) return;
      if (
        parent &&
        parent.type === 'BinaryExpression' &&
        parent.operator === 'instanceof' &&
        parent.right === node
      ) {
        return;
      }
      cand.safe = false;
    },
    fallback: 'iteration',
  } as any);
  for (const [k, c] of [...candidates]) if (!c.safe) candidates.delete(k);
  if (candidates.size === 0) return 0;

  // --- Step 3: proven-Foo variables (optional; empty map means no such vars) ---
  const provenInstances = findProvenInstances(ast, analysis, candidates);

  // --- Step 4: map method name → unique candidate class, or null on conflict ---
  const methodToClass = new Map<string, string | null>();
  for (const [classRender, cand] of candidates) {
    for (const name of cand.members.keys()) {
      if (methodToClass.has(name)) methodToClass.set(name, null);
      else methodToClass.set(name, classRender);
    }
  }

  // --- Step 5: collect and classify every potentially-relevant .X access ---
  const accesses = collectMethodAccesses(ast, analysis, candidates, provenInstances, methodToClass);

  // --- Step 6: decide which methods are safe to rename ---
  interface SafeRename {
    classRender: string;
    methodNodes: any[];
    accessNodes: any[];
  }
  const safe = new Map<string, SafeRename>();

  for (const [classRender, cand] of candidates) {
    for (const [methodName, methodNodes] of cand.members) {
      if (methodToClass.get(methodName) !== classRender) continue; // conflict or shadowed
      const list = accesses.get(methodName) || [];
      let ok = true;
      const renameSites: any[] = [];
      for (const a of list) {
        if (a.receiverKind === 'super') {
          // super.M targets the parent class, not Foo. Renaming Foo's
          // own M is orthogonal: super.M still binds to parent's M at
          // runtime. Skip this site (don't rewrite it) but don't bail.
          continue;
        }
        if (
          (a.receiverKind === 'this-class' ||
            a.receiverKind === 'new' ||
            a.receiverKind === 'var-proven') &&
          a.classRender === classRender
        ) {
          renameSites.push(a.memberNode);
          continue;
        }
        ok = false;
        break;
      }
      if (ok) {
        safe.set(methodName, { classRender, methodNodes, accessNodes: renameSites });
      }
    }
  }

  // --- Step 7: apply renames ---
  let renamedCount = 0;
  for (const info of safe.values()) {
    const newName = gen();
    for (const mNode of info.methodNodes) {
      mNode.key = { type: 'Identifier', name: newName };
    }
    for (const aNode of info.accessNodes) {
      aNode.property = { type: 'Identifier', name: newName };
    }
    renamedCount++;
  }
  return renamedCount;
}

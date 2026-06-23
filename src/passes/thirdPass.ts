import * as crypto from 'crypto';
import { ASTNode, IdentifierNode, PassHandlerMap } from '../types';
import { gen } from '../random';
import { Identifier } from '../ast';
import { getScopeAnalysis } from '../scopeAnalysis';

/**
 * Check if a function's last parameter is a rest element (...args).
 * If so, we must not append dummy params after it.
 */
function hasRestParam(node: any): boolean {
  if (!node.params || node.params.length === 0) return false;
  const last = node.params[node.params.length - 1];
  return last.type === 'RestElement';
}

/**
 * Some function forms have hard constraints on arity:
 *  - getters (`get x()` / `get [x]()`) must have 0 params
 *  - setters (`set x(v)`) must have exactly 1 param
 * Adding dummy params to either produces `SyntaxError: Getter must not
 * have any formal parameters` at parse time. Skip these entirely.
 *
 * The `kind` field lives on the *enclosing* node (ObjectMethod,
 * ClassMethod, MethodDefinition), not on the FunctionExpression that's
 * its value. We accept both shapes here so the helper can be called
 * from either handler.
 */
function isAccessor(node: any): boolean {
  return node && (node.kind === 'get' || node.kind === 'set');
}

/**
 * Generate 0-15 random dummy identifier nodes for parameter injection.
 *
 * `forbidden`, if supplied, is a set of obfuscated names that are live
 * in the target function's scope chain. A dummy param sharing a name
 * with a live binding would shadow every reference to that binding
 * inside the function body — silent breakage. The Unicode name space
 * makes collisions astronomically unlikely, but shadowing happens
 * deterministically when it does, so we reroll on match.
 */
export function addIdentifiers(forbidden?: Set<string>): IdentifierNode[] {
  const len = crypto.randomBytes(1)[0] % 16;
  const result: IdentifierNode[] = [];
  for (let i = 0; i < len; i++) {
    let name = gen();
    // gen() guarantees global uniqueness (no other binding has this
    // name), but the forbidden set catches names from ancestor scopes
    // that gen()'s issued-names set already knows about — we re-roll
    // rather than accept a shadow. Bound the retries for safety.
    let retries = 0;
    while (forbidden && forbidden.has(name) && retries < 8) {
      name = gen();
      retries++;
    }
    result.push(Identifier(name));
  }
  return result;
}

/**
 * Obfuscated-name set live in the function's scope chain. Used to
 * make sure the dummy params we inject don't accidentally shadow a
 * name the body references.
 */
function liveNamesFor(node: any): Set<string> | undefined {
  const a = getScopeAnalysis();
  return a ? a.liveNamesByScope.get(node) : undefined;
}

/**
 * True if a function body opens with a `"use strict"` directive. Such a
 * function may not have a "non-simple" parameter list (defaults, rest,
 * destructuring) — `SyntaxError: Illegal 'use strict' directive in function
 * with non-simple parameter list` — so we can't give it default-valued dummy
 * params and skip injection entirely.
 */
function hasUseStrictDirective(node: any): boolean {
  const body = node.body;
  if (!body || body.type !== 'BlockStatement') return false;
  // Babel keeps directives in a dedicated array.
  if (Array.isArray(body.directives)) {
    for (const d of body.directives) {
      if (d && d.value && d.value.value === 'use strict') return true;
    }
  }
  // ESTree shape: a leading string-literal ExpressionStatement.
  const first = body.body && body.body[0];
  if (first && first.type === 'ExpressionStatement') {
    const e = first.expression;
    if (e && (e.value === 'use strict' ||
      (e.type === 'StringLiteral' && e.value === 'use strict'))) return true;
  }
  return false;
}

/**
 * Append dummy parameters to a function, preserving its `Function.length`.
 *
 * The dummies are emitted as default-valued params (`name = <n>`), which do
 * NOT count toward `.length` (only leading simple params do). Plain dummy
 * params would inflate `.length`, which breaks any runtime that reads arity —
 * notably lodash's `baseRest`, where `func.length` decides where rest
 * arguments start, so an inflated arity makes `_.assign`/`_.merge` collect an
 * empty source list and silently copy nothing.
 */
function injectDummyParams(node: any): void {
  if (hasRestParam(node)) return;
  // A "use strict" body can't carry a non-simple parameter list, so leave its
  // arity alone rather than emit invalid syntax.
  if (hasUseStrictDirective(node)) return;
  const dummies = addIdentifiers(liveNamesFor(node)).map((id) => ({
    type: 'AssignmentPattern',
    left: id,
    right: { type: 'NumericLiteral', value: crypto.randomBytes(1)[0] },
  }));
  node.params = node.params.concat(dummies);
}

/**
 * Third pass: inject dummy parameters into functions and strip comments.
 */
export const thirdPassHandlers: PassHandlerMap = {
  VariableDeclaration(node) { return node; },
  ObjectExpression(node) { return node; },
  Property(node) { return node; },
  BlockStatement(node) { return node; },
  ForInStatement(node) { return node; },
  LogicalExpression(node) { return node; },
  BinaryExpression(node) { return node; },
  Identifier(node) { return node; },
  VariableDeclarator(node) { return node; },
  NewExpression(node) { return node; },
  CallExpression(node) { return node; },

  FunctionExpression(node: any) {
    // Accessor flag is set by MethodDefinition handler (ESTree shape).
    if (node.__egodeath_accessor) return node;
    injectDummyParams(node);
    return node;
  },

  ReturnStatement(node) { return node; },
  MemberExpression(node) { return node; },
  ThisExpression(node) { return node; },
  ExpressionStatement(node) { return node; },
  UpdateExpression(node) { return node; },
  AssignmentExpression(node) { return node; },

  FunctionDeclaration(node) {
    injectDummyParams(node);
    return node;
  },

  IfStatement(node) { return node; },
  UnaryExpression(node) { return node; },
  SwitchCase(node) { return node; },
  SwitchStatement(node) { return node; },
  ConditionalExpression(node) { return node; },
  Program(node) { return node; },
  Literal(node) { return node; },
  ThrowStatement(node) { return node; },
  Directive(node) { return node; },

  // Modern ES6+ node types
  ArrowFunctionExpression(node) {
    injectDummyParams(node);
    return node;
  },

  SpreadElement(node) { return node; },
  RestElement(node) { return node; },
  TemplateLiteral(node) { return node; },
  TaggedTemplateExpression(node) { return node; },
  TemplateElement(node) { return node; },
  ObjectPattern(node) { return node; },
  ArrayPattern(node) { return node; },
  AssignmentPattern(node) { return node; },
  ClassDeclaration(node) { return node; },
  ClassExpression(node) { return node; },
  ClassBody(node) { return node; },
  PropertyDefinition(node) { return node; },
  ForOfStatement(node) { return node; },
  YieldExpression(node) { return node; },
  AwaitExpression(node) { return node; },
  ImportDeclaration(node) { return node; },
  ExportNamedDeclaration(node) { return node; },
  ExportDefaultDeclaration(node) { return node; },
  ExportAllDeclaration(node) { return node; },
  DoWhileStatement(node) { return node; },
  ArrayExpression(node) { return node; },
  CatchClause(node) { return node; },
  ForStatement(node) { return node; },
  TryStatement(node) { return node; },
  WhileStatement(node) { return node; },
  SequenceExpression(node) { return node; },
  EmptyStatement(node) { return node; },
  LabeledStatement(node) { return node; },
  BreakStatement(node) { return node; },
  ContinueStatement(node) { return node; },
  DebuggerStatement(node) { return node; },
  ChainExpression(node) { return node; },
  OptionalMemberExpression(node) { return node; },
  OptionalCallExpression(node) { return node; },

  MethodDefinition(node) {
    // ESTree-style: MethodDefinition wraps a FunctionExpression. If this
    // is a getter or setter, mark the value function so the
    // FunctionExpression handler won't inject dummy params into it.
    if (isAccessor(node) && node.value) {
      node.value.__egodeath_accessor = true;
    }
    return node;
  },

  ObjectMethod(node) {
    if (isAccessor(node)) return node;
    injectDummyParams(node);
    return node;
  },

  // Babel represents class method definitions as ClassMethod (with params
  // directly on the node). Constructors and get/set accessors have arity
  // constraints — skip those.
  ClassMethod(node: any) {
    if (isAccessor(node)) return node;
    // Constructors accept any arity, but webpack bundles sometimes rely
    // on `Foo.length` reflecting the expected constructor arity. Skip to
    // be safe.
    if (node.kind === 'constructor') return node;
    injectDummyParams(node);
    return node;
  },

  // Babel-specific literal types
  StringLiteral(node) { return node; },
  NumericLiteral(node) { return node; },
  BooleanLiteral(node) { return node; },
  NullLiteral(node) { return node; },
  RegExpLiteral(node) { return node; },
  ObjectProperty(node) { return node; },
};

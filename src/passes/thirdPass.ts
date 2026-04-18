import * as crypto from 'crypto';
import { ASTNode, IdentifierNode, PassHandlerMap } from '../types';
import { gen } from '../random';
import { Identifier } from '../ast';

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
 */
export function addIdentifiers(): IdentifierNode[] {
  const len = crypto.randomBytes(1)[0] % 16;
  const result: IdentifierNode[] = [];
  for (let i = 0; i < len; i++) {
    result.push(Identifier(gen()));
  }
  return result;
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
    if (!hasRestParam(node)) node.params = node.params.concat(addIdentifiers());
    return node;
  },

  ReturnStatement(node) { return node; },
  MemberExpression(node) { return node; },
  ThisExpression(node) { return node; },
  ExpressionStatement(node) { return node; },
  UpdateExpression(node) { return node; },
  AssignmentExpression(node) { return node; },

  FunctionDeclaration(node) {
    if (!hasRestParam(node)) node.params = node.params.concat(addIdentifiers());
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
    if (!hasRestParam(node)) node.params = node.params.concat(addIdentifiers());
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
    if (!hasRestParam(node)) node.params = node.params.concat(addIdentifiers());
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
    if (!hasRestParam(node)) node.params = node.params.concat(addIdentifiers());
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

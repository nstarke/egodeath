import * as recast from 'recast';
import { ASTNode, PassHandlerMap } from '../types';
import { substitute, traverseNodeAddSwap, findNested } from '../substitute';
import { getGlobals } from '../globals';

const jsfuck = require('jsfuck').JSFuck;

/**
 * Check if the parent node is a require() call — we must not encode
 * require() arguments or module resolution breaks at runtime.
 */
function isRequireCall(parent: any): boolean {
  if (parent.type === 'CallExpression') {
    const callee = parent.callee;
    if (callee && callee.type === 'Identifier' && callee.name === 'require') {
      return true;
    }
  }
  return false;
}

/**
 * Check if the parent is an import/export declaration (source string).
 */
function isImportSource(parent: any): boolean {
  return parent.type === 'ImportDeclaration' ||
    parent.type === 'ExportNamedDeclaration' ||
    parent.type === 'ExportAllDeclaration';
}

/**
 * Second pass: apply identifier substitutions and encode strings.
 */
export const secondPassHandlers: PassHandlerMap = {
  VariableDeclaration(node) { return node; },
  ObjectExpression(node) { return node; },

  Property(node) {
    substitute(node.key);
    substitute(node.value);
    return node;
  },

  ForStatement(node) {
    substitute(node.init);
    substitute(node.test);
    substitute(node.update);
    return node;
  },

  BlockStatement(node) { return node; },

  ForInStatement(node) {
    substitute(node.left);
    substitute(node.right);
    return node;
  },

  LogicalExpression(node) {
    substitute(node.left);
    substitute(node.right);
    return node;
  },

  BinaryExpression(node) {
    substitute(node.left);
    substitute(node.right);
    return node;
  },

  Identifier(node) { return node; },

  VariableDeclarator(node) {
    substitute(node.id);
    substitute(node.init);
    return node;
  },

  NewExpression(node) {
    substitute(node.callee);
    node.arguments.forEach((arg: ASTNode) => substitute(arg));
    return node;
  },

  CallExpression(node) {
    substitute(node.callee);
    node.arguments.forEach((arg: ASTNode) => substitute(arg));
    return node;
  },

  FunctionExpression(node) {
    node.params.forEach((param: ASTNode) => substitute(param));
    return node;
  },

  ReturnStatement(node) {
    substitute(node.argument);
    return node;
  },

  MemberExpression(node) {
    traverseNodeAddSwap(getGlobals(), node);
    return node;
  },

  ThisExpression(node) { return node; },
  ExpressionStatement(node) { return node; },

  UpdateExpression(node) {
    substitute(node.argument);
    return node;
  },

  AssignmentExpression(node) {
    substitute(node.left);
    substitute(node.right);
    return node;
  },

  FunctionDeclaration(node) {
    substitute(node.id);
    node.params.forEach((param: ASTNode) => substitute(param));
    return node;
  },

  IfStatement(node) {
    substitute(node.test);
    return node;
  },

  UnaryExpression(node) {
    substitute(node.argument);
    return node;
  },

  SwitchCase(node) { return node; },

  SwitchStatement(node) {
    substitute(node.discriminant);
    return node;
  },

  ConditionalExpression(node) {
    substitute(node.alternate);
    substitute(node.test);
    substitute(node.consequent);
    return node;
  },

  Program(node) { return node; },

  Literal(node, parent) {
    if (parent.type === 'Property') {
      const found = findNested(getGlobals(), node.value);
      if (found.length) {
        node.value = found.pop().___val;
      }
    } else if (
      typeof node.value === 'string' &&
      node.value &&
      parent.type !== 'Property' &&
      !isRequireCall(parent) &&
      !isImportSource(parent) &&
      node.value.length < 64
    ) {
      const e = jsfuck.encode(node.value);
      node.type = 'UnaryExpression';
      node.operator = '';
      node.argument = recast.parse(e, {
        parser: require('recast/parsers/babel'),
      }).program.body.pop();
    }
    return node;
  },

  ThrowStatement(node) { return node; },
  Directive(node) { return node; },

  DoWhileStatement(node) {
    substitute(node.test);
    substitute(node.body);
    return node;
  },

  ArrayExpression(node) {
    node.elements.forEach((el: ASTNode) => substitute(el));
  },

  CatchClause(node) {
    substitute(node.param);
    return node;
  },

  // Modern ES6+ node types
  ArrowFunctionExpression(node) {
    node.params.forEach((param: ASTNode) => substitute(param));
    return node;
  },

  SpreadElement(node) {
    substitute(node.argument);
    return node;
  },

  RestElement(node) {
    substitute(node.argument);
    return node;
  },

  TemplateLiteral(node) { return node; },
  TaggedTemplateExpression(node) { return node; },
  TemplateElement(node) { return node; },

  ObjectPattern(node) { return node; },
  ArrayPattern(node) { return node; },

  AssignmentPattern(node) {
    substitute(node.left);
    return node;
  },

  ClassDeclaration(node) {
    substitute(node.id);
    return node;
  },

  ClassExpression(node) {
    substitute(node.id);
    return node;
  },

  ClassBody(node) { return node; },

  MethodDefinition(node) {
    substitute(node.key);
    return node;
  },

  PropertyDefinition(node) {
    substitute(node.key);
    return node;
  },

  ForOfStatement(node) {
    substitute(node.left);
    substitute(node.right);
    return node;
  },

  YieldExpression(node) {
    substitute(node.argument);
    return node;
  },

  AwaitExpression(node) {
    substitute(node.argument);
    return node;
  },

  // Import/export — don't touch module specifier strings
  ImportDeclaration(node) { return node; },
  ExportNamedDeclaration(node) { return node; },
  ExportDefaultDeclaration(node) { return node; },
  ExportAllDeclaration(node) { return node; },

  TryStatement(node) { return node; },
  WhileStatement(node) {
    substitute(node.test);
    return node;
  },
  SequenceExpression(node) { return node; },
  EmptyStatement(node) { return node; },
  LabeledStatement(node) { return node; },
  BreakStatement(node) { return node; },
  ContinueStatement(node) { return node; },
  DebuggerStatement(node) { return node; },
  ChainExpression(node) { return node; },

  OptionalMemberExpression(node) {
    traverseNodeAddSwap(getGlobals(), node);
    return node;
  },

  OptionalCallExpression(node) {
    substitute(node.callee);
    node.arguments.forEach((arg: ASTNode) => substitute(arg));
    return node;
  },

  // Babel-specific: StringLiteral and NumericLiteral (babel parser uses these instead of Literal)
  StringLiteral(node, parent) {
    if (
      typeof node.value === 'string' &&
      node.value &&
      parent.type !== 'Property' &&
      parent.type !== 'ObjectProperty' &&
      !isRequireCall(parent) &&
      !isImportSource(parent) &&
      node.value.length < 64
    ) {
      const e = jsfuck.encode(node.value);
      node.type = 'UnaryExpression';
      node.operator = '';
      node.argument = recast.parse(e, {
        parser: require('recast/parsers/babel'),
      }).program.body.pop();
    }
    return node;
  },

  NumericLiteral(node) { return node; },
  BooleanLiteral(node) { return node; },
  NullLiteral(node) { return node; },
  RegExpLiteral(node) { return node; },

  // Babel uses ObjectProperty and ObjectMethod instead of Property
  ObjectProperty(node) {
    substitute(node.key);
    substitute(node.value);
    return node;
  },

  ObjectMethod(node) {
    substitute(node.key);
    node.params.forEach((param: ASTNode) => substitute(param));
    return node;
  },
};

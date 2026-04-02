import { ASTNode, PassHandlerMap } from '../types';
import { gen } from '../random';
import { getGlobals, addWindowProp, createEntry } from '../globals';
import { traverseNode, descend } from '../substitute';

/**
 * First pass: catalog all identifiers and build the globals mapping.
 */
export const firstPassHandlers: PassHandlerMap = {
  VariableDeclaration(node) { return node; },
  ObjectExpression(node) { return node; },
  Property(node) { return node; },
  BlockStatement(node) { return node; },
  ForInStatement(node) { return node; },
  LogicalExpression(node) { return node; },

  BinaryExpression(node, parent) {
    if (parent.type === 'Property') {
      if (node.left.raw && node.right.raw) {
        const code = eval(node.left.raw + ' ' + node.operator + ' ' + node.right.raw);
        const globals = getGlobals();
        globals[code] = globals[code] || createEntry(gen());
      }
    }
    return node;
  },

  Identifier(node) {
    const globals = getGlobals();
    globals[node.name] = globals[node.name] || createEntry(gen());
    return node;
  },

  VariableDeclarator(node) { return node; },
  NewExpression(node) { return node; },
  CallExpression(node) { return node; },
  FunctionExpression(node) { return node; },
  ReturnStatement(node) { return node; },

  MemberExpression(node) {
    const keys = traverseNode(node);
    descend(getGlobals(), keys);
  },

  ThisExpression(node) { return node; },
  ExpressionStatement(node) { return node; },
  UpdateExpression(node) { return node; },

  AssignmentExpression(node) {
    if (node.left && node.left.object && node.left.object.name === 'window') {
      if (node.left.property.name) {
        const globals = getGlobals();
        globals[node.left.property.name] = globals[node.left.property.name] || createEntry(gen());
        addWindowProp(node.left.property.name);
      }
    }
    return node;
  },

  FunctionDeclaration(node) { return node; },
  IfStatement(node) { return node; },
  UnaryExpression(node) { return node; },
  SwitchCase(node) { return node; },
  SwitchStatement(node) { return node; },
  ConditionalExpression(node) { return node; },
  Program(node) { return node; },
  Literal(node) { return node; },
  ThrowStatement(node) { return node; },
  Directive(node) { return node; },

  // Modern ES6+ node types — pass through, let Identifier handler catalog names
  ArrowFunctionExpression(node) { return node; },
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
  MethodDefinition(node) { return node; },
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
};

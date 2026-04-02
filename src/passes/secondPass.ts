import * as recast from 'recast';
import { ASTNode, PassHandlerMap } from '../types';
import { substitute, traverseNodeAddSwap, findNested } from '../substitute';
import { getGlobals } from '../globals';

const jsfuck = require('jsfuck').JSFuck;

/**
 * Check if the parent node is a require() call.
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
 * Build a String.fromCharCode(...charCodes) AST node that evaluates
 * to the original string at runtime but hides the literal value.
 * Used for require() and dynamic import() arguments.
 *
 *   "fs" → String.fromCharCode(102, 115)
 */
function buildFromCharCode(value: string): ASTNode {
  return {
    type: 'CallExpression',
    callee: {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'String' },
      property: { type: 'Identifier', name: 'fromCharCode' },
      computed: false,
    },
    arguments: Array.from(value).map((ch) => ({
      type: 'NumericLiteral',
      value: ch.charCodeAt(0),
    })),
  };
}

/**
 * Encode a string as a unicode-escaped string literal.
 * Used for static import/export source strings where expressions
 * are not allowed — only literal strings are valid.
 *
 *   "fs" → "\u0066\u0073"
 *
 * JavaScript resolves unicode escapes in string literals identically
 * to the original characters, so module resolution still works.
 */
function unicodeEscape(value: string): string {
  return Array.from(value)
    .map((ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
    .join('');
}

/**
 * Check if the parent is a dynamic import() call.
 */
function isDynamicImport(parent: any): boolean {
  return parent.type === 'CallExpression' && parent.callee?.type === 'Import';
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
      (isRequireCall(parent) || isDynamicImport(parent))
    ) {
      // require() and dynamic import() — replace with String.fromCharCode()
      const charCodeNode = buildFromCharCode(node.value);
      Object.keys(node).forEach((k) => delete node[k]);
      Object.assign(node, charCodeNode);
      return node;
    } else if (
      typeof node.value === 'string' &&
      node.value &&
      isImportSource(parent)
    ) {
      // Static import/export — must stay a string literal, so use unicode escapes
      node.value = unicodeEscape(node.value);
      if (node.raw) node.raw = '"' + unicodeEscape(node.value) + '"';
      if (node.extra) {
        node.extra.rawValue = node.value;
        node.extra.raw = '"' + node.value + '"';
      }
      return node;
    }
    // String hiding is handled by string array extraction (post-transform)
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

  TemplateLiteral(node) {
    // Substitute identifiers in template expressions: `${foo}`
    if (node.expressions) {
      node.expressions.forEach((expr: ASTNode) => substitute(expr));
    }
    return node;
  },

  TaggedTemplateExpression(node) {
    substitute(node.tag);
    return node;
  },

  TemplateElement(node) { return node; },

  ObjectPattern(node) {
    // Substitute value targets in destructuring: var {a: localVar} = obj
    if (node.properties) {
      for (const prop of node.properties) {
        if (prop.type === 'RestElement') {
          substitute(prop.argument);
        } else if (prop.value) {
          substitute(prop.value);
        }
      }
    }
    return node;
  },

  ArrayPattern(node) {
    // Substitute elements in array destructuring: var [a, b] = arr
    if (node.elements) {
      node.elements.forEach((el: ASTNode) => {
        if (el) substitute(el);
      });
    }
    return node;
  },

  AssignmentPattern(node) {
    substitute(node.left);
    substitute(node.right);
    return node;
  },

  ClassDeclaration(node) {
    substitute(node.id);
    substitute(node.superClass);
    return node;
  },

  ClassExpression(node) {
    substitute(node.id);
    substitute(node.superClass);
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
      (isRequireCall(parent) || isDynamicImport(parent))
    ) {
      // require() and dynamic import() — replace with String.fromCharCode()
      const charCodeNode = buildFromCharCode(node.value);
      Object.keys(node).forEach((k) => delete node[k]);
      Object.assign(node, charCodeNode);
      return node;
    } else if (
      typeof node.value === 'string' &&
      node.value &&
      isImportSource(parent)
    ) {
      // Static import/export — use unicode escapes in the string literal
      node.value = unicodeEscape(node.value);
      if (node.extra) {
        node.extra.rawValue = node.value;
        node.extra.raw = '"' + node.value + '"';
      }
      return node;
    }
    // String hiding is handled by string array extraction (post-transform)
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

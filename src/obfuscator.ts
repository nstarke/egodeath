import * as recast from 'recast';
import * as estraverse from 'estraverse';
import { ASTNode, PassHandlerMap } from './types';
import { resetGlobals, resetWindowProps } from './globals';
import { buildConsoleKeywords } from './keywords';
import { firstPassHandlers } from './passes/firstPass';
import { secondPassHandlers } from './passes/secondPass';
import { thirdPassHandlers } from './passes/thirdPass';

/**
 * Extended visitor keys for modern AST node types that estraverse
 * doesn't know about natively. Without these, estraverse skips
 * traversal into these nodes.
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

  // Babel-specific node types (babel parser uses these instead of ESTree equivalents)
  ObjectProperty: ['key', 'value'],
  ObjectMethod: ['key', 'params', 'body'],
  StringLiteral: [],
  NumericLiteral: [],
  BooleanLiteral: [],
  NullLiteral: [],
  RegExpLiteral: [],
};

function runPass(ast: any, handlers: PassHandlerMap): void {
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any, parent: any) {
      if (!handlers[node.type]) return;
      handlers[node.type](node, parent);
    },
    fallback: 'iteration',
  } as any);
}

/**
 * Obfuscate JavaScript source code.
 *
 * @param code - The JavaScript source code to obfuscate
 * @returns The obfuscated JavaScript code
 */
export function obfuscate(code: string): string {
  // Reset global state for each run
  resetGlobals();
  resetWindowProps();

  // Strip shebang line if present — parsers can't handle it
  let shebang = '';
  if (code.startsWith('#!')) {
    const newlineIdx = code.indexOf('\n');
    shebang = code.slice(0, newlineIdx + 1);
    code = code.slice(newlineIdx + 1);
  }

  const ast = recast.parse(code, {
    parser: require('recast/parsers/babel'),
  });

  // First Pass: catalog identifiers
  runPass(ast, firstPassHandlers);

  // Second Pass: substitute identifiers and encode strings
  runPass(ast, secondPassHandlers);

  // Third Pass: inject dummy parameters and strip comments
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any, parent: any) {
      if (node.comments) delete node.comments;
      if (!thirdPassHandlers[node.type]) return;
      thirdPassHandlers[node.type](node, parent);
    },
    fallback: 'iteration',
  } as any);

  // Prepend console stubs
  const consoleKeywords = buildConsoleKeywords();
  ast.program.body = consoleKeywords.concat(ast.program.body);

  return shebang + recast.print(ast).code;
}

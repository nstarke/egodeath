import * as estraverse from 'estraverse';
import { captureGlobal } from '../capturedGlobals';

/**
 * Regex Encoding Transform
 *
 * Converts RegExp literals (/pattern/flags) into new RegExp(pattern, flags)
 * constructor calls. The pattern and flags become StringLiteral nodes that
 * are then picked up by string array extraction, XOR+hex encoded, and
 * hidden in the chained encrypted string array.
 *
 * Before: /^[A-Z]\d+$/i
 * After:  new RegExp("^[A-Z]\\d+$", "i")
 *
 * The StringLiterals then flow through the normal pipeline:
 *   → string array extraction
 *   → chained XOR encoding
 *   → sparse position-dependent errors
 *   → accessor function calls
 *
 * Result: new RegExp(accessor(N), accessor(M))
 * where both N and M decode from the encrypted array.
 */

const VISITOR_KEYS: { [key: string]: string[] } = {
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
  StringLiteral: [],
  NumericLiteral: [],
  BooleanLiteral: [],
  NullLiteral: [],
  RegExpLiteral: [],
  ClassMethod: ['key', 'params', 'body'],
  ClassProperty: ['key', 'value'],
};

/**
 * Convert all RegExp literals to new RegExp(pattern, flags) calls.
 * The pattern and flags strings then flow through string array extraction.
 *
 * `RegExp` is referenced as a free identifier in the generated
 * NewExpression. In code that locally shadows the global — notably
 * lodash's runInContext does `var RegExp = context.RegExp` — `var`
 * hoisting puts the local binding in scope at the top of the function,
 * so any injected `new RegExp(...)` that runs before the assignment
 * sees `undefined` → `TypeError: RegExp is not a constructor`. Capture
 * the global once at program level and reference that capture instead
 * when there are regex literals to rewrite.
 */
export function applyRegexEncoding(ast: any): void {
  const replacements: { node: any; replacement: any }[] = [];

  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any) {
      if (node.type !== 'RegExpLiteral') return;
      replacements.push({ node, replacement: null });
    },
    fallback: 'iteration',
  } as any);

  if (replacements.length === 0) return;

  // Reference a program-level capture of `RegExp` to survive local
  // shadowing (e.g. lodash runInContext's `var RegExp = context.RegExp`).
  // captureGlobal injects the `var X = RegExp;` declaration into
  // ast.program.body on first request.
  const regexpCaptureName = captureGlobal(ast, 'RegExp');

  for (const entry of replacements) {
    const node = entry.node;
    const pattern = node.pattern;
    const flags = node.flags || '';
    const args: any[] = [{ type: 'StringLiteral', value: pattern }];
    if (flags) args.push({ type: 'StringLiteral', value: flags });
    entry.replacement = {
      type: 'NewExpression',
      callee: { type: 'Identifier', name: regexpCaptureName },
      arguments: args,
    };
  }

  // Apply replacements by morphing nodes in-place
  for (const { node, replacement } of replacements) {
    Object.keys(node).forEach((k) => delete node[k]);
    Object.assign(node, replacement);
  }
}

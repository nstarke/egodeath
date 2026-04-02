import * as recast from 'recast';
import * as estraverse from 'estraverse';
import { gen } from '../random';

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

// ---- Exclusions ----

/**
 * Callee identifiers that must never be proxied.
 */
const EXCLUDED_CALLEES = new Set([
  'require',
  'eval',
  'super',
  // Proxy names are set dynamically — see applyProxyFunctions
]);

/**
 * Should this CallExpression be proxied?
 */
function shouldProxy(
  node: any,
  parent: any,
  fcName: string,
  mcName: string,
): boolean {
  const callee = node.callee;

  // Never proxy calls that are already our proxies
  if (callee.type === 'Identifier' && (callee.name === fcName || callee.name === mcName)) {
    return false;
  }

  // Never proxy excluded builtins
  if (callee.type === 'Identifier' && EXCLUDED_CALLEES.has(callee.name)) {
    return false;
  }

  // Never proxy import() — it's a special form, not a real function
  if (callee.type === 'Import') return false;

  // Skip super calls
  if (callee.type === 'Super') return false;

  // Skip tagged template expressions (they have a special calling convention)
  if (parent.type === 'TaggedTemplateExpression') return false;

  // Skip calls with spread arguments — apply doesn't handle them the same way
  if (node.arguments.some((arg: any) => arg.type === 'SpreadElement')) return false;

  return true;
}

// ---- AST helpers ----

function id(name: string): any {
  return { type: 'Identifier', name };
}

function buildProxyDecl(name: string, code: string): any {
  const ast = recast.parse(`var ${name} = ${code}`, {
    parser: require('recast/parsers/babel'),
  });
  return ast.program.body[0];
}

// ---- Core transform ----

/**
 * Apply proxy function wrapping to all eligible call expressions.
 *
 * Simple calls:  foo(x, y)       → _fc(foo, x, y)
 * Method calls:  obj.method(x)   → _mc(obj, "method", x)
 * Computed:      obj[expr](x)    → _mc(obj, expr, x)
 *
 * Two dispatcher functions are prepended to the program:
 *
 *   _fc: function() {
 *     var fn = arguments[0];
 *     var a = [];
 *     for (var i = 1; i < arguments.length; i++) a.push(arguments[i]);
 *     return fn.apply(void 0, a);
 *   }
 *
 *   _mc: function() {
 *     var o = arguments[0];
 *     var p = arguments[1];
 *     var a = [];
 *     for (var i = 2; i < arguments.length; i++) a.push(arguments[i]);
 *     return o[p].apply(o, a);
 *   }
 *
 * Runs before identifier passes so proxy names get obfuscated.
 */
export function applyProxyFunctions(ast: any): void {
  const fcName = gen();
  const mcName = gen();

  // Build proxy function declarations
  const fcDecl = buildProxyDecl(fcName, `function() {
    var fn = arguments[0];
    var a = [];
    for (var i = 1; i < arguments.length; i++) a.push(arguments[i]);
    return fn.apply(void 0, a);
  };`);

  const mcDecl = buildProxyDecl(mcName, `function() {
    var o = arguments[0];
    var p = arguments[1];
    var a = [];
    for (var i = 2; i < arguments.length; i++) a.push(arguments[i]);
    return o[p].apply(o, a);
  };`);

  // Collect replacements
  const replacements: { node: any; newCallee: any; newArgs: any[] }[] = [];

  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any, parent: any) {
      if (node.type !== 'CallExpression') return;
      if (!shouldProxy(node, parent, fcName, mcName)) return;

      const callee = node.callee;

      if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
        // Method call: obj.method(x) → _mc(obj, "method", x)
        //              obj[expr](x)  → _mc(obj, expr, x)
        const obj = callee.object;
        let prop: any;

        if (callee.computed) {
          // Already computed: obj[expr] — pass expr directly
          prop = callee.property;
        } else {
          // Dot notation: obj.method — convert property name to string
          const propName = callee.property.name || callee.property.value;
          if (!propName) return; // safety
          prop = { type: 'StringLiteral', value: propName };
        }

        replacements.push({
          node,
          newCallee: id(mcName),
          newArgs: [obj, prop, ...node.arguments],
        });

      } else {
        // Simple call: foo(x) → _fc(foo, x)
        replacements.push({
          node,
          newCallee: id(fcName),
          newArgs: [callee, ...node.arguments],
        });
      }
    },
    fallback: 'iteration',
  } as any);

  if (replacements.length === 0) return;

  // Apply replacements
  for (const { node, newCallee, newArgs } of replacements) {
    node.callee = newCallee;
    node.arguments = newArgs;
  }

  // Prepend proxy function declarations
  ast.program.body = [fcDecl, mcDecl, ...ast.program.body];
}

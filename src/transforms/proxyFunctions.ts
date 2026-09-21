import { VISITOR_KEYS } from '../visitorKeys';
import * as recast from 'recast';
import * as estraverse from 'estraverse';
import { gen } from '../random';

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

  // Optional chains have their own short-circuiting and receiver rules.
  if (node.optional || callee.type === 'OptionalMemberExpression' ||
      callee.type === 'ChainExpression') return false;

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

  // Skip super method/property calls: `super.m(x)` would become
  // `methodProxy(super, "m", x)`, putting bare `super` in an argument
  // position — a hard SyntaxError ("'super' can only be used with
  // function calls or in property accesses"). `super` is only legal as
  // `super()` or `super.prop`/`super[prop]`, never standalone.
  if ((callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression')
      && callee.object && callee.object.type === 'Super') {
    return false;
  }

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
 * Method calls:  obj.method(x)   → _mc(obj, "method")(x)
 * Computed:      obj[expr](x)    → _mc(obj, expr)(x)
 *
 * The method dispatcher resolves the target and returns an invocation closure.
 * Lookup errors precede argument evaluation; non-callable targets throw only
 * when the closure is invoked, after source arguments have been evaluated.
 *
 * Runs before identifier passes so proxy names get obfuscated.
 */
export function applyProxyFunctions(ast: any): void {
  const fcName = gen();
  const mcName = gen();

  // Build proxy function declarations.
  // Use built-in apply so target functions may safely have an own .apply.
  // Each method resolver captures the target and apply for its invocation.
  const fcDecl = buildProxyDecl(fcName, `function() {
    var _apply = Function.prototype.apply;
    var fn = arguments[0];
    var a = [];
    for (var i = 1; i < arguments.length; i++) a.push(arguments[i]);
    return _apply.call(fn, void 0, a);
  };`);

  const mcDecl = buildProxyDecl(mcName, `function() {
    var _apply = Function.prototype.apply;
    var o = arguments[0];
    var p = arguments[1];
    var m = o[p];
    return function() {
      return _apply.call(m, o, arguments);
    };
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
        // Resolve the receiver/property before evaluating call arguments.
        // The returned closure invokes that exact target with its receiver;
        // apply also throws for non-callables, after arguments have run.
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
          newCallee: {
            type: 'CallExpression', callee: id(mcName), arguments: [obj, prop],
          },
          newArgs: node.arguments,
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

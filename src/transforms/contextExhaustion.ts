import { randInt, pick } from '../transformHelpers';
import { VISITOR_KEYS } from '../visitorKeys';
import * as estraverse from 'estraverse';
import { gen } from '../random';

// ---- AST builders ----

function id(name: string): any { return { type: 'Identifier', name }; }
function num(value: number): any { return { type: 'NumericLiteral', value }; }
function str(value: string): any { return { type: 'StringLiteral', value: value }; }
function bool(value: boolean): any { return { type: 'BooleanLiteral', value }; }
function nul(): any { return { type: 'NullLiteral' }; }

function bin(op: string, left: any, right: any): any {
  return { type: 'BinaryExpression', operator: op, left, right };
}

function unary(op: string, argument: any): any {
  return { type: 'UnaryExpression', operator: op, argument, prefix: true };
}

function paren(expr: any): any {
  expr.extra = expr.extra || {};
  expr.extra.parenthesized = true;
  return expr;
}

function cond(test: any, consequent: any, alternate: any): any {
  return { type: 'ConditionalExpression', test, consequent, alternate };
}

function seq(...exprs: any[]): any {
  return { type: 'SequenceExpression', expressions: exprs };
}

function voidExpr(arg: any): any {
  return unary('void', arg);
}

// ---- Opaque true/false generators (lightweight, no Math.random dependency) ----

function opaqueTrue(): any {
  return pick([
    // typeof undefined === "undefined"
    bin('===', unary('typeof', id('undefined')),
      str('undefined')),
    // !0
    unary('!', num(0)),
    // !!1
    unary('!', unary('!', num(1))),
    // !""
    unary('!', str('')),
    // !null
    unary('!', nul()),
    // [] == false  → nah, that's truthy. Use !![]
    unary('!', unary('!', { type: 'ArrayExpression', elements: [] })),
  ]);
}

function opaqueFalse(): any {
  return pick([
    // !1
    unary('!', num(1)),
    // !!0
    unary('!', unary('!', num(0))),
    // ![]  → false
    unary('!', { type: 'ArrayExpression', elements: [] }),
    // !!""
    unary('!', unary('!', str(''))),
    // !!null
    unary('!', unary('!', nul())),
    // void 0 === undefined is true, so !== gives false...
    // simpler: just !1
    unary('!', num(1)),
  ]);
}

// ---- Bloat expression generators ----
// Each wraps an expression in verbose but semantically transparent noise.

type BloatWrapper = (expr: any) => any;

/**
 * Wrap in nested ternaries that always resolve to the original value:
 *   expr → (true ? (false ? junk : (true ? expr : junk)) : junk)
 * Depth is 2-4 levels.
 */
const nestedTernary: BloatWrapper = (expr) => {
  const depth = randInt(2, 4);
  let result = expr;

  for (let i = 0; i < depth; i++) {
    const junk = pick([num(randInt(0, 999)), str(gen()), nul(), bool(false)]);
    if (randInt(0, 1) === 0) {
      // true ? result : junk
      result = cond(opaqueTrue(), result, junk);
    } else {
      // false ? junk : result
      result = cond(opaqueFalse(), junk, result);
    }
  }

  return paren(result);
};

/**
 * Void-chain prefix: prepend void expressions via comma operator:
 *   expr → (void 0, void 0, void "x", expr)
 */
const voidChain: BloatWrapper = (expr) => {
  const count = randInt(2, 5);
  const voids: any[] = [];
  for (let i = 0; i < count; i++) {
    voids.push(voidExpr(
      pick([num(randInt(0, 99)), str(gen()), nul(), bool(false), num(0)])
    ));
  }
  return paren(seq(...voids, expr));
};

/**
 * Conditional void noise:
 *   expr → (true ? expr : (void 0, void 0, null))
 *   Wraps the junk side in useless void expressions to add volume.
 */
const conditionalVoidNoise: BloatWrapper = (expr) => {
  const noiseCount = randInt(3, 6);
  const noiseExprs: any[] = [];
  for (let i = 0; i < noiseCount; i++) {
    noiseExprs.push(voidExpr(pick([num(randInt(0, 255)), str(gen()), nul()])));
  }
  noiseExprs.push(nul());
  const junk = paren(seq(...noiseExprs));

  if (randInt(0, 1) === 0) {
    return paren(cond(opaqueTrue(), expr, junk));
  }
  return paren(cond(opaqueFalse(), junk, expr));
};

const WRAPPERS: BloatWrapper[] = [
  nestedTernary,
  voidChain,
  conditionalVoidNoise,
  nestedTernary,   // double weight — most effective for volume
  voidChain,       // double weight — safe and verbose
];

// ---- Main transform ----

/**
 * Apply context window exhaustion to the AST.
 *
 * Wrap expression statements in nested ternaries and void-expression noise
 * within function bodies and the program body.
 *
 * All generated code uses fresh variable names (via gen()) that will be
 * further obfuscated by subsequent identifier passes.
 */
export function applyContextExhaustion(ast: any, budget?: any): void {
  const wrapProb = budget ? Math.round(budget.contextExhaustionProb * 100) : 35;

  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any) {
      const isFn =
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'ObjectMethod';

      if (isFn && node.body && node.body.type === 'BlockStatement') {
        bloatBlock(node.body, wrapProb);
      }
    },
    fallback: 'iteration',
  } as any);

  // Also bloat the program body
  if (ast.program.body.length >= 2) {
    bloatBlock(ast.program, wrapProb);
  }
}

function bloatBlock(block: any, wrapProb: number): void {
  const stmts: any[] = block.body;
  if (stmts.length < 2) return;

  const newBody: any[] = [];

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];

    // Wrap expression statements in verbose noise (probability from budget)
    if (stmt.type === 'ExpressionStatement' && wrapProb > 0 && randInt(1, 100) <= wrapProb) {
      const wrapper = pick(WRAPPERS);
      newBody.push({
        ...stmt,
        expression: wrapper(stmt.expression),
      });
      continue;
    }

    newBody.push(stmt);
  }

  block.body = newBody;
}

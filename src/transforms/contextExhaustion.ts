import * as crypto from 'crypto';
import * as estraverse from 'estraverse';
import { gen } from '../random';

// ---- Helpers ----

function randInt(min: number, max: number): number {
  return min + (crypto.randomBytes(4).readUInt32BE(0) % (max - min + 1));
}

function pick<T>(arr: T[]): T {
  return arr[crypto.randomBytes(4).readUInt32BE(0) % arr.length];
}

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

function iife(params: string[], body: any[], args: any[]): any {
  return {
    type: 'CallExpression',
    callee: paren({
      type: 'FunctionExpression',
      id: null,
      params: params.map(p => id(p)),
      body: { type: 'BlockStatement', body },
    }),
    arguments: args,
  };
}

function varDecl(name: string, init: any): any {
  return {
    type: 'VariableDeclaration',
    kind: 'var',
    declarations: [{ type: 'VariableDeclarator', id: id(name), init }],
  };
}

function ret(arg: any): any {
  return { type: 'ReturnStatement', argument: arg };
}

function exprStmt(expr: any): any {
  return { type: 'ExpressionStatement', expression: expr };
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
 * Wrap in an IIFE with junk parameters:
 *   expr → (function(_v, j1, j2, j3) { return _v; })(expr, null, 0, "")
 */
const iifeWrap: BloatWrapper = (expr) => {
  const paramName = gen();
  const junkParams = Array.from({ length: randInt(2, 5) }, () => gen());
  const junkArgs: any[] = junkParams.map(() =>
    pick([num(randInt(0, 100)), str(gen()), nul(), bool(false), num(0)])
  );

  return iife(
    [paramName, ...junkParams],
    [ret(id(paramName))],
    [expr, ...junkArgs],
  );
};

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
 * Nested identity closures:
 *   expr → (function(a){return a})(  (function(b){return b})(expr)  )
 */
const nestedIdentity: BloatWrapper = (expr) => {
  const depth = randInt(2, 4);
  let result = expr;
  for (let i = 0; i < depth; i++) {
    const p = gen();
    result = iife([p], [ret(id(p))], [result]);
  }
  return result;
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

/**
 * typeof guard wrap:
 *   expr → (typeof expr !== "undefined" ? expr : expr)
 *   Both branches return expr, but it looks like a safety check.
 *   Only works for identifier expressions.
 */
const typeofGuard: BloatWrapper = (expr) => {
  return paren(cond(
    bin('!==', unary('typeof', expr), str('undefined')),
    expr,
    expr,
  ));
};

const WRAPPERS: BloatWrapper[] = [
  nestedTernary,
  voidChain,
  conditionalVoidNoise,
  nestedTernary,   // double weight — most effective for volume
  voidChain,       // double weight — safe and verbose
];

// ---- Statement-level bloat generators ----
// These inject entirely new statements between existing ones.

/**
 * Generate a junk self-referencing closure that computes nothing useful.
 * Returns a var declaration + invocation as statements.
 */
function junkClosure(): any[] {
  const fnName = gen();
  const param = gen();
  const local1 = gen();
  const local2 = gen();
  const depth = randInt(1, 3);

  let body: any[] = [
    varDecl(local1, bin('+', id(param), num(randInt(1, 50)))),
    varDecl(local2, bin('*', id(local1), num(randInt(2, 7)))),
  ];

  // Add nested loops / conditionals for volume
  for (let i = 0; i < depth; i++) {
    const tmp = gen();
    body.push(
      varDecl(tmp, bin('^', id(local2), num(randInt(1, 255)))),
      exprStmt(bin('+', id(tmp), num(randInt(0, 100)))),
    );
  }

  body.push(ret(id(local2)));

  return [
    varDecl(fnName, {
      type: 'FunctionExpression',
      id: null,
      params: [id(param)],
      body: { type: 'BlockStatement', body },
    }),
    exprStmt({
      type: 'CallExpression',
      callee: id(fnName),
      arguments: [num(randInt(0, 100))],
    }),
  ];
}

/**
 * Generate a redundant variable aliasing chain.
 *   var _a = <junk>; var _b = _a; var _c = _b; void _c;
 */
function aliasingChain(): any[] {
  const length = randInt(3, 6);
  const names: string[] = [];
  const stmts: any[] = [];

  for (let i = 0; i < length; i++) {
    const name = gen();
    names.push(name);
    if (i === 0) {
      stmts.push(varDecl(name, bin('+', num(randInt(0, 100)), num(randInt(0, 100)))));
    } else {
      stmts.push(varDecl(name, id(names[i - 1])));
    }
  }

  // End with a void to "use" the last variable
  stmts.push(exprStmt(voidExpr(id(names[names.length - 1]))));
  return stmts;
}

/**
 * Generate a do-nothing for loop that wastes tokens.
 */
function junkLoop(): any[] {
  const counter = gen();
  const acc = gen();
  const limit = randInt(2, 8);

  return [
    varDecl(acc, num(0)),
    {
      type: 'ForStatement',
      init: varDecl(counter, num(0)),
      test: bin('<', id(counter), num(limit)),
      update: { type: 'UpdateExpression', operator: '++', argument: id(counter), prefix: false },
      body: {
        type: 'BlockStatement',
        body: [
          exprStmt({
            type: 'AssignmentExpression',
            operator: '+=',
            left: id(acc),
            right: bin('^', id(counter), num(randInt(1, 100))),
          }),
        ],
      },
    },
    exprStmt(voidExpr(id(acc))),
  ];
}

const STMT_BLOATERS: (() => any[])[] = [
  junkClosure,
  aliasingChain,
  junkLoop,
];

// ---- Visitor keys ----

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

// ---- Main transform ----

/**
 * Apply context window exhaustion to the AST.
 *
 * Two strategies applied to function bodies and program body:
 *
 * 1. **Expression bloating**: Existing expression statements have their
 *    expressions wrapped in verbose but semantically transparent constructs
 *    (IIFEs, nested ternaries, void chains, identity closures).
 *
 * 2. **Statement injection**: Entirely new junk statements are inserted
 *    between existing ones (self-referencing closures, aliasing chains,
 *    dead loops).
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

import * as crypto from 'crypto';
import * as estraverse from 'estraverse';
import { gen } from '../random';

// ---- Randomness helpers ----

function randInt(min: number, max: number): number {
  return min + (crypto.randomBytes(4).readUInt32BE(0) % (max - min + 1));
}

function pick<T>(arr: T[]): T {
  return arr[crypto.randomBytes(4).readUInt32BE(0) % arr.length];
}

// ---- AST builder helpers ----

function id(name: string): any {
  return { type: 'Identifier', name };
}

function num(value: number): any {
  return { type: 'NumericLiteral', value };
}

function bin(op: string, left: any, right: any): any {
  return { type: 'BinaryExpression', operator: op, left, right };
}

function unary(op: string, argument: any): any {
  return { type: 'UnaryExpression', operator: op, argument, prefix: true };
}

function call(callee: any, args: any[]): any {
  return { type: 'CallExpression', callee, arguments: args };
}

function member(obj: any, prop: any): any {
  return { type: 'MemberExpression', object: obj, property: prop, computed: false };
}

function paren(expr: any): any {
  // Recast / babel represent parentheses via extra.parenthesized
  expr.extra = expr.extra || {};
  expr.extra.parenthesized = true;
  return expr;
}

function assign(name: string, value: any): any {
  return {
    type: 'ExpressionStatement',
    expression: {
      type: 'AssignmentExpression',
      operator: '=',
      left: id(name),
      right: value,
    },
  };
}

// ---- Predicate generators ----
// Each returns { expr, alwaysTrue } where expr is an AST node that
// evaluates to a boolean. The generators use a probe variable that
// gets assigned a random value at runtime so static analysis can't
// constant-fold the predicate away.

type PredicateFactory = (probeVar: string) => { expr: any; alwaysTrue: boolean };

/**
 * (x * x + x) % 2 === 0  — always true
 * Proof: x(x+1) is the product of consecutive integers, always even.
 */
const quadraticEven: PredicateFactory = (v) => ({
  alwaysTrue: true,
  expr: bin('===',
    bin('%',
      paren(bin('+', bin('*', id(v), id(v)), id(v))),
      num(2)),
    num(0)),
});

/**
 * (x * x + x) % 2 !== 0  — always false
 */
const quadraticEvenNeg: PredicateFactory = (v) => ({
  alwaysTrue: false,
  expr: bin('!==',
    bin('%',
      paren(bin('+', bin('*', id(v), id(v)), id(v))),
      num(2)),
    num(0)),
});

/**
 * (x | 0) === x  — always true for integers (which Math.random()*N|0 always is)
 */
const bitwiseOr0: PredicateFactory = (v) => ({
  alwaysTrue: true,
  expr: bin('===', paren(bin('|', id(v), num(0))), id(v)),
});

/**
 * (x ^ x) === 0  — always true for any value
 */
const xorSelf: PredicateFactory = (v) => ({
  alwaysTrue: true,
  expr: bin('===', paren(bin('^', id(v), id(v))), num(0)),
});

/**
 * (x ^ x) !== 0  — always false
 */
const xorSelfNeg: PredicateFactory = (v) => ({
  alwaysTrue: false,
  expr: bin('!==', paren(bin('^', id(v), id(v))), num(0)),
});

/**
 * ((x * (x + 1) * (x + 2)) % 6) === 0  — always true
 * Product of 3 consecutive integers is always divisible by 6.
 */
const tripleConsecutive: PredicateFactory = (v) => ({
  alwaysTrue: true,
  expr: bin('===',
    bin('%',
      paren(bin('*',
        bin('*', id(v), paren(bin('+', id(v), num(1)))),
        paren(bin('+', id(v), num(2))))),
      num(6)),
    num(0)),
});

/**
 * ((x * (x + 1) * (x + 2)) % 6) !== 0  — always false
 */
const tripleConsecutiveNeg: PredicateFactory = (v) => ({
  alwaysTrue: false,
  expr: bin('!==',
    bin('%',
      paren(bin('*',
        bin('*', id(v), paren(bin('+', id(v), num(1)))),
        paren(bin('+', id(v), num(2))))),
      num(6)),
    num(0)),
});

/**
 * ((x & 1) + ((x >> 1) & 1)) >= 0  — always true (sum of bits is non-negative)
 */
const bitSumNonNeg: PredicateFactory = (v) => ({
  alwaysTrue: true,
  expr: bin('>=',
    paren(bin('+',
      paren(bin('&', id(v), num(1))),
      paren(bin('&', paren(bin('>>', id(v), num(1))), num(1))))),
    num(0)),
});

/**
 * (x * x) >= 0  — always true (square is non-negative for int32 values
 * in the range we generate). We clamp to small values to avoid overflow.
 */
const squareNonNeg: PredicateFactory = (v) => ({
  alwaysTrue: true,
  expr: bin('>=', paren(bin('*', id(v), id(v))), num(0)),
});

/**
 * (x * x) < 0  — always false
 */
const squareNeg: PredicateFactory = (v) => ({
  alwaysTrue: false,
  expr: bin('<', paren(bin('*', id(v), id(v))), num(0)),
});

/**
 * ((x % k) + k) % k === x % k — always true when x >= 0.
 * This is the "safe modulo" identity. We use it with a random k.
 */
const safeModulo: PredicateFactory = (v) => {
  const k = randInt(2, 13);
  return {
    alwaysTrue: true,
    expr: bin('===',
      bin('%', paren(bin('+', paren(bin('%', id(v), num(k))), num(k))), num(k)),
      bin('%', id(v), num(k))),
  };
};

/**
 * typeof x === "number"  — always true since we assign a number
 */
const typeofNumber: PredicateFactory = (v) => ({
  alwaysTrue: true,
  expr: bin('===',
    unary('typeof', id(v)),
    { type: 'StringLiteral', value: 'number' }),
});

/**
 * typeof x === "string"  — always false since we assign a number
 */
const typeofString: PredicateFactory = (v) => ({
  alwaysTrue: false,
  expr: bin('===',
    unary('typeof', id(v)),
    { type: 'StringLiteral', value: 'string' }),
});

/**
 * ((x | -1) === -1)  — always true (x | 0xFFFFFFFF is always -1 in int32)
 */
const orAllOnes: PredicateFactory = (v) => ({
  alwaysTrue: true,
  expr: bin('===', paren(bin('|', id(v), num(-1))), num(-1)),
});

/**
 * (~~x === x)  — always true for integers (double bitwise NOT is identity for int32)
 */
const doubleNot: PredicateFactory = (v) => ({
  alwaysTrue: true,
  expr: bin('===', unary('~', unary('~', id(v))), id(v)),
});

// ---- Registry ----

const ALWAYS_TRUE_PREDICATES: PredicateFactory[] = [
  quadraticEven,
  bitwiseOr0,
  xorSelf,
  tripleConsecutive,
  bitSumNonNeg,
  squareNonNeg,
  safeModulo,
  typeofNumber,
  orAllOnes,
  doubleNot,
];

const ALWAYS_FALSE_PREDICATES: PredicateFactory[] = [
  quadraticEvenNeg,
  xorSelfNeg,
  tripleConsecutiveNeg,
  squareNeg,
  typeofString,
];

// ---- Public API ----

export interface OpaquePredicate {
  /** The boolean expression AST node */
  expr: any;
  /** Whether the predicate always evaluates to true */
  alwaysTrue: boolean;
  /** The probe variable name (needs to be declared and initialized) */
  probeVar: string;
  /**
   * Statement that initializes the probe variable to a random integer.
   * Must be inserted before the predicate is used.
   */
  probeInit: any;
}

/**
 * Generate a random opaque predicate.
 * @param wantTrue  If specified, force true or false predicate.
 */
export function generatePredicate(wantTrue?: boolean): OpaquePredicate {
  const probeVar = gen();
  const pool = wantTrue === true
    ? ALWAYS_TRUE_PREDICATES
    : wantTrue === false
      ? ALWAYS_FALSE_PREDICATES
      : [...ALWAYS_TRUE_PREDICATES, ...ALWAYS_FALSE_PREDICATES];

  const factory = pick(pool);
  const { expr, alwaysTrue } = factory(probeVar);

  // Probe init: var <probeVar> = (Math.random() * <k> | 0);
  // This produces a random non-negative integer that static analysis can't predict.
  const k = randInt(50, 500);
  const probeInit: any = {
    type: 'VariableDeclaration',
    kind: 'var',
    declarations: [{
      type: 'VariableDeclarator',
      id: id(probeVar),
      init: paren(bin('|',
        bin('*', call(member(id('Math'), id('random')), []), num(k)),
        num(0))),
    }],
  };

  return { expr, alwaysTrue, probeVar, probeInit };
}

// ---- AST injection ----

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
};

/**
 * Generate a plausible-looking dead code block.
 * These should look real enough that an analyzer can't trivially dismiss them.
 */
function generateDeadCode(): any[] {
  const v1 = gen();
  const v2 = gen();
  const k1 = randInt(1, 100);
  const k2 = randInt(1, 100);

  const patterns: (() => any[])[] = [
    // var x = <k>; var y = x + <k2>; return y;
    () => [
      { type: 'VariableDeclaration', kind: 'var', declarations: [
        { type: 'VariableDeclarator', id: id(v1), init: num(k1) },
      ]},
      { type: 'VariableDeclaration', kind: 'var', declarations: [
        { type: 'VariableDeclarator', id: id(v2), init: bin('+', id(v1), num(k2)) },
      ]},
      { type: 'ReturnStatement', argument: id(v2) },
    ],
    // throw new Error(<string>);
    () => [
      { type: 'ThrowStatement', argument: {
        type: 'NewExpression',
        callee: id('Error'),
        arguments: [{ type: 'StringLiteral', value: gen() }],
      }},
    ],
    // var x = []; x.push(<k>); return x;
    () => [
      { type: 'VariableDeclaration', kind: 'var', declarations: [
        { type: 'VariableDeclarator', id: id(v1), init: { type: 'ArrayExpression', elements: [] } },
      ]},
      { type: 'ExpressionStatement', expression: call(
        member(id(v1), id('push')), [num(k1)]
      )},
      { type: 'ReturnStatement', argument: id(v1) },
    ],
    // var x = <k1> * <k2>; if (x > 0) { return x; }
    () => [
      { type: 'VariableDeclaration', kind: 'var', declarations: [
        { type: 'VariableDeclarator', id: id(v1), init: bin('*', num(k1), num(k2)) },
      ]},
      { type: 'IfStatement',
        test: bin('>', id(v1), num(0)),
        consequent: { type: 'BlockStatement', body: [
          { type: 'ReturnStatement', argument: id(v1) },
        ]},
        alternate: null,
      },
    ],
  ];

  return pick(patterns)();
}

/**
 * Apply opaque predicates to function bodies in the AST.
 *
 * For each function body with enough statements, we:
 *  1. Wrap some real statements in always-true if blocks
 *  2. Inject dead code behind always-false if blocks
 *  3. Insert the probe variable init at the top of the function
 */
export function applyOpaquePredicates(ast: any): void {
  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any) {
      const isFn =
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'ObjectMethod';

      if (isFn && node.body && node.body.type === 'BlockStatement') {
        injectPredicates(node.body);
      }
    },
    fallback: 'iteration',
  } as any);
}

function injectPredicates(body: any): void {
  const stmts: any[] = body.body;
  if (stmts.length < 2) return;

  const newBody: any[] = [];
  const probeInits: any[] = [];

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];

    // Skip declarations, returns, imports/exports — don't wrap these
    const skip =
      stmt.type === 'VariableDeclaration' ||
      stmt.type === 'ReturnStatement' ||
      stmt.type === 'ThrowStatement' ||
      stmt.type === 'ImportDeclaration' ||
      stmt.type === 'ExportNamedDeclaration' ||
      stmt.type === 'ExportDefaultDeclaration' ||
      stmt.type === 'ExportAllDeclaration';

    if (skip) {
      newBody.push(stmt);
      continue;
    }

    // ~30% chance: wrap statement in always-true predicate
    if (randInt(1, 10) <= 3) {
      const pred = generatePredicate(true);
      probeInits.push(pred.probeInit);
      newBody.push({
        type: 'IfStatement',
        test: pred.expr,
        consequent: { type: 'BlockStatement', body: [stmt] },
        alternate: {
          type: 'BlockStatement',
          body: generateDeadCode(),
        },
      });
      continue;
    }

    // ~20% chance: inject dead code block before this statement
    if (randInt(1, 10) <= 2) {
      const pred = generatePredicate(false);
      probeInits.push(pred.probeInit);
      newBody.push({
        type: 'IfStatement',
        test: pred.expr,
        consequent: { type: 'BlockStatement', body: generateDeadCode() },
        alternate: null,
      });
    }

    newBody.push(stmt);
  }

  // Insert probe inits at the top of the function body
  body.body = [...probeInits, ...newBody];
}

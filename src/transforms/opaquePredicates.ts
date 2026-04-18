import * as crypto from 'crypto';
import * as estraverse from 'estraverse';
import { gen } from '../random';
import { generateDeadCode as generateDeadCodeBlock, collectScopeVars } from './deadCodeInjection';

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

// Dead code generation is now delegated to deadCodeInjection.ts

/**
 * Apply opaque predicates to function bodies in the AST.
 *
 * For each function body with enough statements, we:
 *  1. Wrap some real statements in always-true if blocks
 *  2. Inject dead code behind always-false if blocks
 *  3. Insert the probe variable init at the top of the function
 */
export function applyOpaquePredicates(ast: any, budget?: any): void {
  const prob = budget ? budget.opaquePredicateProb : 0.30;
  const deadCodeSize = budget ? Math.min(4, Math.max(1, Math.floor(budget.deadCodeMultiplier / 3))) : 1;

  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any) {
      const isFn =
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'ObjectMethod';

      if (isFn && node.body && node.body.type === 'BlockStatement') {
        injectPredicates(node.body, prob, deadCodeSize);
      }
    },
    fallback: 'iteration',
  } as any);
}

function injectPredicates(body: any, prob: number, deadCodeSize: number = 1): void {
  const stmts: any[] = body.body;
  if (stmts.length < 2) return;

  const scopeVars = collectScopeVars(stmts);
  const newBody: any[] = [];
  const probeInits: any[] = [];

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];

    // Skip declarations, returns, imports/exports — don't wrap these.
    // FunctionDeclaration and ClassDeclaration are especially important:
    // wrapping them in `if {}` makes them block-scoped, which hides the
    // binding from the enclosing scope ("X is not defined" at later uses).
    const skip =
      stmt.type === 'VariableDeclaration' ||
      stmt.type === 'FunctionDeclaration' ||
      stmt.type === 'ClassDeclaration' ||
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

    // Wrap statement in always-true predicate (probability from budget)
    if (prob > 0 && randInt(1, 100) <= Math.round(prob * 100)) {
      const pred = generatePredicate(true);
      probeInits.push(pred.probeInit);
      newBody.push({
        type: 'IfStatement',
        test: pred.expr,
        consequent: { type: 'BlockStatement', body: [stmt] },
        alternate: {
          type: 'BlockStatement',
          // Paper 3: dead code mutated from real statements (structurally identical)
          body: generateDeadCodeBlock(scopeVars, deadCodeSize, stmts),
        },
      });
      continue;
    }

    // Inject dead code block before this statement (lower probability)
    if (prob > 0 && randInt(1, 100) <= Math.round(prob * 70)) {
      const pred = generatePredicate(false);
      probeInits.push(pred.probeInit);
      newBody.push({
        type: 'IfStatement',
        test: pred.expr,
        consequent: { type: 'BlockStatement', body: generateDeadCodeBlock(scopeVars, deadCodeSize, stmts) },
        alternate: null,
      });
    }

    newBody.push(stmt);
  }

  // If the budget allows heavy dead code and CFF didn't run on this body
  // (no WhileStatement with switch inside), inject extra standalone dead
  // code blocks to fill the token budget.
  const hasCFF = newBody.some((s: any) =>
    s.type === 'WhileStatement' && s.body?.body?.[0]?.type === 'SwitchStatement');
  if (!hasCFF && deadCodeSize >= 2) {
    const extraBlocks = Math.min(10, deadCodeSize * 2);
    for (let j = 0; j < extraBlocks; j++) {
      const pred = generatePredicate(false);
      probeInits.push(pred.probeInit);
      // Insert dead code at a random position in the body
      const pos = randInt(0, newBody.length);
      newBody.splice(pos, 0, {
        type: 'IfStatement',
        test: pred.expr,
        consequent: { type: 'BlockStatement', body: generateDeadCodeBlock(scopeVars, deadCodeSize, stmts) },
        alternate: null,
      });
    }
  }

  // Insert probe inits at the top of the function body
  body.body = [...probeInits, ...newBody];
}

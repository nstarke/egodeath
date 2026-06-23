import * as crypto from 'crypto';
import * as estraverse from 'estraverse';
import { gen } from '../random';

/**
 * LPN-Inspired Noise Injection (Paper 7: Jain, Lin, Sahai)
 *
 * Based on the Learning Parity with Noise (LPN) assumption from the
 * breakthrough iO paper. LPN works by adding random errors to linear
 * equations, making them unsolvable without the secret.
 *
 * We apply this principle to numeric computations: inject random noise
 * values that are added and then cancelled out through a complex path.
 * The intermediate values are meaningless without tracing the full
 * cancellation chain, making static analysis of data flow intractable.
 *
 * For each eligible assignment `x = expr`:
 *   1. Generate a random noise value N
 *   2. Compute the result with noise: x = expr + N
 *   3. Cancel the noise through a separate path: x = x - N
 *
 * The noise and cancellation are split across multiple variables and
 * operations so the pairing is not obvious. The noise variable names
 * and cancellation paths are unique per injection.
 */

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

function bin(op: string, left: any, right: any): any {
  return { type: 'BinaryExpression', operator: op, left, right };
}

function paren(expr: any): any {
  expr.extra = expr.extra || {};
  expr.extra.parenthesized = true;
  return expr;
}

function varDecl(name: string, init: any): any {
  return {
    type: 'VariableDeclaration', kind: 'var',
    declarations: [{ type: 'VariableDeclarator', id: id(name), init }],
  };
}

function exprStmt(expr: any): any {
  return { type: 'ExpressionStatement', expression: expr };
}

function assignExpr(left: any, right: any): any {
  return { type: 'AssignmentExpression', operator: '=', left, right };
}

// ---- Noise patterns ----
// Each pattern injects noise and cancels it through a different path.
// The variety ensures no single deobfuscation heuristic removes all noise.

type NoisePattern = (
  targetVar: string,
  originalExpr: any,
) => { setup: any[]; noisyAssign: any; cancellation: any[] };

/**
 * Simple add/subtract noise:
 *   var noise = <random>;
 *   x = (expr) + noise;
 *   x = x - noise;
 *
 * The subtract is separated from the add by being a separate statement.
 */
const addSubNoise: NoisePattern = (targetVar, originalExpr) => {
  const noiseVar = gen();
  const noiseVal = randInt(100, 100000);

  return {
    setup: [varDecl(noiseVar, num(noiseVal))],
    noisyAssign: exprStmt(assignExpr(id(targetVar),
      bin('+', paren(originalExpr), id(noiseVar)))),
    cancellation: [
      exprStmt(assignExpr(id(targetVar),
        bin('-', id(targetVar), id(noiseVar)))),
    ],
  };
};

/**
 * XOR noise (self-cancelling):
 *   var noise = <random>;
 *   x = (expr) ^ noise;
 *   x = x ^ noise;
 *
 * XOR with the same value twice restores the original. Only works
 * for integer expressions (which is fine since JS bitwise ops produce int32).
 */
const xorNoise: NoisePattern = (targetVar, originalExpr) => {
  const noiseVar = gen();
  const noiseVal = randInt(0x100, 0xFFFFFF);

  return {
    setup: [varDecl(noiseVar, num(noiseVal))],
    noisyAssign: exprStmt(assignExpr(id(targetVar),
      bin('^', paren(bin('|', paren(originalExpr), num(0))), id(noiseVar)))),
    cancellation: [
      exprStmt(assignExpr(id(targetVar),
        bin('^', id(targetVar), id(noiseVar)))),
    ],
  };
};

/**
 * Multiply/divide noise:
 *   var noise = <small prime>;
 *   x = (expr) * noise;
 *   x = x / noise;
 *
 * Uses small primes to avoid precision loss in floating point.
 */
const mulDivNoise: NoisePattern = (targetVar, originalExpr) => {
  const noiseVar = gen();
  const noiseVal = pick([3, 7, 11, 13, 17, 19, 23]);

  return {
    setup: [varDecl(noiseVar, num(noiseVal))],
    noisyAssign: exprStmt(assignExpr(id(targetVar),
      bin('*', paren(originalExpr), id(noiseVar)))),
    cancellation: [
      exprStmt(assignExpr(id(targetVar),
        bin('/', id(targetVar), id(noiseVar)))),
    ],
  };
};

/**
 * Split noise across two variables:
 *   var n1 = <random1>;
 *   var n2 = <random2>;
 *   x = (expr) + n1 + n2;
 *   x = x - n2;
 *   x = x - n1;
 *
 * The cancellation is split into two steps with different variables,
 * making it harder to pair the noise injection with its cancellation.
 */
const splitNoise: NoisePattern = (targetVar, originalExpr) => {
  const n1 = gen();
  const n2 = gen();
  const v1 = randInt(100, 50000);
  const v2 = randInt(100, 50000);

  return {
    setup: [varDecl(n1, num(v1)), varDecl(n2, num(v2))],
    noisyAssign: exprStmt(assignExpr(id(targetVar),
      bin('+', bin('+', paren(originalExpr), id(n1)), id(n2)))),
    cancellation: [
      exprStmt(assignExpr(id(targetVar), bin('-', id(targetVar), id(n2)))),
      exprStmt(assignExpr(id(targetVar), bin('-', id(targetVar), id(n1)))),
    ],
  };
};

/**
 * Computed noise (noise derived from a chain of operations):
 *   var seed = <random>;
 *   var noise = ((seed * prime) ^ mask) & 0xFFFF;
 *   x = (expr) + noise;
 *   x = x - noise;
 *
 * The noise value is computed through a chain that looks like a hash,
 * making it harder to determine the noise value statically.
 */
const computedNoise: NoisePattern = (targetVar, originalExpr) => {
  const seedVar = gen();
  const noiseVar = gen();
  const seedVal = randInt(1, 100000);
  const prime = pick([7, 13, 31, 37, 61, 127]);
  const mask = randInt(0x100, 0xFFFF);

  return {
    setup: [
      varDecl(seedVar, num(seedVal)),
      varDecl(noiseVar, bin('&',
        paren(bin('^', paren(bin('*', id(seedVar), num(prime))), num(mask))),
        num(0xFFFF))),
    ],
    noisyAssign: exprStmt(assignExpr(id(targetVar),
      bin('+', paren(originalExpr), id(noiseVar)))),
    cancellation: [
      exprStmt(assignExpr(id(targetVar),
        bin('-', id(targetVar), id(noiseVar)))),
    ],
  };
};

/**
 * Rotate noise (shift-based, integer only):
 *   var noise = <random>;
 *   x = ((expr | 0) + (noise << 16)) | 0;
 *   x = (x - (noise << 16)) | 0;
 *
 * Uses bit shifting to place noise in high bits, then removes it.
 */
const rotateNoise: NoisePattern = (targetVar, originalExpr) => {
  const noiseVar = gen();
  const noiseVal = randInt(1, 0xFF);
  const shift = pick([8, 12, 16]);

  return {
    setup: [varDecl(noiseVar, num(noiseVal))],
    noisyAssign: exprStmt(assignExpr(id(targetVar),
      bin('|',
        paren(bin('+', paren(bin('|', paren(originalExpr), num(0))),
          paren(bin('<<', id(noiseVar), num(shift))))),
        num(0)))),
    cancellation: [
      exprStmt(assignExpr(id(targetVar),
        bin('|',
          paren(bin('-', id(targetVar), paren(bin('<<', id(noiseVar), num(shift))))),
          num(0)))),
    ],
  };
};

const NOISE_PATTERNS: NoisePattern[] = [
  addSubNoise,
  xorNoise,
  mulDivNoise,
  splitNoise,
  computedNoise,
  rotateNoise,
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
 * Apply LPN-inspired noise injection to function bodies.
 *
 * For each function body, scans for simple assignment statements
 * (x = expr where expr involves arithmetic) and ~25% of the time
 * wraps them in a noise-inject-then-cancel pattern.
 *
 * The noise is added to the computation result and then removed
 * through a separate path, so the final value is correct. But
 * intermediate values are meaningless — defeating data-flow analysis
 * that tries to track values through the computation.
 */
export function applyNoiseInjection(ast: any): void {
  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any) {
      const isFn =
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'ObjectMethod';

      if (isFn && node.body && node.body.type === 'BlockStatement') {
        injectNoise(node.body);
      }
    },
    fallback: 'iteration',
  } as any);
}

function injectNoise(block: any): void {
  const stmts: any[] = block.body;
  if (stmts.length < 2) return;

  const newBody: any[] = [];

  for (const stmt of stmts) {
    // Check for expression assignment: x = <arithmetic expr>
    if (isEligibleAssignment(stmt)) {
      if (randInt(1, 100) <= 25) {
        const targetVar = stmt.expression.left.name;
        const originalExpr = stmt.expression.right;
        const pattern = pick(NOISE_PATTERNS) as NoisePattern;
        const { setup, noisyAssign, cancellation } = pattern(targetVar, originalExpr);
        newBody.push(...setup, noisyAssign, ...cancellation);
        continue;
      }
    }

    // Check for var declaration with arithmetic init: var x = <arithmetic expr>
    if (isEligibleVarDecl(stmt)) {
      if (randInt(1, 100) <= 25) {
        const decl = stmt.declarations[0];
        const targetVar = decl.id.name;
        const originalExpr = decl.init;

        // Split into: var x; then noise-inject x = expr
        const varOnly: any = {
          type: 'VariableDeclaration', kind: 'var',
          declarations: [{ type: 'VariableDeclarator', id: id(targetVar), init: null }],
        };
        const pattern = pick(NOISE_PATTERNS) as NoisePattern;
        const { setup, noisyAssign, cancellation } = pattern(targetVar, originalExpr);
        newBody.push(varOnly, ...setup, noisyAssign, ...cancellation);
        continue;
      }
    }

    newBody.push(stmt);
  }

  block.body = newBody;
}

// The noise patterns round-trip a value through arithmetic identities that
// only hold for 32-bit integers (several wrap the value in `(expr | 0)` or XOR
// it, which coerce to int32). Only the bitwise operators are guaranteed to
// produce an int32 result, so those are the only safe expressions to wrap.
//
// Crucially this excludes `+`: it is string concatenation when either operand
// is a string, so wrapping `s = "a" + s` as `(("a" + s) | 0) ^ n` coerces the
// string to 0 and silently corrupts the value (this broke lodash's template
// engine, where `source` is built by string concatenation). `- * / %` are
// excluded too — they coerce to Number but can yield non-integers that the
// `| 0`/XOR patterns would truncate.
const SAFE_NOISE_OPS = ['|', '&', '^', '<<', '>>', '>>>'];

/**
 * Check if a statement is an eligible var declaration for noise injection.
 * Must be: VariableDeclaration with a single declarator where id is
 * an Identifier and init is a bitwise (int32-producing) BinaryExpression.
 */
function isEligibleVarDecl(stmt: any): boolean {
  if (stmt.type !== 'VariableDeclaration') return false;
  if (stmt.declarations.length !== 1) return false;
  const decl = stmt.declarations[0];
  if (decl.id.type !== 'Identifier') return false;
  if (!decl.init || decl.init.type !== 'BinaryExpression') return false;
  return SAFE_NOISE_OPS.includes(decl.init.operator);
}

/**
 * Check if a statement is an eligible assignment for noise injection.
 * Must be: ExpressionStatement with AssignmentExpression where left is an
 * Identifier and right is a bitwise (int32-producing) BinaryExpression.
 */
function isEligibleAssignment(stmt: any): boolean {
  if (stmt.type !== 'ExpressionStatement') return false;
  const expr = stmt.expression;
  if (expr.type !== 'AssignmentExpression') return false;
  if (expr.operator !== '=') return false;
  if (expr.left.type !== 'Identifier') return false;

  const right = expr.right;
  if (right.type === 'BinaryExpression') {
    return SAFE_NOISE_OPS.includes(right.operator);
  }

  return false;
}

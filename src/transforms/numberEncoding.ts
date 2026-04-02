import * as crypto from 'crypto';
import * as estraverse from 'estraverse';

// ---- Helpers ----

function randInt(min: number, max: number): number {
  return min + (crypto.randomBytes(4).readUInt32BE(0) % (max - min + 1));
}

function pick<T>(arr: T[]): T {
  return arr[crypto.randomBytes(4).readUInt32BE(0) % arr.length];
}

// ---- AST builders ----

function num(value: number): any {
  // Use hex representation sometimes for extra obscurity
  if (value > 9 && randInt(0, 1) === 1) {
    return { type: 'NumericLiteral', value, extra: { rawValue: value, raw: '0x' + value.toString(16) } };
  }
  return { type: 'NumericLiteral', value };
}

function bin(op: string, left: any, right: any): any {
  return { type: 'BinaryExpression', operator: op, left, right };
}

function unary(op: string, argument: any, prefix = true): any {
  return { type: 'UnaryExpression', operator: op, argument, prefix };
}

function paren(expr: any): any {
  expr.extra = expr.extra || {};
  expr.extra.parenthesized = true;
  return expr;
}

// ---- Encoding strategies ----
// Each takes a target integer and returns an AST expression that evaluates to it.

type Encoder = (n: number) => any;

/**
 * Double bitwise NOT: ~~n === n for int32.
 * Wraps in an extra operation for complexity.
 *   42 → ~~42  (but 42 itself is encoded via another strategy)
 * We use: ~~(n ^ 0) since (n ^ 0) === n
 */
const doubleNotXor: Encoder = (n) => {
  const mask = randInt(1, 255);
  // ~~((n ^ mask) ^ mask) === n
  return unary('~', unary('~',
    paren(bin('^', paren(bin('^', num(n ^ mask), num(mask))), num(0)))
  ));
};

/**
 * Shift + add/subtract: break n into (base << shift) + remainder
 *   42 → (5 << 3) + 2   (5*8 + 2 = 42)
 */
const shiftAdd: Encoder = (n) => {
  const shift = randInt(1, 4);
  const divisor = 1 << shift;
  const base = Math.floor(n / divisor);
  const remainder = n - (base * divisor);

  if (remainder === 0) {
    return paren(bin('<<', num(base), num(shift)));
  }
  if (remainder > 0) {
    return paren(bin('+', paren(bin('<<', num(base), num(shift))), num(remainder)));
  }
  return paren(bin('-', paren(bin('<<', num(base), num(shift))), num(-remainder)));
};

/**
 * XOR identity: (n ^ key) ^ key === n
 *   42 → (42 ^ 0x37) ^ 0x37
 */
const xorIdentity: Encoder = (n) => {
  const key = randInt(1, 0xFFFF);
  return paren(bin('^', paren(bin('^', num(n), num(key))), num(key)));
};

/**
 * Addition/subtraction with random offset:
 *   42 → (42 + 137) - 137
 */
const addSubOffset: Encoder = (n) => {
  const offset = randInt(50, 500);
  if (randInt(0, 1) === 0) {
    return paren(bin('-', num(n + offset), num(offset)));
  }
  return paren(bin('+', num(n - offset), num(offset)));
};

/**
 * Multiplication + remainder:
 *   42 → 6 * 7 + 0   or   42 → 8 * 5 + 2
 */
const mulAdd: Encoder = (n) => {
  // Pick a random factor between 2 and 13
  const factor = randInt(2, 13);
  const quotient = Math.floor(n / factor);
  const remainder = n - (quotient * factor);

  if (remainder === 0) {
    return paren(bin('*', num(quotient), num(factor)));
  }
  if (remainder > 0) {
    return paren(bin('+', paren(bin('*', num(quotient), num(factor))), num(remainder)));
  }
  return paren(bin('-', paren(bin('*', num(quotient), num(factor))), num(-remainder)));
};

/**
 * Bitwise OR with 0 wrapping another expression:
 *   42 → ((n + k - k) | 0)
 * The |0 ensures int32 and adds visual noise.
 */
const orZeroWrap: Encoder = (n) => {
  const k = randInt(1, 255);
  return paren(bin('|',
    paren(bin('-', paren(bin('+', num(n), num(k))), num(k))),
    num(0)
  ));
};

/**
 * Complement trick: ~n === -(n+1), so n === ~(-(n+1)) === ~(-n-1)
 *   42 → ~(-43)
 */
const complementNeg: Encoder = (n) => {
  return unary('~', paren(unary('-', num(n + 1))));
};

/**
 * Nested shifts: combine left and right shifts
 *   42 → ((42 << 3) >> 3)   — but use a scrambled intermediate
 *   42 → ((n << s) >>> s) where the shift preserves value for small n
 */
const nestedShift: Encoder = (n) => {
  const shift = randInt(1, 4);
  // (n << s) >>> s === n  for 0 <= n < 2^(32-s)
  return paren(bin('>>>', paren(bin('<<', num(n), num(shift))), num(shift)));
};

/**
 * Two-layer: apply two simple operations
 *   42 → (((42 ^ key1) + offset) - offset) ^ key1
 * Simplified: ((n ^ k) - n + n) ^ k  but we use add/xor combo
 */
const twoLayer: Encoder = (n) => {
  const key = randInt(1, 0xFF);
  const scrambled = n ^ key;
  // (scrambled ^ key) === n
  return paren(bin('^', num(scrambled), num(key)));
};

/**
 * Division trick: n === (n * k) / k
 *   42 → (42 * 7) / 7  →  294 / 7
 */
const divisionTrick: Encoder = (n) => {
  const k = pick([2, 3, 5, 7, 11, 13]);
  return paren(bin('/', num(n * k), num(k)));
};

/**
 * Subtraction from larger: n === big - (big - n)
 *   42 → 1000 - 958
 */
const subFromLarger: Encoder = (n) => {
  const big = randInt(Math.abs(n) + 100, Math.abs(n) + 1000);
  return paren(bin('-', num(big), num(big - n)));
};

// ---- Registry ----

const ENCODERS: Encoder[] = [
  doubleNotXor,
  shiftAdd,
  xorIdentity,
  addSubOffset,
  mulAdd,
  orZeroWrap,
  complementNeg,
  nestedShift,
  twoLayer,
  divisionTrick,
  subFromLarger,
];

/**
 * Encode a number using a randomly selected strategy.
 * Can optionally apply two layers of encoding for extra obscurity.
 */
function encodeNumber(n: number): any {
  const encoder = pick(ENCODERS);
  let expr = encoder(n);

  // 30% chance: wrap the result in a second layer
  if (randInt(1, 10) <= 3) {
    // Wrap with |0 to assert int and add noise
    expr = paren(bin('|', expr, num(0)));
  }

  return expr;
}

// ---- Exclusions ----

/**
 * Numbers that should not be encoded:
 * - 0, 1, -1: too common, encoding them bloats output
 * - Non-integers: bitwise operations truncate to int32
 * - Very large numbers: may overflow int32 in bitwise ops
 * - NaN, Infinity
 */
function shouldEncode(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (!Number.isInteger(value)) return false;
  if (value === 0 || value === 1 || value === -1) return false;
  // Stay within safe int32 range for bitwise operations
  if (value > 0x7FFFFFFF || value < -0x80000000) return false;
  return true;
}

/**
 * Check if this numeric node is in a position where encoding it
 * would break something (e.g., array index in destructuring,
 * switch case values that need to be literals, etc.)
 */
function shouldSkipPosition(node: any, parent: any): boolean {
  // Switch case test values — some engines optimize literal cases
  // We can still encode these, but skip for safety
  if (parent.type === 'SwitchCase' && parent.test === node) return true;
  return false;
}

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
 * Replace numeric literals with equivalent bitwise/arithmetic expressions.
 *
 *   42  →  (5 << 3) + 2
 *   100 →  ~~((100 ^ 0xa3) ^ 0xa3)
 *   7   →  (~(-8))
 *
 * Each instance is uniquely generated even for the same number.
 * 11 different encoding strategies are randomly selected.
 */
export function applyNumberEncoding(ast: any): void {
  const replacements: { node: any; encoded: any }[] = [];

  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any, parent: any) {
      const isNum =
        node.type === 'NumericLiteral' ||
        (node.type === 'Literal' && typeof node.value === 'number');

      if (!isNum) return;
      if (!shouldEncode(node.value)) return;
      if (shouldSkipPosition(node, parent)) return;

      replacements.push({ node, encoded: encodeNumber(node.value) });
    },
    fallback: 'iteration',
  } as any);

  // Apply replacements by morphing nodes in-place
  for (const { node, encoded } of replacements) {
    Object.keys(node).forEach((k) => delete node[k]);
    Object.assign(node, encoded);
  }
}

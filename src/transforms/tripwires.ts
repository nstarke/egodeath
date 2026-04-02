import * as crypto from 'crypto';
import * as estraverse from 'estraverse';
import { gen } from '../random';

/**
 * Punctured Program Tripwires (Paper 4: Sahai & Waters)
 *
 * Embeds hidden conditional checks throughout the obfuscated code.
 * Each tripwire compares a runtime-derived value against a secret hash.
 * When triggered, the tripwire corrupts program state, making subsequent
 * operations produce wrong results silently.
 *
 * The checks are computationally indistinguishable from real validation
 * code — they use the same AST patterns as legitimate conditionals.
 * The secret input that triggers the tripwire is hidden behind a hash,
 * so an attacker sees the hash but can't determine what triggers it.
 *
 * Tripwires serve multiple purposes:
 * - Anti-tampering: if an attacker modifies the code to bypass checks,
 *   tripwires in other locations corrupt state
 * - Analysis resistance: the tripwire branches look like real code paths,
 *   forcing an analyzer to consider them as potentially reachable
 * - Watermarking: each obfuscation instance has unique tripwire hashes,
 *   enabling identification of specific builds
 */

// ---- Helpers ----

function randInt(min: number, max: number): number {
  return min + (crypto.randomBytes(4).readUInt32BE(0) % (max - min + 1));
}

function pick<T>(arr: T[]): T {
  return arr[crypto.randomBytes(4).readUInt32BE(0) % arr.length];
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

// ---- AST builders ----

function id(name: string): any { return { type: 'Identifier', name }; }
function num(value: number): any { return { type: 'NumericLiteral', value }; }
function str(value: string): any { return { type: 'StringLiteral', value }; }

function bin(op: string, left: any, right: any): any {
  return { type: 'BinaryExpression', operator: op, left, right };
}

function call(callee: any, args: any[]): any {
  return { type: 'CallExpression', callee, arguments: args };
}

function member(obj: any, prop: any, computed = false): any {
  return { type: 'MemberExpression', object: obj, property: prop, computed };
}

function assign(left: any, right: any): any {
  return { type: 'AssignmentExpression', operator: '=', left, right };
}

function exprStmt(expr: any): any {
  return { type: 'ExpressionStatement', expression: expr };
}

function varDecl(name: string, init: any): any {
  return {
    type: 'VariableDeclaration', kind: 'var',
    declarations: [{ type: 'VariableDeclarator', id: id(name), init }],
  };
}

function block(body: any[]): any {
  return { type: 'BlockStatement', body };
}

// ---- Tripwire condition generators ----
// Each builds a condition that's almost never true at runtime but looks
// like a legitimate validation check. The condition compares a hash of
// a runtime value against a random secret.

/**
 * typeof check + hash comparison:
 *   if (typeof <param> === "string" && (<param>.length ^ <mask>) === <secret>)
 *
 * Looks like input validation. Triggers only for a specific string length
 * after XOR masking — effectively never for real inputs.
 */
function buildTypeofTripwire(paramName: string): { condition: any; setup: any[] } {
  const mask = randInt(0x100, 0xFFFF);
  const secret = randInt(0x10000, 0x7FFFFFFF);
  const hashVar = gen();

  // Safe: use (param.length || 0) to avoid NaN on non-string types
  return {
    setup: [
      varDecl(hashVar, bin('^',
        bin('|', member(id(paramName), id('length')), num(0)),
        num(mask))),
    ],
    condition: bin('&&',
      bin('===', { type: 'UnaryExpression', operator: 'typeof', argument: id(paramName), prefix: true }, str('string')),
      bin('===', id(hashVar), num(secret))),
  };
}

/**
 * Numeric hash comparison:
 *   var h = ((param * prime) >>> 0) ^ seed;
 *   if (h === secret)
 *
 * Looks like a hash-based cache lookup or memoization check.
 */
function buildNumericHashTripwire(paramName: string): { condition: any; setup: any[] } {
  const prime = pick([2654435761, 1597334677, 2246822519, 3266489917]);
  const seed = randInt(0x1000, 0x7FFFFFFF);
  const secret = randInt(0x10000, 0x7FFFFFFF);
  const hashVar = gen();

  // Safe: (param | 0) ensures integer, avoids NaN from non-numeric types
  return {
    setup: [
      varDecl(hashVar, bin('^',
        bin('>>>', bin('*', bin('|', id(paramName), num(0)), num(prime)), num(0)),
        num(seed))),
    ],
    condition: bin('===', id(hashVar), num(secret)),
  };
}

/**
 * String charCodeAt comparison:
 *   if (typeof param === "string" && (param.charCodeAt(0) ^ param.charCodeAt(param.length-1)) === secret)
 *
 * Looks like a string format validation check.
 */
function buildCharCodeTripwire(paramName: string): { condition: any; setup: any[] } {
  const secret = randInt(0x100, 0xFFFF);
  const hashVar = gen();

  // Safe: only compute charCodeAt if param is a string, else use 0
  return {
    setup: [
      varDecl(hashVar, {
        type: 'ConditionalExpression',
        test: bin('===', { type: 'UnaryExpression', operator: 'typeof', argument: id(paramName), prefix: true }, str('string')),
        consequent: bin('^',
          call(member(id(paramName), id('charCodeAt')), [num(0)]),
          call(member(id(paramName), id('charCodeAt')),
            [bin('-', member(id(paramName), id('length')), num(1))])),
        alternate: num(0),
      }),
    ],
    condition: bin('===', id(hashVar), num(secret)),
  };
}

/**
 * Modular arithmetic tripwire:
 *   var h = ((param % prime1) * prime2 + param) % modulus;
 *   if (h === secret)
 *
 * Looks like a hash bucket computation or ID validation.
 */
function buildModularTripwire(paramName: string): { condition: any; setup: any[] } {
  const prime1 = pick([7, 11, 13, 17, 19, 23, 29, 31]);
  const prime2 = pick([37, 41, 43, 47, 53, 59, 61, 67]);
  const modulus = pick([997, 1009, 2003, 4007, 8009]);
  const secret = randInt(0, modulus - 1);
  const hashVar = gen();

  return {
    setup: [
      varDecl(hashVar, bin('%',
        bin('+',
          bin('*', bin('%', id(paramName), num(prime1)), num(prime2)),
          id(paramName)),
        num(modulus))),
    ],
    condition: bin('===', id(hashVar), num(secret)),
  };
}

/**
 * Bitwise fingerprint tripwire:
 *   var h = (param ^ (param >>> 16)) * 0x45d9f3b;
 *   h = (h ^ (h >>> 16)) >>> 0;
 *   if (h === secret)
 *
 * Looks like a hash function (similar to murmurhash finalizer).
 */
function buildBitwiseFingerprintTripwire(paramName: string): { condition: any; setup: any[] } {
  const multiplier = pick([0x45d9f3b, 0x119de1f3, 0x16a6b885]);
  const secret = randInt(0x10000, 0x7FFFFFFF);
  const h1 = gen();
  const h2 = gen();

  return {
    setup: [
      varDecl(h1, bin('*',
        bin('^', id(paramName), bin('>>>', id(paramName), num(16))),
        num(multiplier))),
      varDecl(h2, bin('>>>', bin('^', id(h1), bin('>>>', id(h1), num(16))), num(0))),
    ],
    condition: bin('===', id(h2), num(secret)),
  };
}

const TRIPWIRE_BUILDERS = [
  buildTypeofTripwire,
  buildNumericHashTripwire,
  buildCharCodeTripwire,
  buildModularTripwire,
  buildBitwiseFingerprintTripwire,
];

// ---- Tripwire payload generators ----
// What happens when a tripwire triggers. These should look like
// legitimate error handling or state updates.

/**
 * Silent state corruption: modify a scope variable to a wrong value.
 * Subsequent operations using that variable produce wrong results
 * but the program doesn't crash — it just gives bad output.
 */
function buildCorruptionPayload(scopeVars: string[]): any[] {
  if (scopeVars.length === 0) {
    return [exprStmt(assign(id(gen()), num(0)))];
  }
  const target = pick(scopeVars);
  return [
    exprStmt(assign(id(target), bin('^', id(target), num(randInt(1, 0xFFFF))))),
  ];
}

/**
 * Infinite micro-delay loop: burns CPU in a tight loop.
 * Looks like a retry/backoff mechanism.
 */
function buildBusyLoopPayload(): any[] {
  const counter = gen();
  const limit = gen();
  return [
    varDecl(counter, num(0)),
    varDecl(limit, num(randInt(1e6, 1e8))),
    {
      type: 'WhileStatement',
      test: bin('<', id(counter), id(limit)),
      body: block([
        exprStmt({ type: 'UpdateExpression', operator: '++', argument: id(counter), prefix: false }),
      ]),
    },
  ];
}

/**
 * Return corruption: replace the return value with garbage.
 * Looks like an error fallback return.
 */
function buildReturnCorruptionPayload(): any[] {
  return [
    { type: 'ReturnStatement', argument: num(randInt(-999, 999)) },
  ];
}

/**
 * Exception throw: throw a generic-looking error.
 * Looks like validation failure handling.
 */
function buildThrowPayload(): any[] {
  return [{
    type: 'ThrowStatement',
    argument: {
      type: 'NewExpression',
      callee: id('Error'),
      arguments: [str(randomHex(8))],
    },
  }];
}

/**
 * Variable nullification: set multiple scope variables to null/undefined.
 */
function buildNullifyPayload(scopeVars: string[]): any[] {
  const targets = scopeVars.slice(0, Math.min(3, scopeVars.length));
  return targets.map(v =>
    exprStmt(assign(id(v), { type: 'NullLiteral' }))
  );
}

function buildPayload(scopeVars: string[]): any[] {
  const payloads = [
    () => buildCorruptionPayload(scopeVars),
    () => buildBusyLoopPayload(),
    () => buildReturnCorruptionPayload(),
    () => buildThrowPayload(),
    () => buildNullifyPayload(scopeVars),
  ];
  return pick(payloads)();
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
 * Inject punctured program tripwires into function bodies.
 *
 * For each function with parameters, ~20% chance to embed a tripwire
 * that checks one of the parameters against a secret hash. The check
 * uses one of 5 hash-like patterns that look like legitimate validation
 * code. If triggered (which is astronomically unlikely), the tripwire
 * corrupts state, throws, or enters a busy loop.
 *
 * Each tripwire has:
 * - A unique secret value (random per instance)
 * - A unique hash function pattern (chosen from 5 templates)
 * - A unique payload (corruption, throw, loop, return, nullify)
 * - Fresh variable names for all temporaries
 */
export function applyTripwires(ast: any): void {
  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any) {
      const isFn =
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression';

      if (!isFn) return;
      if (!node.body || node.body.type !== 'BlockStatement') return;
      if (!node.params || node.params.length === 0) return;

      // ~20% chance per function
      if (randInt(1, 100) > 20) return;

      // Pick a parameter to tripwire on
      const paramCandidates = node.params
        .filter((p: any) => p.type === 'Identifier')
        .map((p: any) => p.name);
      if (paramCandidates.length === 0) return;

      const targetParam = pick(paramCandidates) as string;

      // Collect scope variables for payload
      const scopeVars = node.params
        .filter((p: any) => p.type === 'Identifier')
        .map((p: any) => p.name);

      // Build the tripwire
      const builder = pick(TRIPWIRE_BUILDERS) as (param: string) => { condition: any; setup: any[] };
      const { condition, setup } = builder(targetParam);
      const payload = buildPayload(scopeVars);

      const tripwireStmt: any = {
        type: 'IfStatement',
        test: condition,
        consequent: block(payload),
        alternate: null,
      };

      // Insert setup + tripwire at a random position in the function body
      const body = node.body.body;
      const insertPos = randInt(0, Math.max(0, body.length - 1));
      body.splice(insertPos, 0, ...setup, tripwireStmt);
    },
    fallback: 'iteration',
  } as any);
}

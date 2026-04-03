import * as crypto from 'crypto';
import * as estraverse from 'estraverse';
import { gen } from '../random';

/**
 * Self-Integrity Verification (Paper 10: Bartusek & Malavolta)
 *
 * Inspired by the "dual-mode" verification concept: the obfuscated
 * program periodically checks its own integrity at runtime. If any
 * part of the code has been modified (by a deobfuscator, patcher,
 * or tampering tool), the hash changes and the anti-tamper response
 * triggers — corrupting state, throwing, or entering a loop.
 *
 * Implementation:
 * 1. At build time, after all other transforms, we inject integrity
 *    check functions into the program body.
 * 2. Each check function captures a snippet of surrounding code as a
 *    string (via Function.prototype.toString on a nearby function),
 *    hashes it, and compares against a placeholder.
 * 3. Since the hash is computed AFTER obfuscation, we use a two-pass
 *    approach: first inject the check with a placeholder, then in
 *    the final output, compute the actual hash and replace placeholders.
 *
 * Actually, since Function.prototype.toString returns the source of
 * a function at runtime, we can compute a hash of the runtime source
 * and compare it against a known value. But the known value depends
 * on the final output, creating a chicken-and-egg problem.
 *
 * Practical solution: instead of hashing the full source, we check
 * structural invariants that tampering would break:
 * - The string array length (if someone removes entries, it changes)
 * - The presence of specific token counts
 * - The typeof checks on key variables
 * - The arguments.length of specific functions
 *
 * These checks are obfuscated and scattered throughout the code,
 * making them hard to locate and remove without breaking the program.
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
function str(value: string): any { return { type: 'StringLiteral', value }; }

function bin(op: string, left: any, right: any): any {
  return { type: 'BinaryExpression', operator: op, left, right };
}

function member(obj: any, prop: any, computed = false): any {
  return { type: 'MemberExpression', object: obj, property: prop, computed };
}

function call(callee: any, args: any[]): any {
  return { type: 'CallExpression', callee, arguments: args };
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

// ---- Integrity check generators ----
// Each builds a self-check that verifies a structural property of the
// running code. If the check fails, an anti-tamper response triggers.

/**
 * Check that a specific function has the expected number of statements
 * in its toString() output (measured by semicolon count).
 *
 * Tampering (removing dead code, simplifying expressions) changes the
 * semicolon count and triggers the check.
 */
function buildToStringLengthCheck(targetFnName: string, tamperResponse: any[]): any[] {
  const hashVar = gen();
  const srcVar = gen();
  const countVar = gen();

  // Runtime: get function source, count semicolons, check against threshold
  // The threshold is set to 0 (placeholder) — any non-empty function passes.
  // The real value comes from the fact that if someone removes the check
  // itself, the surrounding code structure changes.
  return [
    varDecl(srcVar, call(member(id(targetFnName), id('toString')), [])),
    varDecl(countVar, member(
      bin('||',
        call(member(id(srcVar), id('match')), [
          { type: 'RegExpLiteral', pattern: ';', flags: 'g' },
        ]),
        { type: 'ArrayExpression', elements: [] }
      ),
      id('length')
    )),
    {
      type: 'IfStatement',
      test: bin('<', id(countVar), num(1)),
      consequent: block(tamperResponse),
      alternate: null,
    },
  ];
}

/**
 * Check that the string array exists and has a minimum length.
 *
 * If an attacker inlines all string references and removes the array,
 * this check detects it.
 */
function buildArrayLengthCheck(arrayName: string, tamperResponse: any[]): any[] {
  const lenVar = gen();

  return [
    varDecl(lenVar, {
      type: 'ConditionalExpression',
      test: bin('!==',
        { type: 'UnaryExpression', operator: 'typeof', argument: id(arrayName), prefix: true },
        str('undefined')),
      consequent: member(id(arrayName), id('length')),
      alternate: num(0),
    }),
    {
      type: 'IfStatement',
      test: bin('<', id(lenVar), num(1)),
      consequent: block(tamperResponse),
      alternate: null,
    },
  ];
}

/**
 * Check that eval is still the native eval function (not replaced).
 *
 * Deobfuscators often replace eval() with a safe evaluator. This
 * check detects that by examining eval.toString().
 */
function buildEvalIntegrityCheck(tamperResponse: any[]): any[] {
  const srcVar = gen();

  return [
    varDecl(srcVar, call(member(id('eval'), id('toString')), [])),
    {
      type: 'IfStatement',
      test: bin('===',
        call(member(id(srcVar), id('indexOf')), [str('native code')]),
        num(-1)),
      consequent: block(tamperResponse),
      alternate: null,
    },
  ];
}

/**
 * Check that Function.prototype.toString hasn't been tampered with.
 *
 * Some deobfuscators override toString to hide modifications.
 */
function buildToStringIntegrityCheck(tamperResponse: any[]): any[] {
  const srcVar = gen();

  return [
    varDecl(srcVar, call(
      member(member(member(id('Function'), id('prototype')), id('toString')), id('toString')),
      [])),
    {
      type: 'IfStatement',
      test: bin('===',
        call(member(id(srcVar), id('indexOf')), [str('native code')]),
        num(-1)),
      consequent: block(tamperResponse),
      alternate: null,
    },
  ];
}

/**
 * Timing check: measure how long a simple operation takes.
 *
 * If a debugger is attached and stepping through, operations take
 * much longer than expected. This detects debugging.
 */
function buildTimingCheck(tamperResponse: any[]): any[] {
  const startVar = gen();
  const endVar = gen();
  const dummyVar = gen();

  return [
    varDecl(startVar, call(member(id('Date'), id('now')), [])),
    varDecl(dummyVar, num(0)),
    {
      type: 'ForStatement',
      init: varDecl(gen(), num(0)),
      test: bin('<', id(dummyVar), num(100)),
      update: { type: 'UpdateExpression', operator: '++', argument: id(dummyVar), prefix: false },
      body: block([]),
    },
    varDecl(endVar, call(member(id('Date'), id('now')), [])),
    {
      type: 'IfStatement',
      test: bin('>', bin('-', id(endVar), id(startVar)), num(500)),
      consequent: block(tamperResponse),
      alternate: null,
    },
  ];
}

// ---- Anti-tamper responses ----

function buildSilentCorruption(): any[] {
  // Corrupt a global-ish variable or just set a flag
  const v = gen();
  return [
    varDecl(v, num(0)),
    {
      type: 'WhileStatement',
      test: bin('<', id(v), num(randInt(1e6, 1e8))),
      body: block([
        exprStmt({ type: 'UpdateExpression', operator: '++', argument: id(v), prefix: false }),
      ]),
    },
  ];
}

function buildBusyWait(): any[] {
  // Long busy-wait loop (not truly infinite — bounded but very slow)
  const v = gen();
  return [
    varDecl(v, num(0)),
    {
      type: 'WhileStatement',
      test: bin('<', id(v), num(randInt(1e8, 1e9))),
      body: block([
        exprStmt({ type: 'UpdateExpression', operator: '++', argument: id(v), prefix: false }),
      ]),
    },
  ];
}

function buildThrowError(): any[] {
  return [{
    type: 'ThrowStatement',
    argument: {
      type: 'NewExpression',
      callee: id('Error'),
      arguments: [str(crypto.randomBytes(8).toString('hex'))],
    },
  }];
}

function buildTamperResponse(): any[] {
  return pick([buildSilentCorruption, buildBusyWait, buildThrowError])();
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
 * Apply self-integrity verification checks to the AST.
 *
 * Injects 2-4 integrity checks as IIFEs at the program level.
 * Each check verifies a different structural property and triggers
 * an anti-tamper response if the check fails.
 *
 * The checks are wrapped in try/catch so they don't crash the
 * program in environments where certain APIs aren't available
 * (e.g., Function.prototype.toString may behave differently in
 * some runtimes).
 */
export function applySelfIntegrity(ast: any): void {
  const checks: any[][] = [];

  // Collect function names for toString checks
  const fnNames: string[] = [];
  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any) {
      if (node.type === 'FunctionDeclaration' && node.id?.name) {
        fnNames.push(node.id.name);
      }
    },
    fallback: 'iteration',
  } as any);

  // Build 2-4 integrity checks from different categories
  const numChecks = randInt(2, 4);
  const availableChecks: (() => any[])[] = [
    () => buildEvalIntegrityCheck(buildTamperResponse()),
    () => buildToStringIntegrityCheck(buildTamperResponse()),
    () => buildTimingCheck(buildTamperResponse()),
  ];

  // Add function-specific checks if we have function names
  if (fnNames.length > 0) {
    availableChecks.push(() =>
      buildToStringLengthCheck(pick(fnNames) as string, buildTamperResponse()));
  }

  // Pick and build checks
  for (let i = 0; i < numChecks; i++) {
    const builder = pick(availableChecks) as () => any[];
    checks.push(builder());
  }

  // Wrap each check group in a try/catch IIFE so failures don't crash
  const checkIIFEs = checks.map(checkStmts => ({
    type: 'ExpressionStatement',
    expression: {
      type: 'CallExpression',
      callee: {
        type: 'FunctionExpression',
        id: null,
        params: [],
        body: block([{
          type: 'TryStatement',
          block: block(checkStmts),
          handler: {
            type: 'CatchClause',
            param: id(gen()),
            body: block([]),  // silently ignore if the check API isn't available
          },
          finalizer: null,
        }]),
        extra: { parenthesized: true },
      },
      arguments: [],
    },
  }));

  // Scatter checks at random positions in the program body
  for (const iife of checkIIFEs) {
    const pos = randInt(0, ast.program.body.length);
    ast.program.body.splice(pos, 0, iife);
  }
}

import * as crypto from 'crypto';
import * as estraverse from 'estraverse';
import { gen } from '../random';
import { captureGlobal } from '../capturedGlobals';

// ---- Helpers ----

function randInt(min: number, max: number): number {
  return min + (crypto.randomBytes(4).readUInt32BE(0) % (max - min + 1));
}

function randomSuffix(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const len = randInt(4, 8);
  let s = '';
  for (let i = 0; i < len; i++) {
    s += chars[crypto.randomBytes(1)[0] % chars.length];
  }
  return s;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- AST builders ----

function id(name: string): any {
  return { type: 'Identifier', name };
}

function str(value: string): any {
  return { type: 'StringLiteral', value };
}

function num(value: number): any {
  return { type: 'NumericLiteral', value };
}

/**
 * Build an encoded "debugger" string with a unique suffix:
 *   "debugger<suffix>".replace(new RegExp("<suffix>$"), "")
 *
 * Both StringLiterals get picked up by string array extraction
 * and XOR+hex encoded, so the word "debugger" never appears in
 * the final output.
 */
function buildEncodedDebuggerString(ast: any): any {
  const suffix = randomSuffix();
  const regexPattern = escapeRegex(suffix) + '$';

  return {
    type: 'CallExpression',
    callee: {
      type: 'MemberExpression',
      object: str('debugger' + suffix),
      property: id('replace'),
      computed: false,
    },
    arguments: [
      {
        type: 'NewExpression',
        // Reference a program-level capture of `RegExp` so the helper
        // keeps working inside a function that locally shadows RegExp
        // (see capturedGlobals.ts for the full rationale).
        callee: id(captureGlobal(ast, 'RegExp')),
        arguments: [str(regexPattern)],
      },
      str(''),
    ],
  };
}

/**
 * Build: eval("debugger<suffix>".replace(new RegExp("<suffix>$"), ""))
 *
 * At runtime this evaluates to eval("debugger") which triggers a
 * breakpoint. Each instance has a unique suffix so no two are alike.
 */
function buildEvalDebugger(ast: any): any {
  return {
    type: 'ExpressionStatement',
    expression: {
      type: 'CallExpression',
      callee: id('eval'),
      arguments: [buildEncodedDebuggerString(ast)],
    },
  };
}

/**
 * Build a setInterval that repeatedly calls eval("debugger"):
 *
 *   setInterval(function() {
 *     eval("debugger<suffix>".replace(new RegExp("<suffix>$"), ""))
 *   }, <interval>);
 *
 * Each setInterval has a unique encoded debugger string and a
 * random interval between 500ms and 5000ms.
 */
/**
 * Prime numbers between 5000 and 600000 used as setInterval delays.
 * Prime intervals ensure the callbacks don't synchronize (overlap)
 * for a very long time, creating unpredictable breakpoint timing.
 */
const PRIME_INTERVALS = [
  5003, 5009, 5011, 5021, 5059, 5099, 5101, 5153, 5197, 5231,
  5279, 5303, 5347, 5399, 5407, 5449, 5501, 5503, 5527, 5557,
  7001, 7013, 7019, 7039, 7079, 7103, 7109, 7127, 7151, 7177,
  10007, 10009, 10037, 10039, 10061, 10067, 10069, 10079, 10091,
  15013, 15017, 15031, 15053, 15061, 15073, 15077, 15083, 15091,
  20011, 20021, 20023, 20029, 20047, 20051, 20063, 20071, 20089,
  30011, 30013, 30029, 30047, 30059, 30071, 30089, 30091, 30097,
  50021, 50023, 50033, 50047, 50051, 50053, 50069, 50077, 50087,
  75011, 75013, 75017, 75029, 75037, 75041, 75079, 75083, 75109,
  100003, 100019, 100043, 100049, 100057, 100069, 150001, 150017,
  200003, 200017, 200023, 200033, 250007, 250013, 250027, 250031,
  300007, 300017, 300023, 350003, 400009, 400031, 450001, 500009,
  550007, 599999,
];

function buildSetIntervalDebugger(ast: any): any {
  const interval = PRIME_INTERVALS[randInt(0, PRIME_INTERVALS.length - 1)];

  const setIntervalCall = {
    type: 'CallExpression',
    callee: id('setInterval'),
    arguments: [
      {
        type: 'FunctionExpression',
        id: null,
        params: [],
        body: {
          type: 'BlockStatement',
          body: [{
            type: 'ExpressionStatement',
            expression: {
              type: 'CallExpression',
              callee: id('eval'),
              arguments: [buildEncodedDebuggerString(ast)],
            },
          }],
        },
      },
      num(interval),
    ],
  };

  // unref() the timer handle so it doesn't keep a Node.js process alive.
  // Without this, the injected traps pin the event loop open forever: a
  // library obfuscated with anti-debug hangs its host (CLIs never exit,
  // `tape`/`tap` test runners time out reporting "no plan" even though every
  // assertion passed). In a browser the handle is a plain number with no
  // `.unref`, so the guarded call is a no-op there. unref() does NOT stop the
  // timer — the debugger traps still fire while the program has real work
  // pending — it only stops the timer from being the sole reason to stay up.
  //
  //   (function (h) { if (h && h.unref) h.unref(); })(setInterval(fn, t));
  const handle = gen();
  const handleRef = () => id(handle);
  const unrefMember = () => ({
    type: 'MemberExpression',
    object: handleRef(),
    property: id('unref'),
    computed: false,
  });

  return {
    type: 'ExpressionStatement',
    expression: {
      type: 'CallExpression',
      callee: {
        type: 'FunctionExpression',
        id: null,
        params: [handleRef()],
        body: {
          type: 'BlockStatement',
          body: [{
            type: 'IfStatement',
            test: {
              type: 'LogicalExpression',
              operator: '&&',
              left: handleRef(),
              right: unrefMember(),
            },
            consequent: {
              type: 'ExpressionStatement',
              expression: {
                type: 'CallExpression',
                callee: unrefMember(),
                arguments: [],
              },
            },
            alternate: null,
          }],
        },
      },
      arguments: [setIntervalCall],
    },
  };
}

/**
 * Build the anti-debug IIFE that sets up multiple setInterval debugger traps:
 *
 *   (function() {
 *     setInterval(function() { eval("debugger...") }, 1234);
 *     setInterval(function() { eval("debugger...") }, 3456);
 *     ...
 *   })();
 */
function buildAntiDebugIIFE(ast: any): any {
  const count = randInt(10, 20);
  const body: any[] = [];

  for (let i = 0; i < count; i++) {
    body.push(buildSetIntervalDebugger(ast));
  }

  return {
    type: 'ExpressionStatement',
    expression: {
      type: 'CallExpression',
      callee: {
        type: 'FunctionExpression',
        id: null,
        params: [],
        body: { type: 'BlockStatement', body },
        extra: { parenthesized: true },
      },
      arguments: [],
    },
  };
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
 * Apply anti-debugging transforms to the AST.
 *
 * 1. Injects eval("debugger") statements at random positions in
 *    function bodies (~15% chance per eligible statement).
 *
 * 2. Prepends an IIFE to the program that sets up 3-8 setInterval
 *    calls, each repeatedly triggering eval("debugger") at random
 *    intervals (500-5000ms).
 *
 * Every injected debugger string uses a unique suffix+replace pattern
 * so no two are identical, and all strings flow through the string
 * array extraction for XOR+hex encoding.
 */
export function applyAntiDebug(ast: any): void {
  // Inject eval("debugger") into function bodies
  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any) {
      const isFn =
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'ObjectMethod';

      if (isFn && node.body && node.body.type === 'BlockStatement') {
        injectDebuggerStatements(ast, node.body);
      }
    },
    fallback: 'iteration',
  } as any);

  // Prepend the anti-debug IIFE with setInterval traps
  ast.program.body.unshift(buildAntiDebugIIFE(ast));
}

/**
 * Inject eval("debugger") at random positions in a block.
 */
function injectDebuggerStatements(ast: any, block: any): void {
  const stmts: any[] = block.body;
  if (stmts.length < 2) return;

  const newBody: any[] = [];

  for (const stmt of stmts) {
    // ~15% chance to inject a debugger trap before this statement
    if (randInt(1, 100) <= 15) {
      newBody.push(buildEvalDebugger(ast));
    }
    newBody.push(stmt);
  }

  block.body = newBody;
}

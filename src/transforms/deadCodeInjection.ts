import * as crypto from 'crypto';
import { gen } from '../random';

// ---- Randomness helpers ----

function randInt(min: number, max: number): number {
  return min + (crypto.randomBytes(4).readUInt32BE(0) % (max - min + 1));
}

function pick<T>(arr: T[]): T {
  return arr[crypto.randomBytes(4).readUInt32BE(0) % arr.length];
}

function pickN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const result: T[] = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = crypto.randomBytes(4).readUInt32BE(0) % copy.length;
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

// ---- AST builder helpers ----

function id(name: string): any {
  return { type: 'Identifier', name };
}

function num(value: number): any {
  return { type: 'NumericLiteral', value };
}

function str(value: string): any {
  return { type: 'StringLiteral', value };
}

function bin(op: string, left: any, right: any): any {
  return { type: 'BinaryExpression', operator: op, left, right };
}

function assign(left: any, right: any): any {
  return {
    type: 'ExpressionStatement',
    expression: { type: 'AssignmentExpression', operator: '=', left, right },
  };
}

function assignOp(op: string, left: any, right: any): any {
  return {
    type: 'ExpressionStatement',
    expression: { type: 'AssignmentExpression', operator: op, left, right },
  };
}

function varDecl(name: string, init: any): any {
  return {
    type: 'VariableDeclaration',
    kind: 'var',
    declarations: [{ type: 'VariableDeclarator', id: id(name), init }],
  };
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

function block(body: any[]): any {
  return { type: 'BlockStatement', body };
}

function ifStmt(test: any, consequent: any[], alternate?: any[] | null): any {
  return {
    type: 'IfStatement',
    test,
    consequent: block(consequent),
    alternate: alternate ? block(alternate) : null,
  };
}

function forLoop(initName: string, limit: any, body: any[]): any {
  return {
    type: 'ForStatement',
    init: varDecl(initName, num(0)),
    test: bin('<', id(initName), limit),
    update: {
      type: 'UpdateExpression',
      operator: '++',
      argument: id(initName),
      prefix: false,
    },
    body: block(body),
  };
}

function ret(arg: any): any {
  return { type: 'ReturnStatement', argument: arg };
}

// ---- Cross-file donor statement pool ----
// When obfuscating multiple files, donor statements from ALL files are
// collected here so that dead code in file A can be mutated from code
// in file B/C/etc. This makes reverse-engineering harder because the
// dead code doesn't structurally match ANY code in the current file.

let _donorStatements: any[] = [];

/**
 * Set the cross-file donor statement pool.
 * Called by obfuscateMultiple() before processing each file.
 */
export function setDonorStatements(stmts: any[]): void {
  _donorStatements = stmts;
}

/**
 * Get the current donor statement pool.
 */
export function getDonorStatements(): any[] {
  return _donorStatements;
}

/**
 * Clear the donor pool (e.g. after a batch run).
 */
export function clearDonorStatements(): void {
  _donorStatements = [];
}

// ---- Scope variable collector ----

/**
 * Collect variable names from a function body that dead code can reference.
 * This makes dead code look like it belongs by using real variable names.
 */
export function collectScopeVars(body: any[]): string[] {
  const vars: string[] = [];
  for (const stmt of body) {
    if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        if (decl.id && decl.id.name) vars.push(decl.id.name);
      }
    }
    if (stmt.type === 'ExpressionStatement' &&
        stmt.expression?.type === 'AssignmentExpression' &&
        stmt.expression.left?.name) {
      vars.push(stmt.expression.left.name);
    }
  }
  return vars;
}

// ---- Dead code template generators ----
// Each returns an array of AST statements. `scopeVars` are real variable
// names from the surrounding scope that can be referenced (read-only)
// to make the dead code look authentic.

type DeadCodeTemplate = (scopeVars: string[]) => any[];

/**
 * A for-loop that accumulates a sum and assigns to a new variable.
 * Uses a real scope variable in the loop bound if available.
 */
const loopAccumulate: DeadCodeTemplate = (scopeVars) => {
  const acc = gen();
  const i = gen();
  const limit = scopeVars.length > 0
    ? bin('+', id(pick(scopeVars)), num(randInt(1, 10)))
    : num(randInt(5, 20));

  return [
    varDecl(acc, num(0)),
    forLoop(i, limit, [
      assignOp('+=', id(acc), bin('*', id(i), num(randInt(2, 7)))),
    ]),
  ];
};

/**
 * Build an array, push items in a loop, then access an element.
 */
const arrayBuild: DeadCodeTemplate = (scopeVars) => {
  const arr = gen();
  const i = gen();
  const tmp = gen();
  const limit = randInt(3, 8);

  return [
    varDecl(arr, { type: 'ArrayExpression', elements: [] }),
    forLoop(i, num(limit), [
      exprStmt(call(member(id(arr), id('push')), [bin('*', id(i), num(randInt(2, 9)))])),
    ]),
    varDecl(tmp, member(id(arr), num(randInt(0, limit - 1)), true)),
  ];
};

/**
 * Create an object, assign properties, access them.
 */
const objectManip: DeadCodeTemplate = (scopeVars) => {
  const obj = gen();
  const key1 = gen();
  const key2 = gen();
  const tmp = gen();
  const k1 = randInt(1, 100);
  const k2 = randInt(1, 100);

  const stmts: any[] = [
    varDecl(obj, { type: 'ObjectExpression', properties: [] }),
    assign(member(id(obj), id(key1)), num(k1)),
    assign(member(id(obj), id(key2)), num(k2)),
  ];

  // Optionally reference a real scope var
  if (scopeVars.length > 0) {
    stmts.push(
      assign(member(id(obj), id(gen())),
        bin('+', id(pick(scopeVars)), num(randInt(1, 50)))),
    );
  }

  stmts.push(varDecl(tmp, bin('+', member(id(obj), id(key1)), member(id(obj), id(key2)))));
  return stmts;
};

/**
 * String concatenation with a conditional.
 */
const stringConcat: DeadCodeTemplate = (scopeVars) => {
  const s = gen();
  const suffix = gen();
  const k = randInt(0, 50);
  const cond = scopeVars.length > 0
    ? bin('>', id(pick(scopeVars)), num(k))
    : bin('>', num(randInt(10, 100)), num(k));

  return [
    varDecl(s, str(gen())),
    ifStmt(cond,
      [assignOp('+=', id(s), str(gen()))],
      [assignOp('+=', id(s), str(gen()))]),
    varDecl(suffix, bin('+', id(s), str(gen()))),
  ];
};

/**
 * Nested if/else with arithmetic.
 */
const nestedConditional: DeadCodeTemplate = (scopeVars) => {
  const v = gen();
  const r = gen();
  const initVal = scopeVars.length > 0
    ? bin('*', id(pick(scopeVars)), num(randInt(1, 5)))
    : num(randInt(1, 100));
  const threshold1 = randInt(10, 50);
  const threshold2 = randInt(51, 100);

  return [
    varDecl(v, initVal),
    varDecl(r, num(0)),
    ifStmt(
      bin('<', id(v), num(threshold1)),
      [assign(id(r), bin('+', id(v), num(randInt(1, 20))))],
      [ifStmt(
        bin('<', id(v), num(threshold2)),
        [assign(id(r), bin('*', id(v), num(randInt(2, 5))))],
        [assign(id(r), bin('-', id(v), num(randInt(1, 20))))],
      )],
    ),
  ];
};

/**
 * Try/catch with a computation inside.
 */
const tryCatchBlock: DeadCodeTemplate = (scopeVars) => {
  const v = gen();
  const err = gen();
  const k = randInt(1, 100);

  const tryBody: any[] = [
    varDecl(v, num(k)),
    assign(id(v), bin('*', id(v), num(randInt(2, 10)))),
  ];

  if (scopeVars.length > 0) {
    tryBody.push(assign(id(v), bin('+', id(v), id(pick(scopeVars)))));
  }

  return [{
    type: 'TryStatement',
    block: block(tryBody),
    handler: {
      type: 'CatchClause',
      param: id(err),
      body: block([
        varDecl(gen(), bin('+', num(0), num(0))),
      ]),
    },
    finalizer: null,
  }];
};

/**
 * While loop with a decrementing counter.
 */
const whileCountdown: DeadCodeTemplate = (scopeVars) => {
  const counter = gen();
  const acc = gen();
  const limit = scopeVars.length > 0
    ? bin('|', id(pick(scopeVars)), num(0))
    : num(randInt(3, 15));

  return [
    varDecl(counter, limit),
    varDecl(acc, num(1)),
    {
      type: 'WhileStatement',
      test: bin('>', id(counter), num(0)),
      body: block([
        assignOp('*=', id(acc), id(counter)),
        exprStmt({
          type: 'UpdateExpression',
          operator: '--',
          argument: id(counter),
          prefix: false,
        }),
      ]),
    },
  ];
};

/**
 * Switch statement with computed cases.
 */
const switchComputed: DeadCodeTemplate = (scopeVars) => {
  const v = gen();
  const r = gen();
  const disc = scopeVars.length > 0
    ? bin('%', id(pick(scopeVars)), num(randInt(3, 6)))
    : bin('%', num(randInt(0, 100)), num(randInt(3, 6)));

  const numCases = randInt(3, 5);
  const cases: any[] = [];
  for (let i = 0; i < numCases; i++) {
    cases.push({
      type: 'SwitchCase',
      test: num(i),
      consequent: [
        assign(id(r), bin('+', id(v), num(randInt(1, 50)))),
        { type: 'BreakStatement', label: null },
      ],
    });
  }
  // Default case
  cases.push({
    type: 'SwitchCase',
    test: null,
    consequent: [
      assign(id(r), id(v)),
      { type: 'BreakStatement', label: null },
    ],
  });

  return [
    varDecl(v, num(randInt(1, 100))),
    varDecl(r, num(0)),
    { type: 'SwitchStatement', discriminant: disc, cases },
  ];
};

/**
 * Bitwise manipulation chain.
 */
const bitwiseChain: DeadCodeTemplate = (scopeVars) => {
  const v = gen();
  const initVal = scopeVars.length > 0
    ? id(pick(scopeVars))
    : num(randInt(1, 255));

  return [
    varDecl(v, initVal),
    assign(id(v), bin('^', id(v), num(randInt(1, 255)))),
    assign(id(v), bin('<<', id(v), num(randInt(1, 3)))),
    assign(id(v), bin('&', id(v), num(randInt(0xFF, 0xFFFF)))),
    assign(id(v), bin('>>>', id(v), num(randInt(1, 2)))),
  ];
};

// ---- Registry ----

const TEMPLATES: DeadCodeTemplate[] = [
  loopAccumulate,
  arrayBuild,
  objectManip,
  stringConcat,
  nestedConditional,
  tryCatchBlock,
  whileCountdown,
  switchComputed,
  bitwiseChain,
];

// ---- Public API ----

/**
 * Generate a realistic dead code block.
 * If realStatements are provided, ~50% of the time dead code is generated
 * by MUTATING real code (Paper 3: structurally identical dead code).
 * Otherwise falls back to template-based generation.
 *
 * @param scopeVars       Variable names from surrounding scope to reference.
 * @param count           Number of templates to combine (1-3).
 * @param realStatements  Optional: real statements from the same scope to mutate.
 */
export function generateDeadCode(
  scopeVars: string[] = [],
  count?: number,
  realStatements?: any[],
): any[] {
  // Build a combined donor pool: local real statements + cross-file donors
  const allDonors: any[] = [
    ...(realStatements || []),
    ..._donorStatements,
  ];

  // 50% chance: use mutation-based dead code when donors available
  if (allDonors.length >= 2 && randInt(0, 1) === 0) {
    return generateMutatedCode(allDonors);
  }
  const n = count || randInt(1, 2);
  const templates = pickN(TEMPLATES, n);
  const stmts: any[] = [];
  for (const tmpl of templates) {
    stmts.push(...tmpl(scopeVars));
  }
  return stmts;
}

// ==== Mutation-based dead code (Paper 3: Subgroup Elimination) ====
//
// Instead of generating dead code from templates, we clone REAL statements
// and mutate them: change constants, swap operators, rename variables,
// invert conditions. The result has identical AST structure to the real
// code — same node types, same nesting depth, same expression patterns —
// but operates on different values. Static analysis cannot distinguish
// dead from real based on structure alone.

/** Operators that can be swapped for each other */
const BINARY_OP_GROUPS: string[][] = [
  ['+', '-'],
  ['*', '/'],
  ['<', '>', '<=', '>='],
  ['===', '!=='],
  ['==', '!='],
  ['&', '|'],
  ['^', '&'],
  ['<<', '>>'],
];

const ASSIGN_OP_SWAPS: { [key: string]: string[] } = {
  '+=': ['-=', '*='],
  '-=': ['+=', '*='],
  '*=': ['+=', '-='],
  '=': ['='],
};

const UNARY_OP_SWAPS: { [key: string]: string[] } = {
  '++': ['--'],
  '--': ['++'],
  '!': ['~', '!'],
  '~': ['!', '~'],
  '-': ['+', '-'],
  '+': ['-', '+'],
  'typeof': ['typeof'],
  'void': ['void'],
};

/**
 * Deep-clone an AST node, mutating it along the way:
 * - Numeric literals: perturbed by a random offset
 * - String literals: replaced with random strings of same length
 * - Identifiers (non-keyword): renamed to fresh generated names
 * - Binary operators: swapped within equivalence groups
 * - Unary operators: swapped within equivalence groups
 * - Boolean literals: inverted
 */
function mutateNode(node: any, nameMap: Map<string, string>): any {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(child => mutateNode(child, nameMap));

  const clone: any = {};
  for (const key of Object.keys(node)) {
    // Skip location/metadata
    if (key === 'loc' || key === 'start' || key === 'end' ||
        key === 'extra' || key === 'comments' || key === 'leadingComments' ||
        key === 'trailingComments' || key === 'innerComments') {
      continue;
    }
    clone[key] = mutateNode(node[key], nameMap);
  }

  // Mutate based on node type
  switch (clone.type) {
    case 'NumericLiteral':
    case 'Literal':
      if (typeof clone.value === 'number' && isFinite(clone.value)) {
        // Perturb: change by ±1 to ±50, or multiply by 2-5
        if (randInt(0, 1) === 0) {
          clone.value = clone.value + randInt(-50, 50);
        } else {
          clone.value = clone.value * randInt(2, 5);
        }
        if (clone.raw) delete clone.raw;
        if (clone.extra) delete clone.extra;
      }
      if (typeof clone.value === 'string') {
        // Replace with random string of similar length
        clone.value = gen().substring(0, Math.max(1, clone.value.length));
        if (clone.raw) delete clone.raw;
        if (clone.extra) delete clone.extra;
      }
      break;

    case 'StringLiteral':
      clone.value = gen().substring(0, Math.max(1, clone.value.length));
      if (clone.raw) delete clone.raw;
      if (clone.extra) delete clone.extra;
      break;

    case 'BooleanLiteral':
      clone.value = !clone.value;
      break;

    case 'Identifier':
      // Rename non-keyword identifiers to fresh names
      if (clone.name && clone.name !== 'undefined' && clone.name !== 'null' &&
          clone.name !== 'true' && clone.name !== 'false' &&
          clone.name !== 'arguments' && clone.name !== 'this') {
        if (!nameMap.has(clone.name)) {
          nameMap.set(clone.name, gen());
        }
        clone.name = nameMap.get(clone.name)!;
      }
      break;

    case 'BinaryExpression':
    case 'LogicalExpression':
      if (clone.operator) {
        const group = BINARY_OP_GROUPS.find(g => g.includes(clone.operator));
        if (group && group.length > 1) {
          const others = group.filter(op => op !== clone.operator);
          clone.operator = pick(others);
        }
      }
      break;

    case 'AssignmentExpression':
      if (clone.operator && ASSIGN_OP_SWAPS[clone.operator]) {
        const swaps = ASSIGN_OP_SWAPS[clone.operator];
        clone.operator = pick(swaps);
      }
      break;

    case 'UpdateExpression':
      if (clone.operator && UNARY_OP_SWAPS[clone.operator]) {
        clone.operator = pick(UNARY_OP_SWAPS[clone.operator]);
      }
      break;

    case 'UnaryExpression':
      if (clone.operator && UNARY_OP_SWAPS[clone.operator]) {
        clone.operator = pick(UNARY_OP_SWAPS[clone.operator]);
      }
      break;
  }

  return clone;
}

/**
 * Generate dead code by cloning and mutating real statements.
 *
 * Takes 2-4 consecutive real statements, deep-clones them, and mutates:
 * - All identifiers get fresh names (via a consistent rename map)
 * - Numeric constants are perturbed
 * - String literals are replaced
 * - Operators are swapped within equivalence groups
 * - Booleans are flipped
 *
 * The result has IDENTICAL AST structure to the original statements
 * but computes something completely different on different variables.
 */
function generateMutatedCode(realStatements: any[]): any[] {
  // Pick a random slice of 2-4 consecutive statements
  const sliceLen = Math.min(realStatements.length, randInt(2, 4));
  const startIdx = randInt(0, Math.max(0, realStatements.length - sliceLen));
  const slice = realStatements.slice(startIdx, startIdx + sliceLen);

  // Clone and mutate with a fresh name mapping
  const nameMap = new Map<string, string>();
  const mutated = slice.map(stmt => mutateNode(stmt, nameMap));

  // Wrap in a var declaration block so the fresh variables are declared
  const varDecls: any[] = [];
  for (const [, newName] of nameMap) {
    varDecls.push({
      type: 'VariableDeclaration',
      kind: 'var',
      declarations: [{
        type: 'VariableDeclarator',
        id: id(newName),
        init: num(randInt(0, 100)),
      }],
    });
  }

  return [...varDecls, ...mutated];
}

/**
 * Generate dead code suitable for a CFF switch case.
 * Includes a state variable assignment and break to look like a real case.
 */
export function generateDeadCaseBody(
  stateVar: string,
  realStateIds: number[],
  scopeVars: string[],
): any[] {
  const stmts = generateDeadCode(scopeVars, 1);

  // End by transitioning to a random real state (making the case look
  // like a legitimate step in the state machine)
  const targetState = pick(realStateIds);
  stmts.push(
    {
      type: 'ExpressionStatement',
      expression: {
        type: 'AssignmentExpression',
        operator: '=',
        left: id(stateVar),
        right: num(targetState),
      },
    },
    { type: 'BreakStatement', label: null },
  );
  return stmts;
}

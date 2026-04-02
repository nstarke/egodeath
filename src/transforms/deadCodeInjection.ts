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
 * @param scopeVars  Variable names from surrounding scope to reference.
 * @param count      Number of templates to combine (1-3).
 */
export function generateDeadCode(scopeVars: string[] = [], count?: number): any[] {
  const n = count || randInt(1, 2);
  const templates = pickN(TEMPLATES, n);
  const stmts: any[] = [];
  for (const tmpl of templates) {
    stmts.push(...tmpl(scopeVars));
  }
  return stmts;
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

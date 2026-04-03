import * as crypto from 'crypto';
import * as estraverse from 'estraverse';
import { generateDeadCode, collectScopeVars } from './deadCodeInjection';

const EXTRA_VISITOR_KEYS: { [key: string]: string[] } = {
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

function pick<T>(arr: T[]): T {
  return arr[crypto.randomBytes(4).readUInt32BE(0) % arr.length];
}

// Minimum number of top-level statements to bother flattening
const MIN_STATEMENTS = 3;
// Maximum statements — very large functions create pathological switch statements
const MAX_STATEMENTS = 100;

interface CaseBlock {
  stateId: number;
  body: any[];
}

/**
 * Generate N unique random state IDs.
 */
function generateStateIds(count: number): number[] {
  const ids: number[] = [];
  const used = new Set<number>();
  while (ids.length < count) {
    const id = crypto.randomBytes(2).readUInt16BE(0) % 10000;
    if (!used.has(id)) {
      used.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * Shuffle an array in-place (Fisher-Yates).
 */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomBytes(4).readUInt32BE(0) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ----- AST builder helpers -----

function numericLiteral(value: number): any {
  return { type: 'NumericLiteral', value };
}

function identifier(name: string): any {
  return { type: 'Identifier', name };
}

function assignState(stateVar: string, stateId: number): any {
  return {
    type: 'ExpressionStatement',
    expression: {
      type: 'AssignmentExpression',
      operator: '=',
      left: identifier(stateVar),
      right: numericLiteral(stateId),
    },
  };
}

function breakStatement(): any {
  return { type: 'BreakStatement', label: null };
}

function switchCase(test: any, consequent: any[]): any {
  return { type: 'SwitchCase', test, consequent };
}

// ----- Variable hoisting -----

interface HoistResult {
  hoisted: any[];       // var declarations to place before the while
  transformed: any[];   // statements with declarations converted to assignments
}

/**
 * Extract variable declarations from statements, hoist them as
 * uninitialized `var` declarations, and replace originals with
 * assignments. This is needed because moving statements into
 * switch cases changes block scoping for let/const.
 */
function hoistDeclarations(stmts: any[]): HoistResult {
  const hoisted: any[] = [];
  const transformed: any[] = [];

  for (const stmt of stmts) {
    if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        const isDestructuring =
          decl.id.type === 'ObjectPattern' || decl.id.type === 'ArrayPattern';

        if (isDestructuring) {
          // Destructuring: extract each binding name as a simple var declaration
          // var { a, b } = obj  →  var a; var b;  +  ({a, b} = obj);
          const names = extractBindingNames(decl.id);
          for (const name of names) {
            hoisted.push({
              type: 'VariableDeclaration',
              kind: 'var',
              declarations: [{
                type: 'VariableDeclarator',
                id: identifier(name),
                init: null,
              }],
            });
          }
          if (decl.init) {
            // Convert to destructuring assignment expression: ({a, b} = obj)
            transformed.push({
              type: 'ExpressionStatement',
              expression: {
                type: 'AssignmentExpression',
                operator: '=',
                left: decl.id,
                right: decl.init,
              },
            });
          }
        } else {
          // Simple identifier: hoist as var (no init)
          hoisted.push({
            type: 'VariableDeclaration',
            kind: 'var',
            declarations: [{
              type: 'VariableDeclarator',
              id: cloneId(decl.id),
              init: null,
            }],
          });
          if (decl.init) {
            transformed.push({
              type: 'ExpressionStatement',
              expression: {
                type: 'AssignmentExpression',
                operator: '=',
                left: cloneId(decl.id),
                right: decl.init,
              },
            });
          }
        }
      }
    } else {
      transformed.push(stmt);
    }
  }

  return { hoisted, transformed };
}

function cloneId(id: any): any {
  if (id.type === 'Identifier') {
    return { type: 'Identifier', name: id.name };
  }
  // ObjectPattern, ArrayPattern — return as-is (caller handles destructuring)
  return id;
}

/**
 * Extract all binding names from a destructuring pattern.
 * { a, b: c, ...d } → ['a', 'c', 'd']
 * [a, , b, ...c]    → ['a', 'b', 'c']
 */
function extractBindingNames(pattern: any): string[] {
  const names: string[] = [];
  if (pattern.type === 'Identifier') {
    names.push(pattern.name);
  } else if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties) {
      if (prop.type === 'RestElement') {
        names.push(...extractBindingNames(prop.argument));
      } else {
        // prop.value is the local binding (may itself be a pattern)
        names.push(...extractBindingNames(prop.value || prop.key));
      }
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const elem of pattern.elements) {
      if (elem) {
        if (elem.type === 'RestElement') {
          names.push(...extractBindingNames(elem.argument));
        } else {
          names.push(...extractBindingNames(elem));
        }
      }
    }
  } else if (pattern.type === 'AssignmentPattern') {
    names.push(...extractBindingNames(pattern.left));
  }
  return names;
}

// ----- Core flattening -----

/**
 * Convert an array of statements into CaseBlock entries for the
 * state machine. Returns the list of cases and the entry state ID.
 *
 * Each top-level statement becomes one or more switch cases:
 *  - Simple statements: one case, advance to next state
 *  - IfStatement: one case for the test (branches to consequent/alternate
 *    states), plus cases for each branch body
 *  - ReturnStatement / ThrowStatement: one case, no state transition
 *  - Loops, try/catch, switch: opaque — put in one case as-is
 */
function buildCases(
  stmts: any[],
  stateVar: string,
): { cases: CaseBlock[]; entryState: number; exitState: number } {

  // First, count how many state IDs we need.
  // Worst case: each stmt needs 1 + if-stmts need 2 extra (consequent + alternate)
  let needed = stmts.length + 1; // +1 for the exit/terminal state
  for (const stmt of stmts) {
    if (stmt.type === 'IfStatement') {
      needed += 2; // consequent block + alternate block
    }
  }

  const ids = generateStateIds(needed);
  let idIdx = 0;
  const nextId = () => ids[idIdx++];

  const cases: CaseBlock[] = [];
  const exitState = nextId();

  // Assign entry state for each statement
  const stateForStmt: number[] = stmts.map(() => nextId());
  const entryState = stateForStmt.length > 0 ? stateForStmt[0] : exitState;

  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i];
    const myState = stateForStmt[i];
    const nextState = i + 1 < stmts.length ? stateForStmt[i + 1] : exitState;

    if (stmt.type === 'ReturnStatement') {
      // Return case — no state transition
      cases.push({ stateId: myState, body: [stmt] });

    } else if (stmt.type === 'ThrowStatement') {
      cases.push({ stateId: myState, body: [stmt] });

    } else if (stmt.type === 'IfStatement') {
      const consequentState = nextId();
      const alternateState = stmt.alternate ? nextId() : nextState;

      // Test case: evaluate condition, branch to consequent or alternate
      cases.push({
        stateId: myState,
        body: [
          {
            type: 'IfStatement',
            test: stmt.test,
            consequent: {
              type: 'BlockStatement',
              body: [assignState(stateVar, consequentState), breakStatement()],
            },
            alternate: {
              type: 'BlockStatement',
              body: [assignState(stateVar, alternateState), breakStatement()],
            },
          },
        ],
      });

      // Consequent case
      const consBody = statementsOf(stmt.consequent);
      cases.push({
        stateId: consequentState,
        body: [...consBody, assignState(stateVar, nextState), breakStatement()],
      });

      // Alternate case (if exists)
      if (stmt.alternate) {
        const altBody = stmt.alternate.type === 'IfStatement'
          ? [stmt.alternate]  // else-if: keep as-is inside the case
          : statementsOf(stmt.alternate);
        cases.push({
          stateId: alternateState,
          body: [...altBody, assignState(stateVar, nextState), breakStatement()],
        });
      }

    } else {
      // All other statements: execute and advance
      cases.push({
        stateId: myState,
        body: [stmt, assignState(stateVar, nextState), breakStatement()],
      });
    }
  }

  // Exit case: break out of the while loop
  cases.push({
    stateId: exitState,
    body: [{ type: 'ReturnStatement', argument: null }],
  });

  return { cases, entryState, exitState };
}

/**
 * Extract the body statements from a node that might be
 * a BlockStatement or a single statement.
 */
function statementsOf(node: any): any[] {
  if (!node) return [];
  if (node.type === 'BlockStatement') return node.body;
  return [node];
}

/**
 * Primes suitable for modular arithmetic state encoding.
 * Must be coprime with the modulus (guaranteed since modulus is also prime).
 */
const MOD_PRIMES = [
  104729, 104743, 104759, 104761, 104773,
  104789, 104801, 104803, 104827, 104831,
];

const MOD_MULTIPLIERS = [
  7, 11, 13, 17, 19, 23, 29, 31, 37, 41,
  43, 47, 53, 59, 61, 67, 71, 73, 79, 83,
];

/**
 * Build the while(true) { switch(f(_s)) { cases... } } AST structure.
 *
 * Paper 3 (Subgroup Elimination): Instead of switching on _s directly,
 * the discriminant is (_s * MULT) % MOD — a modular arithmetic
 * transformation. The case values are the transformed state IDs.
 * State assignments still use raw IDs; only the switch dispatch
 * goes through the modular function.
 *
 * This means an analyzer looking at case values sees transformed
 * numbers that don't correspond to the raw state IDs in assignments.
 * Recovering the mapping requires solving (_s * MULT) % MOD = caseValue
 * for each case, which requires knowing MULT and MOD.
 */
function buildStateMachine(
  stateVar: string,
  entryState: number,
  cases: CaseBlock[],
): any {
  // Shuffle case order so reading top-to-bottom reveals nothing
  shuffle(cases);

  // Pick random modular arithmetic parameters
  const modulus = pick(MOD_PRIMES);
  const multiplier = pick(MOD_MULTIPLIERS);

  // Transform: each case's test value = (rawStateId * multiplier) % modulus
  const switchCases = cases.map((c) => {
    const encodedId = (c.stateId * multiplier) % modulus;
    return switchCase(numericLiteral(encodedId), c.body);
  });

  // Discriminant: (_s * multiplier) % modulus
  const discriminant = {
    type: 'BinaryExpression',
    operator: '%',
    left: {
      type: 'BinaryExpression',
      operator: '*',
      left: identifier(stateVar),
      right: numericLiteral(multiplier),
    },
    right: numericLiteral(modulus),
  };

  return {
    type: 'WhileStatement',
    test: { type: 'BooleanLiteral', value: true },
    body: {
      type: 'BlockStatement',
      body: [{
        type: 'SwitchStatement',
        discriminant,
        cases: switchCases,
      }],
    },
  };
}

/**
 * Flatten the body of a single function.
 * Returns the new body statements (hoisted vars + state var + while/switch).
 */
export function flattenFunctionBody(body: any[], deadCodeMul: number = 1): any[] | null {
  if (body.length < MIN_STATEMENTS) return null;
  if (body.length > MAX_STATEMENTS) return null;

  // Don't flatten if body contains constructs that break when hoisted to var
  for (const stmt of body) {
    if (
      stmt.type === 'ImportDeclaration' ||
      stmt.type === 'ExportNamedDeclaration' ||
      stmt.type === 'ExportDefaultDeclaration' ||
      stmt.type === 'ExportAllDeclaration'
    ) {
      return null;
    }
    // let/const rely on block scoping and temporal dead zone —
    // converting to var changes semantics and breaks cross-module code
    if (stmt.type === 'VariableDeclaration' && (stmt.kind === 'let' || stmt.kind === 'const')) {
      return null;
    }
    // Class declarations also can't be hoisted (TDZ semantics)
    if (stmt.type === 'ClassDeclaration') {
      return null;
    }
  }

  const stateVar = '_s';

  // Hoist variable declarations
  const { hoisted, transformed } = hoistDeclarations(body);

  // Build case blocks from the transformed statements
  const { cases, entryState } = buildCases(transformed, stateVar);

  // Inject dead switch cases that are never reached but look real.
  // The deadCodeMul controls how many dead cases to inject — at high
  // values (budget has lots of headroom), we inject many large dead cases.
  const realStateIds = cases.map((c) => c.stateId);
  const scopeVars = collectScopeVars(body);
  const deadCaseCount = Math.max(2, Math.floor(cases.length * 0.3 * deadCodeMul));
  // How many templates to combine per dead case (more = larger blocks)
  const templatesPerCase = Math.min(5, Math.max(1, Math.floor(deadCodeMul / 5)));
  // Collect real case bodies for mutation-based dead code (Paper 3)
  const realCaseBodies = cases.filter(c => c.body.length > 1).map(c => c.body);
  const deadIds = generateStateIds(deadCaseCount);
  for (const deadId of deadIds) {
    // Generate dead code — will use mutation of real cases ~50% of the time
    const realSource = realCaseBodies.length > 0 ? pick(realCaseBodies) : undefined;
    const stmts = generateDeadCode(scopeVars, templatesPerCase, realSource);
    const targetState = pick(realStateIds);
    stmts.push(
      {
        type: 'ExpressionStatement',
        expression: {
          type: 'AssignmentExpression',
          operator: '=',
          left: identifier(stateVar),
          right: numericLiteral(targetState),
        },
      },
      breakStatement(),
    );
    cases.push({ stateId: deadId, body: stmts });
  }

  // State variable declaration
  const stateVarDecl: any = {
    type: 'VariableDeclaration',
    kind: 'var',
    declarations: [{
      type: 'VariableDeclarator',
      id: identifier(stateVar),
      init: numericLiteral(entryState),
    }],
  };

  // Assemble: hoisted vars → state var → while/switch
  const machine = buildStateMachine(stateVar, entryState, cases);
  return [...hoisted, stateVarDecl, machine];
}

/**
 * Apply control flow flattening to all function bodies in an AST.
 * Modifies the AST in-place.
 */
export function applyControlFlowFlattening(ast: any, budget?: any): void {
  const deadCodeMul = budget ? budget.deadCodeMultiplier : 1;

  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any) {
      const isFn =
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'ObjectMethod';

      if (isFn && node.body && node.body.type === 'BlockStatement') {
        const flattened = flattenFunctionBody(node.body.body, deadCodeMul);
        if (flattened) {
          node.body.body = flattened;
        }
      }
    },
    fallback: 'iteration',
  } as any);
}

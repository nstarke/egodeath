import * as estraverse from 'estraverse';

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

/**
 * Build a SequenceExpression (comma expression) from an array of expressions.
 * If only one expression, returns it directly.
 */
function sequence(exprs: any[]): any {
  if (exprs.length === 1) return exprs[0];
  return { type: 'SequenceExpression', expressions: exprs };
}

/**
 * Flush a run of collected expressions into the result array
 * as a single comma-separated ExpressionStatement.
 */
function flushRun(run: any[], result: any[]): void {
  if (run.length === 0) return;
  if (run.length === 1) {
    // Single expression — keep as normal ExpressionStatement
    result.push({ type: 'ExpressionStatement', expression: run[0] });
  } else {
    // Multiple expressions — merge with comma operator
    result.push({ type: 'ExpressionStatement', expression: sequence(run) });
  }
}

/**
 * Merge consecutive ExpressionStatements in a statement list
 * into SequenceExpressions (comma operator).
 *
 * Runs of ExpressionStatements are collected. If the run is
 * terminated by a ReturnStatement or ThrowStatement, the
 * return/throw value is folded into the sequence:
 *
 *   a(); b(); return c();  →  return (a(), b(), c());
 *   x = 1; y = 2; z = 3;  →  x = 1, y = 2, z = 3;
 *
 * Non-mergeable statements (var, if, for, break, etc.) break the run.
 */
function mergeBlock(body: any[]): any[] {
  const result: any[] = [];
  let run: any[] = [];

  for (let i = 0; i < body.length; i++) {
    const stmt = body[i];

    if (stmt.type === 'ExpressionStatement') {
      run.push(stmt.expression);
      continue;
    }

    if (stmt.type === 'ReturnStatement' && run.length > 0) {
      // Fold: a(), b(), ..., returnValue
      if (stmt.argument) {
        run.push(stmt.argument);
      }
      result.push({
        type: 'ReturnStatement',
        argument: run.length > 0 ? sequence(run) : null,
      });
      run = [];
      continue;
    }

    if (stmt.type === 'ThrowStatement' && run.length > 0 && stmt.argument) {
      // Fold: a(), b(), ..., throwValue
      run.push(stmt.argument);
      result.push({
        type: 'ThrowStatement',
        argument: sequence(run),
      });
      run = [];
      continue;
    }

    // Non-mergeable statement — flush current run, then add statement
    flushRun(run, result);
    run = [];
    result.push(stmt);
  }

  // Flush any remaining run
  flushRun(run, result);
  return result;
}

/**
 * Apply comma expression merging to all BlockStatements in the AST.
 * Recursively processes every block body: function bodies, if/else
 * blocks, loop bodies, switch case consequents, try/catch blocks, etc.
 */
export function applyCommaExpressions(ast: any): void {
  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any) {
      // Process BlockStatement bodies
      if (node.type === 'BlockStatement' && Array.isArray(node.body)) {
        node.body = mergeBlock(node.body);
      }

      // Process SwitchCase consequents (not wrapped in BlockStatement)
      if (node.type === 'SwitchCase' && Array.isArray(node.consequent)) {
        node.consequent = mergeBlock(node.consequent);
      }

      // Process Program body
      if (node.type === 'Program' && Array.isArray(node.body)) {
        node.body = mergeBlock(node.body);
      }
    },
    fallback: 'iteration',
  } as any);
}

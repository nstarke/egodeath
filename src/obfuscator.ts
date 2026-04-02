import * as recast from 'recast';
import * as estraverse from 'estraverse';
import { ASTNode, PassHandlerMap } from './types';
import { resetGlobals, resetWindowProps } from './globals';
import { buildConsoleKeywords } from './keywords';
import { firstPassHandlers } from './passes/firstPass';
import { secondPassHandlers } from './passes/secondPass';
import { thirdPassHandlers } from './passes/thirdPass';
import { applyControlFlowFlattening } from './transforms/controlFlowFlattening';
import { applyOpaquePredicates } from './transforms/opaquePredicates';
import { applyStringArrayExtraction } from './transforms/stringArrayExtraction';
import { applyGlobalVariableEncoding } from './transforms/globalVariableEncoding';
import { applyPropertyKeyEncoding } from './transforms/propertyKeyEncoding';
import { applyProxyFunctions } from './transforms/proxyFunctions';
import { applyNumberEncoding } from './transforms/numberEncoding';
import { applyCommaExpressions } from './transforms/commaExpressions';
import { applyContextExhaustion } from './transforms/contextExhaustion';
import { applyAntiDebug } from './transforms/antiDebug';
import { applyTripwires } from './transforms/tripwires';
import { ObfuscateOptions, DEFAULT_OPTIONS, BloatBudget, computeBloatBudget } from './options';

const { minify_sync } = require('terser');

/**
 * Extended visitor keys for modern AST node types that estraverse
 * doesn't know about natively. Without these, estraverse skips
 * traversal into these nodes.
 */
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

  // Babel-specific node types (babel parser uses these instead of ESTree equivalents)
  ObjectProperty: ['key', 'value'],
  ObjectMethod: ['key', 'params', 'body'],
  StringLiteral: [],
  NumericLiteral: [],
  BooleanLiteral: [],
  NullLiteral: [],
  RegExpLiteral: [],
};

function runPass(ast: any, handlers: PassHandlerMap): void {
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any, parent: any) {
      if (!handlers[node.type]) return;
      handlers[node.type](node, parent);
    },
    fallback: 'iteration',
  } as any);
}

/**
 * Obfuscate JavaScript source code.
 *
 * @param code - The JavaScript source code to obfuscate
 * @param options - Optional configuration (target token budget, etc.)
 * @returns The obfuscated JavaScript code
 */
export function obfuscate(code: string, options?: Partial<ObfuscateOptions>): string {
  const opts: ObfuscateOptions = { ...DEFAULT_OPTIONS, ...options };
  const budget = computeBloatBudget(code.length, opts);

  // Reset global state for each run
  resetGlobals();
  resetWindowProps();

  // Strip shebang line if present — parsers can't handle it
  let shebang = '';
  if (code.startsWith('#!')) {
    const newlineIdx = code.indexOf('\n');
    shebang = code.slice(0, newlineIdx + 1);
    code = code.slice(newlineIdx + 1);
  }

  const ast = recast.parse(code, {
    parser: require('recast/parsers/babel'),
  });

  // Anti-debugging: inject eval("debugger") traps and setInterval loops.
  // Runs before all other transforms so debugger strings get encoded.
  if (budget.maxBloatRatio > 3) {
    applyAntiDebug(ast);
  }

  // Punctured program tripwires (Paper 4: Sahai & Waters)
  // Hidden checks that trigger corruption on secret inputs.
  // Runs early so tripwire code gets obfuscated by all subsequent passes.
  if (budget.maxBloatRatio > 3) {
    applyTripwires(ast);
  }

  // Pre-transforms are gated on budget. At very low budgets, structural
  // transforms are skipped entirely — only identifier renaming + string
  // array extraction run, providing baseline obfuscation.
  if (budget.maxBloatRatio > 3) {
    // Control flow flattening: while/switch state machines
    applyControlFlowFlattening(ast, budget);
  }

  if (budget.maxBloatRatio > 3) {
    // Opaque predicates: fake branches with math conditions
    applyOpaquePredicates(ast, budget);
  }

  if (budget.maxBloatRatio > 5) {
    // Proxy functions: route all calls through dispatchers
    applyProxyFunctions(ast);
  }

  if (budget.maxBloatRatio > 8) {
    // Context window exhaustion: ternary/void noise
    applyContextExhaustion(ast, budget);
  }

  if (budget.maxBloatRatio > 3) {
    // Comma expression merging
    applyCommaExpressions(ast);
  }

  // First Pass: catalog identifiers
  runPass(ast, firstPassHandlers);

  // Second Pass: substitute identifiers and encode strings
  runPass(ast, secondPassHandlers);

  // Third Pass: inject dummy parameters and strip comments
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any, parent: any) {
      if (node.comments) delete node.comments;
      if (!thirdPassHandlers[node.type]) return;
      thirdPassHandlers[node.type](node, parent);
    },
    fallback: 'iteration',
  } as any);

  // Post-transforms are gated on budget — they add significant volume
  // through string generation (each property/global adds 2+ strings to the array)
  if (budget.maxBloatRatio > 10) {
    // Post-transform: global variable encoding
    applyGlobalVariableEncoding(ast);
  }

  if (budget.maxBloatRatio > 5) {
    // Post-transform: property key encoding
    applyPropertyKeyEncoding(ast);
  }

  if (budget.maxBloatRatio > 3) {
    // Post-transform: number encoding
    applyNumberEncoding(ast);
  }

  // Post-transform: string array extraction + rotation
  // Collects all string literals into a rotated array, replaces with accessor calls
  // Runs last so it captures all strings including global+property name strings
  applyStringArrayExtraction(ast, budget);

  // Prepend console stubs
  const consoleKeywords = buildConsoleKeywords();
  ast.program.body = consoleKeywords.concat(ast.program.body);

  let output = shebang + recast.print(ast).code;

  // Final pass: minify to strip whitespace and formatting
  // Uses terser with no mangling (no variable renaming) and minimal
  // compression (no dead code elimination) to preserve all obfuscation
  // while removing readable formatting.
  try {
    const result = minify_sync(output, {
      mangle: false,         // never rename variables
      compress: false,       // no AST-level compression (would undo obfuscation)
      format: {
        beautify: false,     // collapse whitespace
        comments: false,     // strip any remaining comments
        semicolons: true,    // use semicolons (not ASI)
      },
    });
    if (result && result.code) {
      output = result.code;
    }
  } catch {
    // Terser can't parse some obfuscated constructs — fall back to
    // regex-based whitespace stripping that doesn't require parsing
    output = output
      .replace(/\/\/[^\n]*/g, '')           // strip line comments
      .replace(/\/\*[\s\S]*?\*\//g, '')     // strip block comments
      .replace(/^\s+/gm, '')               // strip leading whitespace
      .replace(/\s*\n\s*/g, '\n')          // collapse blank lines
      .replace(/\n+/g, '')                 // join all lines
      .replace(/\s{2,}/g, ' ');            // collapse multiple spaces
  }

  return output;
}

import * as recast from 'recast';
import * as estraverse from 'estraverse';
import { ASTNode, PassHandlerMap } from './types';
import { resetGlobals, resetWindowProps } from './globals';
import {
  resetIssuedNames,
  generateSharedNamePool,
  setSharedNamePool,
  clearSharedNamePool,
} from './random';
import { resetCapturedGlobals, flushCapturedGlobals } from './capturedGlobals';
import { buildConsoleKeywords } from './keywords';
import { firstPassHandlers } from './passes/firstPass';
import { secondPassHandlers } from './passes/secondPass';
import { thirdPassHandlers } from './passes/thirdPass';
import { analyzeScopes, setScopeAnalysis, resetScopeAnalysis } from './scopeAnalysis';
import { applyClosedObjectRename } from './transforms/closedObjectRename';
import { applyClosedClassRename } from './transforms/closedClassRename';
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
import { applyNoiseInjection } from './transforms/noiseInjection';
import { applySelfIntegrity } from './transforms/selfIntegrity';
import { applyRegexEncoding } from './transforms/regexEncoding';
import { applyTemplateLiteralFlattening } from './transforms/templateLiteralFlattening';
import { ObfuscateOptions, DEFAULT_OPTIONS, BloatBudget, computeBloatBudget } from './options';
import { setDonorStatements, clearDonorStatements } from './transforms/deadCodeInjection';
import { setStringArrayDecoys, clearStringArrayDecoys } from './transforms/stringArrayExtraction';
import { buildCrossFilePrelude } from './transforms/crossFileTransplant';
import { makeDispatchPlan, normalizeFileExports, pickSlotForFile } from './transforms/exportNormalization';

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
  resetIssuedNames();
  resetCapturedGlobals();
  resetScopeAnalysis();

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

  // Closed-* rename transforms run VERY early — before any structural
  // pre-transform (proxyFunctions in particular) rewrites the shapes
  // they rely on. proxyFunctions turns `obj.method(a, b)` into a call
  // through a dispatcher (`_mc(obj, "method", a, b)`) — the
  // MemberExpression disappears, so closedClassRename's access-site
  // scan would miss everything. Running these here also means we
  // don't pay for a pointless scope analysis of the already-renamed
  // shapes; the main scope analysis that feeds firstPass/secondPass
  // runs later against the post-pre-transform AST.
  //
  //   closedObjectRename: `const obj = {...}` whose refs never escape
  //   → rename every property key and every `obj.X` access site.
  //   closedClassRename:  `class Foo {...}` whose binding only sees
  //   `new Foo()` / `x instanceof Foo` → rename every instance
  //   method/field and every provably-Foo receiver's `.X` site.
  //
  // Both transforms take a ScopeAnalysis purely to identify which
  // Identifier nodes refer to the same binding; they don't need the
  // assigned rename strings from that analysis.
  const earlyAnalysis = analyzeScopes(ast.program);
  applyClosedObjectRename(ast, earlyAnalysis);
  applyClosedClassRename(ast, earlyAnalysis);

  // Anti-debugging: inject eval("debugger") traps and setInterval loops.
  // Runs before all other transforms so debugger strings get encoded.
  if (budget.maxBloatRatio > 3) {
    applyAntiDebug(ast);
  }

  // Punctured program tripwires (Paper 4: Sahai & Waters)
  // Hidden checks that trigger corruption on secret inputs.
  if (budget.maxBloatRatio > 3) {
    applyTripwires(ast);
  }

  // LPN-inspired noise injection (Paper 7: Jain, Lin, Sahai)
  // Adds and cancels random noise through split paths.
  if (budget.maxBloatRatio > 5) {
    applyNoiseInjection(ast);
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

  // Scope analysis: build per-binding rename table so references in
  // different scopes can pick different renders, and genuine free
  // references (globals we haven't listed as keywords) don't get swept
  // up by the flat name map. Must run after every transform that
  // introduces identifiers (CFF state vars, proxy dispatchers, etc.) so
  // those are analyzed too, and before firstPass so secondPass can read
  // the scope-resolved names. A second analysis (separate from the
  // earlyAnalysis used by the closed-* transforms above) so the rename
  // pass sees every identifier the pre-transforms have since added.
  setScopeAnalysis(analyzeScopes(ast.program));

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

  // Post-transform: regex encoding
  // Converts /pattern/flags to new RegExp("pattern", "flags") so the
  // pattern strings flow through string array extraction.
  applyRegexEncoding(ast);

  if (process.env.EGODEATH_DEBUG_REGEXP) {
    const count = (recast.print(ast).code.match(/=\s*RegExp\b/g) || []).length;
    process.stderr.write('[after regexEnc] RegExp count: ' + count + '\n');
  }

  // Template literal flattening: rewrite `foo ${x} bar` into
  // "foo " + x + " bar" so the quasi strings land as plain
  // StringLiterals that the next pass can pack into the string
  // array. Without this, template literals' static text survives
  // verbatim through every obfuscation layer. Must run before
  // stringArrayExtraction so the emitted literals get collected.
  applyTemplateLiteralFlattening(ast);

  // Post-transform: string array extraction + rotation
  // Collects all string literals into a rotated array, replaces with accessor calls
  // Runs last so it captures all strings including global+property name strings
  applyStringArrayExtraction(ast, budget);

  if (process.env.EGODEATH_DEBUG_REGEXP) {
    const count = (recast.print(ast).code.match(/=\s*RegExp\b/g) || []).length;
    process.stderr.write('[after stringArrayExt] RegExp count: ' + count + '\n');
  }

  // Self-integrity verification (Paper 10: dual-mode hash check)
  // Checks that eval, toString, and code structure haven't been tampered with.
  // Runs after all transforms so it checks the final obfuscated form.
  if (budget.maxBloatRatio > 5) {
    applySelfIntegrity(ast);
  }

  if (process.env.EGODEATH_DEBUG_REGEXP) {
    const code = recast.print(ast).code;
    const count = (code.match(/=\s*RegExp\b/g) || []).length;
    const vars = ast.program.body.filter((s: any) => s.type === 'VariableDeclaration').length;
    process.stderr.write('[pre-console-prepend] RegExp count: ' + count + ' body.len=' + ast.program.body.length + ' vars=' + vars + '\n');
  }

  // Flush built-in-global captures (RegExp, etc.) into ast.program.body
  // as the outermost declarations. Must happen after every transform that
  // might call captureGlobal(), and before the console-stub prepend so
  // captures land at program position 0 — guaranteeing they run before
  // any use site, even when source code later shadows the global with
  // `var RegExp = …` (lodash runInContext). See capturedGlobals.ts.
  flushCapturedGlobals(ast);

  const consoleKeywords = buildConsoleKeywords();
  ast.program.body = consoleKeywords.concat(ast.program.body);

  // Strip original source positions from every node before printing.
  // Recast preserves original whitespace/ASI when a node still carries its
  // parse-time `start`/`end`/`loc`. For code we've structurally rewritten
  // (and we rewrite almost everything), that preservation resurrects
  // hazards — notably ASI-reliant inputs like `const x = f()\nexports = ...`
  // get reprinted with no semicolon, so wrapping the next statement in
  // `(…)` via contextExhaustion turns two statements into a call
  // (`f()(…)`) and silently changes semantics. Force fresh formatting.
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any) {
      // Some of these are non-configurable on recast Node instances, so
      // delete may throw. Fall back to assignment, which is what recast
      // checks.
      try { delete node.start; } catch { node.start = undefined; }
      try { delete node.end; } catch { node.end = undefined; }
      try { delete node.loc; } catch { node.loc = undefined; }
      try { delete node.range; } catch { node.range = undefined; }
      try { delete node.original; } catch { node.original = undefined; }
    },
    fallback: 'iteration',
  } as any);

  let output = shebang + recast.print(ast).code;

  // Normalize CRLF → LF so terser and regex fallback work on all platforms
  output = output.replace(/\r\n?/g, '\n');

  // Safety net: recast prints `UnaryExpression(-, NumericLiteral(-n))` as
  // "--n" with no separator — the two `-` glyphs collide into the decrement
  // token, which is only valid on an lvalue and raises "Invalid left-hand
  // side expression in prefix operation" on load. Transforms try to avoid
  // emitting that structure, but rare construction paths still sneak it
  // through. Normalize by inserting a space between `--` and a following
  // digit so the two unary minuses stay separate tokens. `--ident` (prefix
  // decrement on a variable) is untouched because the regex anchors on a
  // trailing digit.
  output = output.replace(/--(\d)/g, '- -$1');

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

  // Re-apply the `--digit` safety net after minification/fallback — both
  // paths can re-collapse whitespace in ways that could resurface the
  // decrement-on-literal token (e.g., a `-\n-1` sequence becoming `--1`
  // when newlines are stripped in the fallback path).
  output = output.replace(/--(\d)/g, '- -$1');

  return output;
}

/** Maximum AST node count a donor statement may have. */
const MAX_DONOR_NODES = 40;

/**
 * Cheap size check: count AST descendants up to `limit`. Returns the
 * count (capped at limit + 1). Used to reject donor statements whose
 * subtrees are too large to clone cheaply — without this, a single
 * webpack IIFE ExpressionStatement wrapping 10k nodes would poison
 * the donor pool and every subsequent `generateMutatedCode` call
 * would deep-clone it.
 */
function countNodesBounded(node: any, limit: number): number {
  if (!node || typeof node !== 'object') return 0;
  let count = 1;
  const stack: any[] = [node];
  while (stack.length > 0 && count <= limit) {
    const n = stack.pop();
    for (const key of Object.keys(n)) {
      if (key === 'loc' || key === 'start' || key === 'end' ||
          key === 'extra' || key === 'comments' || key === 'leadingComments' ||
          key === 'trailingComments' || key === 'innerComments' || key === 'range') {
        continue;
      }
      const v = n[key];
      if (Array.isArray(v)) {
        for (const vv of v) {
          if (vv && typeof vv === 'object') { count++; stack.push(vv); }
          if (count > limit) return count;
        }
      } else if (v && typeof v === 'object') {
        count++;
        stack.push(v);
        if (count > limit) return count;
      }
    }
  }
  return count;
}

/**
 * Collect statements from an AST for use as donor material in
 * cross-file dead code mutation. Only collects "simple" statements
 * (variable declarations and expression statements) whose subtrees
 * stay under `MAX_DONOR_NODES` — generateMutatedCode deep-clones
 * every selected donor, so a single giant statement (IIFE-wrapped
 * bundle closure, long object literal, etc.) dominates the per-file
 * obfuscation cost even when the donor pool is capped at 200.
 *
 * Uses @babel/parser directly rather than recast: we only need a
 * plain AST to read statements out of, and recast's position-
 * preserving parser is ~10x slower for no benefit here.
 */
function collectDonorStatements(code: string): any[] {
  const babelParser = require('@babel/parser');
  let ast: any;
  try {
    ast = babelParser.parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: [],
    });
  } catch {
    return [];
  }
  const donors: any[] = [];
  const SIMPLE_TYPES = new Set([
    'VariableDeclaration',
    'ExpressionStatement',
    'ReturnStatement',
  ]);

  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any) {
      if (!SIMPLE_TYPES.has(node.type)) return;
      // Reject-but-recurse: countNodesBounded is O(MAX_DONOR_NODES)
      // so the extra work is small, and by continuing traversal we
      // still collect small simple statements nested inside giant
      // IIFEs or assignment expressions — useful donors the
      // collection would otherwise miss.
      if (countNodesBounded(node, MAX_DONOR_NODES) <= MAX_DONOR_NODES) {
        donors.push(node);
      }
    },
    fallback: 'iteration',
  } as any);

  return donors;
}

/** Cap for the cross-file donor pool to avoid OOM on large bundles. */
const MAX_DONOR_STATEMENTS = 200;

/**
 * Size of the shared identifier pool when `shareIdentifiers` is on.
 * A single obfuscate() run over a modest input issues a few hundred
 * to a few thousand `gen()` calls across renamer + transforms. 30k
 * covers files well into the tens-of-KB raw-source range before
 * the fallback-to-random path kicks in for the tail.
 */
const SHARED_POOL_SIZE = 30_000;

/**
 * Cap on the cross-file string-decoy pool. The pool is unioned across
 * every input file, so without a ceiling a 50-file bundle with rich
 * literal content could push thousands of strings into every other
 * file's array. 800 strings × 4 hex chars × avg length 10 is ≈ 32KB
 * of decoy payload per file — enough to normalize the visible
 * preamble without dominating output size.
 */
const MAX_DECOY_POOL = 800;

/**
 * Walk a file's AST once with @babel/parser and return every string
 * value that would plausibly land in its string array: source
 * `StringLiteral` values plus `TemplateElement` cooked values
 * (templateLiteralFlattening later turns these into StringLiterals).
 *
 * Skips shapes `stringArrayExtraction` would exclude anyway — require
 * arguments, import/export sources, directive prologues, and empty
 * strings — so the union of these sets across files is a realistic
 * approximation of the real array contents. The approximation is
 * coarse (transform-injected strings like antiDebug's "debugger"
 * payloads aren't counted), but good enough for the decoy set — the
 * point is to pad each file's visible array, not to exactly match
 * the post-transform content.
 */
function collectExtractableStrings(code: string): Set<string> {
  const babelParser = require('@babel/parser');
  let ast: any;
  try {
    ast = babelParser.parse(code, {
      sourceType: 'unambiguous',
      errorRecovery: true,
      plugins: [],
    });
  } catch {
    return new Set();
  }
  const out = new Set<string>();
  estraverse.traverse(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any, parent: any) {
      if (node.type === 'StringLiteral' || (node.type === 'Literal' && typeof node.value === 'string')) {
        const v = node.value;
        if (typeof v !== 'string' || v === '') return;
        // Replicate the minimum exclusions so decoys don't include
        // import paths or property keys that the real pass wouldn't.
        if (parent) {
          if (parent.type === 'CallExpression' && parent.callee && parent.callee.type === 'Identifier' && parent.callee.name === 'require') return;
          if (parent.type === 'CallExpression' && parent.callee && parent.callee.type === 'Import') return;
          if (parent.type === 'ImportDeclaration' || parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportAllDeclaration') return;
          if ((parent.type === 'Property' || parent.type === 'ObjectProperty') && parent.key === node) return;
          if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
          if (parent.type === 'ExpressionStatement' && parent.directive != null) return;
        }
        out.add(v);
      } else if (node.type === 'TemplateElement') {
        const cooked = node.value && typeof node.value.cooked === 'string' ? node.value.cooked : '';
        if (cooked) out.add(cooked);
      }
    },
    fallback: 'iteration',
  } as any);
  return out;
}

/**
 * Obfuscate multiple JavaScript files, using code from ALL files as
 * donor material for dead code mutation.
 *
 * Dead code in each output file will be mutated from statements drawn
 * from every input file, making structural analysis harder because
 * the dead code doesn't necessarily match any code in the same file.
 *
 * @param files   - Array of {filename, code} pairs
 * @param options - Optional configuration (target token budget, etc.)
 * @returns Array of {filename, code} pairs with obfuscated output
 */
export function obfuscateMultiple(
  files: { filename: string; code: string }[],
  options?: Partial<ObfuscateOptions>,
): { filename: string; code: string }[] {
  // Phase 1: collect donor statements from ALL files
  let allDonors: any[] = [];
  for (const file of files) {
    allDonors.push(...collectDonorStatements(file.code));
  }

  // Cap the pool to avoid OOM on large bundles — randomly sample
  if (allDonors.length > MAX_DONOR_STATEMENTS) {
    const sampled: any[] = [];
    for (let i = 0; i < MAX_DONOR_STATEMENTS; i++) {
      const idx = Math.floor(Math.random() * allDonors.length);
      sampled.push(allDonors[idx]);
      // Swap-remove to avoid picking the same one twice
      allDonors[idx] = allDonors[allDonors.length - 1];
      allDonors.pop();
    }
    allDonors = sampled;
  }

  // Phase 2: cross-file string-array normalization.
  //
  // Each file's string array would otherwise be a fingerprint —
  // different length, different length distribution, depending only
  // on that file's own literals. A reader looking at a batch can then
  // tell files apart at a glance. To prevent this we pre-collect a
  // union of every file's source strings, cap it, and pass each file
  // the union minus its own so every output ends up with an array of
  // comparable length and similar character-length distribution.
  // Decoys are real strings from other files in the batch, so they
  // look indistinguishable from legitimate entries.
  const perFileStrings = files.map((f) => collectExtractableStrings(f.code));
  const unionStrings = new Set<string>();
  for (const s of perFileStrings) for (const str of s) unionStrings.add(str);

  let decoyPool = Array.from(unionStrings);
  if (decoyPool.length > MAX_DECOY_POOL) {
    // Random sample; destructive swap-remove to avoid picking the
    // same string twice. Caller doesn't see the original pool, so
    // mutating it in place is fine.
    const sampled: string[] = [];
    for (let i = 0; i < MAX_DECOY_POOL && decoyPool.length > 0; i++) {
      const idx = Math.floor(Math.random() * decoyPool.length);
      sampled.push(decoyPool[idx]);
      decoyPool[idx] = decoyPool[decoyPool.length - 1];
      decoyPool.pop();
    }
    decoyPool = sampled;
  }

  // Phase 3: set the shared donor pool and obfuscate each file with
  // its file-specific decoy set.
  //
  // Before obfuscating each file, we source-level-prepend a
  // cross-file transplant prelude built from every SIBLING file's
  // source. The prelude carries:
  //   (A) live references to sibling string literals (so after
  //       string-array extraction, sibling-string indexes are
  //       accessed from live code paths, not just present as inert
  //       array entries),
  //   (B) sibling top-level declarations — function bodies, classes,
  //       var statements — embedded inside an IIFE that sits in an
  //       opaque-false branch.
  // Both payloads are unreachable at runtime (the guard is always
  // false for any integer) but syntactically live, so the
  // downstream renamer, CFF, opaque-predicate, proxy-function, and
  // string-array passes process them exactly like real code. The
  // merged AST for each output now contains every sibling's
  // function declarations and reachable-string set — dissolving
  // the "which source did this come from" signal a static reader
  // (human or LLM) could otherwise use.
  // Optional: API surface normalization (opt-in). When enabled,
  // every file gets its CommonJS exports rewritten into a shared
  // dispatch shape — same key set, same number of slots — with the
  // real default export landing at a per-file slot. The rewrite is
  // a source-level transform run *before* the rest of the pipeline,
  // so downstream obfuscation processes the normalized shape
  // uniformly (renames, property-key-encodes, string-arrayifies)
  // exactly as it would any other source. The dispatch plan is
  // generated once here and reused for every file in the batch, so
  // the key set is byte-identical at the source level across files.
  const normalizeExports = Boolean((options || {}).normalizeExports);
  const dispatchPlan = normalizeExports ? makeDispatchPlan() : null;

  // Optional: identifier-pool sharing. When enabled, generate a
  // single pool of random identifiers up front and reinstall it
  // (resetting the draw index) before each file's obfuscate() call.
  // The Nth gen() call in every file then returns the same name,
  // so renamed identifiers at matching positions collide across
  // siblings. Pool size is a generous upper bound on the number of
  // gen() calls a single file makes — an obfuscate() run over a
  // ~100KB input typically issues 1-3k names across all transforms;
  // 30k covers very large inputs, with fresh-random fallback for
  // anything that exhausts it.
  const shareIdentifiers = Boolean((options || {}).shareIdentifiers);
  const sharedPool = shareIdentifiers ? generateSharedNamePool(SHARED_POOL_SIZE) : null;

  setDonorStatements(allDonors);
  let results: { filename: string; code: string }[];
  try {
    results = files.map((file, i) => {
      const own = perFileStrings[i];
      const decoys = decoyPool.filter((s) => !own.has(s));
      setStringArrayDecoys(decoys);
      // Reinstall the pool before EACH file's obfuscate() call so
      // the draw index is 0 and every file walks the same sequence
      // from the start. Done inside the loop (not once outside) so
      // the finally in the outer try still clears the pool even if
      // this file's obfuscate() throws mid-pass.
      if (sharedPool) setSharedNamePool(sharedPool);
      try {
        const siblingSources = files
          .filter((_, j) => j !== i)
          .map((f) => f.code);
        const prelude = buildCrossFilePrelude(siblingSources);
        // Apply export normalization to the file's own source
        // BEFORE merging with the prelude. The prelude is guarded
        // sibling code that never executes and shouldn't carry the
        // current file's export surface; only the file's own body
        // needs its exports rewritten.
        const ownCode = dispatchPlan
          ? normalizeFileExports(file.code, dispatchPlan, pickSlotForFile(dispatchPlan, i))
          : file.code;
        const merged = prelude + ownCode;
        return {
          filename: file.filename,
          code: obfuscate(merged, options),
        };
      } finally {
        clearStringArrayDecoys();
      }
    });
  } finally {
    clearDonorStatements();
    // Always clear the pool after the batch — leaving it installed
    // would cause the NEXT obfuscate() call from anywhere in the
    // process to keep drawing from this batch's pool.
    if (sharedPool) clearSharedNamePool();
  }

  // Phase 4: post-pass length equalization.
  //
  // Pre-pass decoys (Phase 3) normalize the *source-derived* portion
  // of each file's array, but the random transforms (antiDebug,
  // tripwires, CFF dead code, opaque predicates, …) inject wildly
  // varying amounts of additional strings depending on each run's
  // RNG. Two files with identical sources can still come out with
  // arrays differing by 50+ entries. The only way to guarantee
  // visually identical array lengths is to fix it up after the fact.
  //
  // We parse each output, find the string array, compute the max
  // length, and pad every shorter array by appending hex entries
  // borrowed from siblings — the hex is valid, the same character-
  // length distribution as the rest of the file's array, and we
  // also bump the accessor's hardcoded loop bound so the decoder
  // processes the appended entries (they decode to garbage the
  // runtime never reads, but the arrayLen-vs-array-length shape
  // stays consistent for a static inspector).
  return normalizeStringArrays(results);
}

// ---- Post-pass string-array length equalization ----

/**
 * Walk a program body looking for the string array declaration
 * emitted by `applyStringArrayExtraction` — the first
 * VariableDeclaration whose declarator initializer is an
 * ArrayExpression of StringLiterals. Returns both the declarator and
 * the array node so the caller can mutate in place.
 */
function findStringArrayDecl(program: any): { arrayExpr: any } | null {
  for (const stmt of program.body || []) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const d of stmt.declarations || []) {
      const init = d && d.init;
      if (
        init &&
        init.type === 'ArrayExpression' &&
        Array.isArray(init.elements) &&
        init.elements.length > 0 &&
        init.elements.every(
          (e: any) => e && (e.type === 'StringLiteral' || (e.type === 'Literal' && typeof e.value === 'string')),
        )
      ) {
        return { arrayExpr: init };
      }
    }
  }
  return null;
}

/**
 * Find the accessor's outer decode loop — the ForStatement whose
 * header matches `for (var ci = 0; ci < <N>; ci++)` with a numeric
 * right-hand side equal to `currentLen`.  The inner character-by-
 * character loop uses `<v>.length` on its right (not a literal), so
 * the value-match disambiguates even though both loops share the
 * same skeleton. Returns the NumericLiteral so the caller can bump
 * its `.value`.
 */
function findAccessorLengthLiteral(program: any, currentLen: number): any | null {
  let found: any = null;
  estraverse.traverse(program, {
    keys: EXTRA_VISITOR_KEYS,
    enter(node: any) {
      if (found) return (estraverse as any).VisitorOption.Break;
      if (node.type !== 'ForStatement') return;
      if (!node.test || node.test.type !== 'BinaryExpression') return;
      if (node.test.operator !== '<') return;
      const right = node.test.right;
      if (!right) return;
      if (right.type === 'NumericLiteral' || (right.type === 'Literal' && typeof right.value === 'number')) {
        if (right.value === currentLen) {
          found = right;
          return (estraverse as any).VisitorOption.Break;
        }
      }
    },
    fallback: 'iteration',
  } as any);
  return found;
}

/**
 * Equalize every file's string-array length to the longest by
 * appending hex entries borrowed from siblings. Accessor
 * `arrayLen` constants are updated in lockstep so the decoder
 * iterates the full array.
 *
 * Appended entries are valid hex drawn from other files' real
 * arrays — same encoding stride (multiple of 4 chars), same
 * statistical shape. The decoder will produce garbage strings for
 * them when the chain decodes, but those cache slots are never
 * accessed by any code in the file, so the garbage is inert.
 */
function normalizeStringArrays(
  results: { filename: string; code: string }[],
): { filename: string; code: string }[] {
  if (results.length < 2) return results;

  // Parse each file, locate its array. Files without an array (code
  // that was too small to trigger string extraction) are skipped —
  // we don't retroactively add an array to a file that didn't ship
  // one.
  interface FileState {
    filename: string;
    ast: any;
    arrayExpr: any;
    lenLiteral: any | null;
    currentLen: number;
  }
  const states: FileState[] = [];
  for (const r of results) {
    let ast: any;
    try {
      ast = recast.parse(r.code, { parser: require('recast/parsers/babel') });
    } catch {
      states.push({ filename: r.filename, ast: null, arrayExpr: null, lenLiteral: null, currentLen: 0 });
      continue;
    }
    const found = findStringArrayDecl(ast.program);
    if (!found) {
      states.push({ filename: r.filename, ast, arrayExpr: null, lenLiteral: null, currentLen: 0 });
      continue;
    }
    const currentLen = found.arrayExpr.elements.length;
    const lenLiteral = findAccessorLengthLiteral(ast.program, currentLen);
    states.push({ filename: r.filename, ast, arrayExpr: found.arrayExpr, lenLiteral, currentLen });
  }

  // Gather the hex pool: every encoded entry from every file's array,
  // used as the decoy source. Borrowing from siblings (rather than
  // generating fresh random hex) preserves the character-length
  // distribution of real entries.
  const hexPool: string[] = [];
  for (const st of states) {
    if (!st.arrayExpr) continue;
    for (const e of st.arrayExpr.elements) {
      if (e && typeof e.value === 'string' && e.value.length > 0) hexPool.push(e.value);
    }
  }
  if (hexPool.length === 0) return results;

  const maxLen = Math.max(...states.map((s) => s.currentLen));
  if (maxLen === 0) return results;

  const out: { filename: string; code: string }[] = [];
  for (let i = 0; i < states.length; i++) {
    const st = states[i];
    const orig = results[i];
    if (!st.ast || !st.arrayExpr) { out.push(orig); continue; }

    const need = maxLen - st.currentLen;
    if (need <= 0) { out.push(orig); continue; }

    for (let k = 0; k < need; k++) {
      const hex = hexPool[Math.floor(Math.random() * hexPool.length)];
      st.arrayExpr.elements.push({ type: 'StringLiteral', value: hex });
    }
    if (st.lenLiteral) st.lenLiteral.value = maxLen;

    out.push({ filename: st.filename, code: recast.print(st.ast).code });
  }
  return out;
}

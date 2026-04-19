/**
 * Program-level captures for built-in globals that source code may
 * locally shadow.
 *
 * Background: lodash's `runInContext` starts with
 *   var Array = context.Array, Date = context.Date, ... ,
 *       RegExp = context.RegExp, ...
 * `var` hoisting creates those local bindings at the *top* of the
 * function, undefined until the assignment runs. Any obfuscator-injected
 * expression that references e.g. `RegExp` earlier in the function
 * (antiDebug's `eval("debugger<s>".replace(new RegExp("<s>$"), ""))`,
 * propertyKeyEncoding's suffix-strip helper, globalVariableEncoding's
 * eval wrapper, or regexEncoding's rewritten regex literal) then sees
 * the not-yet-assigned local instead of the global and throws
 * `TypeError: RegExp is not a constructor`.
 *
 * Fix: once per obfuscate() run, issue a single program-level capture
 *   var <captureName> = RegExp;
 * and have every transform that wants `RegExp` (or any other commonly
 * shadowed global) reference the capture's unique name instead.
 *
 * The capture declarations are NOT unshifted into ast.program.body at
 * request time — doing so would race with other transforms that also
 * unshift (antiDebug's IIFE, stringArrayExtraction's array decl, etc.)
 * and the capture can end up *after* one of its uses, making the
 * binding hoisted-but-undefined at the use site. Instead,
 * `captureGlobal` just registers a request; the orchestrator calls
 * `flushCapturedGlobals(ast)` at a single well-defined point (after
 * all transforms have produced their code, before console stubs) so
 * every capture decl is guaranteed to sit before every use.
 *
 * Standalone callers that run a single transform in isolation (unit
 * tests) should call `flushCapturedGlobals(ast)` after the transform
 * they're testing; transforms themselves must not call it.
 */

import { gen } from './random';
import { getGlobals } from './globals';

interface CaptureEntry {
  name: string;
  global: string;
}

/**
 * Names of globals we capture. Add more here when a new transform
 * surfaces a hoisting-related shadowing hazard.
 */
const CAPTURABLE_GLOBALS = new Set([
  'RegExp',
  'Array',
  'Date',
  'Error',
  'Function',
  'Math',
  'Object',
  'String',
  'TypeError',
]);

// Per-obfuscation-run state. Keyed by global name, valued by the
// captured local name.
let captures: Map<string, CaptureEntry> = new Map();

/**
 * Clear captured state. Call at the top of every obfuscate() run
 * alongside resetGlobals() / resetIssuedNames().
 */
export function resetCapturedGlobals(): void {
  captures = new Map();
}

/**
 * Return the local identifier name that refers to the captured version
 * of the given global. Safe to call many times — the first call for a
 * given global allocates a fresh name, subsequent calls return the
 * same one.
 *
 * If `secondPass` has already rewritten the bindings map (i.e.
 * `globals[name].___val` is set), the RENAMED form is returned so
 * transforms that run after secondPass still emit references that
 * match the declaration's final renamed identifier.
 *
 * The `ast` argument is accepted for API symmetry with the previous
 * iteration of this module; it is not currently used by this function.
 * Callers still pass it so flushCapturedGlobals(ast) can remain the
 * single sink that mutates ast.program.body.
 */
export function captureGlobal(_ast: any, globalName: string): string {
  if (!CAPTURABLE_GLOBALS.has(globalName)) {
    throw new Error(`capturedGlobals: ${globalName} is not a registered capturable global`);
  }
  const existing = captures.get(globalName);
  const name = existing ? existing.name : gen();
  if (!existing) captures.set(globalName, { name, global: globalName });

  const globals = getGlobals();
  const renamed = (globals as any)[name] && (globals as any)[name].___val;
  return renamed ? renamed : name;
}

/**
 * Flush all registered captures into `ast.program.body` as a run of
 * VariableDeclarations at position 0. Safe to call multiple times:
 * subsequent calls are no-ops (idempotent per-ast via a WeakSet).
 *
 * Call this once, right before final console-stub prepending, so the
 * captures land at the outermost program scope and are guaranteed to
 * run before any use site.
 */
const flushedAsts: WeakSet<object> = new WeakSet();
export function flushCapturedGlobals(ast: any): void {
  if (!ast || !ast.program || !Array.isArray(ast.program.body)) return;
  if (flushedAsts.has(ast)) return;
  flushedAsts.add(ast);
  const globals = getGlobals();
  const decls: any[] = [];
  for (const entry of captures.values()) {
    // If secondPass renamed the captured identifier (entry.name was
    // registered by firstPass because a transform that ran before
    // firstPass emitted `new <name>(…)` into the AST), use the RENAMED
    // form here. Every use site in the tree was rewritten to that
    // renamed form, so the declaration must match or it won't bind.
    const renamed = (globals as any)[entry.name] && (globals as any)[entry.name].___val;
    const declName = renamed ? renamed : entry.name;
    // The init `{type:'Identifier', name: globalName}` is flagged so
    // later transforms (in particular globalVariableEncoding) know to
    // skip it — encoding RegExp in `var X = RegExp;` would make the
    // capture's init depend on the capture itself.
    const initNode: any = {
      type: 'Identifier',
      name: entry.global,
      __capturedGlobalInit: true,
    };
    decls.push({
      type: 'VariableDeclaration',
      kind: 'var',
      declarations: [{
        type: 'VariableDeclarator',
        id: { type: 'Identifier', name: declName },
        init: initNode,
      }],
      __capturedGlobalDecl: true,
    });
  }
  if (decls.length > 0) ast.program.body = decls.concat(ast.program.body);
}

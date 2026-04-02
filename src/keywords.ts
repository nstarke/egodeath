import * as recast from 'recast';

const Window = require('window');

/**
 * Dynamically detect all function properties on the console object
 * and generate no-op stubs for each.
 */
export function buildConsoleKeywords(): any[] {
  const methods = Object.getOwnPropertyNames(console)
    .filter((p) => {
      try {
        return typeof (console as any)[p] === 'function' && !p.startsWith('_');
      } catch { return false; }
    });

  return methods.map((method) => {
    return recast.parse(`console.${method} = function (){};\n`, {
      parser: require('recast/parsers/babel'),
    }).program.body.pop();
  });
}

/**
 * Names that should never be obfuscated or encoded, regardless of source.
 * These are structural identifiers that JavaScript/Node.js rely on.
 */
const NEVER_OBFUSCATE = new Set([
  // Module system
  'exports', 'module', 'require', 'arguments',
  // Special values
  'undefined', 'NaN', 'Infinity',
  // Reserved tokens used as property accessors
  'window', 'console', 'global', 'globalThis', 'self',
  'window.document',
  // Literal-like values from the original code
  '"a"', '1', '["a"]', '{a:2}',
]);

/**
 * Dynamically build the global keywords list by introspecting:
 * 1. The `window` package (browser globals — DOM APIs, constructors)
 * 2. Node.js `globalThis` (built-in modules, constructors, functions)
 * 3. Prototype properties of all discovered constructors
 *
 * Everything discovered is treated as a keyword — it won't be
 * renamed by the identifier passes.
 */
export function buildKeywords(): string[] {
  const keywords = new Set<string>(NEVER_OBFUSCATE);

  // --- Source 1: window package (browser-like globals) ---
  try {
    const win = new Window();
    for (const name of Object.getOwnPropertyNames(win)) {
      if (name.startsWith('_')) continue; // skip internal props
      keywords.add(name);
      try {
        const val = win[name];
        if (val && typeof val === 'function' && val.prototype) {
          for (const prop of Object.getOwnPropertyNames(val.prototype)) {
            keywords.add(prop);
          }
        }
        if (val && typeof val === 'object') {
          for (const prop of Object.getOwnPropertyNames(val)) {
            keywords.add(prop);
          }
        }
      } catch { /* some properties throw on access */ }
    }
  } catch { /* window package may fail in some environments */ }

  // --- Source 2: Node.js globalThis ---
  try {
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (name.startsWith('_')) continue;
      keywords.add(name);
      try {
        const val = (globalThis as any)[name];
        if (val && typeof val === 'function' && val.prototype) {
          for (const prop of Object.getOwnPropertyNames(val.prototype)) {
            keywords.add(prop);
          }
        }
        if (val && typeof val === 'object' && val !== null) {
          for (const prop of Object.getOwnPropertyNames(val)) {
            keywords.add(prop);
          }
        }
      } catch { /* some globals throw on access */ }
    }
  } catch {}

  // --- Source 3: Additional DOM/Node property names that must be preserved ---
  const extraProps = [
    'subarray', 'getPrototypeOf', 'getOwnPropertyNames',
    'hasOwnProperty', 'createElement', 'appendChild',
    'setAttribute', 'cloneNode', 'innerHTML', 'lastChild',
    'createHTMLDocument', 'body', 'childNodes',
    'prototype', 'constructor', '__proto__',
  ];
  for (const prop of extraProps) {
    keywords.add(prop);
  }

  // Remove 'catch' — it's a method name we want to be able to obfuscate
  // (the original code explicitly deleted it)
  keywords.delete('catch');

  return Array.from(keywords);
}

/**
 * Dynamically build the set of global names that can be recovered
 * via eval("Name") at runtime. Used by global variable encoding.
 *
 * Only includes constructors, objects, and functions — not values
 * like undefined/NaN, not module-system identifiers, and not
 * properties that are only meaningful on an object (like 'length').
 */
export function buildEncodableGlobals(): Set<string> {
  const globals = new Set<string>();

  // Collect from globalThis — these are the names that eval("X")
  // will resolve to the correct value at runtime
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (name.startsWith('_')) continue;
    try {
      const val = (globalThis as any)[name];
      // Only encode functions and non-null objects (constructors, namespaces)
      if (typeof val === 'function' || (typeof val === 'object' && val !== null)) {
        globals.add(name);
      }
    } catch { /* skip inaccessible */ }
  }

  // Also add browser globals from the window package that are
  // commonly referenced in client-side code
  try {
    const win = new Window();
    for (const name of Object.getOwnPropertyNames(win)) {
      if (name.startsWith('_')) continue;
      try {
        const val = win[name];
        if (typeof val === 'function' || (typeof val === 'object' && val !== null)) {
          globals.add(name);
        }
      } catch {}
    }
  } catch {}

  // Remove things that should NOT be eval-encoded
  const skipEval = [
    'eval', 'require', 'module', 'exports', 'arguments',
    'console', 'window', 'global', 'globalThis', 'self',
    'process', 'Buffer', 'undefined', 'NaN',
    // Node built-in module names (these are strings, not constructors)
    'fs', 'path', 'http', 'https', 'net', 'os', 'url', 'util',
    'crypto', 'stream', 'events', 'assert', 'cluster', 'dns',
    'domain', 'readline', 'repl', 'tls', 'tty', 'v8', 'vm', 'zlib',
    'child_process', 'dgram', 'http2', 'inspector', 'perf_hooks',
    'worker_threads', 'string_decoder', 'querystring', 'punycode',
    'sys', 'constants', 'timers', 'diagnostics_channel', 'wasi',
    'async_hooks', 'trace_events', 'buffer',
    // Frame/timing functions that shouldn't be eval'd
    'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout',
    'setImmediate', 'clearImmediate', 'queueMicrotask', 'fetch',
    'structuredClone', 'atob', 'btoa',
  ];
  for (const name of skipEval) {
    globals.delete(name);
  }

  return globals;
}

// --- Cached instances ---

let _keywords: string[] | null = null;
let _encodableGlobals: Set<string> | null = null;

export function getKeywords(): string[] {
  if (!_keywords) {
    _keywords = buildKeywords();
  }
  return _keywords;
}

export function getEncodableGlobals(): Set<string> {
  if (!_encodableGlobals) {
    _encodableGlobals = buildEncodableGlobals();
  }
  return _encodableGlobals;
}

export function isKeyword(prop: string): boolean {
  return getKeywords().indexOf(prop) !== -1;
}

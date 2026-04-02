import * as recast from 'recast';

const Window = require('window');
const win = new Window();

/**
 * Console method stubs injected into obfuscated output.
 */
export const CONSOLE_METHODS = [
  'assert', 'clear', 'count', 'error', 'group',
  'groupCollapsed', 'groupEnd', 'info', 'log',
  'table', 'time', 'timeEnd', 'trace', 'warn',
];

export function buildConsoleKeywords(): any[] {
  return CONSOLE_METHODS.map((method) => {
    return recast.parse(`console.${method} = function (){};\n`, {
      parser: require('recast/parsers/babel'),
    }).program.body.pop();
  });
}

/**
 * Base keywords that should never be obfuscated.
 */
const BASE_KEYWORDS: string[] = [
  'Array', 'Math', 'Object', 'Function', 'Boolean', 'Symbol',
  'Error', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'TypeError', 'URIError', 'Number', 'Date', 'Infinity', 'String',
  'RegExp', 'Array', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray',
  'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView',
  'JSON', 'Promise', 'Reflect', 'Proxy', 'window', 'arguments',
  'console', 'exports', 'module', 'require', 'window.document',
  '"a"', '1', '["a"]', '{a:2}',
  'unescape', 'escape', 'decodeURIComponent', 'decodeURI',
  'encodeURIComponent', 'encodeURI',
];

/**
 * Additional property names extracted from built-in prototypes.
 */
const EXTRA_PROPS: string[] = [
  'subarray', 'not', 'getPrototypeOf', 'getOwnPropertyNames',
  'hasOwnProperty', 'createElement', 'resolveWith', 'appendChild',
  'setAttribute', 'cloneNode', 'innerHTML', 'lastChild',
  'createHTMLDocument', 'body', 'childNodes', 'rejectWith', 'notifyWith',
];

/**
 * Build the full keywords list by combining base keywords with
 * properties from their prototypes.
 */
export function buildKeywords(): string[] {
  let props = [...EXTRA_PROPS];

  BASE_KEYWORDS.forEach((key) => {
    try {
      const evald = eval(key);
      props = props.concat(Object.getOwnPropertyNames(evald));
      if (evald.prototype) {
        props = props.concat(Object.getOwnPropertyNames(evald.prototype));
      }
    } catch {
      // Some keywords may not eval in Node context — skip them
    }
  });

  const keywords = [...BASE_KEYWORDS, ...props];
  // Remove 'catch' from keywords (matches original behavior)
  const catchIdx = keywords.indexOf('catch');
  if (catchIdx !== -1) {
    delete keywords[catchIdx];
  }

  return keywords;
}

let _keywords: string[] | null = null;

/**
 * Get the cached keywords list.
 */
export function getKeywords(): string[] {
  if (!_keywords) {
    _keywords = buildKeywords();
  }
  return _keywords;
}

/**
 * Check if a property name is a reserved keyword that should not be obfuscated.
 */
export function isKeyword(prop: string): boolean {
  return getKeywords().indexOf(prop) !== -1;
}

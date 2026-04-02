import * as crypto from 'crypto';
import * as estraverse from 'estraverse';
import * as recast from 'recast';
import { gen } from '../random';

// jsfuck replaced with compact XOR+hex encoding

// ---- Chained XOR+Hex encoding (Paper 2: Kilian-style) ----
//
// Each string's XOR key depends on the decoded content of the PREVIOUS
// string in the array. This creates a decryption chain: you cannot
// decode string N without first decoding strings 0 through N-1.
//
// Chain: key[0] = seed
//        key[i] = (key[i-1] ^ simpleHash(string[i-1]) ^ (i * prime)) & 0xFF || 1
//
// At runtime, the accessor must decode the entire chain on first call,
// then cache all results. Individual subsequent accesses are O(1).

/**
 * Simple hash of a string — sum of char codes modulo 256.
 * Used to derive the chain key for the next entry.
 */
function simpleStringHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h + str.charCodeAt(i)) & 0xFF;
  }
  return h;
}

/**
 * Compute the chained XOR keys for all strings in order.
 * Returns an array of keys where key[i] depends on the decoded string[i-1].
 */
function computeChainKeys(strings: string[], seed: number, prime: number): number[] {
  const keys: number[] = [];
  let prevKey = seed;

  for (let i = 0; i < strings.length; i++) {
    const key = ((prevKey ^ (i * prime)) & 0xFF) || 1;
    keys.push(key);
    // Chain: next key depends on current string's content
    prevKey = (key ^ simpleStringHash(strings[i])) & 0xFF;
  }

  return keys;
}

/**
 * XOR-encode a string with a given key and return as hex.
 */
function xorHexEncodeWithKey(str: string, key: number): string {
  let hex = '';
  for (let i = 0; i < str.length; i++) {
    const encoded = str.charCodeAt(i) ^ key;
    hex += encoded.toString(16).padStart(2, '0');
  }
  return hex;
}

// ---- Helpers ----

function randInt(min: number, max: number): number {
  return min + (crypto.randomBytes(4).readUInt32BE(0) % (max - min + 1));
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomBytes(4).readUInt32BE(0) % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

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
};

// ---- Exclusion checks ----

function isRequireCall(parent: any): boolean {
  if (parent.type === 'CallExpression') {
    const c = parent.callee;
    if (c && c.type === 'Identifier' && c.name === 'require') return true;
  }
  return false;
}

function isDynamicImport(parent: any): boolean {
  return parent.type === 'CallExpression' && parent.callee?.type === 'Import';
}

function isImportExportSource(parent: any): boolean {
  return parent.type === 'ImportDeclaration' ||
    parent.type === 'ExportNamedDeclaration' ||
    parent.type === 'ExportAllDeclaration';
}

function isPropertyKey(node: any, parent: any): boolean {
  if (parent.type === 'Property' || parent.type === 'ObjectProperty') {
    return parent.key === node;
  }
  if (parent.type === 'MemberExpression') {
    return parent.property === node && !parent.computed;
  }
  return false;
}

function isDirective(parent: any): boolean {
  return parent.type === 'ExpressionStatement' && parent.directive != null;
}

/**
 * Should this string literal be excluded from extraction?
 */
function shouldExclude(node: any, parent: any): boolean {
  if (isRequireCall(parent)) return true;
  if (isDynamicImport(parent)) return true;
  if (isImportExportSource(parent)) return true;
  if (isPropertyKey(node, parent)) return true;
  if (isDirective(parent)) return true;
  // Empty strings are not worth extracting
  if (node.value === '') return true;
  return false;
}

// ---- Core transform ----

interface StringEntry {
  value: string;
  /** Index in the final (post-rotation) array */
  finalIndex: number;
}

/**
 * Apply string array extraction + rotation to an AST.
 *
 * 1. Walk AST, collect all eligible string literals, deduplicate
 * 2. Shuffle strings, assign each a final index
 * 3. Pick a rotation offset R and base index offset B
 * 4. Pre-rotate the array so after runtime rotation it's in the right order
 * 5. Replace each string literal with accessorFn(finalIndex + B)
 * 6. Prepend: array declaration, rotation IIFE, accessor function
 */
export function applyStringArrayExtraction(ast: any, budget?: any): void {
  const arrayName = gen();
  const accessorName = gen();

  // XOR cipher constants (random per obfuscation run)
  const xorPrime = [3, 5, 7, 11, 13, 17, 19, 23, 29, 31][randInt(0, 9)];
  const xorSeed = randInt(1, 255);

  // ---- Pass 1: Collect strings ----

  const stringMap = new Map<string, number>(); // value → finalIndex
  const replacements: { node: any; parent: any }[] = [];

  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any, parent: any) {
      const isStr =
        (node.type === 'StringLiteral') ||
        (node.type === 'Literal' && typeof node.value === 'string');

      if (!isStr) return;
      if (shouldExclude(node, parent)) return;

      const val = node.value as string;
      if (!stringMap.has(val)) {
        stringMap.set(val, 0); // index assigned after shuffle
      }
      replacements.push({ node, parent });
    },
    fallback: 'iteration',
  } as any);

  if (stringMap.size === 0) return;

  // ---- Build shuffled array ----

  const strings = Array.from(stringMap.keys());
  shuffle(strings);

  // Assign final indices (post-rotation order)
  strings.forEach((s, i) => stringMap.set(s, i));

  // ---- Base offset (no rotation — chaining requires sequential order) ----

  const baseOffset = randInt(50, 500);

  // With chained encoding (Paper 2), each entry's key depends on the
  // decoded content of the previous entry. This means the array must
  // stay in its build-time order — rotation would break the chain.
  // The chain itself provides protection: you can't decode entry N
  // without first decoding entries 0 through N-1.
  const orderedStrings = strings; // shuffled but not rotated

  // ---- Pass 2: Replace string nodes with accessor calls ----

  for (const { node } of replacements) {
    const val = node.value as string;
    const finalIndex = stringMap.get(val)!;
    const encodedIndex = finalIndex + baseOffset;

    // Replace node in-place with: accessorFn(encodedIndex)
    const callNode: any = {
      type: 'CallExpression',
      callee: { type: 'Identifier', name: accessorName },
      arguments: [{ type: 'NumericLiteral', value: encodedIndex }],
    };

    // Morph the node
    Object.keys(node).forEach((k) => delete node[k]);
    Object.assign(node, callNode);
  }

  // ---- Build preamble AST ----

  // 1. var _arr = [encoded("str1"), encoded("str2"), ...];
  //
  // Two encoding modes:
  //   - jsfuck: maximum obfuscation, ~1000x expansion (budget permitting)
  //   - XOR+hex: compact encoding, ~2x expansion, decoded at runtime
  //
  // XOR+hex strings look like "4a1f3c..." — meaningless hex. The accessor
  // function XOR-decodes them with a position-derived key at runtime.
  // jsfuck strings are JavaScript expressions that evaluate to the string.
  //
  // The encoding mode is per-string: first `jsfuckLimit` strings use jsfuck,
  // the rest use XOR+hex. This lets the budget control the bloat.

  // Chained XOR+hex encoding (Paper 2: Kilian-style randomization).
  // Each string's key depends on the decoded content of the previous string.
  // The orderedStrings array is encoded with chained keys — decoding entry N
  // requires knowing the decoded content of entry N-1.
  const arrayLen = orderedStrings.length;
  const chainKeys = computeChainKeys(orderedStrings, xorSeed, xorPrime);
  const arrayElements = orderedStrings.map((s, idx) => {
    const hex = xorHexEncodeWithKey(s, chainKeys[idx]);
    return { type: 'StringLiteral', value: hex };
  });

  const arrayDecl: any = {
    type: 'VariableDeclaration',
    kind: 'var',
    declarations: [{
      type: 'VariableDeclarator',
      id: { type: 'Identifier', name: arrayName },
      init: {
        type: 'ArrayExpression',
        elements: arrayElements,
      },
    }],
  };

  // 2. Chained accessor function (Paper 2: Kilian-style)
  //
  // On first call, decodes the ENTIRE chain in order — key for entry N
  // depends on the decoded content of entry N-1. After the chain is
  // fully decoded, all strings are cached for O(1) access.
  //
  // The chain decryption uses the same simpleStringHash and key derivation
  // as the build-time encoding, but in reverse (decode with the key,
  // then derive the next key from the decoded content).
  const cacheName = gen();
  const chainDecodedFlag = gen();

  const accessorCode = `
  var ${cacheName} = {};
  var ${chainDecodedFlag} = false;
  var ${accessorName} = function(i) {
    if (!${chainDecodedFlag}) {
      var prevKey = ${xorSeed};
      for (var ci = 0; ci < ${arrayLen}; ci++) {
        var k = ((prevKey ^ (ci * ${xorPrime})) & 255) || 1;
        var v = ${arrayName}[ci];
        var s = "";
        var h = 0;
        for (var j = 0; j < v.length; j += 2) {
          var ch = parseInt(v.substr(j, 2), 16) ^ k;
          s += String.fromCharCode(ch);
          h = (h + ch) & 255;
        }
        ${cacheName}[ci + ${baseOffset}] = s;
        prevKey = (k ^ h) & 255;
      }
      ${chainDecodedFlag} = true;
    }
    return ${cacheName}[i];
  };`;

  const accessorAst = recast.parse(accessorCode, {
    parser: require('recast/parsers/babel'),
  });
  const accessorStmts = accessorAst.program.body; // cache decl + accessor decl

  // Prepend to program body (before everything else)
  ast.program.body = [arrayDecl, ...accessorStmts, ...ast.program.body];
}

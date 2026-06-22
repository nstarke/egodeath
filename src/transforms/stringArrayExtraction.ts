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
 * Sparse XOR encoding with position-dependent error patterns
 * (Paper 9: Ragavan, Vafa, Vaikuntanathan — LPN variants)
 *
 * Instead of XOR'ing every character with the same key, each character
 * gets a DIFFERENT XOR value derived from:
 *   1. The chain key (from Paper 2 chaining)
 *   2. The character's position within the string
 *   3. A "sparse error" at select positions — an extra XOR that makes
 *      the encoding non-uniform across the string
 *
 * The sparse error pattern is determined by a secondary seed. Only
 * positions where (pos * errorPrime) % errorMod < errorThreshold get
 * the extra error XOR. This creates a sparse, position-dependent
 * error vector analogous to LPN's noise.
 *
 * To decode, the runtime must know: key, errorSeed, errorPrime,
 * errorMod, errorThreshold — all embedded in the accessor function.
 *
 * @param str          The string to encode
 * @param key          Base XOR key (from chain)
 * @param errorSeed    Seed for the sparse error pattern
 * @param errorPrime   Prime for error position selection
 * @param errorMod     Modulus for error position selection
 * @param errorThreshold  Positions where (pos*P)%M < threshold get extra error
 */
function sparseXorEncode(
  str: string,
  key: number,
  errorSeed: number,
  errorPrime: number,
  errorMod: number,
  errorThreshold: number,
): string {
  let hex = '';
  for (let i = 0; i < str.length; i++) {
    // Position-dependent key: base key rotated by position
    let posKey = ((key + i * 7 + (i * i * 3)) & 0xFF) || 1;

    // Sparse error: additional XOR at select positions
    if ((i * errorPrime) % errorMod < errorThreshold) {
      posKey = (posKey ^ ((errorSeed + i * 13) & 0xFF)) & 0xFF;
    }

    // Pad to 4 hex chars per input char: JS strings are UTF-16, so
    // charCodeAt returns 0-65535. XOR-ing with an 8-bit posKey preserves
    // the high byte, so encoded values can exceed 0xFF whenever the
    // original char does. A 2-char group would desync the decoder at the
    // first non-latin-1 character. 4 chars covers the full BMP (and
    // surrogate halves for chars above BMP, which JS exposes as separate
    // code units).
    const encoded = str.charCodeAt(i) ^ posKey;
    hex += encoded.toString(16).padStart(4, '0');
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

// ---- Cross-file decoy pool ----
//
// obfuscateMultiple() seeds this before each per-file obfuscate()
// call so the emitted string array gets padded with entries drawn
// from the OTHER files' source strings. The decoys are real strings
// (they look indistinguishable from legitimate entries) but no code
// in this file references their indices — they sit in the chain-
// decoded cache and are never read. What the outside world sees:
// every file in the batch has an array of comparable length and
// similar character distribution, so you can't tell which file is
// which by eyeballing the array preamble.
//
// The pool is a pre-shuffled list with an optional base size. Each
// call to getAndClearStringArrayDecoys() returns what was set and
// resets the state, following the same module-singleton pattern
// setDonorStatements uses for dead-code donors.

let pendingDecoys: string[] | null = null;

export function setStringArrayDecoys(decoys: string[] | null): void {
  pendingDecoys = decoys;
}

export function clearStringArrayDecoys(): void {
  pendingDecoys = null;
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

  // Sparse error pattern constants (Paper 9: LPN-inspired)
  const errorSeed = randInt(1, 255);
  const errorPrime = [3, 5, 7, 11, 13][randInt(0, 4)];
  const errorMod = [7, 11, 13, 17, 19][randInt(0, 4)];
  // Threshold controls sparsity: lower = fewer positions get extra error
  // ~30-50% of positions get the sparse error
  const errorThreshold = Math.max(2, Math.floor(errorMod * 0.4));

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

  // Cross-file normalization decoys (see setStringArrayDecoys at top).
  // Filter down to strings this file doesn't already have so the real
  // indices aren't duplicated; the leftover becomes pure padding.
  const decoyCandidates = pendingDecoys ? pendingDecoys.filter((s) => !stringMap.has(s) && s !== '') : [];

  // If the file has no real strings AND no decoys, no array is needed.
  if (stringMap.size === 0 && decoyCandidates.length === 0) return;

  // ---- Build shuffled array ----

  const strings = Array.from(stringMap.keys());
  shuffle(strings);

  // Assign final indices for the REAL strings (post-shuffle order).
  // Decoys get appended after these and keep their own positions —
  // real-string indices (which are baked into every accessor call
  // inserted below) stay stable regardless of how many decoys land at
  // the tail.
  strings.forEach((s, i) => stringMap.set(s, i));

  // ---- Base offset (no rotation — chaining requires sequential order) ----

  const baseOffset = randInt(50, 500);

  // With chained encoding (Paper 2), each entry's key depends on the
  // decoded content of the previous entry. This means the array must
  // stay in its build-time order — rotation would break the chain.
  // The chain itself provides protection: you can't decode entry N
  // without first decoding entries 0 through N-1.
  //
  // Decoys are appended AFTER the real strings so every real index
  // keeps its position. Shuffling the decoys mixes their character-
  // length distribution along the chain tail instead of all clumping
  // at one end.
  const shuffledDecoys = decoyCandidates.slice();
  shuffle(shuffledDecoys);
  const orderedStrings = strings.concat(shuffledDecoys);

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
    const hex = sparseXorEncode(s, chainKeys[idx], errorSeed, errorPrime, errorMod, errorThreshold);
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

  // 2. Chained accessor with sparse XOR decoding (Papers 2 + 9)
  //
  // Decodes the entire chain on first call. Each character uses a
  // position-dependent key plus a sparse error pattern — the same
  // encoding applied at build time, reversed at runtime.

  // The accessor's local bindings are generated through gen() too, so the
  // decoder bootstrap doesn't ship readable names like `prevKey`/`posKey`.
  // This transform runs AFTER the firstPass/secondPass rename passes, so any
  // identifier left literal in this template would survive verbatim into the
  // output. gen() never reissues a name, so these can't collide with the
  // array/accessor/cache/flag names or with anything the passes assigned; as
  // function-scoped vars they only need to differ from each other anyway.
  const idx = gen();        // accessor param (encoded array index)
  const prevKey = gen();    // rolling chain key
  const ci = gen();         // outer loop counter (entry index)
  const k = gen();          // per-entry key
  const v = gen();          // current encoded hex string
  const s = gen();          // decoded string accumulator
  const h = gen();          // running content hash
  const cpos = gen();       // character position within the entry
  const j = gen();          // inner loop counter (hex offset)
  const posKey = gen();     // position-dependent key
  const ch = gen();         // decoded char code

  const accessorCode = `
  var ${cacheName} = {};
  var ${chainDecodedFlag} = false;
  var ${accessorName} = function(${idx}) {
    if (!${chainDecodedFlag}) {
      var ${prevKey} = ${xorSeed};
      for (var ${ci} = 0; ${ci} < ${arrayLen}; ${ci}++) {
        var ${k} = ((${prevKey} ^ (${ci} * ${xorPrime})) & 255) || 1;
        var ${v} = ${arrayName}[${ci}];
        var ${s} = "";
        var ${h} = 0;
        var ${cpos} = 0;
        // 4 hex chars per input character — see sparseXorEncode. Changing
        // this stride silently corrupts the whole chain from the first
        // non-latin-1 char onward.
        for (var ${j} = 0; ${j} < ${v}.length; ${j} += 4) {
          var ${posKey} = ((${k} + ${cpos} * 7 + (${cpos} * ${cpos} * 3)) & 255) || 1;
          if ((${cpos} * ${errorPrime}) % ${errorMod} < ${errorThreshold}) {
            ${posKey} = (${posKey} ^ ((${errorSeed} + ${cpos} * 13) & 255)) & 255;
          }
          var ${ch} = parseInt(${v}.substr(${j}, 4), 16) ^ ${posKey};
          ${s} += String.fromCharCode(${ch});
          ${h} = (${h} + ${ch}) & 255;
          ${cpos}++;
        }
        ${cacheName}[${ci} + ${baseOffset}] = ${s};
        ${prevKey} = (${k} ^ ${h}) & 255;
      }
      ${chainDecodedFlag} = true;
    }
    return ${cacheName}[${idx}];
  };`;

  const accessorAst = recast.parse(accessorCode, {
    parser: require('recast/parsers/babel'),
  });
  const accessorStmts = accessorAst.program.body; // cache decl + accessor decl

  // Prepend to program body (before everything else)
  ast.program.body = [arrayDecl, ...accessorStmts, ...ast.program.body];
}

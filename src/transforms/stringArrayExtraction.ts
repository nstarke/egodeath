import * as crypto from 'crypto';
import * as estraverse from 'estraverse';
import * as recast from 'recast';
import { gen } from '../random';

// jsfuck replaced with compact XOR+hex encoding

// ---- XOR+Hex encoding ----

/**
 * Derive a per-string XOR key from the array index.
 * Uses a prime multiplier and seed so each position gets a different key.
 */
function deriveKey(index: number, prime: number, seed: number): number {
  return ((index * prime + seed) & 0xFF) || 1; // avoid 0 (no-op XOR)
}

/**
 * XOR-encode a string and return it as a hex string.
 * Each character is XOR'd with a key derived from the array index.
 */
function xorHexEncode(str: string, index: number, prime: number, seed: number): string {
  const key = deriveKey(index, prime, seed);
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

  // ---- Rotation + base offset ----

  const rotation = randInt(1, Math.max(1, strings.length));
  const baseOffset = randInt(50, 500);

  // Pre-rotate: shift the array backwards by `rotation` so that after
  // the runtime forward-rotation, indices line up correctly.
  // Forward rotation: R times push(shift()) turns [a,b,c,d] with R=1 into [b,c,d,a]
  // We need: after rotation, arr[i] === strings[i]
  // So we store the array rotated backwards: last R items move to the front
  const preRotated = [
    ...strings.slice(strings.length - rotation),
    ...strings.slice(0, strings.length - rotation),
  ];

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

  // All strings use XOR+hex encoding: each char is XOR'd with a
  // position-derived key and hex-encoded. The accessor decodes at runtime.
  // This gives ~2x expansion (vs jsfuck's ~1000x) while remaining fully opaque.
  //
  // We encode using the preRotated index directly. The accessor derives
  // the preRotated index from the post-rotation index using the known
  // rotation offset and array length.
  const arrayLen = preRotated.length;
  const arrayElements = preRotated.map((s, idx) => {
    const hex = xorHexEncode(s, idx, xorPrime, xorSeed);
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

  // 2. Rotation IIFE: (function(a, n) { while(n--) a.push(a.shift()); })(_arr, R);
  const rotationIIFE: any = {
    type: 'ExpressionStatement',
    expression: {
      type: 'CallExpression',
      callee: {
        type: 'FunctionExpression',
        id: null,
        params: [
          { type: 'Identifier', name: 'a' },
          { type: 'Identifier', name: 'n' },
        ],
        body: {
          type: 'BlockStatement',
          body: [{
            type: 'WhileStatement',
            test: {
              type: 'UpdateExpression',
              operator: '--',
              argument: { type: 'Identifier', name: 'n' },
              prefix: false,
            },
            body: {
              type: 'BlockStatement',
              body: [{
                type: 'ExpressionStatement',
                expression: {
                  type: 'CallExpression',
                  callee: {
                    type: 'MemberExpression',
                    object: { type: 'Identifier', name: 'a' },
                    property: { type: 'Identifier', name: 'push' },
                    computed: false,
                  },
                  arguments: [{
                    type: 'CallExpression',
                    callee: {
                      type: 'MemberExpression',
                      object: { type: 'Identifier', name: 'a' },
                      property: { type: 'Identifier', name: 'shift' },
                      computed: false,
                    },
                    arguments: [],
                  }],
                },
              }],
            },
          }],
        },
      },
      arguments: [
        { type: 'Identifier', name: arrayName },
        { type: 'NumericLiteral', value: rotation },
      ],
    },
  };

  // 3. Accessor function with XOR+hex decoder
  //
  // If all strings are jsfuck (expressions that evaluate directly), the
  // accessor just indexes: return _arr[i - BASE];
  //
  // If any strings use XOR+hex, the accessor decodes them:
  //   function(i) {
  //     var idx = i - BASE;
  //     var v = _arr[idx];
  //     if (typeof v !== "string") return v;  // jsfuck already evaluated
  //     var k = ((idx * PRIME + SEED) & 255) || 1;
  //     var s = "";
  //     for (var j = 0; j < v.length; j += 2)
  //       s += String.fromCharCode(parseInt(v.substr(j, 2), 16) ^ k);
  //     return _arr[idx] = s;  // cache decoded result
  //   }
  //
  // The cache assignment (_arr[idx] = s) means each string is only decoded
  // once — subsequent accesses return the cached value directly.

  // Accessor function: decodes XOR+hex at runtime with a decode cache.
  // Computes the preRotated index from the post-rotation array index
  // to derive the correct XOR key, then hex-decodes and XOR-decodes.
  const cacheName = gen();
  const accessorCode = `var ${cacheName} = {};
  var ${accessorName} = function(i) {
    if (${cacheName}[i] !== void 0) return ${cacheName}[i];
    var idx = i - ${baseOffset};
    var v = ${arrayName}[idx];
    var pidx = (idx + ${rotation}) % ${arrayLen};
    var k = ((pidx * ${xorPrime} + ${xorSeed}) & 255) || 1;
    var s = "";
    for (var j = 0; j < v.length; j += 2)
      s += String.fromCharCode(parseInt(v.substr(j, 2), 16) ^ k);
    ${cacheName}[i] = s;
    return s;
  };`;

  const accessorAst = recast.parse(accessorCode, {
    parser: require('recast/parsers/babel'),
  });
  const accessorStmts = accessorAst.program.body; // cache decl + accessor decl

  // Prepend to program body (before everything else)
  ast.program.body = [arrayDecl, rotationIIFE, ...accessorStmts, ...ast.program.body];
}

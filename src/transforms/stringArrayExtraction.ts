import * as crypto from 'crypto';
import * as estraverse from 'estraverse';
import * as recast from 'recast';
import { gen } from '../random';

const jsfuck = require('jsfuck').JSFuck;

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
export function applyStringArrayExtraction(ast: any): void {
  const arrayName = gen();
  const accessorName = gen();

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

  // 1. var _arr = [jsfuck("str1"), jsfuck("str2"), ...];
  // Each string is encoded with jsfuck so the array contains no readable literals.
  const jsfuckElements = preRotated.map((s) => {
    const encoded = jsfuck.encode(s);
    // Parse the jsfuck expression into an AST node
    const exprAst = recast.parse(encoded, {
      parser: require('recast/parsers/babel'),
    });
    return exprAst.program.body[0].expression || exprAst.program.body[0];
  });

  const arrayDecl: any = {
    type: 'VariableDeclaration',
    kind: 'var',
    declarations: [{
      type: 'VariableDeclarator',
      id: { type: 'Identifier', name: arrayName },
      init: {
        type: 'ArrayExpression',
        elements: jsfuckElements,
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

  // 3. Accessor function: var _get = function(i) { return _arr[i - BASE]; };
  const accessorDecl: any = {
    type: 'VariableDeclaration',
    kind: 'var',
    declarations: [{
      type: 'VariableDeclarator',
      id: { type: 'Identifier', name: accessorName },
      init: {
        type: 'FunctionExpression',
        id: null,
        params: [{ type: 'Identifier', name: 'i' }],
        body: {
          type: 'BlockStatement',
          body: [{
            type: 'ReturnStatement',
            argument: {
              type: 'MemberExpression',
              object: { type: 'Identifier', name: arrayName },
              property: {
                type: 'BinaryExpression',
                operator: '-',
                left: { type: 'Identifier', name: 'i' },
                right: { type: 'NumericLiteral', value: baseOffset },
              },
              computed: true,
            },
          }],
        },
      },
    }],
  };

  // Prepend to program body (before everything else)
  ast.program.body = [arrayDecl, rotationIIFE, accessorDecl, ...ast.program.body];
}

import * as crypto from 'crypto';
import * as estraverse from 'estraverse';

// ---- Helpers ----

function randInt(min: number, max: number): number {
  return min + (crypto.randomBytes(4).readUInt32BE(0) % (max - min + 1));
}

/**
 * Generate a random alphanumeric suffix of length 4-8.
 */
function randomSuffix(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const len = randInt(4, 8);
  let s = '';
  for (let i = 0; i < len; i++) {
    s += chars[crypto.randomBytes(1)[0] % chars.length];
  }
  return s;
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Globals to encode ----

/**
 * Global objects/constructors that can be recovered via eval("Name").
 * We only target globals that are safe to eval — actual built-in
 * objects reachable from the global scope.
 */
const ENCODABLE_GLOBALS = new Set([
  'Array',
  'ArrayBuffer',
  'Boolean',
  'DataView',
  'Date',
  'Error',
  'EvalError',
  'Float32Array',
  'Float64Array',
  'Function',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Infinity',
  'JSON',
  'Map',
  'Math',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'RangeError',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Set',
  'String',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
  'WeakMap',
  'WeakSet',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'isFinite',
  'isNaN',
  'parseFloat',
  'parseInt',
  'unescape',
]);

// ---- Visitor keys ----

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

// ---- AST helpers ----

function id(name: string): any {
  return { type: 'Identifier', name };
}

/**
 * Build: eval( "Name<suffix>".replace(new RegExp("<suffix>$"), "") )
 *
 * Both StringLiterals ("Name<suffix>" and "<suffix>$") will be
 * picked up by string array extraction and jsfuck-encoded.
 */
function buildEvalReplace(globalName: string): any {
  const suffix = randomSuffix();
  const fullString = globalName + suffix;
  const regexPattern = escapeRegex(suffix) + '$';

  return {
    type: 'CallExpression',
    callee: id('eval'),
    arguments: [{
      type: 'CallExpression',
      callee: {
        type: 'MemberExpression',
        object: { type: 'StringLiteral', value: fullString },
        property: id('replace'),
        computed: false,
      },
      arguments: [
        {
          type: 'NewExpression',
          callee: id('RegExp'),
          arguments: [{ type: 'StringLiteral', value: regexPattern }],
        },
        { type: 'StringLiteral', value: '' },
      ],
    }],
  };
}

// ---- Position checks ----

/**
 * Check if this identifier is in a position where it references
 * the global (not a property access, declaration, or label).
 */
function isGlobalReference(node: any, parent: any): boolean {
  // Property of a member expression: obj.Math → don't touch "Math"
  if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) {
    return false;
  }
  // Property key in object: { Math: val } → don't touch
  if ((parent.type === 'Property' || parent.type === 'ObjectProperty') && parent.key === node) {
    return false;
  }
  // Variable declarator id: var Math = ... → don't touch
  if (parent.type === 'VariableDeclarator' && parent.id === node) {
    return false;
  }
  // Function declaration name: function Math() {} → don't touch
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression') && parent.id === node) {
    return false;
  }
  // Parameter: function(Math) {} → don't touch
  if (parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' ||
      parent.type === 'ArrowFunctionExpression') {
    if (parent.params && parent.params.includes(node)) return false;
  }
  // Class declaration name
  if ((parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && parent.id === node) {
    return false;
  }
  // Label
  if (parent.type === 'LabeledStatement' && parent.label === node) {
    return false;
  }
  // MethodDefinition key
  if (parent.type === 'MethodDefinition' && parent.key === node) {
    return false;
  }
  // Import/export specifier
  if (parent.type === 'ImportSpecifier' || parent.type === 'ExportSpecifier') {
    return false;
  }
  // Catch clause param
  if (parent.type === 'CatchClause' && parent.param === node) {
    return false;
  }

  return true;
}

// ---- Main transform ----

/**
 * Replace global variable references with eval/replace expressions.
 *
 * Math.random() becomes:
 *   eval("MathxK92q".replace(/xK92q$/, "")).random()
 *
 * The "MathxK92q" string will be picked up by string array extraction,
 * placed in the rotated array, and jsfuck-encoded — making the global
 * name completely invisible in the final output.
 */
export function applyGlobalVariableEncoding(ast: any): void {
  // Collect replacements first, then apply (avoid modifying during traversal)
  const replacements: { node: any; replacement: any }[] = [];

  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any, parent: any) {
      if (node.type !== 'Identifier') return;
      if (!ENCODABLE_GLOBALS.has(node.name)) return;
      if (!isGlobalReference(node, parent)) return;

      replacements.push({
        node,
        replacement: buildEvalReplace(node.name),
      });
    },
    fallback: 'iteration',
  } as any);

  // Apply replacements by morphing nodes in-place
  for (const { node, replacement } of replacements) {
    Object.keys(node).forEach((k) => delete node[k]);
    Object.assign(node, replacement);
  }
}

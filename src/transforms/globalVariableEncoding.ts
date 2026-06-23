import * as crypto from 'crypto';
import * as estraverse from 'estraverse';
import { captureGlobal } from '../capturedGlobals';

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

import { getEncodableGlobals } from '../keywords';

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
function buildEvalReplace(ast: any, globalName: string): any {
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
          // Program-level capture of RegExp survives `var RegExp = …`
          // shadowing inside lodash-style runInContext. See
          // capturedGlobals.ts.
          callee: id(captureGlobal(ast, 'RegExp')),
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
  // Assignment target (`foo = x`, `foo += x`, etc.) — `eval(...)` is not
  // an lvalue, so replacing `foo` on the LHS produces "Invalid left-hand
  // side in assignment" at runtime.
  if (parent.type === 'AssignmentExpression' && parent.left === node) {
    return false;
  }
  // Update expression target (`foo++`, `--foo`) — same lvalue issue.
  if (parent.type === 'UpdateExpression' && parent.argument === node) {
    return false;
  }
  // For-in / for-of binding when the declaration form is `for (x in …)`
  // (no `var`/`let`/`const`): `x` is an assignment target, not a
  // reference. Replacing it produces an invalid lvalue.
  if ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement')
      && parent.left === node) {
    return false;
  }
  // Destructuring pattern bindings: `{x} = obj` or `[x] = arr` where the
  // Identifier is bound, not referenced.
  if ((parent.type === 'ObjectPattern' || parent.type === 'ArrayPattern')) {
    return false;
  }
  if (parent.type === 'RestElement' && parent.argument === node) {
    return false;
  }
  if (parent.type === 'AssignmentPattern' && parent.left === node) {
    return false;
  }
  // Object destructuring property value: `{foo: x} = obj` — `x` is a
  // binding target if the enclosing pattern is a destructuring target.
  // We conservatively skip Property/ObjectProperty values; the right
  // side of object *literal* properties (`{foo: X}` where the enclosing
  // is an ObjectExpression) is a reference and we'd want to encode it,
  // but distinguishing needs grandparent info. Err on the side of
  // correctness — globalVariableEncoding only matters for a small set of
  // global identifiers (Math, Object, Array, …) and missing a few
  // references is fine; mangling assignment targets is not.
  if ((parent.type === 'Property' || parent.type === 'ObjectProperty') && parent.value === node) {
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
/**
 * Collect every name introduced as a local binding anywhere in the program:
 * variable/function/class declarations, function & catch parameters (including
 * destructuring patterns), and import bindings. Used to keep
 * globalVariableEncoding from rewriting a reference that may resolve to one of
 * these locals instead of the same-named global.
 */
function collectDeclaredNames(program: any): Set<string> {
  const names = new Set<string>();

  const addPattern = (pat: any): void => {
    if (!pat || typeof pat !== 'object') return;
    switch (pat.type) {
      case 'Identifier':
        names.add(pat.name);
        break;
      case 'AssignmentPattern':
        addPattern(pat.left);
        break;
      case 'RestElement':
        addPattern(pat.argument);
        break;
      case 'ArrayPattern':
        for (const el of pat.elements || []) addPattern(el);
        break;
      case 'ObjectPattern':
        for (const p of pat.properties || []) {
          if (p.type === 'RestElement') addPattern(p.argument);
          else addPattern(p.value);
        }
        break;
    }
  };

  estraverse.traverse(program, {
    keys: VISITOR_KEYS,
    enter(node: any) {
      switch (node.type) {
        case 'VariableDeclarator':
          addPattern(node.id);
          break;
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
          if (node.id) names.add(node.id.name);
          for (const p of node.params || []) addPattern(p);
          break;
        case 'ClassDeclaration':
        case 'ClassExpression':
          if (node.id) names.add(node.id.name);
          break;
        case 'CatchClause':
          addPattern(node.param);
          break;
        case 'ImportDefaultSpecifier':
        case 'ImportNamespaceSpecifier':
        case 'ImportSpecifier':
          if (node.local) names.add(node.local.name);
          break;
      }
    },
    fallback: 'iteration',
  } as any);

  return names;
}

export function applyGlobalVariableEncoding(ast: any): void {
  // Names that are declared as local bindings somewhere in the program. A
  // reference to such a name may resolve to the local, not the global, so
  // encoding it as `eval("Name")` (an unconditional real-global read) is
  // unsafe. This matters for code that re-declares a global name to probe the
  // environment: lodash does `var Buffer = moduleExports ? context.Buffer :
  // undefined` and later `Buffer ? Buffer.isBuffer : undefined` — encoding
  // those `Buffer`s to the real global makes `_.isBuffer` ignore a missing
  // Buffer (breaking feature detection). Renamed locals already fall out (their
  // name is no longer a known global), but a binding the renamer left alone —
  // e.g. one scope analysis treated as free — would otherwise be miscompiled.
  const locallyDeclared = collectDeclaredNames(ast.program);

  // Collect replacements first, then apply (avoid modifying during traversal)
  const replacements: { node: any; replacement: any }[] = [];

  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any, parent: any) {
      if (node.type !== 'Identifier') return;
      // Skip the synthetic init of a capturedGlobals bootstrap decl:
      // encoding `var X = RegExp;` as `var X = eval(...)` that itself
      // references `new X(...)` would dereference X before it's
      // assigned. See capturedGlobals.ts.
      if ((node as any).__capturedGlobalInit) return;
      if (!getEncodableGlobals().has(node.name)) return;
      if (locallyDeclared.has(node.name)) return;
      if (!isGlobalReference(node, parent)) return;

      replacements.push({
        node,
        replacement: buildEvalReplace(ast, node.name),
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

import * as crypto from 'crypto';
import * as estraverse from 'estraverse';
import { gen } from '../random';

// ---- Helpers ----

function randInt(min: number, max: number): number {
  return min + (crypto.randomBytes(4).readUInt32BE(0) % (max - min + 1));
}

function randomSuffix(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const len = randInt(4, 8);
  let s = '';
  for (let i = 0; i < len; i++) {
    s += chars[crypto.randomBytes(1)[0] % chars.length];
  }
  return s;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  ClassMethod: ['key', 'params', 'body'],
  ClassProperty: ['key', 'value'],
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
 * Build: var <varName> = "<propName><suffix>".replace(new RegExp("<suffix>$"), "");
 *
 * Both StringLiterals are picked up by string array extraction and
 * XOR+hex encoded. At runtime, the .replace() strips the suffix,
 * leaving the original property name. Different scopes get different
 * suffixes but all resolve to the same property name at runtime.
 */
function buildPropVarDecl(varName: string, propName: string): any {
  const suffix = randomSuffix();
  const regexPattern = escapeRegex(suffix) + '$';
  return {
    type: 'VariableDeclaration',
    kind: 'var',
    declarations: [{
      type: 'VariableDeclarator',
      id: id(varName),
      init: {
        type: 'CallExpression',
        callee: {
          type: 'MemberExpression',
          object: { type: 'StringLiteral', value: propName + suffix },
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
      },
    }],
  };
}

// ---- Core transform ----

interface Replacement {
  node: any;
  propName: string;
  varName: string;
  kind: 'member' | 'property' | 'method-def';
}

/**
 * Apply property key encoding to the AST.
 *
 * Converts:
 *   obj.foo        → obj[_v]     (where _v = "foo<suffix>".replace(...))
 *   {foo: val}     → {[_v]: val}
 *   class { foo(){} } → class { [_v](){} }
 *
 * Each instance gets a unique variable and suffix. The "foo<suffix>"
 * StringLiteral will be picked up by string array extraction and
 * jsfuck-encoded.
 */
export function applyPropertyKeyEncoding(ast: any): void {
  // Process each function body and the program body
  processBody(ast.program.body);

  estraverse.traverse(ast.program, {
    keys: VISITOR_KEYS,
    enter(node: any) {
      const isFn =
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'ObjectMethod';

      if (isFn && node.body && node.body.type === 'BlockStatement') {
        processBody(node.body.body);
      }
    },
    fallback: 'iteration',
  } as any);
}

/**
 * Process a list of statements: find all property accesses and object
 * keys, generate encoding variables, prepend declarations, and convert
 * to computed access.
 */
function processBody(body: any[]): void {
  const replacements: Replacement[] = [];

  // Walk all nodes in this body to find property accesses
  for (const stmt of body) {
    collectReplacements(stmt, replacements);
  }

  if (replacements.length === 0) return;

  // Deduplicate: same property name in the same scope gets the same
  // variable. This ensures obj.foo = 1 and obj.foo are consistent.
  const propToVar = new Map<string, string>();
  for (const r of replacements) {
    if (!propToVar.has(r.propName)) {
      propToVar.set(r.propName, r.varName);
    } else {
      r.varName = propToVar.get(r.propName)!;
    }
  }

  // Generate one var declaration per unique property name
  const varDecls: any[] = [];
  for (const [propName, varName] of propToVar) {
    varDecls.push(buildPropVarDecl(varName, propName));
  }

  // Apply replacements — morph nodes in place
  for (const r of replacements) {
    if (r.kind === 'member') {
      // obj.foo → obj[varName]: set computed=true, replace property
      r.node.computed = true;
      r.node.property = id(r.varName);
    } else if (r.kind === 'property') {
      // {foo: val} → {[varName]: val}: set computed=true, replace key
      r.node.computed = true;
      r.node.key = id(r.varName);
    } else if (r.kind === 'method-def') {
      // class { foo() {} } → class { [varName]() {} }
      r.node.computed = true;
      r.node.key = id(r.varName);
    }
  }

  // Prepend var declarations to the body
  body.unshift(...varDecls);
}

/**
 * Recursively collect all property access and object key nodes
 * that should be encoded.
 */
function collectReplacements(node: any, out: Replacement[]): void {
  if (!node || typeof node !== 'object') return;

  // Skip array processing for non-AST arrays
  if (Array.isArray(node)) {
    for (const child of node) {
      collectReplacements(child, out);
    }
    return;
  }

  // MemberExpression with dot notation: obj.foo
  if (node.type === 'MemberExpression' && !node.computed && node.property) {
    const propName = node.property.name || node.property.value;
    if (propName && typeof propName === 'string' && shouldEncode(propName)) {
      const varName = gen();
      out.push({ node, propName, varName, kind: 'member' });
    }
  }

  // OptionalMemberExpression: obj?.foo
  if (node.type === 'OptionalMemberExpression' && !node.computed && node.property) {
    const propName = node.property.name || node.property.value;
    if (propName && typeof propName === 'string' && shouldEncode(propName)) {
      const varName = gen();
      out.push({ node, propName, varName, kind: 'member' });
    }
  }

  // Property / ObjectProperty in object literals: { foo: val }
  if ((node.type === 'Property' || node.type === 'ObjectProperty') &&
      !node.computed && node.key) {
    const propName = node.key.name || node.key.value;
    if (propName && typeof propName === 'string' && shouldEncode(propName)) {
      const varName = gen();
      out.push({ node, propName, varName, kind: 'property' });
    }
  }

  // MethodDefinition / ClassMethod / PropertyDefinition in classes
  if ((node.type === 'MethodDefinition' || node.type === 'ClassMethod' ||
       node.type === 'ClassProperty' || node.type === 'PropertyDefinition' ||
       node.type === 'ObjectMethod') && !node.computed && node.key) {
    const propName = node.key.name || node.key.value;
    if (propName && typeof propName === 'string' && shouldEncode(propName)) {
      const varName = gen();
      out.push({ node, propName, varName, kind: 'method-def' });
    }
  }

  // Don't recurse into nested function bodies — those get their own
  // processBody call from the estraverse, creating their own scope registry.
  // This ensures each scope has its own set of property key variables.
  const isFnBody =
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression' ||
    node.type === 'ObjectMethod' ||
    node.type === 'ClassMethod';
  if (isFnBody) return;

  // Recurse into child nodes
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end' ||
        key === 'extra' || key === 'comments' || key === 'leadingComments' ||
        key === 'trailingComments' || key === 'innerComments') {
      continue;
    }
    const child = node[key];
    if (child && typeof child === 'object') {
      collectReplacements(child, out);
    }
  }
}

// ---- Exclusions ----

/**
 * Property names that should NOT be encoded because they are
 * built-in names that must remain as-is for correct behavior.
 * These are structural properties that JavaScript engines rely on.
 */
const SKIP_PROPS = new Set([
  // Constructor/prototype chain
  'constructor', 'prototype', '__proto__',
  // Module system
  'exports', 'module', 'require', 'default',
  // Symbols accessed by name
  'iterator', 'asyncIterator', 'hasInstance',
  'toPrimitive', 'toStringTag', 'species',
]);

function shouldEncode(propName: string): boolean {
  if (SKIP_PROPS.has(propName)) return false;
  return true;
}

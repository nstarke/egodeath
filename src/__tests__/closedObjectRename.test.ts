import * as recast from 'recast';
import * as estraverse from 'estraverse';
import { applyClosedObjectRename } from '../transforms/closedObjectRename';
import { analyzeScopes, resetScopeAnalysis } from '../scopeAnalysis';
import { resetIssuedNames } from '../random';
import { obfuscate } from '../obfuscator';

function parse(code: string): any {
  return recast.parse(code, { parser: require('recast/parsers/babel') });
}

interface ObjInfo {
  decl: any | null;         // VariableDeclarator whose id.name === bindingName
  keys: string[];           // key name strings in the object literal (or null if not a plain Identifier/string key)
  accessProps: string[];    // every ref.X name, in source order
}

function inspect(ast: any, bindingName: string): ObjInfo {
  let decl: any = null;
  const keys: string[] = [];
  const accessProps: string[] = [];
  estraverse.traverse(ast.program, {
    enter(node: any, parent: any) {
      if (
        node.type === 'VariableDeclarator' &&
        node.id && node.id.type === 'Identifier' && node.id.name === bindingName &&
        node.init && node.init.type === 'ObjectExpression'
      ) {
        decl = node;
        for (const p of node.init.properties || []) {
          if (!p.key) continue;
          if (p.key.type === 'Identifier') keys.push(p.key.name);
          else if (p.key.type === 'StringLiteral') keys.push(String(p.key.value));
          else if (p.key.type === 'Literal') keys.push(String(p.key.value));
        }
      }
      if (
        (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') &&
        node.object && node.object.type === 'Identifier' && node.object.name === bindingName &&
        !node.computed && node.property && node.property.type === 'Identifier'
      ) {
        // Skip the obj position that's itself a property of an outer
        // MemberExpression (e.g. `other.obj.foo`) — that wouldn't match
        // the refs we care about anyway because our binding is at the
        // outermost identifier only.
        if (parent && (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.object === node) {
          // node itself is an inner member chain segment; still, if its
          // object is `bindingName`, the NAME used on `bindingName` is
          // node.property. Capture.
        }
        accessProps.push(node.property.name);
      }
    },
    fallback: 'iteration',
  } as any);
  return { decl, keys, accessProps };
}

function runTransform(code: string): { ast: any; renamed: number } {
  const ast = parse(code);
  const analysis = analyzeScopes(ast.program);
  const renamed = applyClosedObjectRename(ast, analysis);
  return { ast, renamed };
}

beforeEach(() => {
  resetIssuedNames();
  resetScopeAnalysis();
});

describe('applyClosedObjectRename — escape analysis', () => {
  it('renames keys of a fully-internal object', () => {
    const { ast, renamed } = runTransform('const obj = { a: 1, b: 2 }; obj.a; obj.b;');
    expect(renamed).toBe(1);
    const info = inspect(ast, 'obj');
    // Keys were changed (no longer 'a'/'b') and both refer to the same new names as accesses.
    expect(info.keys).not.toContain('a');
    expect(info.keys).not.toContain('b');
    // Every access uses a key that also appears in the declaration.
    for (const p of info.accessProps) {
      expect(info.keys).toContain(p);
    }
    expect(info.accessProps.length).toBe(2);
  });

  it('leaves an object that is returned from a function', () => {
    const { ast, renamed } = runTransform('function f() { const obj = { a: 1 }; return obj; }');
    expect(renamed).toBe(0);
    const info = inspect(ast, 'obj');
    expect(info.keys).toEqual(['a']);
  });

  it('leaves an object passed as a call argument', () => {
    const { ast, renamed } = runTransform('const obj = { a: 1 }; send(obj);');
    expect(renamed).toBe(0);
    expect(inspect(ast, 'obj').keys).toEqual(['a']);
  });

  it('leaves an object aliased to another binding', () => {
    const { ast, renamed } = runTransform('const obj = { a: 1 }; const alias = obj; alias.a;');
    expect(renamed).toBe(0);
    expect(inspect(ast, 'obj').keys).toEqual(['a']);
  });

  it('leaves an object touched by computed access', () => {
    const { ast, renamed } = runTransform('const obj = { a: 1, b: 2 }; obj[k];');
    expect(renamed).toBe(0);
    expect(inspect(ast, 'obj').keys).toEqual(['a', 'b']);
  });

  it('leaves an object spread into another literal', () => {
    const { ast, renamed } = runTransform('const obj = { a: 1 }; const cp = { ...obj };');
    expect(renamed).toBe(0);
    expect(inspect(ast, 'obj').keys).toEqual(['a']);
  });

  it('bails when the declaration itself uses a spread property', () => {
    const { ast, renamed } = runTransform('const src = { z: 9 }; const obj = { a: 1, ...src }; obj.a;');
    expect(renamed).toBe(0);
    // src also escapes (passed into obj via spread) so its keys are untouched too.
    expect(inspect(ast, 'obj').keys).toEqual(['a', ...[]]);
  });

  it('bails when a property value is a FunctionExpression (own this)', () => {
    const { ast, renamed } = runTransform(
      'const obj = { a: 1, fn: function () { return this.a; } }; obj.a; obj.fn();'
    );
    expect(renamed).toBe(0);
    expect(inspect(ast, 'obj').keys).toEqual(['a', 'fn']);
  });

  it('bails when the object contains an ObjectMethod', () => {
    const { ast, renamed } = runTransform(
      'const obj = { a: 1, fn() { return 2; } }; obj.a;'
    );
    expect(renamed).toBe(0);
  });

  it('renames even when a property value is an arrow function (no own this)', () => {
    // Arrow doesn't bind `this`, and the closure over `obj.a` goes
    // through `obj.a` which is a safe access context — so the binding
    // is still closed.
    const { ast, renamed } = runTransform(
      'const obj = { a: 1, fn: () => obj.a + 1 }; obj.a; obj.fn;'
    );
    expect(renamed).toBe(1);
    const info = inspect(ast, 'obj');
    expect(info.keys).not.toContain('a');
    expect(info.keys).not.toContain('fn');
    // Both keys in declaration must be reachable from the access sites.
    for (const p of info.accessProps) {
      expect(info.keys).toContain(p);
    }
  });

  it('bails on reassignment to the binding', () => {
    const { ast, renamed } = runTransform('let obj = { a: 1 }; obj.a; obj = { b: 2 };');
    expect(renamed).toBe(0);
  });

  it('bails on access to a skip-listed property name', () => {
    const { ast, renamed } = runTransform('const obj = { a: 1 }; obj.a; obj.toString;');
    expect(renamed).toBe(0);
  });

  it('bails when the declaration defines a skip-listed key', () => {
    const { ast, renamed } = runTransform('const obj = { constructor: 1, a: 2 }; obj.a;');
    expect(renamed).toBe(0);
  });

  it('bails when the object is assigned to module.exports', () => {
    const { ast, renamed } = runTransform('const obj = { a: 1 }; module.exports = obj;');
    expect(renamed).toBe(0);
  });

  it('treats shorthand declaration keys as renamable', () => {
    const { ast, renamed } = runTransform('const x = 1, y = 2; const obj = { x, y }; obj.x; obj.y;');
    expect(renamed).toBe(1);
    const info = inspect(ast, 'obj');
    expect(info.keys).not.toContain('x');
    expect(info.keys).not.toContain('y');
  });
});

describe('applyClosedObjectRename — end-to-end obfuscate', () => {
  beforeAll(() => {
    (global as any).setInterval = () => 0;
  });

  // Low ratio so heavier transforms stay off and the assertion targets
  // just the rename correctness.
  const OPTS = { targetTokens: 2000 };

  it('renamed closed object still returns correct values', () => {
    const code = `
      function run() {
        const obj = { foo: 10, bar: 20, baz: 30 };
        return obj.foo + obj.bar + obj.baz;
      }
      module.exports = { tot: run() };
    `;
    const out = obfuscate(code, OPTS);
    // The literal source words 'foo'/'bar'/'baz' should not survive
    // verbatim anywhere in the output — they were renamed and then
    // XOR-packed into the string array.
    expect(out).not.toContain('foo');
    expect(out).not.toContain('bar');
    expect(out).not.toContain('baz');
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    expect(mod.exports.tot).toBe(60);
  });

  it('escaped object still runs correctly (keys preserved)', () => {
    const code = `
      function make() {
        const obj = { visible: 7 };
        return obj;
      }
      module.exports = { payload: make() };
    `;
    const out = obfuscate(code, OPTS);
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    expect(mod.exports.payload).toEqual({ visible: 7 });
  });

  it('handles mixed access patterns (read, write, update, call-free method through arrow)', () => {
    const code = `
      function run() {
        const counters = { hits: 0, misses: 0 };
        counters.hits++;
        counters.hits++;
        counters.misses += 2;
        counters.hits = counters.hits + 1;
        return counters.hits * 10 + counters.misses;
      }
      module.exports = { r: run() };
    `;
    const out = obfuscate(code, OPTS);
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    // hits = 3 (two ++ then +1), misses = 2.
    expect(mod.exports.r).toBe(32);
  });

  it('skip-listed property prevents rename, code still works', () => {
    const code = `
      function run() {
        const obj = { a: 1 };
        return obj.a + (obj.toString === Object.prototype.toString ? 100 : 0);
      }
      module.exports = { r: run() };
    `;
    const out = obfuscate(code, OPTS);
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    expect(mod.exports.r).toBe(101);
  });
});

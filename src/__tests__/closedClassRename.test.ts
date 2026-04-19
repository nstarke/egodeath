import * as recast from 'recast';
import * as estraverse from 'estraverse';
import { applyClosedClassRename } from '../transforms/closedClassRename';
import { analyzeScopes, resetScopeAnalysis } from '../scopeAnalysis';
import { resetIssuedNames } from '../random';
import { obfuscate } from '../obfuscator';

function parse(code: string): any {
  return recast.parse(code, { parser: require('recast/parsers/babel') });
}

/** Collect method-name strings used as keys in the class body of `className`. */
function classBodyKeyNames(ast: any, className: string): string[] {
  const names: string[] = [];
  estraverse.traverse(ast.program, {
    enter(node: any) {
      if (
        node.type === 'ClassDeclaration' &&
        node.id && node.id.name === className &&
        node.body && Array.isArray(node.body.body)
      ) {
        for (const m of node.body.body) {
          if (!m) continue;
          if ((m.type === 'MethodDefinition' || m.type === 'ClassMethod' ||
               m.type === 'PropertyDefinition' || m.type === 'ClassProperty') &&
              m.key && m.key.type === 'Identifier') {
            names.push(m.key.name);
          }
        }
      }
    },
    fallback: 'iteration',
  } as any);
  return names;
}

/** All non-computed `.X` property names found in the whole AST. */
function allPropertyAccessNames(ast: any): string[] {
  const names: string[] = [];
  estraverse.traverse(ast.program, {
    enter(node: any) {
      if (
        (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') &&
        !node.computed && node.property && node.property.type === 'Identifier'
      ) {
        names.push(node.property.name);
      }
    },
    fallback: 'iteration',
  } as any);
  return names;
}

function runTransform(code: string): { ast: any; renamed: number } {
  const ast = parse(code);
  const analysis = analyzeScopes(ast.program);
  const renamed = applyClosedClassRename(ast, analysis);
  return { ast, renamed };
}

beforeEach(() => {
  resetIssuedNames();
  resetScopeAnalysis();
});

describe('applyClosedClassRename — escape analysis', () => {
  it('renames methods of a fully-internal class with a new-expression caller', () => {
    const { ast, renamed } = runTransform(`
      class Calc {
        add(a, b) { return a + b; }
        sub(a, b) { return a - b; }
      }
      const result = new Calc().add(1, 2);
    `);
    expect(renamed).toBe(2);
    const keys = classBodyKeyNames(ast, 'Calc');
    expect(keys).not.toContain('add');
    expect(keys).not.toContain('sub');
    // Access site also rewritten; .add is no longer anywhere.
    expect(allPropertyAccessNames(ast)).not.toContain('add');
    expect(allPropertyAccessNames(ast)).not.toContain('sub');
  });

  it('renames methods accessed through a proven-instance variable', () => {
    const { ast, renamed } = runTransform(`
      class Calc {
        add(a, b) { return a + b; }
      }
      const c = new Calc();
      c.add(1, 2);
      c.add(3, 4);
    `);
    expect(renamed).toBe(1);
    expect(classBodyKeyNames(ast, 'Calc')).not.toContain('add');
    expect(allPropertyAccessNames(ast)).not.toContain('add');
  });

  it('renames this.method accesses inside the class body', () => {
    const { ast, renamed } = runTransform(`
      class Calc {
        double(x) { return this.add(x, x); }
        add(a, b) { return a + b; }
      }
      new Calc().double(5);
    `);
    expect(renamed).toBe(2);
    // No `.add` or `.double` anywhere in the output (including this.add).
    expect(allPropertyAccessNames(ast)).not.toContain('add');
    expect(allPropertyAccessNames(ast)).not.toContain('double');
  });

  it('leaves an exported class untouched', () => {
    const { ast, renamed } = runTransform(`
      class Thing {
        method() { return 1; }
      }
      module.exports = { Thing };
    `);
    expect(renamed).toBe(0);
    expect(classBodyKeyNames(ast, 'Thing')).toContain('method');
  });

  it('leaves a class that is a superclass of another', () => {
    const { ast, renamed } = runTransform(`
      class Base {
        method() { return 1; }
      }
      class Child extends Base {}
      new Child();
    `);
    // Base has a subclass → Base binding escapes (referenced as superClass).
    // Child's binding is fine, but its classBodyMembers is empty so no
    // candidate is formed.
    expect(renamed).toBe(0);
    expect(classBodyKeyNames(ast, 'Base')).toContain('method');
  });

  it('leaves a class whose binding is passed as an argument', () => {
    const { ast, renamed } = runTransform(`
      class Widget {
        render() { return "x"; }
      }
      register(Widget);
    `);
    expect(renamed).toBe(0);
    expect(classBodyKeyNames(ast, 'Widget')).toContain('render');
  });

  it('leaves a class whose Foo.prototype is touched', () => {
    const { ast, renamed } = runTransform(`
      class Widget {
        render() { return "x"; }
      }
      Widget.prototype.render2 = function () {};
      new Widget();
    `);
    expect(renamed).toBe(0);
    expect(classBodyKeyNames(ast, 'Widget')).toContain('render');
  });

  it('tolerates an instanceof test on a closed class', () => {
    const { ast, renamed } = runTransform(`
      class Widget {
        open() { return 1; }
      }
      const w = new Widget();
      if (w instanceof Widget) w.open();
    `);
    expect(renamed).toBe(1);
  });
});

describe('applyClosedClassRename — method-level bails', () => {
  it('bails on a method name that also has a non-instance .X access', () => {
    const { ast, renamed } = runTransform(`
      class Widget {
        click() { return 1; }
      }
      const w = new Widget();
      w.click();
      // Non-instance .click access — bail.
      document.click();
    `);
    expect(renamed).toBe(0);
    expect(classBodyKeyNames(ast, 'Widget')).toContain('click');
  });

  it('bails when another class defines the same method (conflict)', () => {
    const { ast, renamed } = runTransform(`
      class A {
        run() { return 1; }
      }
      class B {
        run() { return 2; }
      }
      new A().run();
      new B().run();
    `);
    expect(renamed).toBe(0);
  });

  it('refuses to rename a method on the skip-list', () => {
    const { ast, renamed } = runTransform(`
      class Bag {
        push(x) { return x; }
      }
      new Bag();
    `);
    // The entire class is rejected at collectClassMembers because one
    // of its names ('push') is in the skip list.
    expect(renamed).toBe(0);
    expect(classBodyKeyNames(ast, 'Bag')).toContain('push');
  });

  it('does not rename when this is inside a detached function (not arrow) in a class method', () => {
    const { ast, renamed } = runTransform(`
      class Widget {
        handle() {
          const inner = function () { return this.handle; };
          return inner;
        }
      }
      new Widget().handle();
    `);
    // The `this.handle` inside the inner function expression is
    // detached (its own this). Renaming Widget.handle would break
    // that detached this.handle at some other call site → bail.
    expect(renamed).toBe(0);
  });

  it('is OK with nested arrow using this (arrow inherits class this)', () => {
    const { ast, renamed } = runTransform(`
      class Widget {
        handle() {
          return [1, 2].map(n => this.handle.toString().length + n);
        }
      }
      new Widget().handle();
    `);
    // Arrow inherits `this`, so `this.handle` is still classified as
    // this-class. Renaming works.
    //
    // Note `toString` is in the skip-list so it's untouched, which is
    // fine — we only care that .handle is rewritten.
    expect(renamed).toBe(1);
    expect(allPropertyAccessNames(ast)).not.toContain('handle');
  });

  it('bails if an instance variable has a non-member-access reference', () => {
    const { ast, renamed } = runTransform(`
      class Widget {
        paint() { return 1; }
      }
      const w = new Widget();
      takeAnything(w); // w escapes — bail
      w.paint();
    `);
    expect(renamed).toBe(0);
  });
});

describe('applyClosedClassRename — end-to-end obfuscate', () => {
  beforeAll(() => {
    (global as any).setInterval = () => 0;
  });

  const OPTS = { targetTokens: 2000 };

  it('obfuscated closed class still computes correct values', () => {
    const code = `
      class Arithmetic {
        plus(a, b) { return a + b; }
        times(a, b) { return a * b; }
        fancy(a) { return this.plus(a, this.times(a, 2)); }
      }
      const q = new Arithmetic();
      module.exports = { r: q.plus(q.times(3, 4), q.fancy(5)) };
    `;
    const out = obfuscate(code, OPTS);
    // Source method names should not survive verbatim anywhere —
    // they were renamed, then folded into the string array.
    expect(out).not.toContain('plus');
    expect(out).not.toContain('times');
    expect(out).not.toContain('fancy');
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    // plus(times(3,4), fancy(5)) = 12 + (5 + 10) = 27
    expect(mod.exports.r).toBe(27);
  });

  it('exported class preserves its shape', () => {
    const code = `
      class Thing {
        greet() { return 'hi'; }
      }
      module.exports = { Thing };
    `;
    const out = obfuscate(code, OPTS);
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    const instance = new mod.exports.Thing();
    expect(instance.greet()).toBe('hi');
  });

  it('instance fields rename consistently with accesses', () => {
    const code = `
      class Counter {
        value = 0;
        bump() { this.value = this.value + 1; return this.value; }
      }
      function run() {
        const c = new Counter();
        c.bump();
        c.bump();
        return c.bump() + c.value;
      }
      module.exports = { r: run() };
    `;
    const out = obfuscate(code, OPTS);
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    // bump returns 1, 2, 3; c.value is 3 at the end → 3 + 3 = 6
    expect(mod.exports.r).toBe(6);
  });
});

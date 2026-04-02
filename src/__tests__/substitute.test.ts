import { substitute, traverseNode, descend, findNested } from '../substitute';
import { getGlobals, resetGlobals, setGlobals } from '../globals';
import { GlobalsMap } from '../types';

beforeEach(() => {
  resetGlobals();
});

describe('substitute', () => {
  it('does nothing for null/undefined nodes', () => {
    expect(() => substitute(null)).not.toThrow();
    expect(() => substitute(undefined)).not.toThrow();
  });

  it('does nothing for nodes without a name', () => {
    const node = { type: 'Literal', value: 42 } as any;
    substitute(node);
    expect(node.value).toBe(42);
  });

  it('does nothing for "undefined" named nodes', () => {
    const node = { type: 'Identifier', name: 'undefined' };
    substitute(node);
    expect(node.name).toBe('undefined');
  });

  it('replaces identifier name using globals map', () => {
    setGlobals({ myVar: { ___val: 'obfuscated_name' } } as GlobalsMap);
    const node = { type: 'Identifier', name: 'myVar' };
    substitute(node);
    expect(node.name).toBe('obfuscated_name');
  });

  it('does not replace keyword identifiers', () => {
    setGlobals({ Array: { ___val: 'should_not_use' } } as GlobalsMap);
    const node = { type: 'Identifier', name: 'Array' };
    substitute(node);
    expect(node.name).toBe('Array');
  });

  it('does not replace skipped nodes', () => {
    setGlobals({ myVar: { ___val: 'obfuscated' } } as GlobalsMap);
    const node = { type: 'Identifier', name: 'myVar', skipped: true };
    substitute(node);
    expect(node.name).toBe('myVar');
  });

  it('uses context map when provided', () => {
    setGlobals({ myVar: { ___val: 'global_val' } } as GlobalsMap);
    const ctx = { myVar: { ___val: 'ctx_val' } } as GlobalsMap;
    const node = { type: 'Identifier', name: 'myVar' };
    substitute(node, ctx);
    expect(node.name).toBe('ctx_val');
  });

  it('falls back to globals when context lacks the key', () => {
    setGlobals({ myVar: { ___val: 'global_val' } } as GlobalsMap);
    const ctx = { other: { ___val: 'ctx_val' } } as GlobalsMap;
    const node = { type: 'Identifier', name: 'myVar' };
    substitute(node, ctx);
    expect(node.name).toBe('global_val');
  });
});

describe('traverseNode', () => {
  it('extracts property chain from simple MemberExpression', () => {
    // window.location
    const node = {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'window' },
      property: { type: 'Identifier', name: 'location' },
    };
    expect(traverseNode(node)).toEqual(['window', 'location']);
  });

  it('returns empty array for node without object', () => {
    const node = { type: 'Identifier', name: 'foo' };
    expect(traverseNode(node)).toEqual([]);
  });

  it('handles nested MemberExpression (object has no name, recurses)', () => {
    // obj.prop where obj is a complex expression without .name
    const node = {
      type: 'MemberExpression',
      object: {
        type: 'MemberExpression',
        object: { type: 'Identifier', name: 'a' },
        property: { type: 'Identifier', name: 'b' },
      },
      property: { type: 'Identifier', name: 'c' },
    };
    // The outer node.object has no .name, and it has .property,
    // so it pushes node.property.name = 'c'
    // but first object has no name so it doesn't push it
    // Then it pushes property name 'c'
    const result = traverseNode(node);
    expect(result).toContain('c');
  });
});

describe('descend', () => {
  it('creates nested structure in globals map', () => {
    const base: GlobalsMap = {};
    descend(base, ['window', 'location', 'hash']);
    expect(base.window).toBeDefined();
    expect(base.window.___val).toBeDefined();
    expect(base.window.location).toBeDefined();
    expect(base.window.location.___val).toBeDefined();
    expect(base.window.location.hash).toBeDefined();
    expect(base.window.location.hash.___val).toBeDefined();
  });

  it('preserves existing values when descending', () => {
    const base: GlobalsMap = {
      window: { ___val: 'existing' },
    };
    descend(base, ['window', 'location']);
    expect(base.window.___val).toBe('existing');
    expect(base.window.location.___val).toBeDefined();
  });

  it('handles empty names array', () => {
    const base: GlobalsMap = {};
    descend(base, []);
    expect(Object.keys(base)).toHaveLength(0);
  });
});

describe('findNested', () => {
  it('finds values for matching keys', () => {
    const obj = {
      a: { target: 'found1' },
      b: { c: { target: 'found2' } },
    };
    const results = findNested(obj, 'target');
    expect(results).toContain('found1');
    expect(results).toContain('found2');
    expect(results).toHaveLength(2);
  });

  it('returns empty array when no match', () => {
    const obj = { a: 1, b: { c: 2 } };
    expect(findNested(obj, 'missing')).toEqual([]);
  });

  it('handles flat objects', () => {
    const obj = { target: 'value' };
    expect(findNested(obj, 'target')).toEqual(['value']);
  });

  it('handles arrays in the structure', () => {
    const obj = {
      items: [{ target: 'in_array' }],
    };
    const results = findNested(obj, 'target');
    expect(results).toContain('in_array');
  });

  it('accumulates into provided memo array', () => {
    const memo = ['pre-existing'];
    const obj = { target: 'new' };
    const results = findNested(obj, 'target', memo);
    expect(results).toContain('pre-existing');
    expect(results).toContain('new');
  });
});

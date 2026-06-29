import { substitute, traverseNode, traverseNodeAddSwap, descend, findNested } from '../substitute';
import { getGlobals, resetGlobals, setGlobals } from '../globals';
import { setScopeAnalysis, resetScopeAnalysis, ScopeAnalysis } from '../scopeAnalysis';
import { GlobalsMap } from '../types';

beforeEach(() => {
  resetGlobals();
  resetScopeAnalysis();
});

afterEach(() => {
  resetScopeAnalysis();
});

/** Build a minimal ScopeAnalysis object for direct substitute() tests. */
function makeAnalysis(): ScopeAnalysis {
  return {
    resolvedNames: new WeakMap(),
    freeReferences: new WeakSet(),
    skipNodes: new WeakSet(),
    liveNamesByScope: new WeakMap(),
  };
}

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

describe('substitute with scope analysis', () => {
  it('applies the scope-resolved rename when one exists', () => {
    const analysis = makeAnalysis();
    const node = { type: 'Identifier', name: 'x' } as any;
    analysis.resolvedNames.set(node, 'scoped_render');
    setScopeAnalysis(analysis);
    // Globals also has an entry — scope resolution must win over it.
    setGlobals({ x: { ___val: 'global_render' } } as GlobalsMap);
    substitute(node);
    expect(node.name).toBe('scoped_render');
  });

  it('does not rename a scope-resolved node that is marked skipped', () => {
    const analysis = makeAnalysis();
    const node = { type: 'Identifier', name: 'x', skipped: true } as any;
    analysis.resolvedNames.set(node, 'scoped_render');
    setScopeAnalysis(analysis);
    substitute(node);
    expect(node.name).toBe('x');
  });

  it('leaves skip-marked identifiers untouched', () => {
    const analysis = makeAnalysis();
    const node = { type: 'Identifier', name: 'keyName' } as any;
    analysis.skipNodes.add(node);
    setScopeAnalysis(analysis);
    setGlobals({ keyName: { ___val: 'global_render' } } as GlobalsMap);
    substitute(node);
    expect(node.name).toBe('keyName');
  });

  it('falls through to the flat globals map for free references', () => {
    const analysis = makeAnalysis();
    // Node is not in resolvedNames nor skipNodes — a "free reference" that
    // should fall through to the legacy globals path.
    const node = { type: 'Identifier', name: 'freeVar' } as any;
    setScopeAnalysis(analysis);
    setGlobals({ freeVar: { ___val: 'global_render' } } as GlobalsMap);
    substitute(node);
    expect(node.name).toBe('global_render');
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

describe('traverseNodeAddSwap', () => {
  it('swaps a bare document reference to window.document', () => {
    const node = {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'document' },
      property: { type: 'Identifier', name: 'cookie' },
    } as any;
    traverseNodeAddSwap(undefined, node);
    expect(node.object.name).toBe('window.document');
  });

  it('substitutes the object identifier via the globals map', () => {
    setGlobals({ myObj: { ___val: 'obf_obj' } } as GlobalsMap);
    const node = {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'myObj' },
      property: { type: 'Identifier', name: 'prop' },
      computed: false,
    } as any;
    traverseNodeAddSwap(undefined, node);
    expect(node.object.name).toBe('obf_obj');
  });

  it('skips the property on a non-computed (dotted) access', () => {
    setGlobals({
      myObj: { ___val: 'obf_obj' },
      prop: { ___val: 'should_not_be_used' },
    } as GlobalsMap);
    const node = {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'myObj' },
      property: { type: 'Identifier', name: 'prop' },
      computed: false,
    } as any;
    traverseNodeAddSwap(undefined, node);
    // Dotted property keys are semantic — left untouched and marked skipped.
    expect(node.property.skipped).toBe(true);
    expect(node.property.name).toBe('prop');
  });

  it('substitutes a computed property expression', () => {
    setGlobals({
      myObj: { ___val: 'obf_obj' },
      idx: { ___val: 'obf_idx' },
    } as GlobalsMap);
    const node = {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'myObj' },
      property: { type: 'Identifier', name: 'idx' },
      computed: true,
    } as any;
    traverseNodeAddSwap(undefined, node);
    expect(node.property.name).toBe('obf_idx');
  });

  it('marks a computed keyword property as skipped instead of renaming', () => {
    const node = {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'arr' },
      property: { type: 'Identifier', name: 'length' },
      computed: true,
    } as any;
    traverseNodeAddSwap(undefined, node);
    expect(node.property.skipped).toBe(true);
    expect(node.property.name).toBe('length');
  });

  it('marks the object as skipped when its name is a keyword', () => {
    const node = {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'Array' },
      property: { type: 'Identifier', name: 'isArray' },
      computed: false,
    } as any;
    traverseNodeAddSwap(undefined, node);
    expect(node.skipped).toBe(true);
    expect(node.object.name).toBe('Array');
  });

  it('recurses when the node has an object but no property', () => {
    setGlobals({ inner: { ___val: 'obf_inner' } } as GlobalsMap);
    // A node with an object but no property triggers the recursion branch.
    const node = {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'inner' },
    } as any;
    expect(() => traverseNodeAddSwap(undefined, node)).not.toThrow();
    // The object identifier is still substituted on the way down.
    expect(node.object.name).toBe('obf_inner');
  });

  it('does nothing for a node without an object', () => {
    const node = { type: 'Identifier', name: 'foo' } as any;
    expect(() => traverseNodeAddSwap(undefined, node)).not.toThrow();
    expect(node.name).toBe('foo');
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

import { isKeyword, buildKeywords, buildConsoleKeywords, getEncodableGlobals } from '../keywords';

describe('isKeyword', () => {
  it('recognizes built-in globals', () => {
    expect(isKeyword('Array')).toBe(true);
    expect(isKeyword('Object')).toBe(true);
    expect(isKeyword('Math')).toBe(true);
    expect(isKeyword('JSON')).toBe(true);
    expect(isKeyword('String')).toBe(true);
    expect(isKeyword('Number')).toBe(true);
  });

  it('recognizes module-related keywords', () => {
    expect(isKeyword('require')).toBe(true);
    expect(isKeyword('module')).toBe(true);
    expect(isKeyword('exports')).toBe(true);
  });

  it('recognizes window and console', () => {
    expect(isKeyword('window')).toBe(true);
    expect(isKeyword('console')).toBe(true);
    expect(isKeyword('arguments')).toBe(true);
  });

  it('recognizes prototype methods', () => {
    expect(isKeyword('toString')).toBe(true);
    expect(isKeyword('hasOwnProperty')).toBe(true);
    expect(isKeyword('valueOf')).toBe(true);
  });

  it('recognizes Node.js globals discovered dynamically', () => {
    expect(isKeyword('Promise')).toBe(true);
    expect(isKeyword('Map')).toBe(true);
    expect(isKeyword('Set')).toBe(true);
    expect(isKeyword('WeakMap')).toBe(true);
    expect(isKeyword('Buffer')).toBe(true);
    expect(isKeyword('process')).toBe(true);
  });

  it('recognizes DOM globals from window package', () => {
    expect(isKeyword('Document')).toBe(true);
    expect(isKeyword('Element')).toBe(true);
    expect(isKeyword('Event')).toBe(true);
    expect(isKeyword('Node')).toBe(true);
  });

  it('rejects non-keywords', () => {
    expect(isKeyword('myVariable')).toBe(false);
    expect(isKeyword('foo')).toBe(false);
    expect(isKeyword('bar')).toBe(false);
    expect(isKeyword('customFunc')).toBe(false);
  });

  it('does not treat catch as a keyword', () => {
    expect(isKeyword('catch')).toBe(false);
  });
});

describe('buildKeywords', () => {
  it('returns a large array from dynamic introspection', () => {
    const kw = buildKeywords();
    expect(Array.isArray(kw)).toBe(true);
    // Dynamic discovery should find hundreds of keywords
    expect(kw.length).toBeGreaterThan(200);
  });

  it('includes both Node.js and browser globals', () => {
    const kw = buildKeywords();
    // Node.js
    expect(kw).toContain('Array');
    expect(kw).toContain('Promise');
    expect(kw).toContain('Buffer');
    // Browser (from window package)
    expect(kw).toContain('Document');
    expect(kw).toContain('HTMLElement');
    // Prototype methods
    expect(kw).toContain('toString');
    expect(kw).toContain('hasOwnProperty');
  });
});

describe('buildConsoleKeywords', () => {
  it('dynamically discovers console methods', () => {
    const nodes = buildConsoleKeywords();
    // Should find more than the old hardcoded 14
    expect(nodes.length).toBeGreaterThanOrEqual(14);
    nodes.forEach((node: any) => {
      expect(node.type).toBe('ExpressionStatement');
    });
  });

  it('includes core console methods', () => {
    const nodes = buildConsoleKeywords();
    const code = nodes.map((n: any) => {
      // Extract the method name from the AST
      return n.expression?.left?.property?.name;
    }).filter(Boolean);
    expect(code).toContain('log');
    expect(code).toContain('error');
    expect(code).toContain('warn');
    expect(code).toContain('info');
    expect(code).toContain('trace');
    expect(code).toContain('debug');
    expect(code).toContain('dir');
  });
});

describe('getEncodableGlobals', () => {
  it('returns a Set of global names safe for eval encoding', () => {
    const globals = getEncodableGlobals();
    expect(globals instanceof Set).toBe(true);
    expect(globals.size).toBeGreaterThan(20);
  });

  it('includes constructors and namespaces', () => {
    const globals = getEncodableGlobals();
    expect(globals.has('Array')).toBe(true);
    expect(globals.has('Math')).toBe(true);
    expect(globals.has('Object')).toBe(true);
    expect(globals.has('JSON')).toBe(true);
    expect(globals.has('RegExp')).toBe(true);
    expect(globals.has('Map')).toBe(true);
  });

  it('excludes dangerous or module-system globals', () => {
    const globals = getEncodableGlobals();
    expect(globals.has('eval')).toBe(false);
    expect(globals.has('require')).toBe(false);
    expect(globals.has('module')).toBe(false);
    expect(globals.has('exports')).toBe(false);
    expect(globals.has('console')).toBe(false);
    expect(globals.has('process')).toBe(false);
    expect(globals.has('window')).toBe(false);
  });
});

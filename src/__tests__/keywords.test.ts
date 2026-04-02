import { isKeyword, buildKeywords, CONSOLE_METHODS, buildConsoleKeywords } from '../keywords';

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

  it('rejects non-keywords', () => {
    expect(isKeyword('myVariable')).toBe(false);
    expect(isKeyword('foo')).toBe(false);
    expect(isKeyword('bar')).toBe(false);
    expect(isKeyword('customFunc')).toBe(false);
  });

  it('does not treat catch as a keyword (matches original behavior)', () => {
    // The original code explicitly removes 'catch' from keywords
    expect(isKeyword('catch')).toBe(false);
  });
});

describe('buildKeywords', () => {
  it('returns an array of strings', () => {
    const kw = buildKeywords();
    expect(Array.isArray(kw)).toBe(true);
    expect(kw.length).toBeGreaterThan(50);
  });

  it('includes base keywords and prototype properties', () => {
    const kw = buildKeywords();
    expect(kw).toContain('Array');
    expect(kw).toContain('toString');
    expect(kw).toContain('hasOwnProperty');
  });
});

describe('CONSOLE_METHODS', () => {
  it('contains expected console methods', () => {
    expect(CONSOLE_METHODS).toContain('log');
    expect(CONSOLE_METHODS).toContain('error');
    expect(CONSOLE_METHODS).toContain('warn');
    expect(CONSOLE_METHODS).toContain('info');
    expect(CONSOLE_METHODS).toContain('trace');
  });

  it('has 14 methods', () => {
    expect(CONSOLE_METHODS).toHaveLength(14);
  });
});

describe('buildConsoleKeywords', () => {
  it('returns AST nodes for console stubs', () => {
    const nodes = buildConsoleKeywords();
    expect(nodes).toHaveLength(14);
    nodes.forEach((node: any) => {
      expect(node.type).toBe('ExpressionStatement');
    });
  });
});

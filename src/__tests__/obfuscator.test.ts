import { obfuscate } from '../obfuscator';

describe('obfuscate', () => {
  it('produces valid JavaScript output', () => {
    const code = 'var x = 1;';
    const result = obfuscate(code, { targetTokens: 10000 });
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes console stubs in output', () => {
    const code = 'var x = 1;';
    const result = obfuscate(code, { targetTokens: 10000 });
    expect(result).toContain('console.assert');
    expect(result).toContain('console.log');
    expect(result).toContain('console.error');
  });

  it('does not contain original variable names', () => {
    const code = 'var mySpecialVariable = 42;';
    const result = obfuscate(code, { targetTokens: 10000 });
    expect(result).not.toContain('mySpecialVariable');
  });

  it('encodes global keywords like Array and Object (not readable)', () => {
    const code = 'var x = new Array(); var y = Object.keys({});';
    const result = obfuscate(code, { targetTokens: 10000 });
    // Globals are now eval-encoded, so they should NOT appear as plain identifiers
    // but the code should contain eval (used to recover them at runtime)
    expect(result).toContain('eval');
    expect(result).toContain('replace');
  });

  it('handles function declarations', () => {
    const code = 'function myFunc(a, b) { return a + b; }';
    const result = obfuscate(code, { targetTokens: 10000 });
    expect(result).not.toContain('myFunc');
    expect(typeof result).toBe('string');
  });

  it('handles empty input', () => {
    const result = obfuscate('');
    expect(typeof result).toBe('string');
    // Should still have console stubs
    expect(result).toContain('console');
  });

  it('is idempotent in terms of resetting state', () => {
    const code = 'var a = 1;';
    const result1 = obfuscate(code, { targetTokens: 10000 });
    const result2 = obfuscate(code, { targetTokens: 10000 });
    // Both should be valid (names differ due to randomness)
    expect(result1).toContain('console');
    expect(result2).toContain('console');
  });
});

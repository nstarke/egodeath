import { Identifier, Literal } from '../ast';

describe('Identifier', () => {
  it('creates a node with type Identifier', () => {
    const node = Identifier('foo');
    expect(node.type).toBe('Identifier');
    expect(node.name).toBe('foo');
  });

  it('preserves unicode names', () => {
    const node = Identifier('\u00e9');
    expect(node.name).toBe('\u00e9');
  });
});

describe('Literal', () => {
  it('creates a string literal node', () => {
    const node = Literal('hello');
    expect(node.type).toBe('Literal');
    expect(node.value).toBe('hello');
  });

  it('creates a numeric literal node', () => {
    const node = Literal(42);
    expect(node.type).toBe('Literal');
    expect(node.value).toBe(42);
  });

  it('creates a boolean literal node', () => {
    const node = Literal(true);
    expect(node.value).toBe(true);
  });

  it('creates a null literal node', () => {
    const node = Literal(null);
    expect(node.value).toBeNull();
  });
});

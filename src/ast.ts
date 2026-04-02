import { IdentifierNode, LiteralNode } from './types';

/**
 * Create an AST Identifier node.
 */
export function Identifier(name: string): IdentifierNode {
  return { type: 'Identifier', name };
}

/**
 * Create an AST Literal node.
 */
export function Literal(value: any): LiteralNode {
  return { type: 'Literal', value };
}

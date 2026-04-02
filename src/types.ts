/**
 * AST node types used throughout the obfuscator.
 * These are simplified ESTree-compatible interfaces.
 */

export interface ASTNode {
  type: string;
  [key: string]: any;
}

export interface IdentifierNode extends ASTNode {
  type: 'Identifier';
  name: string;
  skipped?: boolean;
}

export interface LiteralNode extends ASTNode {
  type: 'Literal';
  value: any;
  raw?: string;
}

export interface MemberExpressionNode extends ASTNode {
  type: 'MemberExpression';
  object: ASTNode;
  property: ASTNode;
  skipped?: boolean;
}

export interface FunctionNode extends ASTNode {
  type: 'FunctionDeclaration' | 'FunctionExpression';
  id: IdentifierNode | null;
  params: IdentifierNode[];
}

export interface BinaryExpressionNode extends ASTNode {
  type: 'BinaryExpression';
  left: ASTNode;
  right: ASTNode;
  operator: string;
}

export interface AssignmentExpressionNode extends ASTNode {
  type: 'AssignmentExpression';
  left: ASTNode;
  right: ASTNode;
}

export interface CallExpressionNode extends ASTNode {
  type: 'CallExpression';
  callee: ASTNode;
  arguments: ASTNode[];
}

export interface GlobalsMap {
  [key: string]: any;
}

export type PassHandler = (node: ASTNode, parent: ASTNode) => ASTNode | void;

export interface PassHandlerMap {
  [nodeType: string]: PassHandler;
}

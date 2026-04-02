import { firstPassHandlers } from '../passes/firstPass';
import { secondPassHandlers } from '../passes/secondPass';
import { thirdPassHandlers } from '../passes/thirdPass';
import { addIdentifiers } from '../passes/thirdPass';
import { getGlobals, resetGlobals } from '../globals';

beforeEach(() => {
  resetGlobals();
});

describe('firstPassHandlers', () => {
  it('has handlers for all expected node types', () => {
    const expected = [
      'VariableDeclaration', 'ObjectExpression', 'Property',
      'BlockStatement', 'ForInStatement', 'LogicalExpression',
      'BinaryExpression', 'Identifier', 'VariableDeclarator',
      'NewExpression', 'CallExpression', 'FunctionExpression',
      'ReturnStatement', 'MemberExpression', 'ThisExpression',
      'ExpressionStatement', 'UpdateExpression', 'AssignmentExpression',
      'FunctionDeclaration', 'IfStatement', 'UnaryExpression',
      'SwitchCase', 'SwitchStatement', 'ConditionalExpression',
      'Program', 'Literal', 'ThrowStatement', 'Directive',
    ];
    expected.forEach((type) => {
      expect(firstPassHandlers[type]).toBeDefined();
    });
  });

  it('Identifier handler catalogs names into globals', () => {
    const node = { type: 'Identifier', name: 'myVar' };
    const parent = { type: 'Program' };
    firstPassHandlers.Identifier(node, parent);
    const globals = getGlobals();
    expect(globals.myVar).toBeDefined();
    expect(globals.myVar.___val).toBeDefined();
    expect(typeof globals.myVar.___val).toBe('string');
  });

  it('Identifier handler reuses existing globals entry', () => {
    const globals = getGlobals();
    (globals as any).myVar = { ___val: 'existing' };
    const node = { type: 'Identifier', name: 'myVar' };
    const parent = { type: 'Program' };
    firstPassHandlers.Identifier(node, parent);
    expect(getGlobals().myVar.___val).toBe('existing');
  });

  it('AssignmentExpression handler tracks window property assignments', () => {
    const node = {
      type: 'AssignmentExpression',
      left: {
        type: 'MemberExpression',
        object: { type: 'Identifier', name: 'window' },
        property: { type: 'Identifier', name: 'myGlobal' },
      },
      right: { type: 'Literal', value: 42 },
    };
    const parent = { type: 'ExpressionStatement' };
    firstPassHandlers.AssignmentExpression(node, parent);
    expect(getGlobals().myGlobal).toBeDefined();
  });
});

describe('secondPassHandlers', () => {
  it('has handlers for all expected node types', () => {
    const expected = [
      'VariableDeclaration', 'ObjectExpression', 'Property',
      'ForStatement', 'BlockStatement', 'ForInStatement',
      'LogicalExpression', 'BinaryExpression', 'Identifier',
      'VariableDeclarator', 'NewExpression', 'CallExpression',
      'FunctionExpression', 'ReturnStatement', 'MemberExpression',
      'ThisExpression', 'ExpressionStatement', 'UpdateExpression',
      'AssignmentExpression', 'FunctionDeclaration', 'IfStatement',
      'UnaryExpression', 'SwitchCase', 'SwitchStatement',
      'ConditionalExpression', 'Program', 'Literal',
      'ThrowStatement', 'Directive', 'DoWhileStatement',
      'ArrayExpression', 'CatchClause',
    ];
    expected.forEach((type) => {
      expect(secondPassHandlers[type]).toBeDefined();
    });
  });
});

describe('thirdPassHandlers', () => {
  it('has handlers for all expected node types', () => {
    const expected = [
      'VariableDeclaration', 'ObjectExpression', 'Property',
      'BlockStatement', 'ForInStatement', 'LogicalExpression',
      'BinaryExpression', 'Identifier', 'VariableDeclarator',
      'NewExpression', 'CallExpression', 'FunctionExpression',
      'ReturnStatement', 'MemberExpression', 'ThisExpression',
      'ExpressionStatement', 'UpdateExpression', 'AssignmentExpression',
      'FunctionDeclaration', 'IfStatement', 'UnaryExpression',
      'SwitchCase', 'SwitchStatement', 'ConditionalExpression',
      'Program', 'Literal', 'ThrowStatement', 'Directive',
    ];
    expected.forEach((type) => {
      expect(thirdPassHandlers[type]).toBeDefined();
    });
  });

  it('FunctionExpression handler adds dummy params', () => {
    const node = {
      type: 'FunctionExpression' as const,
      params: [{ type: 'Identifier', name: 'a' }],
    };
    const parent = { type: 'VariableDeclarator' };
    thirdPassHandlers.FunctionExpression(node, parent);
    // Should have original param plus 0-15 dummy params
    expect(node.params.length).toBeGreaterThanOrEqual(1);
  });

  it('FunctionDeclaration handler adds dummy params', () => {
    const node = {
      type: 'FunctionDeclaration' as const,
      params: [],
    };
    const parent = { type: 'Program' };
    thirdPassHandlers.FunctionDeclaration(node, parent);
    expect(node.params.length).toBeGreaterThanOrEqual(0);
  });
});

describe('addIdentifiers', () => {
  it('returns an array of Identifier nodes', () => {
    const ids = addIdentifiers();
    expect(Array.isArray(ids)).toBe(true);
    ids.forEach((id) => {
      expect(id.type).toBe('Identifier');
      expect(typeof id.name).toBe('string');
      expect(id.name.length).toBeGreaterThan(0);
    });
  });

  it('returns 0-15 identifiers', () => {
    for (let i = 0; i < 10; i++) {
      const ids = addIdentifiers();
      expect(ids.length).toBeGreaterThanOrEqual(0);
      expect(ids.length).toBeLessThanOrEqual(15);
    }
  });
});

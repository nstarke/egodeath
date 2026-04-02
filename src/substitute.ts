import { ASTNode, GlobalsMap } from './types';
import { isKeyword } from './keywords';
import { gen } from './random';
import { getGlobals, createEntry } from './globals';

/**
 * Replace an identifier node's name with its obfuscated equivalent.
 */
export function substitute(node: ASTNode | null | undefined, ctx?: GlobalsMap): void {
  if (!node || !node.name || node.name === 'undefined') return;
  const isKey = isKeyword(node.name);
  if (!node.skipped && !isKey) {
    const globals = getGlobals();
    if (globals[node.name]) {
      if (ctx && ctx[node.name]) {
        node.name = ctx[node.name].___val;
      } else {
        node.name = globals[node.name].___val;
      }
    }
  }
}

/**
 * Extract the property chain from a MemberExpression node.
 * e.g., window.location.hash -> ['window', 'location', 'hash']
 */
export function traverseNode(node: ASTNode, finalKey: string[] = []): string[] {
  if (node.object) {
    if (node.object.name) finalKey.push(node.object.name);
    if (node.property) {
      finalKey.push(node.property.name);
    } else {
      return traverseNode(node.object, finalKey);
    }
  }
  return finalKey;
}

/**
 * Process MemberExpression nodes: apply substitutions and handle
 * document -> window.document swaps.
 */
export function traverseNodeAddSwap(base: any, node: ASTNode): void {
  base = base || createEntry(gen());
  if (node.object) {
    const name = node.object.name;
    if (name === 'document') {
      node.object.name = 'window.document';
      return;
    }
    if (!isKeyword(name) && !node.skipped) {
      substitute(node.object, base);
    } else {
      node.skipped = true;
    }
    if (node.property) {
      const propName = node.property.name;
      if (!isKeyword(propName) && !node.property.skipped) {
        substitute(node.property, base);
      } else {
        node.property.skipped = true;
      }
    } else {
      traverseNodeAddSwap(base[node.object.name], node.object);
    }
  }
}

/**
 * Create nested object structure in the globals map for property chains.
 */
export function descend(base: GlobalsMap, names: string[]): void {
  for (let i = 0; i < names.length; i++) {
    base = base[names[i]] = base[names[i]] || createEntry(gen());
  }
}

/**
 * Recursively search a nested object for all values matching a key.
 */
export function findNested(obj: any, key: string, memo?: any[]): any[] {
  if (!Array.isArray(memo)) memo = [];

  for (const i in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, i)) {
      if (i === key) {
        memo.push(obj[i]);
      } else if (obj[i] !== null && typeof obj[i] === 'object') {
        findNested(obj[i], key, memo);
      }
    }
  }

  return memo;
}

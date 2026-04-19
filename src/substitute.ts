import { ASTNode, GlobalsMap } from './types';
import { isKeyword } from './keywords';
import { gen } from './random';
import { getGlobals, createEntry } from './globals';
import { getScopeAnalysis } from './scopeAnalysis';

/**
 * Replace an identifier node's name with its obfuscated equivalent.
 *
 * Priority order:
 *   1. Scope-resolved rename — the identifier node was seen by the
 *      scope analyzer and mapped to a specific binding's render. This
 *      wins because it's aware of shadowing and scope-local name
 *      assignment.
 *   2. Free reference — the analyzer saw this node but found no
 *      binding. Leaving the name untouched is the only safe choice;
 *      it's a real global.
 *   3. Skip-marked — the analyzer flagged this Identifier as a
 *      non-variable position (property key, label). Leave it alone.
 *   4. Flat globals map — the legacy name→name table. Used as a
 *      fallback for identifier nodes synthesized *after* scope analysis
 *      ran (most structural transforms introduce their own names before
 *      firstPass, but a few produce fresh nodes during secondPass). The
 *      fallback keeps those working.
 */
export function substitute(node: ASTNode | null | undefined, ctx?: GlobalsMap): void {
  if (!node || !node.name || node.name === 'undefined') return;

  const analysis = getScopeAnalysis();
  if (analysis) {
    const scoped = analysis.resolvedNames.get(node);
    if (scoped !== undefined) {
      if (!node.skipped) node.name = scoped;
      return;
    }
    if (analysis.skipNodes.has(node)) return;
    // Free references fall through to the flat-globals path below. A
    // "free reference" here just means "scope analysis didn't find a
    // binding for this Identifier at pass-2 time" — which also covers
    // names added to the tree before scope analysis ran but whose
    // declaration is injected later by flushCapturedGlobals (the
    // captured-RegExp style). The flat map still has those names
    // keyed to their final renamed form, so letting the fallback do
    // the rename is what keeps the declaration and references aligned.
  }

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
      // Only rename the property side when it's a *computed* access
      // (`obj[expr]`) — there the "property" is really an expression that
      // may reference a variable. For dotted access (`obj.foo`) the
      // property name is a semantic part of the object's shape; renaming
      // it silently changes obj.foo's name at runtime and breaks any
      // external consumer (module.exports, webpack runtime helpers,
      // Object.keys, reflection). Let propertyKeyEncoding hide these
      // via computed access when budget allows, which preserves the
      // string name at runtime.
      if (node.computed) {
        const propName = node.property.name;
        if (!isKeyword(propName) && !node.property.skipped) {
          substitute(node.property, base);
        } else {
          node.property.skipped = true;
        }
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

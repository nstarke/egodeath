/**
 * Obfuscation options that control the aggressiveness of transforms.
 */
export interface ObfuscateOptions {
  /**
   * Target output size in tokens. Transforms will throttle to stay
   * near this budget. Default: 2_000_000 (2 million tokens).
   *
   * Rough heuristic: 1 token ≈ 4 characters.
   */
  targetTokens: number;

  /**
   * API surface normalization. When set on `obfuscateMultiple`,
   * every file in the batch is rewritten so it ends with a shared
   * `module.exports = { <fixed dispatch key set> }` block. The key
   * set is identical (byte-identical at the source level) across
   * every file, the number of slots is fixed, and each file's real
   * default export lands at exactly one slot — the other slots get
   * type-uniform dummy functions.
   *
   * This defeats "which module is this?" signals at the CommonJS
   * boundary: a reader comparing two outputs can no longer use the
   * shape of the export object, the set of exported names, or the
   * arity/type of exported values to separate "module A" from
   * "module B" — they both expose the same dispatch surface.
   *
   * This breaks original consumers of the module (they must now
   * look up `require('./x').<dispatch_key>` instead of
   * `require('./x')`), so it's off by default and intended for
   * detection-hardening / adversarial-analysis contexts, not
   * production obfuscation.
   *
   * `obfuscate()` (single-file) ignores this flag: without
   * cross-file coordination, the key set is meaningless.
   */
  normalizeExports?: boolean;

  /**
   * Identifier-pool sharing. When set on `obfuscateMultiple`, a
   * single pool of random Unicode identifiers is generated once per
   * batch and installed before each file's obfuscation pass. Every
   * file draws names from the pool in order, with the index reset
   * between files, so the Nth `gen()` call in file A returns the
   * same identifier as the Nth `gen()` call in file B.
   *
   * A reader scanning the final outputs sees overlapping identifier
   * token sets across sibling files — the same surface signal
   * they'd see from a single source obfuscated twice. Combined
   * with cross-file transplants and export normalization, this
   * makes "is this two different modules?" hard to answer from the
   * token stream alone.
   *
   * No semantic effect: the rename map is still unique within each
   * file (pool entries are unique, and a file's local uniqueness
   * check is untouched). `obfuscate()` ignores the flag — pool
   * sharing is a cross-file property by definition.
   */
  shareIdentifiers?: boolean;
}

export const DEFAULT_OPTIONS: ObfuscateOptions = {
  targetTokens: 2_000_000,
};

/**
 * Compute bloat parameters based on input size and target token budget.
 */
export interface BloatBudget {
  /** Target output characters (targetTokens * ~4 chars/token) */
  targetChars: number;

  /** Input character count */
  inputChars: number;

  /** Maximum bloat ratio allowed (targetChars / inputChars) */
  maxBloatRatio: number;

  /** Probability (0-1) for context exhaustion expression wrapping */
  contextExhaustionProb: number;

  /** Probability (0-1) for opaque predicate injection */
  opaquePredicateProb: number;

  /** Multiplier (0-1) for dead code case count in CFF */
  deadCodeMultiplier: number;

  /** Whether to use XOR+hex encoding for strings (always true now) */
  useJsfuck: boolean;

  /** Legacy — no longer used with XOR+hex encoding */
  jsfuckStringLimit: number;
}

/**
 * Compute the bloat budget from input size and options.
 *
 * With XOR+hex string encoding (~2-4x expansion), the main bloat
 * comes from structural transforms (CFF, opaque predicates, dead code,
 * proxy functions, context exhaustion, property/global encoding).
 * Each layer adds roughly 1.5-3x, so the total achievable expansion
 * with all transforms at full intensity is ~10-30x.
 *
 * The budget system throttles transform probabilities when the input
 * is large relative to the target output. Small inputs always get
 * maximum obfuscation.
 */
export function computeBloatBudget(inputChars: number, options: ObfuscateOptions): BloatBudget {
  const CHARS_PER_TOKEN = 4;
  const targetChars = options.targetTokens * CHARS_PER_TOKEN;
  const maxBloatRatio = Math.max(2, targetChars / Math.max(1, inputChars));

  // With XOR+hex string encoding, the main volume comes from dead code
  // injection. headroom controls how aggressively we inject dead code.
  // headroom=1.0 at ratio 30 (modest budget), scales up beyond for
  // larger budgets to fill the token target.
  const headroom = Math.min(1, maxBloatRatio / 30);

  // Transform probabilities scale with headroom
  const contextExhaustionProb = Math.min(0.35, headroom * 0.35);
  const opaquePredicateProb = Math.min(0.30, headroom * 0.30);

  // Dead code multiplier: the primary volume lever.
  // Capped at 15 to avoid OOM — dead code generation is O(n*m) where n is
  // real cases and m is multiplier, and each dead case generates multiple
  // AST nodes that consume memory.
  const deadCodeMultiplier = Math.min(15, maxBloatRatio / 50);

  return {
    targetChars,
    inputChars,
    maxBloatRatio,
    contextExhaustionProb,
    opaquePredicateProb,
    deadCodeMultiplier,
    useJsfuck: true,
    jsfuckStringLimit: Infinity,
  };
}

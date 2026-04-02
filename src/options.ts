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
  // At maxBloatRatio=30 (tight), deadCodeMultiplier=1 (30% extra cases).
  // At maxBloatRatio=1000 (lots of headroom), deadCodeMultiplier=~33
  // (each real case gets ~10 dead cases, plus larger dead code blocks).
  const deadCodeMultiplier = Math.min(150, maxBloatRatio / 10);

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

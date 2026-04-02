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
 *
 * Returns probabilities (0-1) and multipliers that transforms use to
 * throttle their output. Small inputs get aggressive bloating;
 * large inputs get minimal bloating.
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

  /** Whether to jsfuck-encode strings in the string array */
  useJsfuck: boolean;

  /** Max number of strings to jsfuck-encode (rest stay as unicode-escaped literals) */
  jsfuckStringLimit: number;
}

/**
 * Compute the bloat budget from input size and options.
 */
export function computeBloatBudget(inputChars: number, options: ObfuscateOptions): BloatBudget {
  const CHARS_PER_TOKEN = 4;
  const targetChars = options.targetTokens * CHARS_PER_TOKEN;

  // Average jsfuck expansion per string: ~3000 chars for a 5-char string
  // Average strings per 100 chars of input: ~2-3
  // So jsfuck alone can produce: (inputChars / 100) * 3 * 3000 = inputChars * 90
  // Other transforms add ~5-20x on top

  const maxBloatRatio = Math.max(2, targetChars / Math.max(1, inputChars));

  // If the input is already large relative to target, heavily throttle
  // If the input is tiny, allow maximum bloat
  const headroom = Math.min(1, maxBloatRatio / 2000);

  // Context exhaustion: 35% at full budget, 0% when headroom is gone
  const contextExhaustionProb = Math.min(0.35, headroom * 0.35);

  // Opaque predicates: 30%/20% at full budget
  const opaquePredicateProb = Math.min(0.30, headroom * 0.30);

  // Dead code: 30% of real cases at full budget, fewer when tight
  const deadCodeMultiplier = Math.min(1, headroom);

  // Jsfuck is the biggest bloat driver (~90x per string)
  // For large inputs, limit the number of strings that get jsfuck-encoded
  const estimatedStrings = Math.max(1, Math.floor(inputChars / 30));
  const jsfuckBudgetChars = targetChars * 0.7; // allocate 70% of budget to jsfuck
  const charsPerJsfuckString = 3000; // rough average
  const jsfuckStringLimit = Math.max(
    10,
    Math.floor(jsfuckBudgetChars / charsPerJsfuckString),
  );

  return {
    targetChars,
    inputChars,
    maxBloatRatio,
    contextExhaustionProb,
    opaquePredicateProb,
    deadCodeMultiplier,
    useJsfuck: maxBloatRatio > 5, // disable jsfuck entirely for very tight budgets
    jsfuckStringLimit,
  };
}

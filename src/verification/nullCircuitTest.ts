/**
 * Null Circuit Test (Paper 10: Bartusek & Malavolta)
 *
 * Tests the quality of our obfuscation by comparing a real obfuscated
 * function against a "null" obfuscated function (one that does nothing).
 * If the two are structurally distinguishable, our dead code injection
 * and transforms have weaknesses that an analyzer could exploit.
 *
 * A high-quality obfuscator should make real and null functions
 * produce similar structural fingerprints after obfuscation.
 */

import { obfuscate } from '../obfuscator';

// ---- Structural metrics ----

/**
 * Fingerprint of an obfuscated output's structural properties.
 * These are the features a static analyzer would use to distinguish
 * real from null code.
 */
export interface StructuralFingerprint {
  /** Total character count */
  totalChars: number;
  /** Number of unique tokens (split on whitespace/punctuation) */
  uniqueTokens: number;
  /** Ratio of alphanumeric to symbolic characters */
  alphaSymRatio: number;
  /** Number of function keywords/expressions */
  functionCount: number;
  /** Number of if statements */
  ifCount: number;
  /** Number of for/while loops */
  loopCount: number;
  /** Number of return statements */
  returnCount: number;
  /** Number of variable declarations */
  varDeclCount: number;
  /** Number of assignment operators */
  assignmentCount: number;
  /** Number of binary operators */
  binaryOpCount: number;
  /** Number of string literals (hex-encoded) in the array */
  stringArraySize: number;
  /** Average nesting depth (estimated by bracket counting) */
  avgNestingDepth: number;
  /** Number of eval() calls */
  evalCount: number;
  /** Number of switch cases */
  switchCaseCount: number;
}

/**
 * Compute structural fingerprint of obfuscated code.
 */
export function computeFingerprint(code: string): StructuralFingerprint {
  const totalChars = code.length;

  // Token analysis
  const tokens = code.split(/[\s;,{}()\[\]]+/).filter(t => t.length > 0);
  const uniqueTokens = new Set(tokens).size;

  // Alpha vs symbol ratio
  const alphaChars = (code.match(/[a-zA-Z0-9]/g) || []).length;
  const symChars = (code.match(/[^a-zA-Z0-9\s]/g) || []).length;
  const alphaSymRatio = symChars > 0 ? alphaChars / symChars : alphaChars;

  // Statement/expression counts
  const functionCount = (code.match(/function\s*[\w$]*\s*\(/g) || []).length;
  const ifCount = (code.match(/\bif\s*\(/g) || []).length;
  const loopCount = (code.match(/\b(for|while)\s*\(/g) || []).length;
  const returnCount = (code.match(/\breturn\b/g) || []).length;
  const varDeclCount = (code.match(/\bvar\s/g) || []).length;
  const assignmentCount = (code.match(/[^!=<>]=[^=]/g) || []).length;
  const binaryOpCount = (code.match(/[\+\-\*\/\%\&\|\^](?!=)/g) || []).length;

  // String array size (count hex strings)
  const stringArraySize = (code.match(/"[0-9a-f]{4,}"/g) || []).length;

  // Nesting depth estimation
  let maxDepth = 0;
  let currentDepth = 0;
  let totalDepth = 0;
  let depthSamples = 0;
  for (const ch of code) {
    if (ch === '{' || ch === '(' || ch === '[') { currentDepth++; if (currentDepth > maxDepth) maxDepth = currentDepth; }
    if (ch === '}' || ch === ')' || ch === ']') { currentDepth = Math.max(0, currentDepth - 1); }
    if (ch === ';') { totalDepth += currentDepth; depthSamples++; }
  }
  const avgNestingDepth = depthSamples > 0 ? totalDepth / depthSamples : 0;

  // Specific pattern counts
  const evalCount = (code.match(/\beval\s*\(/g) || []).length;
  const switchCaseCount = (code.match(/\bcase\s/g) || []).length;

  return {
    totalChars,
    uniqueTokens,
    alphaSymRatio,
    functionCount,
    ifCount,
    loopCount,
    returnCount,
    varDeclCount,
    assignmentCount,
    binaryOpCount,
    stringArraySize,
    avgNestingDepth,
    evalCount,
    switchCaseCount,
  };
}

/**
 * Compute similarity score between two fingerprints.
 * Returns a value between 0 (completely different) and 1 (identical).
 *
 * Uses normalized metric comparison — each metric contributes equally
 * to the final score. A metric is considered "similar" if the values
 * are within 50% of each other.
 */
export function computeSimilarity(a: StructuralFingerprint, b: StructuralFingerprint): number {
  const metrics: (keyof StructuralFingerprint)[] = [
    'totalChars', 'uniqueTokens', 'alphaSymRatio',
    'functionCount', 'ifCount', 'loopCount', 'returnCount',
    'varDeclCount', 'assignmentCount', 'binaryOpCount',
    'stringArraySize', 'avgNestingDepth', 'evalCount', 'switchCaseCount',
  ];

  let totalSimilarity = 0;
  for (const key of metrics) {
    const va = a[key] as number;
    const vb = b[key] as number;
    const max = Math.max(Math.abs(va), Math.abs(vb), 1);
    const diff = Math.abs(va - vb);
    // Similarity for this metric: 1 when identical, 0 when one is 2x the other
    totalSimilarity += Math.max(0, 1 - diff / max);
  }

  return totalSimilarity / metrics.length;
}

// ---- Null circuit generation ----

/**
 * Generate a "null" function that has the same general shape as the
 * original but does nothing useful. It:
 * - Has the same number of parameters
 * - Has a similar number of variable declarations
 * - Has similar control flow (if/else, loops)
 * - Returns undefined (or a constant)
 *
 * The null function should be indistinguishable from a real function
 * after obfuscation. If it is distinguishable, our transforms are
 * leaking information about the code's purpose.
 */
export function generateNullFunction(
  name: string,
  paramCount: number,
  statementCount: number,
): string {
  const params = Array.from({ length: paramCount }, (_, i) => `p${i}`).join(', ');
  const stmts: string[] = [];

  // Generate similar-looking but useless statements.
  // Track which variables have been declared to avoid ReferenceErrors.
  const declared = new Set<string>();
  for (let i = 0; i < statementCount; i++) {
    const kind = i % 5;
    const lastVar = declared.size > 0 ? Array.from(declared).pop()! : 'p0';
    switch (kind) {
      case 0:
        stmts.push(`  var v${i} = p0 + ${i + 1};`);
        declared.add(`v${i}`);
        break;
      case 1:
        stmts.push(`  ${lastVar} = ${lastVar} * ${i + 2};`);
        break;
      case 2:
        stmts.push(`  if (${lastVar} > ${i * 10}) { ${lastVar} = ${lastVar} - ${i}; }`);
        break;
      case 3:
        stmts.push(`  var v${i} = ${lastVar} + p0;`);
        declared.add(`v${i}`);
        break;
      case 4:
        stmts.push(`  ${lastVar} = ${lastVar} ^ ${i * 7};`);
        break;
    }
  }

  // Always return undefined (null circuit)
  stmts.push('  return;');

  return `function ${name}(${params}) {\n${stmts.join('\n')}\n}`;
}

// ---- Test runner ----

export interface NullCircuitTestResult {
  /** The real function's structural fingerprint */
  realFingerprint: StructuralFingerprint;
  /** The null function's structural fingerprint */
  nullFingerprint: StructuralFingerprint;
  /** Similarity score (0-1) — higher is better for the obfuscator */
  similarity: number;
  /** Per-metric comparison */
  metricComparison: { metric: string; real: number; null_: number; ratio: number }[];
  /** Overall assessment */
  pass: boolean;
  /** Threshold used */
  threshold: number;
}

/**
 * Run the null circuit test.
 *
 * Obfuscates a real function and a null function with the same shape,
 * then compares their structural fingerprints. Returns a similarity
 * score — higher means the obfuscator is doing a better job of making
 * real and null code indistinguishable.
 *
 * @param realCode     The real function source code
 * @param paramCount   Number of parameters in the function
 * @param stmtCount    Number of statements in the function body
 * @param threshold    Minimum similarity to pass (default 0.5)
 * @param targetTokens Token budget for obfuscation
 */
export function runNullCircuitTest(
  realCode: string,
  paramCount: number,
  stmtCount: number,
  threshold: number = 0.5,
  targetTokens: number = 10000,
): NullCircuitTestResult {
  // Generate a null function with similar shape
  const nullCode = generateNullFunction('nullFn', paramCount, stmtCount);

  // Obfuscate both with the same settings
  const obfReal = obfuscate(realCode, { targetTokens });
  const obfNull = obfuscate(nullCode, { targetTokens });

  // Compute fingerprints
  const realFp = computeFingerprint(obfReal);
  const nullFp = computeFingerprint(obfNull);

  // Compute similarity
  const similarity = computeSimilarity(realFp, nullFp);

  // Per-metric comparison
  const metrics: (keyof StructuralFingerprint)[] = [
    'totalChars', 'uniqueTokens', 'alphaSymRatio',
    'functionCount', 'ifCount', 'loopCount', 'returnCount',
    'varDeclCount', 'assignmentCount', 'binaryOpCount',
    'stringArraySize', 'avgNestingDepth', 'evalCount', 'switchCaseCount',
  ];
  const metricComparison = metrics.map(m => {
    const rv = realFp[m] as number;
    const nv = nullFp[m] as number;
    return {
      metric: m,
      real: rv,
      null_: nv,
      ratio: Math.max(rv, nv, 1) > 0 ? Math.min(rv, nv) / Math.max(rv, nv, 1) : 1,
    };
  });

  return {
    realFingerprint: realFp,
    nullFingerprint: nullFp,
    similarity,
    metricComparison,
    pass: similarity >= threshold,
    threshold,
  };
}

/**
 * Unobfuscatable Function Test Cases (Paper 1: Barak et al.)
 *
 * Paper 1 proves that VBB obfuscation is impossible by constructing
 * specific function families where secrets can ALWAYS be extracted
 * from any program that computes the function. These are pathological
 * cases that test the limits of any obfuscator.
 *
 * We implement these as test cases for our obfuscator. Each test
 * constructs a "hard" function, obfuscates it, then attempts to
 * extract the embedded secret from the obfuscated output. If the
 * secret is extractable, we know our obfuscation is insufficient
 * for that pattern — and we can measure HOW extractable it is.
 *
 * Test categories:
 * 1. Password/point functions: f(x) = (x === secret) ? 1 : 0
 * 2. Self-referencing programs: functions that embed their own source
 * 3. Correlation extractors: functions where output correlates with source
 * 4. Signature-like functions: functions with embedded keys
 * 5. Canary values: functions with distinctive constant patterns
 */

import { obfuscate } from '../obfuscator';

// ---- Test result types ----

export interface ExtractionAttempt {
  /** Name of the test case */
  name: string;
  /** Description of what makes this function hard to obfuscate */
  description: string;
  /** The original source code */
  originalCode: string;
  /** The obfuscated output */
  obfuscatedCode: string;
  /** Whether the secret was found in the obfuscated output */
  secretExtracted: boolean;
  /** Details of the extraction attempt */
  extractionDetails: string;
  /** The secret that was embedded */
  secret: string;
  /** Category of the test */
  category: string;
}

// ---- Test case 1: Point function (password check) ----

/**
 * A point function returns true for exactly one input (the "password").
 * Paper 1 shows these CAN be obfuscated (via hashing), but a naive
 * obfuscator that leaves the comparison string visible fails.
 *
 * Tests: Is the password string visible in the obfuscated output?
 */
export function testPointFunction(targetTokens: number = 10000): ExtractionAttempt {
  const secret = 'SuperSecretPassword_' + Math.random().toString(36).slice(2, 10);
  const code = `
    function checkPassword(input) {
      if (input === "${secret}") {
        return true;
      }
      return false;
    }
    module.exports = checkPassword;
  `;

  const obfuscated = obfuscate(code, { targetTokens });

  // Extraction attempt: search for the password string directly
  const directMatch = obfuscated.includes(secret);
  // Also try partial matches (substrings of 8+ chars)
  const partialMatch = secret.length >= 8 &&
    obfuscated.includes(secret.substring(0, 8));

  return {
    name: 'Point Function (Password Check)',
    description: 'Function returns true for exactly one secret input. Tests if the secret string is hidden.',
    category: 'point-function',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret,
    secretExtracted: directMatch || partialMatch,
    extractionDetails: directMatch
      ? 'FAIL: Password found as literal string in output'
      : partialMatch
        ? 'WEAK: Password prefix found in output'
        : 'PASS: Password not found in output (hidden by string array + XOR encoding)',
  };
}

// ---- Test case 2: Embedded constant / magic number ----

/**
 * A function that uses a distinctive constant (magic number) in
 * its computation. If the constant appears in the obfuscated output,
 * an attacker can identify the algorithm.
 */
export function testMagicNumber(targetTokens: number = 10000): ExtractionAttempt {
  // Use a distinctive constant that would identify the algorithm
  const secret = '3735928559'; // 0xDEADBEEF
  const code = `
    function hash(input) {
      var h = 3735928559;
      for (var i = 0; i < input.length; i++) {
        h = h ^ input.charCodeAt(i);
        h = (h * 16777619) >>> 0;
      }
      return h;
    }
    module.exports = hash;
  `;

  const obfuscated = obfuscate(code, { targetTokens });

  // Search for the magic number in various representations
  const decMatch = obfuscated.includes('3735928559');
  const hexMatch = obfuscated.includes('0xDEADBEEF') || obfuscated.includes('0xdeadbeef');
  const fnvMatch = obfuscated.includes('16777619');

  return {
    name: 'Magic Number Extraction',
    description: 'Function uses distinctive constants (0xDEADBEEF, FNV prime). Tests if constants are hidden.',
    category: 'magic-number',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret,
    secretExtracted: decMatch || hexMatch || fnvMatch,
    extractionDetails: decMatch || hexMatch
      ? 'FAIL: Magic number 0xDEADBEEF found in output'
      : fnvMatch
        ? 'WEAK: FNV prime 16777619 found in output'
        : 'PASS: Magic numbers hidden by number encoding',
  };
}

// ---- Test case 3: Canary string pattern ----

/**
 * Embeds a distinctive string pattern that could identify the
 * software or its version. Tests if identifiable strings survive
 * obfuscation.
 */
export function testCanaryString(targetTokens: number = 10000): ExtractionAttempt {
  const secret = 'MyApp-v2.3.1-licensed-to-user42';
  const code = `
    function getVersion() {
      var version = "${secret}";
      return version;
    }
    module.exports = getVersion;
  `;

  const obfuscated = obfuscate(code, { targetTokens });

  const directMatch = obfuscated.includes(secret);
  // Try fragments
  const fragmentMatch =
    obfuscated.includes('MyApp') ||
    obfuscated.includes('v2.3.1') ||
    obfuscated.includes('licensed') ||
    obfuscated.includes('user42');

  return {
    name: 'Canary String Pattern',
    description: 'Function returns a distinctive version/license string. Tests if identifiable fragments survive.',
    category: 'canary-string',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret,
    secretExtracted: directMatch || fragmentMatch,
    extractionDetails: directMatch
      ? 'FAIL: Canary string found verbatim in output'
      : fragmentMatch
        ? 'WEAK: Canary string fragments found in output'
        : 'PASS: Canary string fully hidden',
  };
}

// ---- Test case 4: Embedded key bytes ----

/**
 * A function that uses a cryptographic-style key (sequence of bytes).
 * Tests if byte sequences survive obfuscation.
 */
export function testEmbeddedKey(targetTokens: number = 10000): ExtractionAttempt {
  // Generate a random "key"
  const keyBytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  const secret = keyBytes.join(',');
  const code = `
    function getKey() {
      var key = [${secret}];
      return key;
    }
    module.exports = getKey;
  `;

  const obfuscated = obfuscate(code, { targetTokens });

  // Search for the key bytes as a sequence
  const fullMatch = obfuscated.includes(secret);
  // Try finding 4+ consecutive bytes
  let partialMatch = false;
  for (let i = 0; i <= keyBytes.length - 4; i++) {
    const fragment = keyBytes.slice(i, i + 4).join(',');
    if (obfuscated.includes(fragment)) {
      partialMatch = true;
      break;
    }
  }

  return {
    name: 'Embedded Key Bytes',
    description: 'Function returns a 16-byte key array. Tests if byte sequences are hidden.',
    category: 'embedded-key',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret: `[${secret}]`,
    secretExtracted: fullMatch || partialMatch,
    extractionDetails: fullMatch
      ? 'FAIL: Full key byte sequence found in output'
      : partialMatch
        ? 'WEAK: Partial key sequence (4+ bytes) found in output'
        : 'PASS: Key bytes not found as a recognizable sequence',
  };
}

// ---- Test case 5: URL/endpoint leak ----

/**
 * A function that contains an API URL. Tests if URLs survive obfuscation.
 */
export function testUrlLeak(targetTokens: number = 10000): ExtractionAttempt {
  const secret = 'https://api.internal.example.com/v2/secret-endpoint';
  const code = `
    function getEndpoint() {
      var url = "${secret}";
      return url;
    }
    module.exports = getEndpoint;
  `;

  const obfuscated = obfuscate(code, { targetTokens });

  const directMatch = obfuscated.includes(secret);
  const domainMatch = obfuscated.includes('api.internal.example.com');
  const pathMatch = obfuscated.includes('secret-endpoint');
  const protocolMatch = obfuscated.includes('https://');

  return {
    name: 'URL/Endpoint Leak',
    description: 'Function contains an API URL. Tests if URLs are hidden.',
    category: 'url-leak',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret,
    secretExtracted: directMatch || domainMatch || pathMatch,
    extractionDetails: directMatch
      ? 'FAIL: Full URL found in output'
      : domainMatch
        ? 'WEAK: Domain name found in output'
        : pathMatch
          ? 'WEAK: URL path found in output'
          : 'PASS: URL fully hidden',
  };
}

// ---- Test case 6: Regex pattern leak ----

/**
 * A function that uses a distinctive regex. Tests if regex patterns
 * survive obfuscation (they often do since regex literals are special).
 */
export function testRegexLeak(targetTokens: number = 10000): ExtractionAttempt {
  const secret = '^[A-Z]{2}\\d{6}[A-Z]$';
  const code = `
    function validateID(input) {
      var pattern = new RegExp("${secret}");
      return pattern.test(input);
    }
    module.exports = validateID;
  `;

  const obfuscated = obfuscate(code, { targetTokens });

  // Regex patterns are strings, so they should go through string array
  const directMatch = obfuscated.includes(secret);
  const fragmentMatch = obfuscated.includes('[A-Z]') || obfuscated.includes('\\d{6}');

  return {
    name: 'Regex Pattern Leak',
    description: 'Function uses a distinctive regex pattern. Tests if regex strings are hidden.',
    category: 'regex-leak',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret,
    secretExtracted: directMatch || fragmentMatch,
    extractionDetails: directMatch
      ? 'FAIL: Full regex pattern found in output'
      : fragmentMatch
        ? 'WEAK: Regex fragments found in output'
        : 'PASS: Regex pattern fully hidden in string array',
  };
}

// ---- Test case 7: Control flow signature ----

/**
 * A function with a distinctive control flow pattern (specific
 * sequence of operations). Tests if the operation sequence is
 * preserved or scrambled by CFF.
 */
export function testControlFlowSignature(targetTokens: number = 10000): ExtractionAttempt {
  const secret = 'add-mul-sub-xor-shift'; // The operation sequence
  const code = `
    function transform(x) {
      var a = x + 42;
      var b = a * 7;
      var c = b - 13;
      var d = c ^ 255;
      var e = d << 3;
      return e;
    }
    module.exports = transform;
  `;

  const obfuscated = obfuscate(code, { targetTokens });

  // Check if the operation sequence is preserved in order
  // In CFF, the operations should be in switch cases with shuffled order
  const ops = ['+', '*', '-', '^', '<<'];
  let lastIdx = -1;
  let inOrder = true;
  for (const op of ops) {
    const idx = obfuscated.indexOf(` ${op} `, lastIdx + 1);
    if (idx === -1 || idx < lastIdx) {
      inOrder = false;
      break;
    }
    lastIdx = idx;
  }

  return {
    name: 'Control Flow Signature',
    description: 'Function has a distinctive operation sequence (add-mul-sub-xor-shift). Tests if CFF scrambles it.',
    category: 'control-flow',
    originalCode: code,
    obfuscatedCode: obfuscated,
    secret,
    secretExtracted: inOrder,
    extractionDetails: inOrder
      ? 'WEAK: Operation sequence preserved in original order (CFF may not have applied)'
      : 'PASS: Operation sequence scrambled by control flow flattening',
  };
}

// ---- Runner ----

/**
 * Run all unobfuscatable function tests and return results.
 */
export function runAllTests(targetTokens: number = 10000): ExtractionAttempt[] {
  return [
    testPointFunction(targetTokens),
    testMagicNumber(targetTokens),
    testCanaryString(targetTokens),
    testEmbeddedKey(targetTokens),
    testUrlLeak(targetTokens),
    testRegexLeak(targetTokens),
    testControlFlowSignature(targetTokens),
  ];
}

/**
 * Print a summary of all test results.
 */
export function printSummary(results: ExtractionAttempt[]): string {
  const lines: string[] = ['=== Unobfuscatable Function Tests (Paper 1) ===\n'];

  let passed = 0;
  let failed = 0;
  let weak = 0;

  for (const r of results) {
    const status = r.secretExtracted ? 'EXPOSED' : 'HIDDEN';
    const icon = r.secretExtracted ? '\u2717' : '\u2713';
    lines.push(`${icon} ${r.name}: ${status}`);
    lines.push(`  ${r.extractionDetails}`);

    if (r.extractionDetails.startsWith('PASS')) passed++;
    else if (r.extractionDetails.startsWith('WEAK')) weak++;
    else failed++;
  }

  lines.push(`\nResults: ${passed} passed, ${weak} weak, ${failed} failed out of ${results.length}`);
  return lines.join('\n');
}

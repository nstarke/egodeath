#!/usr/bin/env ts-node
// Standalone evaluation harness for the egodeath obfuscator.
//
// For each trial, this tool:
//   1. Flips a coin to decide whether to present "same module obfuscated twice"
//      or "two different modules each obfuscated".
//   2. Runs the obfuscator with fresh randomness on the selected source(s).
//   3. Rebalances the per-file `target-tokens` until the two samples are within
//      --max-delta bytes of each other (default 250,000).
//   4. Submits both samples to the OpenAI Chat Completions API ("ChatGPT"),
//      asking whether they are the same source twice or two different sources.
//   5. Records the model's verdict alongside the coin-flip ground truth.
//
// After all trials, a confusion-matrix summary is printed.
//
// This harness runs completely independent of the Jest suite — it never
// touches `src/__tests__/` and does not share global state with any other test.
//
// Usage:
//   OPENAI_API_KEY=sk-... npx ts-node --project tools/tsconfig.json \
//     tools/obfuscation-detection-test.ts --runs 20
//
//   npm run detect-obfuscation -- --runs 20 --model gpt-4o --verbose

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { obfuscate, obfuscateMultiple } from '../src/obfuscator';

/** Absolute path to the project root (parent of `tools/`). */
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Return the current git HEAD commit SHA so every report is tied to
 * the exact version of the obfuscator that produced it. Falls back to
 * 'unknown' if the working tree is not a repository or `git` isn't on
 * PATH — we don't want a missing git binary to derail the run.
 */
function gitHeadSha(): string {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString('utf-8').trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Return true when the working tree has uncommitted changes relative
 * to HEAD. Used to annotate the report — a dirty tree means the
 * committed SHA doesn't fully identify the code that ran.
 */
function gitIsDirty(): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString('utf-8').trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Filesystem-safe timestamp slug for log filenames, local time:
 *   2026-04-19_14-30-45
 * Colons and slashes out so the string is portable across shells and
 * file managers.
 */
function timestampSlug(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
  );
}

interface CliOptions {
  runs: number;
  targetTokens: number;
  minDeltaBytes: number;
  maxDeltaBytes: number;
  smallFileThresholdBytes: number;
  smallFileMaxDeltaBytes: number;
  maxResizeAttempts: number;
  model: string;
  sourceDir: string;
  outputJson?: string;
  dumpDir?: string;
  verbose: boolean;
  /**
   * Forward to `obfuscateMultiple({ normalizeExports: true })` for
   * DIFFERENT trials. See `ObfuscateOptions` in src/options.ts.
   * SAME trials never involve obfuscateMultiple, so this flag is a
   * no-op for them — that's desired, since the asymmetry is
   * precisely what we want to measure (DIFFERENT pairs get
   * normalized + cross-polinated; SAME pairs don't).
   */
  normalizeExports: boolean;
  /**
   * Forward to `obfuscateMultiple({ shareIdentifiers: true })` for
   * DIFFERENT trials. Same SAME/DIFFERENT asymmetry as
   * `normalizeExports`.
   */
  shareIdentifiers: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    runs: 10,
    targetTokens: 25_000,
    minDeltaBytes: 100_000,
    maxDeltaBytes: 250_000,
    smallFileThresholdBytes: 250_000,
    smallFileMaxDeltaBytes: 25_000,
    maxResizeAttempts: 6,
    model: 'gpt-4o',
    sourceDir: path.resolve(__dirname, '..', 'tests'),
    verbose: false,
    normalizeExports: false,
    shareIdentifiers: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' || a === '-n') opts.runs = Number(argv[++i]);
    else if (a === '--target-tokens') opts.targetTokens = Number(argv[++i]);
    else if (a === '--min-delta') opts.minDeltaBytes = Number(argv[++i]);
    else if (a === '--max-delta') opts.maxDeltaBytes = Number(argv[++i]);
    else if (a === '--small-file-threshold') opts.smallFileThresholdBytes = Number(argv[++i]);
    else if (a === '--small-file-max-delta') opts.smallFileMaxDeltaBytes = Number(argv[++i]);
    else if (a === '--max-resize-attempts') opts.maxResizeAttempts = Number(argv[++i]);
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--source-dir') opts.sourceDir = path.resolve(argv[++i]);
    else if (a === '--output') opts.outputJson = path.resolve(argv[++i]);
    else if (a === '--dump-dir') opts.dumpDir = path.resolve(argv[++i]);
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--normalize-exports') opts.normalizeExports = true;
    else if (a === '--share-identifiers') opts.shareIdentifiers = true;
    else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage();
      process.exit(2);
    }
  }

  if (!Number.isFinite(opts.runs) || opts.runs < 1) {
    console.error('--runs must be a positive integer');
    process.exit(2);
  }
  if (!Number.isFinite(opts.targetTokens) || opts.targetTokens < 1000) {
    console.error('--target-tokens must be >= 1000');
    process.exit(2);
  }
  if (!Number.isFinite(opts.minDeltaBytes) || opts.minDeltaBytes < 0) {
    console.error('--min-delta must be a non-negative integer');
    process.exit(2);
  }
  if (!Number.isFinite(opts.maxDeltaBytes) || opts.maxDeltaBytes <= opts.minDeltaBytes) {
    console.error('--max-delta must be a positive integer greater than --min-delta');
    process.exit(2);
  }
  if (!Number.isFinite(opts.smallFileThresholdBytes) || opts.smallFileThresholdBytes <= 0) {
    console.error('--small-file-threshold must be a positive integer');
    process.exit(2);
  }
  if (!Number.isFinite(opts.smallFileMaxDeltaBytes) || opts.smallFileMaxDeltaBytes <= 0) {
    console.error('--small-file-max-delta must be a positive integer');
    process.exit(2);
  }
  return opts;
}

function printUsage(): void {
  console.log(`Usage: ts-node tools/obfuscation-detection-test.ts [options]

For each trial, randomly chooses between:
  (SAME)      one source module, obfuscated twice with DIFFERENT target-token
              budgets — the two outputs are sized so their byte delta lands
              in [--min-delta, --max-delta], removing size as a trivial
              signal for SAME and forcing the model to reason about
              semantic invariants.
  (DIFFERENT) two distinct source modules, obfuscated TOGETHER via the
              multi-file pipeline. This shares the dead-code donor pool
              between them and pads both string arrays to the same length,
              so structural cues that usually separate different sources
              (array size, per-file literal distribution) are neutralised.

Both samples are submitted to the OpenAI Chat Completions API ("ChatGPT"),
which is asked to classify them as SAME or DIFFERENT. Ground-truth from the
coin flip is compared against the model's verdict and summarised at the end.

Options:
  --runs, -n <n>            Number of trials (default: 10)
  --target-tokens <n>       Starting obfuscation target tokens (default: 25000)
                            Smaller = smaller samples = fewer API tokens used.

  SAME-trial delta window
  ───────────────────────
  Applies only to SAME trials and switches on output size:
    * When max(bytesA, bytesB) ≥ --small-file-threshold (large-file regime),
      the delta must fall inside [--min-delta, --max-delta].
    * When both outputs are below --small-file-threshold (small-file
      regime), the delta must be ≤ --small-file-max-delta. Forcing a
      100 KB gap between two 20 KB files would leave one 8x the other,
      which itself is a trivial tell — the small regime keeps the pair
      close in size instead.

  --min-delta <bytes>            Large-regime minimum delta (default: 100000).
  --max-delta <bytes>            Large-regime maximum delta (default: 250000).
  --small-file-threshold <bytes> Outputs below this enter the small regime
                                 (default: 250000).
  --small-file-max-delta <bytes> Small-regime maximum delta (default: 25000).

  --max-resize-attempts <n> For SAME trials only — how many re-obfuscations
                            to run while trying to land inside the
                            size-dependent delta window (default: 6). The
                            window is recomputed each iteration, so the
                            loop converges even when shrinking crosses the
                            regime threshold.
  --model <name>            OpenAI model name (default: gpt-4o)
  --source-dir <dir>        Directory containing .js source files
                            (default: ./tests)
  --output <file>           Write full JSON report to this path
  --dump-dir <dir>          Save every submitted sample to this directory
                            (useful for debugging a MISS)
  --verbose, -v             Print the model's raw reply for each trial

  Detection-hardening flags (apply to DIFFERENT trials only; SAME
  trials use the single-file obfuscate() path which doesn't
  coordinate across files, so flipping these flags doesn't change
  what SAME trials produce)
  ───────────────────────────────────────────────────────────────
  --normalize-exports       Rewrite both DIFFERENT-trial outputs so
                            they end with the same-shaped
                            module.exports = {<fixed key set>}
                            dispatch block. Neutralises the CJS
                            export boundary as a "which module is
                            this?" signal.
  --share-identifiers       Seed both DIFFERENT-trial outputs from
                            the same random-identifier pool so the
                            Nth gen() call in each produces the same
                            Unicode name. Collapses identifier token
                            overlap between sibling outputs.

Environment:
  OPENAI_API_KEY            Required. Your OpenAI API key.
`);
}

function listSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`source directory does not exist: ${dir}`);
  }
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.js')) continue;
    if (entry.name.endsWith('.obfuscated.js')) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

function pickOne<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickTwoDistinct<T>(arr: T[]): [T, T] {
  if (arr.length < 2) throw new Error('need at least 2 source files to pick distinct pair');
  const i = Math.floor(Math.random() * arr.length);
  let j = Math.floor(Math.random() * arr.length);
  while (j === i) j = Math.floor(Math.random() * arr.length);
  return [arr[i], arr[j]];
}

interface Sample {
  sourcePath: string;
  targetTokens: number;
  content: string;
  bytes: number;
}

function obfuscateOne(src: string, sourcePath: string, targetTokens: number): Sample {
  const content = obfuscate(src, { targetTokens });
  return {
    sourcePath,
    targetTokens,
    content,
    bytes: Buffer.byteLength(content, 'utf-8'),
  };
}

/**
 * Delta window for a SAME-trial pair, decided by the size of the
 * current outputs:
 *
 *   - When both outputs are SMALL (the larger is < smallFileThreshold,
 *     i.e. the pair would comfortably fit into one API request even
 *     at the upper bound), we require the pair to stay WITHIN
 *     smallFileMaxDelta bytes of each other. A 150KB gap on two
 *     20KB files would leave one sample 8x larger than the other —
 *     that size ratio is itself a trivial tell, so small pairs get
 *     the "close in size" treatment instead.
 *
 *   - Once at least one output has grown past smallFileThreshold,
 *     the pair is in the "large file" regime and the delta must
 *     live inside [minDelta, maxDelta]. A 100–250KB gap on
 *     >250KB files is proportionally small and forces the model
 *     to rely on semantic invariants rather than size ratios.
 */
function deltaWindowFor(
  maxSize: number,
  opts: CliOptions,
): { min: number; max: number; regime: 'small' | 'large' } {
  if (maxSize < opts.smallFileThresholdBytes) {
    return { min: 0, max: opts.smallFileMaxDeltaBytes, regime: 'small' };
  }
  return { min: opts.minDeltaBytes, max: opts.maxDeltaBytes, regime: 'large' };
}

/**
 * SAME-trial pair: obfuscate the same source twice at DIFFERENT
 * target-token budgets so the byte delta between the two outputs
 * lands inside the size-dependent window computed by
 * `deltaWindowFor`. Size stops being a usable cue for SAME vs
 * DIFFERENT — the model has to look past it.
 *
 * Starts with A at `baseTokens` and B at 3x, then nudges whichever
 * sample is currently larger toward the midpoint of the active
 * window. The window itself is recomputed on every iteration because
 * shrinking one sample can move the pair across the small/large
 * regime threshold — the loop still converges because each iteration
 * either moves the larger sample toward the midpoint (small regime)
 * or moves it into the [min, max] window (large regime) and the
 * byte→token rate stays stable within the bloat budget's operating
 * range.
 */
function produceSameSourcePair(
  src: string,
  sourcePath: string,
  baseTokens: number,
  opts: CliOptions,
  maxAttempts: number,
): { a: Sample; b: Sample; attempts: number; converged: boolean; regime: 'small' | 'large' } {
  let tokensA = baseTokens;
  let tokensB = Math.max(baseTokens + 1000, Math.round(baseTokens * 3));
  let a = obfuscateOne(src, sourcePath, tokensA);
  let b = obfuscateOne(src, sourcePath, tokensB);
  let attempts = 1;

  while (attempts < maxAttempts) {
    const maxSize = Math.max(a.bytes, b.bytes);
    const window = deltaWindowFor(maxSize, opts);
    const delta = Math.abs(a.bytes - b.bytes);
    if (delta >= window.min && delta <= window.max) break;

    // Aim at the midpoint of the active window. Small regime:
    // midpoint ≈ smallMax/2 (shrink the gap). Large regime: midpoint
    // of [min, max] (shrink a too-wide gap or widen a too-narrow one).
    const target = (window.min + window.max) / 2;
    const bigger = b.bytes >= a.bytes ? 'b' : 'a';
    if (bigger === 'b') {
      const rate = b.bytes / Math.max(1, b.targetTokens);
      const desiredB = a.bytes + target;
      tokensB = Math.max(1000, Math.round(desiredB / Math.max(1, rate)));
      b = obfuscateOne(src, sourcePath, tokensB);
    } else {
      const rate = a.bytes / Math.max(1, a.targetTokens);
      const desiredA = b.bytes + target;
      tokensA = Math.max(1000, Math.round(desiredA / Math.max(1, rate)));
      a = obfuscateOne(src, sourcePath, tokensA);
    }
    attempts++;
  }

  const maxSize = Math.max(a.bytes, b.bytes);
  const finalWindow = deltaWindowFor(maxSize, opts);
  const finalDelta = Math.abs(a.bytes - b.bytes);
  return {
    a,
    b,
    attempts,
    converged: finalDelta >= finalWindow.min && finalDelta <= finalWindow.max,
    regime: finalWindow.regime,
  };
}

/**
 * DIFFERENT-trial pair: obfuscate two distinct sources TOGETHER via
 * obfuscateMultiple. That shares the dead-code donor pool between
 * the two files and normalises their string arrays to the same
 * length with samples drawn from both files' literals — features a
 * reader might otherwise use to separate "these are different
 * source modules" from "these are the same module twice".
 *
 * No size rebalancing here: the multi-file pipeline already equalises
 * the most visible per-file shape (the string array), and letting
 * the total bytes reflect natural source differences keeps the test
 * honest about what remains detectable downstream.
 */
function produceDifferentSourcesPair(
  srcAPath: string,
  srcBPath: string,
  targetTokens: number,
  extraOpts: { normalizeExports?: boolean; shareIdentifiers?: boolean } = {},
): { a: Sample; b: Sample } {
  const srcA = fs.readFileSync(srcAPath, 'utf-8');
  const srcB = fs.readFileSync(srcBPath, 'utf-8');
  const results = obfuscateMultiple(
    [
      { filename: path.basename(srcAPath), code: srcA },
      { filename: path.basename(srcBPath), code: srcB },
    ],
    { targetTokens, ...extraOpts },
  );
  return {
    a: {
      sourcePath: srcAPath,
      targetTokens,
      content: results[0].code,
      bytes: Buffer.byteLength(results[0].code, 'utf-8'),
    },
    b: {
      sourcePath: srcBPath,
      targetTokens,
      content: results[1].code,
      bytes: Buffer.byteLength(results[1].code, 'utf-8'),
    },
  };
}

interface ChatReply {
  verdict: 'SAME' | 'DIFFERENT' | 'UNKNOWN';
  rawText: string;
}

async function askChatGPT(
  model: string,
  apiKey: string,
  sampleA: string,
  sampleB: string,
): Promise<ChatReply> {
  const systemPrompt =
    'You are an expert JavaScript reverse engineer analysing obfuscated code. ' +
    'You will be given two obfuscated JavaScript files, FILE A and FILE B. ' +
    'Decide whether they were produced from (a) the SAME original source module ' +
    'obfuscated twice with different random seeds, or (b) two DIFFERENT original ' +
    'source modules each obfuscated once. The obfuscator renames identifiers, ' +
    'injects dead code, flattens control flow, and rewrites strings and numbers, ' +
    'so surface-level differences in names and structure do not imply different ' +
    'sources. Focus on invariants: call graphs, literal strings reachable through ' +
    'the de-obfuscated runtime, API surface, and program semantics.\n\n' +
    'Respond with EXACTLY one word on the first line: SAME or DIFFERENT. ' +
    'On the following lines, give a short one- or two-sentence rationale.';

  const userPrompt =
    '===== FILE A =====\n' + sampleA +
    '\n\n===== FILE B =====\n' + sampleB +
    '\n\nQuestion: Are FILE A and FILE B derived from the SAME original source ' +
    'module (obfuscated twice), or from two DIFFERENT original source modules?';

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0,
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }

  const data: any = await res.json();
  const rawText: string = (data?.choices?.[0]?.message?.content ?? '').toString();
  return { verdict: parseVerdict(rawText), rawText };
}

function parseVerdict(rawText: string): 'SAME' | 'DIFFERENT' | 'UNKNOWN' {
  const trimmed = rawText.trim();
  if (!trimmed) return 'UNKNOWN';
  const firstToken = trimmed.split(/[\s,.:;!?]+/)[0]?.toUpperCase();
  if (firstToken === 'SAME') return 'SAME';
  if (firstToken === 'DIFFERENT') return 'DIFFERENT';
  // Fallback: look for an unambiguous occurrence anywhere.
  const sawSame = /\bSAME\b/i.test(trimmed);
  const sawDifferent = /\bDIFFERENT\b/i.test(trimmed);
  if (sawSame && !sawDifferent) return 'SAME';
  if (sawDifferent && !sawSame) return 'DIFFERENT';
  return 'UNKNOWN';
}

interface TrialResult {
  index: number;
  actual: 'SAME' | 'DIFFERENT';
  predicted: 'SAME' | 'DIFFERENT' | 'UNKNOWN';
  match: boolean;
  sourceA: string;
  sourceB: string;
  bytesA: number;
  bytesB: number;
  deltaBytes: number;
  targetTokensA: number;
  targetTokensB: number;
  resizeAttempts: number;
  converged: boolean;
  /**
   * For SAME trials: which delta-window regime applied — 'small' when
   * max(bytesA, bytesB) < --small-file-threshold (delta capped at
   * --small-file-max-delta), 'large' otherwise (delta must fall in
   * [--min-delta, --max-delta]). Not set for DIFFERENT trials.
   */
  sameRegime?: 'small' | 'large';
  rawResponse?: string;
  error?: string;
}

async function runTrial(
  idx: number,
  sources: string[],
  opts: CliOptions,
  apiKey: string,
): Promise<TrialResult> {
  const actual: 'SAME' | 'DIFFERENT' = Math.random() < 0.5 ? 'SAME' : 'DIFFERENT';
  let srcA: string;
  let srcB: string;
  let a: Sample;
  let b: Sample;
  let attempts = 1;
  let converged = true;

  let sameRegime: 'small' | 'large' | undefined;
  if (actual === 'SAME') {
    srcA = pickOne(sources);
    srcB = srcA;
    const src = fs.readFileSync(srcA, 'utf-8');
    const r = produceSameSourcePair(
      src,
      srcA,
      opts.targetTokens,
      opts,
      opts.maxResizeAttempts,
    );
    a = r.a;
    b = r.b;
    attempts = r.attempts;
    converged = r.converged;
    sameRegime = r.regime;
  } else {
    [srcA, srcB] = pickTwoDistinct(sources);
    const r = produceDifferentSourcesPair(srcA, srcB, opts.targetTokens, {
      normalizeExports: opts.normalizeExports,
      shareIdentifiers: opts.shareIdentifiers,
    });
    a = r.a;
    b = r.b;
    // DIFFERENT uses obfuscateMultiple once — no resize loop, so
    // "converged" is always true by construction.
    attempts = 1;
    converged = true;
  }

  if (opts.dumpDir) {
    fs.mkdirSync(opts.dumpDir, { recursive: true });
    const tag = String(idx + 1).padStart(3, '0');
    fs.writeFileSync(path.join(opts.dumpDir, `trial_${tag}_actual_${actual}_A.js`), a.content);
    fs.writeFileSync(path.join(opts.dumpDir, `trial_${tag}_actual_${actual}_B.js`), b.content);
  }

  const base: TrialResult = {
    index: idx,
    actual,
    predicted: 'UNKNOWN',
    match: false,
    sourceA: path.relative(process.cwd(), srcA),
    sourceB: path.relative(process.cwd(), srcB),
    bytesA: a.bytes,
    bytesB: b.bytes,
    deltaBytes: Math.abs(a.bytes - b.bytes),
    targetTokensA: a.targetTokens,
    targetTokensB: b.targetTokens,
    resizeAttempts: attempts,
    converged,
    sameRegime,
  };

  try {
    const reply = await askChatGPT(opts.model, apiKey, a.content, b.content);
    base.predicted = reply.verdict;
    base.rawResponse = reply.rawText;
    base.match = reply.verdict === actual;
  } catch (e: any) {
    base.error = e?.message ?? String(e);
  }
  return base;
}

function fmtKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)}KB`;
}

function printSummary(trials: TrialResult[], opts: CliOptions): void {
  console.log('\n========== RESULTS ==========');

  let correct = 0;
  let wrong = 0;
  let unknown = 0;
  let errors = 0;
  const confusion = {
    SAME_SAME: 0,
    SAME_DIFFERENT: 0,
    SAME_UNKNOWN: 0,
    DIFFERENT_SAME: 0,
    DIFFERENT_DIFFERENT: 0,
    DIFFERENT_UNKNOWN: 0,
  };

  for (const t of trials) {
    if (t.error) {
      errors++;
      continue;
    }
    if (t.predicted === 'UNKNOWN') unknown++;
    else if (t.match) correct++;
    else wrong++;
    const key = `${t.actual}_${t.predicted}` as keyof typeof confusion;
    confusion[key]++;
  }

  const evaluable = correct + wrong;
  console.log(`  trials:        ${trials.length}`);
  console.log(`  errors:        ${errors}`);
  console.log(`  unknown reply: ${unknown}`);
  console.log(`  evaluable:     ${evaluable}`);
  if (evaluable > 0) {
    const acc = (correct / evaluable) * 100;
    console.log(`  correct:       ${correct} (${acc.toFixed(1)}%)`);
    console.log(`  wrong:         ${wrong} (${(100 - acc).toFixed(1)}%)`);
  }

  console.log('\n  Confusion matrix (rows = actual, cols = predicted):');
  console.log('                       pred:SAME   pred:DIFFERENT   pred:UNKNOWN');
  console.log(
    `    actual SAME          ${String(confusion.SAME_SAME).padStart(3)}` +
      `          ${String(confusion.SAME_DIFFERENT).padStart(3)}` +
      `              ${String(confusion.SAME_UNKNOWN).padStart(3)}`,
  );
  console.log(
    `    actual DIFFERENT     ${String(confusion.DIFFERENT_SAME).padStart(3)}` +
      `          ${String(confusion.DIFFERENT_DIFFERENT).padStart(3)}` +
      `              ${String(confusion.DIFFERENT_UNKNOWN).padStart(3)}`,
  );

  console.log('\n  Per-trial detail:');
  console.log('    #   actual      predicted    status   sizeA    sizeB    delta    regime  source A → source B');
  for (const t of trials) {
    const status = t.error
      ? 'ERROR'
      : t.predicted === 'UNKNOWN'
      ? ' ?   '
      : t.match
      ? ' OK  '
      : 'MISS ';
    const srcA = path.basename(t.sourceA);
    const srcB = path.basename(t.sourceB);
    const regimeLabel = t.actual === 'SAME' ? (t.sameRegime ?? '?').padEnd(6) : '—     ';
    console.log(
      `    ${String(t.index + 1).padStart(3)}  ` +
        `${t.actual.padEnd(10)}  ` +
        `${t.predicted.padEnd(11)}  ` +
        `${status}  ` +
        `${fmtKB(t.bytesA).padStart(6)}  ` +
        `${fmtKB(t.bytesB).padStart(6)}  ` +
        `${fmtKB(t.deltaBytes).padStart(6)}${t.converged ? ' ' : '*'}  ` +
        `${regimeLabel}  ` +
        `${srcA} → ${srcB}`,
    );
    if (t.error) {
      console.log(`         error: ${t.error.slice(0, 300)}`);
    } else if (opts.verbose && t.rawResponse) {
      const first = t.rawResponse.split('\n')[0] ?? '';
      console.log(`         reply: ${first.slice(0, 200)}`);
    }
  }

  const anyOverLimit = trials.some((t) => !t.error && !t.converged);
  if (anyOverLimit) {
    console.log(
      '\n  * SAME-trial delta landed outside its active window after exhausting resize attempts' +
        ' (small regime: ≤ --small-file-max-delta; large regime: [--min-delta, --max-delta]).',
    );
  }
}

/**
 * Mirror every chunk written to `process.stdout` into `sink` while
 * still forwarding to the real terminal. Used to capture the run's
 * console output verbatim for a human-readable `.txt` log. Returns
 * a restore callback — calling it reverts stdout back to the original
 * implementation, so the tee stays scoped to the run rather than
 * leaking into anything that imports this file as a library.
 */
function teeStdout(sink: string[]): () => void {
  const original = process.stdout.write.bind(process.stdout);
  const patched = function (this: any, chunk: any, ...rest: any[]): any {
    if (typeof chunk === 'string') sink.push(chunk);
    else if (chunk && typeof (chunk as Buffer).toString === 'function') {
      sink.push((chunk as Buffer).toString('utf-8'));
    }
    // `process.stdout.write` has several overloads (string + encoding,
    // string + encoding + cb, buffer + cb, …). Cast through `any` to
    // forward every variant cleanly without re-declaring the union.
    return (original as any)(chunk, ...rest);
  };
  (process.stdout as any).write = patched;
  return () => {
    (process.stdout as any).write = original;
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Error: OPENAI_API_KEY environment variable is not set.');
    process.exit(1);
  }

  const sources = listSourceFiles(opts.sourceDir);
  if (sources.length < 2) {
    console.error(
      `Error: need at least 2 .js files in ${opts.sourceDir} (found ${sources.length}).`,
    );
    process.exit(1);
  }

  // Decide the log paths up front so both the JSON and TXT sinks
  // share the same timestamp slug — makes it trivial to pair them
  // up afterwards ("the txt and json next to each other are from the
  // same run").
  const slug = timestampSlug();
  const logsDir = path.resolve(PROJECT_ROOT, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const jsonLogPath = path.join(logsDir, `detect_${slug}.json`);
  const txtLogPath = path.join(logsDir, `detect_${slug}.txt`);

  // Start tee'ing stdout into a buffer NOW so the pre-run banner,
  // every per-trial progress line, and the summary all end up in the
  // txt log. Errors inside the try still get their output captured
  // because the tee stays on until the finally block restores
  // stdout.
  const stdoutBuffer: string[] = [];
  const restoreStdout = teeStdout(stdoutBuffer);

  try {
    const sha = gitHeadSha();
    const dirty = gitIsDirty();
    const shaDisplay = sha === 'unknown' ? 'unknown' : sha.slice(0, 10) + (dirty ? ' (dirty)' : '');

    console.log('egodeath obfuscation-detection evaluation');
    console.log(`  runs:          ${opts.runs}`);
    console.log(`  model:         ${opts.model}`);
    console.log(`  git HEAD:      ${shaDisplay}`);
    console.log(`  source-dir:    ${opts.sourceDir} (${sources.length} .js files)`);
    console.log(`  target-tokens: ${opts.targetTokens.toLocaleString()} (SAME-trial base, DIFFERENT-trial fixed)`);
    console.log(`  SAME window:   large (max ≥ ${opts.smallFileThresholdBytes.toLocaleString()}B): delta ∈ [${opts.minDeltaBytes.toLocaleString()}, ${opts.maxDeltaBytes.toLocaleString()}]`);
    console.log(`                 small (max <  ${opts.smallFileThresholdBytes.toLocaleString()}B): delta ≤ ${opts.smallFileMaxDeltaBytes.toLocaleString()}`);
    const diffHardenBits: string[] = ['shared donor pool', 'normalized string arrays'];
    if (opts.normalizeExports) diffHardenBits.push('normalized exports (dispatch object)');
    if (opts.shareIdentifiers) diffHardenBits.push('shared identifier pool');
    console.log(`  DIFFERENT:     obfuscateMultiple (${diffHardenBits.join(' + ')})`);
    if (opts.dumpDir) console.log(`  dump-dir:      ${opts.dumpDir}`);
    console.log('');

    const trials: TrialResult[] = [];
    for (let i = 0; i < opts.runs; i++) {
      process.stdout.write(`  [trial ${i + 1}/${opts.runs}] obfuscating + querying ${opts.model}... `);
      const t = await runTrial(i, sources, opts, apiKey);
      trials.push(t);
      if (t.error) {
        console.log(`ERROR: ${t.error.slice(0, 200)}`);
      } else {
        const marker = t.predicted === 'UNKNOWN' ? '?' : t.match ? 'OK' : 'MISS';
        // Only SAME trials target a specific delta window; DIFFERENT
        // trials don't rebalance and converged is always true by
        // construction, so no tag is appended for them. The active
        // regime drives which bounds appear in the warning.
        let deltaTag = '';
        if (!t.converged) {
          const windowStr =
            t.sameRegime === 'small'
              ? `≤ ${fmtKB(opts.smallFileMaxDeltaBytes)}`
              : `[${fmtKB(opts.minDeltaBytes)}, ${fmtKB(opts.maxDeltaBytes)}]`;
          const regimeTag = t.sameRegime ? ` ${t.sameRegime}-regime` : '';
          deltaTag = ` (delta ${fmtKB(t.deltaBytes)} outside ${windowStr}${regimeTag})`;
        }
        console.log(
          `actual=${t.actual} predicted=${t.predicted} [${marker}] ` +
            `sizes=${fmtKB(t.bytesA)}/${fmtKB(t.bytesB)}${deltaTag}`,
        );
        if (opts.verbose && t.rawResponse) {
          const short = t.rawResponse.replace(/\s+/g, ' ').slice(0, 200);
          console.log(`      reply: ${short}`);
        }
      }
    }

    printSummary(trials, opts);

    // Always persist the run. logs/ was created above; the filename
    // is keyed by local-time stamp so successive runs don't clobber
    // each other, and the git HEAD SHA goes into the report itself
    // so results stay pinned to the exact obfuscator build that
    // produced them.
    const report = {
      options: opts,
      timestamp: new Date().toISOString(),
      gitCommit: sha,
      gitDirty: dirty,
      trials,
    };
    fs.writeFileSync(jsonLogPath, JSON.stringify(report, null, 2));
    console.log(`\n  JSON report written: ${path.relative(process.cwd(), jsonLogPath)}`);
    console.log(`  TXT  report written: ${path.relative(process.cwd(), txtLogPath)}`);

    // Preserve the explicit --output flag as an additional sink when
    // the operator wants the report somewhere specific (CI artefacts,
    // a shared drop directory, etc.). The auto log is still written.
    if (opts.outputJson && path.resolve(opts.outputJson) !== jsonLogPath) {
      fs.mkdirSync(path.dirname(opts.outputJson), { recursive: true });
      fs.writeFileSync(opts.outputJson, JSON.stringify(report, null, 2));
      console.log(`  JSON report written: ${opts.outputJson}`);
    }
  } finally {
    // Restore first so the write below (and anything the shell
    // prints after main returns) doesn't re-enter the capture.
    restoreStdout();
    try {
      fs.writeFileSync(txtLogPath, stdoutBuffer.join(''));
    } catch (e) {
      // Don't let a log-write failure mask a real error from the
      // main body — just surface it and move on.
      process.stderr.write(`warning: could not write txt log to ${txtLogPath}: ${(e as Error)?.message ?? e}\n`);
    }
  }
}

main().catch((e) => {
  console.error('Fatal:', e?.stack ?? e);
  process.exit(1);
});

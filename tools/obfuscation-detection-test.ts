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
import { obfuscate } from '../src/obfuscator';

interface CliOptions {
  runs: number;
  targetTokens: number;
  maxDeltaBytes: number;
  maxResizeAttempts: number;
  model: string;
  sourceDir: string;
  outputJson?: string;
  dumpDir?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    runs: 10,
    targetTokens: 25_000,
    maxDeltaBytes: 250_000,
    maxResizeAttempts: 4,
    model: 'gpt-4o',
    sourceDir: path.resolve(__dirname, '..', 'tests'),
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs' || a === '-n') opts.runs = Number(argv[++i]);
    else if (a === '--target-tokens') opts.targetTokens = Number(argv[++i]);
    else if (a === '--max-delta') opts.maxDeltaBytes = Number(argv[++i]);
    else if (a === '--max-resize-attempts') opts.maxResizeAttempts = Number(argv[++i]);
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--source-dir') opts.sourceDir = path.resolve(argv[++i]);
    else if (a === '--output') opts.outputJson = path.resolve(argv[++i]);
    else if (a === '--dump-dir') opts.dumpDir = path.resolve(argv[++i]);
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
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
  if (!Number.isFinite(opts.maxDeltaBytes) || opts.maxDeltaBytes < 0) {
    console.error('--max-delta must be a non-negative integer');
    process.exit(2);
  }
  return opts;
}

function printUsage(): void {
  console.log(`Usage: ts-node tools/obfuscation-detection-test.ts [options]

For each trial, randomly chooses between:
  (SAME)      one source module, obfuscated twice with fresh randomness
  (DIFFERENT) two distinct source modules, each obfuscated once

Both samples are submitted to the OpenAI Chat Completions API ("ChatGPT"),
which is asked to classify them as SAME or DIFFERENT. Ground-truth from the
coin flip is compared against the model's verdict and summarised at the end.

Options:
  --runs, -n <n>            Number of trials (default: 10)
  --target-tokens <n>       Starting obfuscation target tokens (default: 25000)
                            Smaller = smaller samples = fewer API tokens used.
  --max-delta <bytes>       Maximum allowed byte-size difference between the
                            two samples in a trial (default: 250000)
  --max-resize-attempts <n> How many re-obfuscations to run per trial while
                            trying to bring the pair under --max-delta
                            (default: 4). Each extra attempt scales
                            target-tokens of the smaller sample up toward
                            the size of the larger.
  --model <name>            OpenAI model name (default: gpt-4o)
  --source-dir <dir>        Directory containing .js source files
                            (default: ./tests)
  --output <file>           Write full JSON report to this path
  --dump-dir <dir>          Save every submitted sample to this directory
                            (useful for debugging a MISS)
  --verbose, -v             Print the model's raw reply for each trial

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

function obfuscateSource(sourcePath: string, targetTokens: number): Sample {
  const src = fs.readFileSync(sourcePath, 'utf-8');
  const content = obfuscate(src, { targetTokens });
  return {
    sourcePath,
    targetTokens,
    content,
    bytes: Buffer.byteLength(content, 'utf-8'),
  };
}

// Rebalance target-tokens so the two samples end up within maxDeltaBytes.
// Each attempt scales up the smaller sample's target-tokens by the byte
// ratio of the pair. This converges quickly when output bytes scale
// roughly linearly with target-tokens (which the obfuscator's bloat
// budget is designed to do).
function produceBalancedPair(
  srcA: string,
  srcB: string,
  startTokens: number,
  maxDeltaBytes: number,
  maxAttempts: number,
): { a: Sample; b: Sample; attempts: number; converged: boolean } {
  let a = obfuscateSource(srcA, startTokens);
  let b = obfuscateSource(srcB, startTokens);
  let attempts = 1;

  while (Math.abs(a.bytes - b.bytes) > maxDeltaBytes && attempts < maxAttempts) {
    if (a.bytes < b.bytes) {
      const ratio = b.bytes / Math.max(1, a.bytes);
      const nextTokens = Math.max(1000, Math.round(a.targetTokens * ratio));
      a = obfuscateSource(srcA, nextTokens);
    } else {
      const ratio = a.bytes / Math.max(1, b.bytes);
      const nextTokens = Math.max(1000, Math.round(b.targetTokens * ratio));
      b = obfuscateSource(srcB, nextTokens);
    }
    attempts++;
  }

  return {
    a,
    b,
    attempts,
    converged: Math.abs(a.bytes - b.bytes) <= maxDeltaBytes,
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
  if (actual === 'SAME') {
    srcA = pickOne(sources);
    srcB = srcA;
  } else {
    [srcA, srcB] = pickTwoDistinct(sources);
  }

  const { a, b, attempts, converged } = produceBalancedPair(
    srcA,
    srcB,
    opts.targetTokens,
    opts.maxDeltaBytes,
    opts.maxResizeAttempts,
  );

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
  console.log('    #   actual      predicted    status   sizeA    sizeB    delta    source A → source B');
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
    console.log(
      `    ${String(t.index + 1).padStart(3)}  ` +
        `${t.actual.padEnd(10)}  ` +
        `${t.predicted.padEnd(11)}  ` +
        `${status}  ` +
        `${fmtKB(t.bytesA).padStart(6)}  ` +
        `${fmtKB(t.bytesB).padStart(6)}  ` +
        `${fmtKB(t.deltaBytes).padStart(6)}${t.converged ? ' ' : '*'}  ` +
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
      '\n  * delta exceeded --max-delta after exhausting resize attempts.',
    );
  }
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

  console.log('egodeath obfuscation-detection evaluation');
  console.log(`  runs:          ${opts.runs}`);
  console.log(`  model:         ${opts.model}`);
  console.log(`  source-dir:    ${opts.sourceDir} (${sources.length} .js files)`);
  console.log(`  target-tokens: ${opts.targetTokens.toLocaleString()} (starting)`);
  console.log(`  max-delta:     ${opts.maxDeltaBytes.toLocaleString()} bytes`);
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
      const deltaTag = t.converged ? '' : ` (delta ${fmtKB(t.deltaBytes)} > ${fmtKB(opts.maxDeltaBytes)})`;
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

  if (opts.outputJson) {
    fs.mkdirSync(path.dirname(opts.outputJson), { recursive: true });
    fs.writeFileSync(
      opts.outputJson,
      JSON.stringify(
        {
          options: opts,
          timestamp: new Date().toISOString(),
          trials,
        },
        null,
        2,
      ),
    );
    console.log(`\n  JSON report written: ${opts.outputJson}`);
  }
}

main().catch((e) => {
  console.error('Fatal:', e?.stack ?? e);
  process.exit(1);
});

#!/usr/bin/env ts-node

/**
 * Adversarial deobfuscation harness.
 *
 * Takes obfuscated JavaScript and runs it through the two tools an attacker
 * would reach for first:
 *
 *   1. terser  - aggressive compression + beautify. Constant-folds, inlines,
 *                and re-formats, undoing a lot of cheap obfuscation noise.
 *   2. webcrack - a purpose-built deobfuscator/unpacker. Reverses string
 *                arrays, control-flow flattening, proxy functions, etc.
 *
 * For each input it produces three artifacts so you can see how the
 * obfuscation holds up at each stage and against the realistic chained attack:
 *
 *   <out>/<name>/original.js          copy of the obfuscated input
 *   <out>/<name>/terser.js            terser only
 *   <out>/<name>/webcrack.js          webcrack only
 *   <out>/<name>/terser+webcrack.js   terser, then webcrack (chained)
 *
 * Output goes to the gitignored .adversarial/ directory.
 *
 * NOTE: webcrack depends on isolated-vm, whose native addon only builds
 * against Node >= 22. Run this tool under Node 22+ (e.g. `nvm use 22`).
 *
 * Usage:
 *   npm run adversarial-test                 # default: scan dist/obfuscated
 *   npm run adversarial-test -- <path> ...   # explicit files or directories
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

// terser is already a project dependency; use its sync API like the obfuscator.
const { minify_sync } = require('terser');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WEBCRACK_BIN = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'webcrack');

interface StageResult {
  ran: boolean;
  size: number;
  /** size as a fraction of the original obfuscated size */
  ratio: number;
  error?: string;
}

interface AdversarialReport {
  input: string;
  name: string;
  originalSize: number;
  terser: StageResult;
  webcrack: StageResult;
  terserThenWebcrack: StageResult;
}

/** Recursively collect .js files from a list of files/directories. */
function collectInputs(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!fs.existsSync(p)) {
      console.warn(`  ! skipping missing path: ${p}`);
      continue;
    }
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(p)) {
        out.push(...collectInputs([path.join(p, entry)]));
      }
    } else if (p.endsWith('.js')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Run terser as an adversary would: maximum compression, no mangling (mangling
 * would re-obscure the names we want to read), beautified output.
 */
function runTerser(code: string): { code: string } {
  const result = minify_sync(code, {
    compress: {
      passes: 3,
      drop_console: false,
      // Keep the structure intact while folding constants, removing dead
      // branches, and inlining trivial helpers.
      sequences: false,
      booleans_as_integers: false,
    },
    mangle: false,
    format: {
      beautify: true,
      comments: false,
      indent_level: 2,
    },
    sourceMap: false,
  });
  if (result.error) throw result.error;
  if (typeof result.code !== 'string') throw new Error('terser produced no output');
  return { code: result.code };
}

/**
 * Run webcrack on a file via its CLI, using the *current* node binary so the
 * isolated-vm native addon (built for this ABI) loads correctly. Returns the
 * deobfuscated source.
 */
function runWebcrack(inputFile: string, scratchDir: string): string {
  if (!fs.existsSync(WEBCRACK_BIN)) {
    throw new Error('webcrack is not installed (npm i -D webcrack under Node 22+)');
  }
  fs.rmSync(scratchDir, { recursive: true, force: true });
  execFileSync(process.execPath, [WEBCRACK_BIN, inputFile, '-o', scratchDir, '-f'], {
    stdio: 'pipe',
    timeout: 180000,
    cwd: PROJECT_ROOT,
  });
  // For a single non-bundled file webcrack writes deobfuscated.js; for bundles
  // it splits into modules. Prefer the top-level entry, else concatenate.
  const entry = path.join(scratchDir, 'deobfuscated.js');
  if (fs.existsSync(entry)) return fs.readFileSync(entry, 'utf-8');

  const jsFiles = collectInputs([scratchDir]);
  if (jsFiles.length === 0) throw new Error('webcrack produced no output');
  return jsFiles
    .map(f => `// ===== ${path.relative(scratchDir, f)} =====\n${fs.readFileSync(f, 'utf-8')}`)
    .join('\n\n');
}

function processFile(inputFile: string, outDir: string): AdversarialReport {
  const original = fs.readFileSync(inputFile, 'utf-8');
  const originalSize = Buffer.byteLength(original);

  // Derive a readable, unique-ish name from the path tail. Drop ".." segments
  // so inputs outside the project root don't yield "..__..__" directory names.
  const rel = path.relative(PROJECT_ROOT, inputFile);
  const name = rel
    .split(path.sep)
    .filter(seg => seg && seg !== '..')
    .join('__')
    .replace(/\.js$/, '');
  const dir = path.join(outDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'original.js'), original);

  console.log(`\n=== ${rel} (${(originalSize / 1024).toFixed(1)} KB) ===`);

  const mkStage = (): StageResult => ({ ran: false, size: 0, ratio: 0 });
  const report: AdversarialReport = {
    input: rel,
    name,
    originalSize,
    terser: mkStage(),
    webcrack: mkStage(),
    terserThenWebcrack: mkStage(),
  };

  const scratch = path.join(dir, '.webcrack-scratch');

  // Stage 1: terser only
  let terserCode: string | null = null;
  try {
    terserCode = runTerser(original).code;
    fs.writeFileSync(path.join(dir, 'terser.js'), terserCode);
    const size = Buffer.byteLength(terserCode);
    report.terser = { ran: true, size, ratio: size / originalSize };
    console.log(`  ✓ terser:          ${(size / 1024).toFixed(1)} KB (${(report.terser.ratio * 100).toFixed(0)}% of original)`);
  } catch (e: any) {
    report.terser.error = String(e.message || e).split('\n')[0];
    console.log(`  ✗ terser:          ${report.terser.error}`);
  }

  // Stage 2: webcrack only
  try {
    const wc = runWebcrack(inputFile, scratch);
    fs.writeFileSync(path.join(dir, 'webcrack.js'), wc);
    const size = Buffer.byteLength(wc);
    report.webcrack = { ran: true, size, ratio: size / originalSize };
    console.log(`  ✓ webcrack:        ${(size / 1024).toFixed(1)} KB (${(report.webcrack.ratio * 100).toFixed(0)}% of original)`);
  } catch (e: any) {
    report.webcrack.error = extractError(e);
    console.log(`  ✗ webcrack:        ${report.webcrack.error}`);
  }

  // Stage 3: terser, then webcrack (the realistic chained attack)
  if (terserCode !== null) {
    try {
      const terserFile = path.join(dir, 'terser.js');
      const chained = runWebcrack(terserFile, scratch);
      fs.writeFileSync(path.join(dir, 'terser+webcrack.js'), chained);
      const size = Buffer.byteLength(chained);
      report.terserThenWebcrack = { ran: true, size, ratio: size / originalSize };
      console.log(`  ✓ terser+webcrack: ${(size / 1024).toFixed(1)} KB (${(report.terserThenWebcrack.ratio * 100).toFixed(0)}% of original)`);
    } catch (e: any) {
      report.terserThenWebcrack.error = extractError(e);
      console.log(`  ✗ terser+webcrack: ${report.terserThenWebcrack.error}`);
    }
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  return report;
}

/** Pull a useful one-liner out of an execFileSync error. */
function extractError(e: any): string {
  const stderr = e.stderr?.toString() || '';
  const firstErr = stderr.split('\n').find((l: string) => /error/i.test(l));
  return (firstErr || e.message || String(e)).trim().split('\n')[0].substring(0, 160);
}

function main() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 22) {
    console.error(
      `This tool needs Node >= 22 (webcrack's isolated-vm addon won't load on ${process.version}).\n` +
      `Run: nvm use 22 && npm run adversarial-test`
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const inputArgs = args.length > 0 ? args : [path.join(PROJECT_ROOT, 'dist', 'obfuscated')];
  const outDir = path.join(PROJECT_ROOT, '.adversarial');

  const inputs = collectInputs(inputArgs).filter(f => path.basename(f) !== 'report.json');
  if (inputs.length === 0) {
    console.error(`No .js inputs found under: ${inputArgs.join(', ')}`);
    console.error(`Generate some first with: npm run obfuscate-package`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Adversarial deobfuscation of ${inputs.length} file(s)`);
  console.log(`Output: ${outDir}`);

  const reports: AdversarialReport[] = [];
  for (const input of inputs) {
    reports.push(processFile(input, outDir));
  }

  // Summary: higher ratio = more resistant (deobfuscators couldn't shrink it).
  console.log('\n\n========== SUMMARY ==========\n');
  console.log('  File                                     Orig     terser   webcrack  chained');
  console.log('  ----                                     ----     ------   --------  -------');
  for (const r of reports) {
    const fmt = (s: StageResult) =>
      s.ran ? `${(s.ratio * 100).toFixed(0)}%`.padEnd(8) : 'FAIL'.padEnd(8);
    console.log(
      `  ${r.name.slice(-40).padEnd(40)} ` +
      `${(r.originalSize / 1024).toFixed(0)}KB`.padEnd(8) + ' ' +
      fmt(r.terser) + ' ' + fmt(r.webcrack) + ' ' + fmt(r.terserThenWebcrack)
    );
  }
  console.log('\n  (percentages are output size vs. the obfuscated input;');
  console.log('   lower means the deobfuscator simplified more.)');

  const reportPath = path.join(outDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2));
  console.log(`\n  Full report: ${reportPath}`);
}

main();

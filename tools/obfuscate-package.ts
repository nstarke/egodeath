#!/usr/bin/env ts-node

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { obfuscate } from '../src/obfuscator';

const TOP_10_PACKAGES = [
  'lodash',
  'chalk',
  'commander',
  'debug',
  'express',
  'axios',
  'moment',
  'uuid',
  'minimist',
  'semver',
];

interface FileResult {
  file: string;
  status: 'ok' | 'error';
  error?: string;
  outputPath?: string;
}

interface TestResult {
  ran: boolean;
  passed: boolean;
  output: string;
}

interface PackageReport {
  package: string;
  repoUrl: string;
  total: number;
  succeeded: number;
  failed: number;
  files: FileResult[];
  tests: TestResult;
}

/**
 * Recursively find all .js files, skipping node_modules and .git.
 */
function findJsFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'locale') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Get the git repository URL for an npm package.
 */
function getRepoUrl(packageName: string): string | null {
  try {
    const raw = execSync(`npm view ${packageName} repository.url`, { stdio: 'pipe' }).toString().trim();
    // Normalize: strip git+, .git suffix, convert ssh to https
    let url = raw.replace(/^git\+/, '').replace(/\.git$/, '');
    url = url.replace(/^git:\/\//, 'https://');
    url = url.replace(/^ssh:\/\/git@github\.com/, 'https://github.com');
    url = url.replace(/^git@github\.com:/, 'https://github.com/');
    return url;
  } catch {
    return null;
  }
}

/**
 * Identify the release/built JS files in a package repo.
 * These are the files consumers actually import — not test or config files.
 * We look at the "main" field, then common build output directories.
 */
function findReleaseFiles(repoDir: string): string[] {
  const pkgJsonPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return [];

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
  const candidates: string[] = [];

  // Add main entry if it's a .js file
  for (const field of ['main', 'module', 'browser']) {
    const entry = pkgJson[field];
    if (entry && typeof entry === 'string') {
      const resolved = path.resolve(repoDir, entry);
      if (fs.existsSync(resolved) && resolved.endsWith('.js')) {
        candidates.push(resolved);
      }
    }
  }

  // Add files from "files" field directories (what npm publish ships)
  if (Array.isArray(pkgJson.files)) {
    for (const pattern of pkgJson.files) {
      const resolved = path.resolve(repoDir, pattern);
      if (fs.existsSync(resolved)) {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          candidates.push(...findJsFiles(resolved));
        } else if (stat.isFile() && resolved.endsWith('.js')) {
          candidates.push(resolved);
        }
      }
    }
  }

  // Scan common release directories: dist/, lib/, build/
  for (const dir of ['dist', 'lib', 'build']) {
    const dirPath = path.join(repoDir, dir);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      candidates.push(...findJsFiles(dirPath));
    }
  }

  // If nothing found from the above, fall back to root-level .js files
  // (some packages like lodash/minimist just have index.js at root)
  if (candidates.length === 0) {
    const rootJs = fs.readdirSync(repoDir)
      .filter((f) => f.endsWith('.js') && !f.startsWith('.') && !f.includes('config')
        && !f.includes('gulpfile') && !f.includes('gruntfile') && !f.includes('Gruntfile'))
      .map((f) => path.join(repoDir, f));
    candidates.push(...rootJs);
  }

  // Deduplicate
  return [...new Set(candidates)];
}

/**
 * Figure out the right command to run just the tests, skipping linters
 * and other pre/post hooks that would choke on obfuscated code.
 *
 * Prefers a "tests-only" or "test:unit" script. Falls back to
 * `npm test --ignore-scripts` which skips pretest/posttest hooks.
 */
function resolveTestCommand(pkgJson: any): string | null {
  const scripts = pkgJson.scripts || {};
  const testScript = scripts.test;

  if (!testScript || testScript === 'echo "Error: no test specified" && exit 1') {
    return null;
  }

  // Prefer explicit test-only scripts that skip lint/build
  const testOnlyKeys = ['tests-only', 'test:unit', 'test-only', 'unit', 'test:run'];
  for (const key of testOnlyKeys) {
    if (scripts[key]) {
      return `npm run ${key}`;
    }
  }

  // If there's a pretest (usually lint), bypass hooks with --ignore-scripts
  if (scripts.pretest || scripts.posttest) {
    return 'npm test --ignore-scripts';
  }

  // Otherwise just run npm test normally
  return 'npm test';
}

function obfuscatePackage(packageName: string, distDir: string, tempDir: string): PackageReport {
  const safeName = packageName.replace('/', '-');
  const repoDir = path.join(tempDir, safeName);
  const pkgOutputDir = path.join(distDir, safeName);

  console.log(`\n=== ${packageName} ===`);

  const report: PackageReport = {
    package: packageName,
    repoUrl: '',
    total: 0,
    succeeded: 0,
    failed: 0,
    files: [],
    tests: { ran: false, passed: false, output: '' },
  };

  // Step 1: Get the repo URL
  const repoUrl = getRepoUrl(packageName);
  if (!repoUrl) {
    console.error(`  Could not find repository URL for ${packageName}`);
    return report;
  }
  report.repoUrl = repoUrl;
  console.log(`  Repo: ${repoUrl}`);

  // Step 2: Clone the repo
  console.log(`  Cloning...`);
  try {
    execSync(`git clone --depth 1 "${repoUrl}" "${repoDir}"`, { stdio: 'pipe' });
  } catch (e: any) {
    console.error(`  Failed to clone: ${e.message.split('\n')[0]}`);
    return report;
  }

  // Step 3: Install dependencies (including devDeps for tests)
  console.log(`  Installing dependencies...`);
  try {
    execSync('npm install --ignore-scripts', { cwd: repoDir, stdio: 'pipe', timeout: 120000 });
  } catch (e: any) {
    console.error(`  npm install failed: ${e.message.split('\n')[0]}`);
    return report;
  }

  // Step 4: Build the package if there's a build script
  const pkgJson = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf-8'));
  if (pkgJson.scripts && pkgJson.scripts.build) {
    console.log(`  Building...`);
    try {
      execSync('npm run build', { cwd: repoDir, stdio: 'pipe', timeout: 120000 });
    } catch (e: any) {
      console.log(`  Build failed (continuing anyway): ${e.message.split('\n')[0]}`);
    }
  }

  // Step 5: Find release/built files
  const releaseFiles = findReleaseFiles(repoDir);
  console.log(`  Found ${releaseFiles.length} release .js files`);

  if (releaseFiles.length === 0) {
    console.log(`  No release files found, skipping`);
    return report;
  }

  report.total = releaseFiles.length;
  fs.mkdirSync(pkgOutputDir, { recursive: true });

  // Step 6: Obfuscate each file, save to dist/, and replace in-place
  for (const jsFile of releaseFiles) {
    const relativePath = path.relative(repoDir, jsFile);
    const outputPath = path.join(pkgOutputDir, relativePath);
    const backupPath = jsFile + '.orig';

    let result: FileResult;
    try {
      const source = fs.readFileSync(jsFile, 'utf-8');
      const obfuscated = obfuscate(source);

      // Save obfuscated copy to dist
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, obfuscated, 'utf-8');

      // Back up original and replace with obfuscated version
      fs.copyFileSync(jsFile, backupPath);
      fs.writeFileSync(jsFile, obfuscated, 'utf-8');

      result = { file: relativePath, status: 'ok', outputPath };
      report.succeeded++;
      process.stdout.write('  \u2713 ' + relativePath + '\n');
    } catch (e: any) {
      result = { file: relativePath, status: 'error', error: e.message };
      report.failed++;
      process.stdout.write('  \u2717 ' + relativePath + ' \u2014 ' + e.message.split('\n')[0] + '\n');
    }
    report.files.push(result);
  }

  // Step 7: Run the package's test suite against the obfuscated code
  // Use --ignore-scripts to skip pretest (linters) and posttest hooks that
  // would fail on obfuscated output. We only care about functional correctness.
  const testCmd = resolveTestCommand(pkgJson);
  if (testCmd) {
    console.log(`  Running tests against obfuscated code...`);
    console.log(`  Test command: ${testCmd}`);
    try {
      const testOutput = execSync(testCmd, {
        cwd: repoDir,
        stdio: 'pipe',
        timeout: 120000,
        env: { ...process.env, NODE_ENV: 'test' },
      }).toString();
      report.tests = { ran: true, passed: true, output: testOutput };
      console.log(`  \u2713 Tests PASSED`);
    } catch (e: any) {
      const output = (e.stdout?.toString() || '') + '\n' + (e.stderr?.toString() || '');
      report.tests = { ran: true, passed: false, output };
      console.log(`  \u2717 Tests FAILED`);
      // Print last few lines of output for context
      const lines = output.trim().split('\n');
      const tail = lines.slice(-10);
      for (const line of tail) {
        console.log(`    ${line}`);
      }
    }
  } else {
    console.log(`  No usable test script found`);
  }

  return report;
}

function main() {
  const args = process.argv.slice(2);
  const packages = args.length > 0 ? args : TOP_10_PACKAGES;

  const projectRoot = path.resolve(__dirname, '..');
  const distDir = path.join(projectRoot, 'dist', 'obfuscated');
  const tempDir = path.join(projectRoot, '.tmp-packages');

  fs.mkdirSync(distDir, { recursive: true });
  fs.mkdirSync(tempDir, { recursive: true });

  console.log(`Obfuscating packages: ${packages.join(', ')}`);
  console.log(`Output directory: ${distDir}\n`);

  const reports: PackageReport[] = [];

  for (const pkg of packages) {
    const report = obfuscatePackage(pkg, distDir, tempDir);
    reports.push(report);
  }

  // Print summary
  console.log('\n\n========== SUMMARY ==========\n');
  console.log('  Package              Files         Tests');
  console.log('  -------              -----         -----');

  let totalFiles = 0;
  let totalOk = 0;
  let totalFail = 0;
  let totalTestsRan = 0;
  let totalTestsPassed = 0;

  for (const r of reports) {
    const filePct = r.total > 0 ? `${r.succeeded}/${r.total}` : 'N/A';
    let testStatus = 'no tests';
    if (r.tests.ran) {
      testStatus = r.tests.passed ? 'PASSED' : 'FAILED';
      totalTestsRan++;
      if (r.tests.passed) totalTestsPassed++;
    }
    console.log(`  ${r.package.padEnd(20)} ${filePct.padEnd(13)} ${testStatus}`);

    if (r.failed > 0) {
      const errors = r.files.filter((f) => f.status === 'error');
      const uniqueErrors = new Map<string, number>();
      for (const e of errors) {
        const msg = e.error?.split('\n')[0] || 'unknown';
        uniqueErrors.set(msg, (uniqueErrors.get(msg) || 0) + 1);
      }
      for (const [msg, count] of uniqueErrors) {
        console.log(`    [${count}x] ${msg}`);
      }
    }
    totalFiles += r.total;
    totalOk += r.succeeded;
    totalFail += r.failed;
  }

  console.log('');
  console.log(`  Files: ${totalOk}/${totalFiles} obfuscated successfully, ${totalFail} failed`);
  console.log(`  Tests: ${totalTestsPassed}/${totalTestsRan} suites passed`);

  // Write full report as JSON
  const reportPath = path.join(distDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2), 'utf-8');
  console.log(`\n  Full report: ${reportPath}`);

  // Cleanup temp directory
  fs.rmSync(tempDir, { recursive: true, force: true });

  // Exit with error code if any obfuscation failures
  if (totalFail > 0) {
    process.exit(1);
  }
}

main();

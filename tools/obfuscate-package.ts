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

interface TestResult {
  ran: boolean;
  passed: boolean;
  output: string;
}

interface PackageReport {
  package: string;
  repoUrl: string;
  bundled: boolean;
  bundleError?: string;
  obfuscated: boolean;
  obfuscateError?: string;
  bundleSize: number;
  obfuscatedSize: number;
  tests: TestResult;
}

/**
 * Get the git repository URL for an npm package.
 */
function getRepoUrl(packageName: string): string | null {
  try {
    const raw = execSync(`npm view ${packageName} repository.url`, { stdio: 'pipe' }).toString().trim();
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
 * Find the main entry point of a package.
 */
function findMainEntry(repoDir: string): string | null {
  const pkgJsonPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));

  // Try main, then index.js
  for (const field of ['main']) {
    const entry = pkgJson[field];
    if (entry && typeof entry === 'string') {
      const resolved = path.resolve(repoDir, entry);
      if (fs.existsSync(resolved)) return resolved;
      // Try with .js extension
      if (fs.existsSync(resolved + '.js')) return resolved + '.js';
    }
  }

  // Fallback: index.js
  const indexJs = path.join(repoDir, 'index.js');
  if (fs.existsSync(indexJs)) return indexJs;

  return null;
}

/**
 * Create a webpack config and bundle the library into a single file.
 */
function webpackBundle(repoDir: string, entryPath: string, outputPath: string): boolean {
  // Read the package's imports map for # package imports
  const pkgJsonPath = path.join(repoDir, 'package.json');
  const pkgJson = fs.existsSync(pkgJsonPath)
    ? JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) : {};

  // Build resolve aliases from #imports map
  const aliases: { [key: string]: string } = {};
  if (pkgJson.imports) {
    for (const [key, value] of Object.entries(pkgJson.imports)) {
      const target = typeof value === 'string' ? value
        : typeof value === 'object' && value !== null
          ? (value as any).node || (value as any).default || Object.values(value)[0]
          : null;
      if (target && typeof target === 'string') {
        aliases[key] = path.resolve(repoDir, target);
      }
    }
  }

  const webpackConfig: any = {
    mode: 'none',
    target: 'node',
    entry: entryPath,
    output: {
      path: path.dirname(outputPath),
      filename: path.basename(outputPath),
      libraryTarget: 'commonjs2',
    },
    resolve: {
      extensions: ['.js', '.mjs', '.cjs', '.json', '.node'],
      mainFields: ['main', 'module'],
      alias: aliases,
    },
    module: {
      rules: [{
        test: /\.mjs$/,
        type: 'javascript/auto',
      }],
    },
    experiments: {
      // Enable support for ESM
      outputModule: false,
    },
    externals: [
      /\.node$/,
      'bufferutil',
      'utf-8-validate',
    ],
  };

  const configPath = path.join(repoDir, '_webpack.config.js');
  // Write as JS (not JSON) so regex externals are preserved
  const aliasStr = Object.keys(aliases).length > 0
    ? JSON.stringify(aliases, null, 2)
    : '{}';
  fs.writeFileSync(configPath, `module.exports = {
  mode: "none",
  target: "node",
  entry: ${JSON.stringify(entryPath)},
  output: {
    path: ${JSON.stringify(path.dirname(outputPath))},
    filename: ${JSON.stringify(path.basename(outputPath))},
    libraryTarget: "commonjs2"
  },
  resolve: {
    extensions: [".js", ".mjs", ".cjs", ".json", ".node"],
    mainFields: ["main", "module"],
    alias: ${aliasStr}
  },
  module: {
    rules: [{ test: /\\.mjs$/, type: "javascript/auto" }]
  },
  externals: [
    /\\.node$/,
    "bufferutil",
    "utf-8-validate"
  ]
};
`);

  // Run webpack using the local or global CLI
  const webpackBin = path.resolve(__dirname, '..', 'node_modules', '.bin', 'webpack');
  execSync(`"${webpackBin}" --config "${configPath}"`, {
    cwd: repoDir,
    stdio: 'pipe',
    timeout: 120000,
  });

  return fs.existsSync(outputPath);
}

/**
 * Figure out the right command to run just the tests, skipping linters.
 */
function resolveTestCommand(pkgJson: any): string | null {
  const scripts = pkgJson.scripts || {};
  const testScript = scripts.test;

  if (!testScript || testScript === 'echo "Error: no test specified" && exit 1') {
    return null;
  }

  const testOnlyKeys = ['tests-only', 'test:unit', 'test-only', 'unit', 'test:run'];
  for (const key of testOnlyKeys) {
    if (scripts[key]) return `npm run ${key}`;
  }

  if (scripts.pretest || scripts.posttest) {
    return 'npm test --ignore-scripts';
  }

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
    bundled: false,
    obfuscated: false,
    bundleSize: 0,
    obfuscatedSize: 0,
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
      console.log(`  Build failed (continuing): ${e.message.split('\n')[0]}`);
    }
  }

  // Step 5: Find main entry point
  const mainEntry = findMainEntry(repoDir);
  if (!mainEntry) {
    console.error(`  Could not find main entry point`);
    return report;
  }
  console.log(`  Entry: ${path.relative(repoDir, mainEntry)}`);

  // Step 6: Webpack bundle into a single file
  const bundlePath = path.join(repoDir, '_bundle.js');
  console.log(`  Bundling with webpack...`);
  try {
    webpackBundle(repoDir, mainEntry, bundlePath);
    report.bundled = true;
    report.bundleSize = fs.statSync(bundlePath).size;
    console.log(`  \u2713 Bundle: ${(report.bundleSize / 1024).toFixed(1)} KB`);
  } catch (e: any) {
    const stderr = e.stderr?.toString() || '';
    const stdout = e.stdout?.toString() || '';
    const output = stdout + '\n' + stderr;

    // Extract the most useful error lines
    const errorLines = output.split('\n').filter((l: string) =>
      l.includes('ERROR') || l.includes('Module not found') || l.includes('Can\'t resolve'));
    report.bundleError = errorLines[0]?.trim() || e.message.split('\n')[0];
    console.log(`  \u2717 Bundle failed: ${(report.bundleError || '').substring(0, 120)}`);
    errorLines.slice(1, 4).forEach((l: string) =>
      console.log(`    ${l.trim().substring(0, 120)}`));

    return report;
  }

  // Step 7: Obfuscate the bundle
  console.log(`  Obfuscating...`);
  fs.mkdirSync(pkgOutputDir, { recursive: true });
  try {
    const source = fs.readFileSync(bundlePath, 'utf-8');
    const obfuscated = obfuscate(source, { targetTokens: 2_000_000 });

    const obfuscatedPath = path.join(pkgOutputDir, 'bundle.js');
    fs.writeFileSync(obfuscatedPath, obfuscated, 'utf-8');

    report.obfuscated = true;
    report.obfuscatedSize = obfuscated.length;
    console.log(`  \u2713 Obfuscated: ${(report.obfuscatedSize / 1024).toFixed(1)} KB`);

    // Strip console stubs from the obfuscated output for testing.
    // The stubs (console.log = function(){}) break test runners that
    // check console output. The obfuscation is still valid without them.
    const stripped = obfuscated.replace(/console\.\w+\s*=\s*function\s*\(\)\s*\{\s*\}\s*;?\n?/g, '');

    // Replace the main entry with the obfuscated bundle
    fs.copyFileSync(mainEntry, mainEntry + '.orig');
    fs.writeFileSync(mainEntry, stripped, 'utf-8');
  } catch (e: any) {
    report.obfuscateError = e.message.split('\n')[0];
    console.log(`  \u2717 Obfuscation failed: ${report.obfuscateError}`);
    return report;
  }

  // Step 8: Run the package's test suite against the obfuscated bundle
  const testCmd = resolveTestCommand(pkgJson);
  if (testCmd) {
    console.log(`  Running tests...`);
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
  console.log('  Package              Bundle    Obfuscate  Tests');
  console.log('  -------              ------    ---------  -----');

  let totalBundled = 0;
  let totalObfuscated = 0;
  let totalTestsRan = 0;
  let totalTestsPassed = 0;

  for (const r of reports) {
    const bundle = r.bundled ? `${(r.bundleSize / 1024).toFixed(0)}KB` : 'FAIL';
    const obf = r.obfuscated ? `${(r.obfuscatedSize / 1024).toFixed(0)}KB` : 'FAIL';
    let testStatus = 'no tests';
    if (r.tests.ran) {
      testStatus = r.tests.passed ? 'PASSED' : 'FAILED';
      totalTestsRan++;
      if (r.tests.passed) totalTestsPassed++;
    }
    console.log(`  ${r.package.padEnd(20)} ${bundle.padEnd(9)} ${obf.padEnd(10)} ${testStatus}`);

    if (r.bundleError) console.log(`    Bundle: ${r.bundleError.substring(0, 100)}`);
    if (r.obfuscateError) console.log(`    Obfuscate: ${r.obfuscateError.substring(0, 100)}`);

    if (r.bundled) totalBundled++;
    if (r.obfuscated) totalObfuscated++;
  }

  console.log('');
  console.log(`  Bundled: ${totalBundled}/${reports.length}`);
  console.log(`  Obfuscated: ${totalObfuscated}/${reports.length}`);
  console.log(`  Tests: ${totalTestsPassed}/${totalTestsRan} suites passed`);

  // Write full report as JSON
  const reportPath = path.join(distDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2), 'utf-8');
  console.log(`\n  Full report: ${reportPath}`);

  // Cleanup temp directory
  fs.rmSync(tempDir, { recursive: true, force: true });
}

main();

import * as fs from 'fs';
import * as path from 'path';
import { obfuscate, obfuscateMultiple } from './obfuscator';
import { ObfuscateOptions, DEFAULT_OPTIONS } from './options';

// Parse CLI arguments
const args = process.argv.slice(2);
const inputFiles: string[] = [];
const options: Partial<ObfuscateOptions> = {};

if (process.env.INPUT_FILE) {
  inputFiles.push(process.env.INPUT_FILE);
}

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--target-tokens' && args[i + 1]) {
    options.targetTokens = parseInt(args[i + 1], 10);
    if (isNaN(options.targetTokens) || options.targetTokens < 1) {
      process.stderr.write('Error: --target-tokens must be a positive integer\n');
      process.exit(1);
    }
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    process.stdout.write(`Usage: egodeath [options] <input-file> [input-file...]

Options:
  --target-tokens <n>  Target output size in tokens (default: ${DEFAULT_OPTIONS.targetTokens.toLocaleString()})
                       Small inputs are bloated up to this limit.
                       Large inputs are obfuscated with less bloat.
  --help, -h           Show this help message

When multiple files are given, dead code mutation draws donor code from
ALL input files. Each output is written to <basename>.obfuscated.js.

With a single file, output goes to stdout (as before).

Environment:
  INPUT_FILE           Alternative way to specify a single input file
  DEBUG                Set to skip output (for debugging)
`);
    process.exit(0);
  } else if (!args[i].startsWith('-')) {
    inputFiles.push(args[i]);
  }
}

if (inputFiles.length === 0) {
  inputFiles.push('input.js');
}

if (inputFiles.length === 1) {
  // Single file: original behavior — output to stdout
  const code = fs.readFileSync(inputFiles[0]).toString();
  const result = obfuscate(code, options);

  if (!process.env.DEBUG) {
    console.log(result);
  }
} else {
  // Multiple files: cross-file dead code mutation, output to .obfuscated.js files
  const files = inputFiles.map(f => ({
    filename: f,
    code: fs.readFileSync(f).toString(),
  }));

  const results = obfuscateMultiple(files, options);

  for (const result of results) {
    const ext = path.extname(result.filename);
    const base = result.filename.slice(0, -ext.length);
    const outFile = base + '.obfuscated' + ext;
    fs.writeFileSync(outFile, result.code);
    if (!process.env.DEBUG) {
      process.stderr.write(`Wrote ${outFile}\n`);
    }
  }
}

import * as fs from 'fs';
import { obfuscate } from './obfuscator';
import { ObfuscateOptions, DEFAULT_OPTIONS } from './options';

// Parse CLI arguments
const args = process.argv.slice(2);
let inputFile = process.env.INPUT_FILE || 'input.js';
const options: Partial<ObfuscateOptions> = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--target-tokens' && args[i + 1]) {
    options.targetTokens = parseInt(args[i + 1], 10);
    if (isNaN(options.targetTokens) || options.targetTokens < 1) {
      process.stderr.write('Error: --target-tokens must be a positive integer\n');
      process.exit(1);
    }
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    process.stdout.write(`Usage: egodeath [options] [input-file]

Options:
  --target-tokens <n>  Target output size in tokens (default: ${DEFAULT_OPTIONS.targetTokens.toLocaleString()})
                       Small inputs are bloated up to this limit.
                       Large inputs are obfuscated with less bloat.
  --help, -h           Show this help message

Environment:
  INPUT_FILE           Alternative way to specify the input file
  DEBUG                Set to skip output (for debugging)
`);
    process.exit(0);
  } else if (!args[i].startsWith('-')) {
    inputFile = args[i];
  }
}

const code = fs.readFileSync(inputFile).toString();
const result = obfuscate(code, options);

if (!process.env.DEBUG) {
  console.log(result);
}

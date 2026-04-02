import * as fs from 'fs';
import { obfuscate } from './obfuscator';

const inputFile = process.env.INPUT_FILE || 'input.js';
const code = fs.readFileSync(inputFile).toString();
const result = obfuscate(code);

if (!process.env.DEBUG) {
  console.log(result);
}

# egodeath

![images/screenshot.png](images/screenshot.png)
A JavaScript obfuscator designed to make code extremely difficult to read and analyze for both humans and LLMs. Written in TypeScript.

## Installation

```bash
npm install
npm run build
```

## CLI Usage

```bash
# Basic usage
node dist/index.js input.js > output.js

# With target token budget (default: 2,000,000)
node dist/index.js --target-tokens 500000 input.js > output.js

# Minimal obfuscation (small output)
node dist/index.js --target-tokens 10000 input.js > output.js

# Maximum bloat (10M tokens)
node dist/index.js --target-tokens 10000000 input.js > output.js

# Using environment variable
INPUT_FILE=input.js node dist/index.js > output.js

# Help
node dist/index.js --help
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `--target-tokens <n>` | `2000000` | Target output size in tokens. Small inputs are bloated up to this limit. Large inputs produce less bloat to stay within budget. |
| `--help, -h` | | Show help message |

### npm scripts

```bash
npm run build              # Compile TypeScript to dist/
npm run start              # Run the obfuscator (reads input.js)
npm run test               # Run the test suite
npm run obfuscate-package  # Run compatibility tests against npm packages
```

## Programmatic API

```js
const { obfuscate } = require('./dist/obfuscator');

const code = 'function add(a, b) { return a + b; }';
const obfuscated = obfuscate(code);

// With options
const obfuscated = obfuscate(code, { targetTokens: 500000 });
```

## Transform Pipeline

The obfuscator applies transforms in a specific order. Each stage builds on the previous one.

### Phase 1: Structural Pre-transforms

These reshape the code's control flow and call structure before identifier renaming.

| Order | Transform | File | Description |
|-------|-----------|------|-------------|
| 1 | **Control Flow Flattening** | `transforms/controlFlowFlattening.ts` | Converts function bodies into `while(true) { switch(state) { ... } }` state machines. Each statement becomes a switch case with a random non-sequential state ID. Case order is shuffled. Dead switch cases with realistic code are injected. |
| 2 | **Opaque Predicates** | `transforms/opaquePredicates.ts` | Injects `if` conditions that always evaluate to true or false but are mathematically hard to prove (e.g., `(x*x+x)%2===0`). Real code is wrapped in always-true branches; dead code goes in always-false branches. 15 predicate formulas across modular arithmetic, bitwise, and type-check categories. |
| 3 | **Proxy Functions** | `transforms/proxyFunctions.ts` | Routes all function calls through two dispatcher functions: `_fc(fn, ...args)` for simple calls and `_mc(obj, prop, ...args)` for method calls. Completely flattens the call graph. Excludes `require`, `eval`, `new`, and spread arguments. |
| 4 | **Context Window Exhaustion** | `transforms/contextExhaustion.ts` | Wraps expressions in verbose but semantically transparent noise: deeply nested ternaries with opaque conditions, void-expression chains via comma operator, and conditional void padding. Forces LLMs to waste context window tokens on noise. |
| 5 | **Comma Expression Merging** | `transforms/commaExpressions.ts` | Collapses consecutive expression statements into single comma expressions: `a(); b(); return c()` becomes `return a(), b(), c()`. Also folds into `throw`. Processes all blocks including CFF switch cases. |

### Phase 2: Identifier Passes

The original three-pass system from the base obfuscator.

| Order | Pass | File | Description |
|-------|------|------|-------------|
| 6 | **Pass 1: Catalog** | `passes/firstPass.ts` | Traverses the AST and catalogs every identifier, building a globals map that assigns each an obfuscated random Unicode name. |
| 7 | **Pass 2: Substitute** | `passes/secondPass.ts` | Replaces all identifier names with their obfuscated Unicode equivalents. Encodes `require()` arguments as `String.fromCharCode(...)`. Encodes static `import`/`export` sources as unicode-escaped string literals. |
| 8 | **Pass 3: Dummy Parameters** | `passes/thirdPass.ts` | Injects 0-15 random unused parameters into every function declaration and expression. Strips all comments. |

### Phase 3: Post-transforms

These encode values and hide remaining readable content after identifiers are obfuscated.

| Order | Transform | File | Description |
|-------|-----------|------|-------------|
| 9 | **Global Variable Encoding** | `transforms/globalVariableEncoding.ts` | Replaces references to `Math`, `Array`, `Object`, `JSON`, etc. with `eval("Name<suffix>".replace(new RegExp("<suffix>$"), ""))`. Each instance gets a unique suffix. The name+suffix string goes into the string array. |
| 10 | **Property Key Encoding** | `transforms/propertyKeyEncoding.ts` | Converts dot property access (`obj.foo`) to computed access (`obj[var]`) where the variable holds the property name decoded from a string+suffix+replace pattern. Per-scope registries deduplicate same-name properties within each function closure. Cross-scope access works because all suffixes resolve to the same property name at runtime. |
| 11 | **Number Encoding** | `transforms/numberEncoding.ts` | Replaces numeric literals with equivalent bitwise/arithmetic expressions. 11 encoding strategies: shift+add, XOR identity, complement, division, nested shifts, etc. Each instance is uniquely generated. Skips 0, 1, -1, floats. |
| 12 | **String Array Extraction** | `transforms/stringArrayExtraction.ts` | Collects all remaining string literals into a single array. Each string is XOR-ciphered with a position-derived key and hex-encoded. The array is pre-rotated by a random offset. An accessor function with a decode cache handles runtime decoding. A base offset hides the real array indices. |
| 13 | **Console Stubs** | `obfuscator.ts` | Prepends `console.log = function(){};` (and all other console methods) to silence output. |
| 14 | **Terser Minification** | `obfuscator.ts` | Strips all whitespace and formatting using terser with `mangle: false` and `compress: false` — no variable renaming or dead code elimination, just formatting removal. Output is a single dense line. |

### Dead Code Injection

Dead code is injected at multiple points throughout the pipeline:

| Source | Location | Description |
|--------|----------|-------------|
| `transforms/deadCodeInjection.ts` | CFF switch cases + opaque predicate else branches | 9 template types: loop accumulation, array building, object manipulation, string concatenation, nested conditionals, try/catch, while countdown, switch computed, bitwise chains. Templates reference real scope variables for authenticity. |
| CFF dead cases | Switch statement | ~30% extra unreachable cases per state machine, each transitioning to a real state ID to resist reachability analysis. |
| Opaque predicate branches | if/else blocks | Always-false conditions guard dead code blocks; always-true conditions wrap real code with dead code in the else. |

## Output Size Budget

The `--target-tokens` option controls output size. A bloat budget is computed from input size and target tokens, throttling:

- Context exhaustion wrap probability (0-35%)
- Opaque predicate injection probability (0-30%)
- Dead code case count multiplier (0-100%)
- Number of strings to encode

Small inputs get maximum bloat; large inputs are throttled to stay within budget.

## Project Structure

```
src/
  index.ts              CLI entry point
  obfuscator.ts         Main pipeline orchestrator
  options.ts            Budget system and options
  types.ts              AST type definitions
  random.ts             Random name/string generation
  ast.ts                AST node factory functions
  keywords.ts           Reserved keyword list
  globals.ts            Global state management
  substitute.ts         Identifier substitution utilities
  declarations.d.ts     Module type declarations
  passes/
    firstPass.ts        Identifier cataloging
    secondPass.ts       Identifier substitution + string encoding
    thirdPass.ts        Dummy parameter injection
  transforms/
    controlFlowFlattening.ts
    opaquePredicates.ts
    proxyFunctions.ts
    contextExhaustion.ts
    commaExpressions.ts
    globalVariableEncoding.ts
    propertyKeyEncoding.ts
    numberEncoding.ts
    stringArrayExtraction.ts
    deadCodeInjection.ts
  __tests__/            255 unit tests across 17 suites
tools/
  obfuscate-package.ts  npm package compatibility testing tool
tests/
  input*.js             Original test input files
```

## Testing

```bash
# Run all tests
npm test

# Run a specific test suite
npx jest controlFlowFlattening
npx jest opaquePredicates

# Test against npm packages (clones repos, webpack-bundles, obfuscates, runs tests)
npm run obfuscate-package                    # All 10 packages
npm run obfuscate-package -- minimist semver # Specific packages
```

## Example

### Input (182 chars, 10 lines)

```js
function greet(name) {
  var greeting = 'Hello';
  var msg = greeting + ' ' + name;
  if (name === 'World') {
    msg = msg + '!';
  } else {
    msg = msg + '.';
  }
  return msg;
}
```

### Output (1 line, truncated)

Every run produces different output due to random names, suffixes, XOR keys, state IDs, and opaque predicates. The full output is a single minified line. Here is a representative sample, formatted for readability:

```js
console.assert=function(){};
// ... 14 console stubs ...

var 颈=["c3c6c0dbe486fdfbdcf6","fccef8cef6d99e","8ca0b5a9a2f7a4f28883f689",...];

(function(a,n){while(n--){a.push(a.shift())}})(颈,21);  // rotation IIFE

var 羟={};
var 厌=function(i){                    // XOR+hex decoder / accessor
  if(羟[i]!==void 0)return 羟[i];      // decode cache
  var idx=i-302;
  var v=颈[idx];
  var pidx=(idx+21)%22;                // pre-rotation index
  var k=pidx*7+179&255||1;             // XOR key derivation
  var s="";
  for(var j=0;j<v.length;j+=2)
    s+=String.fromCharCode(parseInt(v.substr(j,2),16)^k);
  羟[i]=s;
  return s
};

var 击=function(){...};                // function call proxy (_fc)
var 潡=function(){...};                // method call proxy (_mc)

function 썞(name,劌,뫓,䈴,깥){         // obfuscated "greet" + dummy params
  var 叻=9488<<2>>>2|0;                // initial state (number-encoded)
  if((䠢*䠢+䠢)%(~-3|0)===0){         // opaque predicate (always true)
    while(true){
      switch(叻){
        case 9488:                     // real state: var greeting = 'Hello'
          祳=厌(302),叻=8115;break;
        case 8115:                     // real state: msg = greeting + ' ' + name
          х=祳+厌(309)+name,叻=1731;break;
        case 1731:                     // real state: if (name === 'World')
          if(name===厌(317)){叻=3973;break}
          else{叻=5027;break}
        case 3973:                     // real: msg = msg + '!'
          х=х+厌(310),叻=6522;break;
        case 5027:                     // real: msg = msg + '.'
          х=х+厌(313),叻=6522;break;
        case 6522:                     // real: return msg
          return х;
        case 497:                      // DEAD: unreachable case (fake code)
          var 傏=0;
          for(var 懆=0;懆<х+6;懆++){傏+=懆*7}
          叻=3973;break;
        case 2819:                     // DEAD: unreachable case (fake code)
          var 瓵=3; ...
          叻=4990;break;
        case 1779:                     // DEAD: exit state
          return;
      }
    }
  }else{                               // opaque predicate false branch (dead)
    var 竂=叻*4;var 卙=0; ...
  }
}
```

What happened to the code:

- **Identifiers**: `greet` -> `썞`, `greeting` -> `祳`, `msg` -> `х`
- **Strings**: `'Hello'`, `'World'`, `'!'`, `'.'` -> XOR+hex encoded in array `颈`, accessed via `厌(302)` etc.
- **Control flow**: sequential statements -> `while(true)/switch` state machine with shuffled, non-sequential case IDs
- **Function calls**: all routed through proxy dispatchers `击` and `潡`
- **Numbers**: `42` -> `(9488<<2>>>2|0)`, `2` -> `(~-3|0)`, etc.
- **Property access**: `obj.foo` -> `obj[var]` where var decodes from string array
- **Globals**: `Math` -> `eval(厌(305).replace(new RegExp(厌(323)),""))`
- **Dead code**: fake switch cases (497, 2819), opaque predicate else branches
- **Formatting**: everything minified to a single line

## Compatibility Test Tool

The `tools/obfuscate-package.ts` tool tests the obfuscator against real npm packages to verify compatibility.

### How it works

For each package, the tool:

1. Clones the package's git repository
2. Installs all dependencies (including devDependencies for testing)
3. Builds the package if it has a build script
4. Uses **webpack** to bundle the library's main entry point into a single CommonJS file (no minification)
5. Runs the obfuscator on the bundled file
6. Replaces the library's main entry with the obfuscated bundle (stripping console stubs for test compatibility)
7. Runs the library's own test suite against the obfuscated version

### Running it

```bash
# Test against all 10 default packages
npm run obfuscate-package

# Test specific packages
npm run obfuscate-package -- minimist semver lodash

# Default packages: lodash, chalk, commander, debug, express,
#                   axios, moment, uuid, minimist, semver
```

### Output locations

After running, the tool produces:

| Path | Contents |
|------|----------|
| `dist/obfuscated/<package>/bundle.js` | The obfuscated webpack bundle for each package |
| `dist/obfuscated/report.json` | Full JSON report with bundle sizes, obfuscation status, test output |
| `.tmp-packages/` | Temporary cloned repos (cleaned up after run) |

The `report.json` contains detailed information for each package:

```json
{
  "package": "semver",
  "repoUrl": "https://github.com/npm/node-semver",
  "bundled": true,
  "obfuscated": true,
  "bundleSize": 69222,
  "obfuscatedSize": 204288,
  "tests": {
    "ran": true,
    "passed": false,
    "output": "..."
  }
}
```

### Viewing obfuscated output

To inspect what obfuscated code looks like for a real library:

```bash
# Run the tool
npm run obfuscate-package -- minimist

# View the obfuscated bundle
cat dist/obfuscated/minimist/bundle.js

# Or for a pretty-printed version (still obfuscated, just formatted)
node -e "console.log(require('fs').readFileSync('dist/obfuscated/minimist/bundle.js','utf-8'))" | npx prettier --parser babel
```

### Known test failure categories

Most test failures are caused by test infrastructure, not obfuscation bugs:

| Category | Packages | Cause |
|----------|----------|-------|
| Coverage thresholds | semver | Tests pass but coverage tool reports <100% on obfuscated code |
| ESM-only packages | chalk, axios, uuid | Webpack can't bundle packages that only export ESM with `#imports` |
| Test runner parsing | commander | Jest's Babel parser can't parse deeply nested obfuscated while/switch |
| Coverage tool spawning | minimist | `nyc` coverage tool fails to spawn `node` subprocess |
| Console stubs | moment | Deprecation warning tests check console output which is stubbed |

## License

ISC

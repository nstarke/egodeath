# Code and generated-runtime audit — 2026-09-21

Reviewed the production pipeline, transforms, scope/name state, verification code,
tests, and benchmark tooling at baseline commit `8218699`.

## Consolidation and dead code

- Replaced 19 copied ESTree/Babel visitor-key tables with `src/visitorKeys.ts`.
  The tables agreed on shared entries; the union includes the class method and
  field entries that some copies lacked.
- Centralized identical transform RNG, shuffle, suffix, and regex-escape helpers
  in `src/transformHelpers.ts`, preserving their existing random-byte behavior.
- Removed unused context-exhaustion wrappers and its disconnected statement
  generator tree, an unused integrity check, unused AST builders, imports,
  parameters, and temporary variables.
- Removed the unused `jsfuck` dependency, declaration, and `useJsfuck` /
  `jsfuckStringLimit` budget fields. These fields had no consumers or effect.
  The optional second argument to `applyStringArrayExtraction` remains accepted
  for existing callers.
- Enabled TypeScript's unused-local and unused-parameter checks for production
  code. Jest retains its own relaxed settings for test fixtures. Fixed the tools
  TypeScript project to exclude Jest tests from its Node-only compilation.

The deliberately generated dead branches, donor code, decoys, and encoding
schemes remain part of the output's obfuscation strategy. Exported utilities with
existing tests were retained even where the production pipeline has no consumer.

## Generated-runtime changes

**Property-name decoding:** previously every function call recreated a RegExp and
stripped a suffix for each encoded property in that function. Each scope now has
persistent caches initialized lazily on first use. Scope-specific encodings stay
independent. Uncalled functions do no decoding. This adds cache bindings and a
small guard to the output, trading some code size and retained strings for much
less repeated allocation and decoding.

**String-array decoding:** previously the first accessor call decoded every
string, including appended cross-file decoys. The decoder now retains its cursor
and chain key, decodes only through the requested index, and stores the results
in a dense array. Reverse/repeated reads use the cache. UTF-16 code units and
content-dependent chain derivation are unchanged. A request near the end still
requires decoding preceding entries; this is required by the chaining scheme.

**Cross-file equalization:** padding only extends the encoded array. Removed the
heuristic search for a matching numeric `for`-loop bound, which could select an
unrelated source loop. The incremental decoder requires no bound rewrite and
never visits the appended padding through generated source accesses.

Lazy decoding changes when plaintext is present in memory. Per-scope caching also
makes subsequent invocations easier for a dynamic observer to distinguish from
first invocations. No claim of unchanged resistance to every analysis technique
is made; these optimizations preserve encoded payloads and chain dependencies.

**Proxy-call correctness:** fixed the two verified method-dispatch bugs. A
resolver now reads the receiver's method before source arguments execute and
returns a closure that calls that exact method with the original receiver.
Built-in `apply` raises `TypeError` for non-callables after argument evaluation.
The closure forwards its `arguments` directly, removing the former argument-array
allocation and copy loop. Calls involving optional-chain callees are preserved
so their short-circuiting semantics remain native. Added original-versus-generated
checks for getter/key/argument order, throwing getters, method replacement,
non-callables, nested calls, optional calls, and both fixes through the pipeline.

## Measurements

Offline benchmark, Node v20.11.1, nine samples per measurement, median elapsed
milliseconds. Compared the compiled baseline with the changed tree using
`tools/benchmark-transforms.js`. Generation and parsing/compilation are excluded
from timings. Every workload checks its result; hot loops are warmed first.

| Workload | Before (ms) | After (ms) | Interpretation |
| --- | ---: | ---: | --- |
| 200,000 calls reading three encoded properties, property + string transforms | 71.96 | 1.69 | About 43× faster |
| Same property workload through the complete pipeline, 5,000-token target | 74.28 | 2.11 | About 35× faster |
| One live string plus 800 unused decoys, fresh decoder initialization | 2.615 | 0.00060 | Decoy decoding eliminated; sub-microsecond result is noisy |
| All 256 strings read, fresh decoder initialization | 0.552 | 0.562 | About 2% slower in this sample; no dense-read win |
| 200,000 method-proxy calls with a receiver and one argument | 5.57 | 5.30 | Similar cost with corrected evaluation order |

These are synthetic workloads chosen to isolate the affected costs, not package
or application-wide speedup claims. Obfuscation is randomized; names, generated
code sizes, and exact timings vary between runs. The property-only sample grew
from about 3.0 KB to 3.6 KB with caching. Large encoded payloads still impose
parse/load costs even when their decoded strings are never requested.

Reproduce the current measurements with `npm run benchmark:transforms`. To compare
with another checkout compiled into a separate directory:

```sh
NODE_PATH="$PWD/node_modules" node tools/benchmark-transforms.js /tmp/egodeath-before
```

The script accepts a compiled tree containing `obfuscator.js`, `random.js`, and
`transforms/`. It uses the current checkout's installed dependencies. No package
downloads or external services are needed.

## Remaining opportunities

1. The simple-function proxy still allocates an argument array and loops over
   `arguments`. Fixed-arity dispatchers or rest arguments are worth profiling on
   call-heavy workloads. The corrected method proxy removes that copy but
   allocates a closure per call; optimization must preserve early lookup and
   late invocation, including throwing getters and argument side effects.
2. Global-variable encoding repeatedly creates regexes and evaluates names.
   Cache the decoded *name*, if profiling warrants it. Caching global *values*
   indiscriminately can break programs that reassign globals or install polyfills.
3. Output size remains a likely load-time bottleneck for large token budgets.
   Existing dead-code multipliers, cross-file transplants, and long identifiers
   add parser work even on unreachable paths. Smaller budgets or an explicit
   performance profile would trade obfuscation volume for startup latency.
4. Run the existing npm-package benchmarks on representative deployment workloads
   and Node/browser engines before applying the synthetic speedup ratios to a
   release. This audit's timings cover the local Node version only.

## Validation

- `npm run build` passed with unused-local and unused-parameter checks enabled.
- `tsc --project tools/tsconfig.json --noEmit` passed.
- `npm test -- --runInBand`: all **40 suites and 613 tests passed** (289 seconds),
  including the new proxy-ordering and runtime-cache regressions and existing
  randomized donor, cross-file, Unicode, scope, and transform coverage.
- The offline benchmark validated results for every timed workload.
- `git diff --check` passed.

The suite uses its existing forced-exit configuration because anti-debug timers
can keep the test process alive. Package downloads, package compatibility runs,
and additional Node/browser versions were not part of this local validation.

#!/usr/bin/env node
// Offline benchmarks for generated code. Build first; optionally compare an
// older compiled tree: NODE_PATH="$PWD/node_modules" node tools/benchmark-transforms.js /tmp/egodeath-before
const path = require('path');
const recast = require('recast');
const { performance } = require('perf_hooks');
const assert = require('assert');
const parser = require('recast/parsers/babel');
const samples = 9;
const iterations = 200000;
const current = path.resolve(__dirname, '../dist');
const roots = process.argv[2] ? [path.resolve(process.argv[2]), current] : [current];
function median(values) { return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]; }
function measure(fn, repeats) {
  const times = [];
  for (let s = 0; s < samples; s++) {
    const start = performance.now();
    for (let i = 0; i < repeats; i++) fn();
    times.push((performance.now() - start) / repeats);
  }
  return median(times);
}
function transforms(root) {
  const globals = require(path.join(root, 'capturedGlobals'));
  const names = require(path.join(root, 'random'));
  const property = require(path.join(root, 'transforms/propertyKeyEncoding'));
  const strings = require(path.join(root, 'transforms/stringArrayExtraction'));
  return { globals, names, property, strings };
}
function generate(t, source, kind, decoys = []) {
  t.globals.resetCapturedGlobals();
  t.names.resetIssuedNames();
  const ast = recast.parse(source, { parser });
  if (kind === 'property') t.property.applyPropertyKeyEncoding(ast);
  t.strings.setStringArrayDecoys(decoys);
  try { t.strings.applyStringArrayExtraction(ast); }
  finally { t.strings.clearStringArrayDecoys(); }
  t.globals.flushCapturedGlobals(ast);
  return recast.print(ast).code;
}
const results = roots.map(root => {
  const t = transforms(root);
  const source = 'function read(o) { return o.alpha + o.beta + o.gamma; }';
  const propertyCode = generate(t, source, 'property');
  const read = new Function(propertyCode + '\nreturn read;')();
  const obj = { alpha: 1, beta: 2, gamma: 3 };
  function workload() { let sum = 0; for (let i = 0; i < iterations; i++) sum += read(obj); assert.equal(sum, iterations * 6); }
  workload(); workload();
  const propertyMs = measure(workload, 1);
  const decoys = Array.from({ length: 800 }, (_, i) => `decoy_${i}_` + 'x'.repeat(64));
  const sparseCode = generate(t, 'var value = "live";', 'strings', decoys);
  const sparse = new Function(sparseCode + '\nreturn value;');
  assert.equal(sparse(), 'live');
  const sparseMs = measure(sparse, 10);
  const values = Array.from({length: 256}, (_, i) => `string_${i}_\u{1f600}_` + 'x'.repeat(32));
  const denseCode = generate(t, 'var values = ' + JSON.stringify(values) + ';', 'strings');
  const dense = new Function(denseCode + '\nreturn values;');
  assert.deepEqual(dense(), values);
  const denseMs = measure(dense, 20);
  const { obfuscate } = require(path.join(root, 'obfuscator'));
  const pipelineCode = obfuscate('module.exports = function(o) { return o.alpha + o.beta + o.gamma; };', { targetTokens: 5000 });
  const mod = { exports: {} };
  new Function('module', 'console', 'setInterval', pipelineCode)(mod, {}, () => 0);
  function pipelineWorkload() {
    let sum = 0;
    for (let i = 0; i < iterations; i++) sum += mod.exports(obj);
    assert.equal(sum, iterations * 6);
  }
  pipelineWorkload(); pipelineWorkload();
  const pipelineMs = measure(pipelineWorkload, 1);
  const methodAst = recast.parse('function invoke(o, x) { return o.method(x); }', { parser });
  require(path.join(root, 'transforms/proxyFunctions')).applyProxyFunctions(methodAst);
  const invoke = new Function(recast.print(methodAst).code + '\nreturn invoke;')();
  const receiver = { value: 6, method(x) { return this.value + x; } };
  function methodWorkload() {
    let sum = 0;
    for (let i = 0; i < iterations; i++) sum += invoke(receiver, 2);
    assert.equal(sum, iterations * 8);
  }
  methodWorkload(); methodWorkload();
  const methodProxyMs = measure(methodWorkload, 1);
  return { root, node: process.version, samples, iterations, propertyMs, sparseMs, denseMs, pipelineMs, methodProxyMs,
    bytes: { property: Buffer.byteLength(propertyCode), sparse: Buffer.byteLength(sparseCode), dense: Buffer.byteLength(denseCode) } };
});
process.stdout.write(JSON.stringify(results, null, 2) + '\n');

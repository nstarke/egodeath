import * as recast from 'recast';
import { applyPropertyKeyEncoding } from '../transforms/propertyKeyEncoding';
import { applyStringArrayExtraction, setStringArrayDecoys, clearStringArrayDecoys } from '../transforms/stringArrayExtraction';
import { resetCapturedGlobals, flushCapturedGlobals } from '../capturedGlobals';
import { resetGlobals } from '../globals';

const parser = require('recast/parsers/babel');

beforeEach(() => { resetGlobals(); resetCapturedGlobals(); });
afterEach(() => clearStringArrayDecoys());

it('decodes each function-scope property once and leaves unused functions lazy', () => {
  const ast = recast.parse(`
    function read(o) { return o.alpha + o.beta; }
    function unused(o) { return o.gamma; }
    function nested(o) { return function() { return o.alpha; }; }
  `, { parser });
  applyPropertyKeyEncoding(ast);
  flushCapturedGlobals(ast);
  let constructions = 0;
  function CountingRegExp(pattern: string) { constructions++; return new RegExp(pattern); }
  const api = new Function('RegExp', recast.print(ast).code + '\nreturn {read, unused, nested};')(CountingRegExp);
  expect(constructions).toBe(0);
  for (let i = 0; i < 10; i++) expect(api.read({ alpha: i, beta: 2 })).toBe(i + 2);
  expect(constructions).toBe(2);
  const a = api.nested({ alpha: 7 });
  const b = api.nested({ alpha: 9 });
  expect(a()).toBe(7);
  expect(b()).toBe(9);
  expect(constructions).toBe(3);
  expect(api.unused({ gamma: 5 })).toBe(5);
  expect(constructions).toBe(4);
});

it('resumes the string chain, caches reverse reads, and never decodes tail decoys', () => {
  const values = ['alpha', '雪😀', '\u0000\ud800', 'last'];
  const source = values.map((s, i) => `function f${i}() { return ${JSON.stringify(s)}; }`).join('\n');
  const ast = recast.parse(source, { parser });
  setStringArrayDecoys(['unused tail'.repeat(100), 'other tail']);
  applyStringArrayExtraction(ast);
  const fns = ast.program.body.filter((n: any) => n.type === 'FunctionDeclaration');
  const ordered = fns.map((n: any) => ({ name: n.id.name, index: n.body.body[0].argument.arguments[0].value }))
    .sort((a: any, b: any) => a.index - b.index);
  let decodedChars = 0;
  const parse = (s: string, radix: number) => { decodedChars++; return parseInt(s, radix); };
  const accessors = new Function('parseInt', recast.print(ast).code + '\nreturn [' + ordered.map((n: any) => n.name).join(',') + '];')(parse);
  expect(decodedChars).toBe(0);
  const firstValue = values[Number(ordered[0].name.slice(1))];
  expect(accessors[0]()).toBe(firstValue);
  expect(decodedChars).toBe(firstValue.length);
  expect(accessors[0]()).toBe(firstValue);
  expect(decodedChars).toBe(firstValue.length);
  for (let i = accessors.length - 1; i >= 0; i--) {
    expect(accessors[i]()).toBe(values[Number(ordered[i].name.slice(1))]);
  }
  expect(decodedChars).toBe(values.reduce((total, value) => total + value.length, 0));
});

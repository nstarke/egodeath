import * as recast from 'recast';
import { applyTemplateLiteralFlattening } from '../transforms/templateLiteralFlattening';
import { obfuscate } from '../obfuscator';

function parse(code: string): any {
  return recast.parse(code, { parser: require('recast/parsers/babel') });
}

function printAfterFlatten(code: string): string {
  const ast = parse(code);
  applyTemplateLiteralFlattening(ast);
  return recast.print(ast).code;
}

describe('applyTemplateLiteralFlattening — AST-level rewrites', () => {
  it('collapses a pure template to a single string literal', () => {
    const out = printAfterFlatten('const a = `hello world`;');
    expect(out).toMatch(/"hello world"/);
    // The backtick form is gone.
    expect(out.includes('`')).toBe(false);
  });

  it('rewrites a template with one interpolation to a concat chain', () => {
    const out = printAfterFlatten('const s = `hi ${name}!`;');
    expect(out).toContain('"hi "');
    expect(out).toContain('"!"');
    expect(out).toContain('+ name');
    expect(out.includes('`')).toBe(false);
  });

  it('rewrites a template that starts with an interpolation', () => {
    // Anchor is an empty string so `${1}${2}` yields "12" not 3.
    const out = printAfterFlatten('const s = `${a}${b}`;');
    expect(out).toContain('""');
    expect(out.includes('`')).toBe(false);
  });

  it('does not flatten the quasi of a tagged template', () => {
    const out = printAfterFlatten('const s = tag`hi ${x}!`;');
    // The backtick template survives as the argument to the tag.
    expect(out).toMatch(/tag`hi \$\{x\}!`/);
  });

  it('still flattens a plain template nested inside a tagged template expression', () => {
    const out = printAfterFlatten('const s = tag`outer ${`inner ${x} more`}!`;');
    // Outer still uses backticks.
    expect(out).toContain('tag`outer ${');
    // Inner got flattened to a concat.
    expect(out).toContain('"inner "');
    expect(out).toContain('" more"');
  });

  it('passes through expressions unchanged', () => {
    const out = printAfterFlatten('const s = `n=${obj.prop + 1}`;');
    expect(out).toContain('"n="');
    expect(out).toContain('obj.prop + 1');
    expect(out.includes('`')).toBe(false);
  });

  it('leaves no empty-segment StringLiteral between adjacent interpolations', () => {
    const out = printAfterFlatten('const s = `${a}${b}${c}`;');
    // Should be along the lines of "" + a + b + c — no extra "" between a and b.
    // Count of "" literals should be exactly one (the anchor).
    const emptyMatches = out.match(/""/g) || [];
    expect(emptyMatches.length).toBe(1);
  });
});

describe('applyTemplateLiteralFlattening — end-to-end obfuscate', () => {
  beforeAll(() => {
    (global as any).setInterval = () => 0;
  });

  const OPTS = { targetTokens: 2000 };

  it('hides static template text from the final output', () => {
    const code = `
      function run(name) {
        return \`fetching \${name}, retrying...\`;
      }
      module.exports = { r: run('repo') };
    `;
    const out = obfuscate(code, OPTS);
    // Source quasi fragments shouldn't appear verbatim anywhere —
    // they've been packed into the encoded string array.
    expect(out).not.toContain('fetching ');
    expect(out).not.toContain('retrying...');

    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    expect(mod.exports.r).toBe('fetching repo, retrying...');
  });

  it('preserves multi-interpolation template semantics', () => {
    const code = `
      function run(a, b) {
        return \`sum=\${a + b}, prod=\${a * b}\`;
      }
      module.exports = { r: run(3, 4) };
    `;
    const out = obfuscate(code, OPTS);
    expect(out).not.toContain('sum=');
    expect(out).not.toContain('prod=');

    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    expect(mod.exports.r).toBe('sum=7, prod=12');
  });

  it('preserves start-with-interpolation string coercion (${1}${2} → "12")', () => {
    const code = `
      function run(a, b) {
        return \`\${a}\${b}\`;
      }
      module.exports = { r: run(1, 2) };
    `;
    const out = obfuscate(code, OPTS);
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    expect(mod.exports.r).toBe('12');
  });

  it('leaves tagged templates functioning', () => {
    const code = `
      function tag(strings, ...values) {
        return strings.raw.join('|') + ':' + values.join(',');
      }
      module.exports = { r: tag\`a \${1} b \${2} c\` };
    `;
    const out = obfuscate(code, OPTS);
    const mod: any = { exports: {} };
    const fn = new Function('module', 'exports', out);
    fn(mod, mod.exports);
    expect(mod.exports.r).toBe('a | b | c:1,2');
  });
});

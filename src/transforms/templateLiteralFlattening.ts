import * as estraverse from 'estraverse';

/**
 * Template literal flattening.
 *
 * String array extraction only sees StringLiteral/Literal nodes — the
 * static text inside a template literal lives on TemplateElement nodes
 * and slips through every string-hiding pass unchanged. That means
 *
 *     `fetching ${url}, retrying...`
 *
 * leaves "fetching " and ", retrying..." visible verbatim in the
 * output, which is the same kind of information leak the string array
 * is supposed to stop.
 *
 * This pass converts every plain TemplateLiteral into an equivalent
 * chain of `+` concatenations whose static parts are ordinary
 * StringLiterals:
 *
 *     `fetching ${url}, retrying...`
 *   →
 *     "fetching " + url + ", retrying..."
 *
 * Those StringLiterals are then picked up by stringArrayExtraction
 * just like any other literal in the source.
 *
 * Edge cases handled:
 *
 *   - Pure template (no interpolation) — e.g. `const x = \`abc\``.
 *     Collapses to a single StringLiteral("abc").
 *
 *   - Template with only interpolations, e.g. `${a}${b}`. We start the
 *     chain with an empty StringLiteral ("") so the leftmost `+` is
 *     string-concat and `${1}${2}` correctly produces "12" and not 3.
 *
 *   - Empty quasi segments between interpolations (`${a}${b}`) — we
 *     omit the empty StringLiteral to avoid `+ "" +` clutter in the
 *     output, but the leading `""` anchor always stays put.
 *
 *   - Tagged templates (``tag`foo${x}`bar``) — the tag function
 *     receives the quasi array verbatim (with both raw and cooked
 *     properties plus the spec-mandated `.raw`). Flattening the
 *     quasi would change what the tag sees, so we leave the
 *     quasi of a TaggedTemplateExpression alone. Nested plain
 *     templates inside the tag's interpolated expressions are still
 *     flattened normally.
 *
 * Runs as a late post-transform so the expressions inside the
 * template (already identifier-renamed by secondPass, possibly
 * already wrapped by globalVariableEncoding / propertyKeyEncoding)
 * are carried across unchanged — we only rearrange the shell.
 */

const EXTRA_VISITOR_KEYS: { [key: string]: string[] } = {
  ArrowFunctionExpression: ['params', 'body'],
  SpreadElement: ['argument'],
  RestElement: ['argument'],
  TemplateLiteral: ['quasis', 'expressions'],
  TaggedTemplateExpression: ['tag', 'quasi'],
  TemplateElement: [],
  ObjectPattern: ['properties'],
  ArrayPattern: ['elements'],
  AssignmentPattern: ['left', 'right'],
  ClassDeclaration: ['id', 'superClass', 'body'],
  ClassExpression: ['id', 'superClass', 'body'],
  ClassBody: ['body'],
  MethodDefinition: ['key', 'value'],
  ImportDeclaration: ['specifiers', 'source'],
  ImportSpecifier: ['imported', 'local'],
  ImportDefaultSpecifier: ['local'],
  ImportNamespaceSpecifier: ['local'],
  ExportNamedDeclaration: ['declaration', 'specifiers', 'source'],
  ExportDefaultDeclaration: ['declaration'],
  ExportAllDeclaration: ['source'],
  ExportSpecifier: ['exported', 'local'],
  ForOfStatement: ['left', 'right', 'body'],
  YieldExpression: ['argument'],
  AwaitExpression: ['argument'],
  ChainExpression: ['expression'],
  OptionalMemberExpression: ['object', 'property'],
  OptionalCallExpression: ['callee', 'arguments'],
  PropertyDefinition: ['key', 'value'],
  StaticBlock: ['body'],
  PrivateIdentifier: [],
  ObjectProperty: ['key', 'value'],
  ObjectMethod: ['key', 'params', 'body'],
  ClassMethod: ['key', 'params', 'body'],
  StringLiteral: [],
  NumericLiteral: [],
  BooleanLiteral: [],
  NullLiteral: [],
  RegExpLiteral: [],
};

/** Build a babel-shape StringLiteral for the given cooked value. */
function stringLit(value: string): any {
  return { type: 'StringLiteral', value };
}

function cookedOf(q: any): string {
  if (!q || !q.value) return '';
  const v = q.value;
  return typeof v.cooked === 'string' ? v.cooked : (typeof v.raw === 'string' ? v.raw : '');
}

function flattenTemplateLiteral(tl: any): any {
  const quasis: any[] = tl.quasis || [];
  const expressions: any[] = tl.expressions || [];

  // Pure string template (no interpolations) — one quasi, no
  // expressions — becomes a plain StringLiteral.
  if (expressions.length === 0) {
    return stringLit(cookedOf(quasis[0]));
  }

  // Anchor the chain with the first quasi (may be ""); this makes the
  // leftmost `+` a string-concat so `${1}${2}` → "12" not 3. We emit
  // the empty anchor unconditionally for templates that start with an
  // interpolation; for templates that start with static text, the
  // first StringLiteral IS that text and no extra "" is needed.
  let acc: any = stringLit(cookedOf(quasis[0]));

  for (let i = 0; i < expressions.length; i++) {
    acc = { type: 'BinaryExpression', operator: '+', left: acc, right: expressions[i] };
    const q = quasis[i + 1];
    const qv = cookedOf(q);
    if (qv.length > 0) {
      acc = {
        type: 'BinaryExpression',
        operator: '+',
        left: acc,
        right: stringLit(qv),
      };
    }
  }
  return acc;
}

/**
 * Walk the program AST and replace every plain TemplateLiteral with a
 * BinaryExpression chain.  Uses `leave` so nested templates are
 * flattened bottom-up — the outer flatten then reads already-
 * flattened children and splices them in as ordinary expressions.
 */
export function applyTemplateLiteralFlattening(ast: any): void {
  estraverse.replace(ast.program, {
    keys: EXTRA_VISITOR_KEYS,
    leave(node: any, parent: any) {
      if (node.type !== 'TemplateLiteral') return;
      // Preserve the quasi of a tagged template — the tag function
      // reads it directly and depends on both its structure and its
      // .raw side, which a concatenation chain cannot reproduce.
      if (parent && parent.type === 'TaggedTemplateExpression' && parent.quasi === node) {
        return;
      }
      return flattenTemplateLiteral(node);
    },
    fallback: 'iteration',
  } as any);
}

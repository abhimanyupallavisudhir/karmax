// Coverage for the conversation Markdown/MathJax renderer (app.js).
// Run: node web/markdown.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// Brace-count from the body's opening `{` (skips any `{}` in the parameter list,
// e.g. `opts = {}`), so functions with default-object params extract cleanly.
function extractFn(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`${name} not found`);
  const bodyStart = src.indexOf(') {', at);
  let depth = 0;
  for (let i = src.indexOf('{', bodyStart); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

global.esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
for (const fn of ['renderMarkdown', 'mdBlocks', 'mdInline', 'mdSplitRow', 'mdIsDelimiterRow', 'mdCellAlign']) eval(extractFn(fn));

let pass = 0, fail = 0;
const ok = (c, m) => c ? pass++ : (fail++, console.error('FAIL:', m));

// Escaping: untrusted text can never inject markup.
ok(renderMarkdown('<script>alert(1)</script>', {}).includes('&lt;script&gt;'), 'html is escaped, not injected');
ok(!renderMarkdown('<img src=x onerror=y>', {}).includes('<img'), 'raw tags do not survive');

// Common block + inline constructs.
ok(/<h1 class="md-h">Title<\/h1>/.test(renderMarkdown('# Title', {})), 'heading');
ok(/<strong>bold<\/strong>/.test(renderMarkdown('this is **bold**', {})), 'bold');
ok(/<em>it<\/em>/.test(renderMarkdown('an _it_ word', {})), 'italic');
ok(/<ul class="md-list"><li>a<\/li><li>b<\/li><\/ul>/.test(renderMarkdown('- a\n- b', {})), 'unordered list');
ok(/<ol class="md-list">/.test(renderMarkdown('1. a\n2. b', {})), 'ordered list');
ok(/<blockquote class="md-quote">/.test(renderMarkdown('> quoted', {})), 'blockquote');

// Inline code and fenced code keep their contents verbatim (escaped, unformatted).
ok(renderMarkdown('use `a_b` here', {}).includes('<code class="md-inline">a_b</code>'), 'inline code is not italicised');
const fence = renderMarkdown('```js\nlet x = 1 < 2;\n```', {});
ok(fence.includes('<pre class="md-code"><code>let x = 1 &lt; 2;</code></pre>'), 'fenced code escaped and unwrapped by <p>');

// The placeholder scheme must not collide with ordinary "space number space" text.
ok(renderMarkdown('I have 3 apples and 7 pears', {}).includes('I have 3 apples and 7 pears'), 'digits in prose are untouched');

// Links: only safe schemes; javascript: is neutralised.
ok(renderMarkdown('[x](https://a.com)', {}).includes('href="https://a.com"'), 'http link kept');
ok(renderMarkdown('[x](javascript:alert(1))', {}).includes('href="#"'), 'javascript: link neutralised');

// Math: left intact for MathJax when enabled; treated as plain text when off.
const withMath = renderMarkdown('inline $a_b=c^2$ and $$x+y$$', { math: true });
ok(withMath.includes('<span class="md-math">$a_b=c^2$</span>'), 'inline math span preserved raw');
ok(withMath.includes('<span class="md-math">$$x+y$$</span>'), 'display math span preserved raw');
ok(!withMath.includes('<em>'), 'underscores inside math are not italicised');
const noMath = renderMarkdown('cost $5 and $10 today', { math: false });
ok(noMath.includes('cost $5 and $10 today'), 'currency $ untouched when math is off');

// GFM pipe tables.
const table = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |', {});
ok(/<table class="md-table">/.test(table), 'table element emitted');
ok(table.includes('<thead><tr><th>A</th><th>B</th></tr></thead>'), 'header row cells');
ok(table.includes('<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody>'), 'body rows');
// Surrounding paragraphs stay separate; a table needs no blank line to be found.
const around = renderMarkdown('before\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nafter', {});
ok(around.includes('<p class="md-p">before</p>') && around.includes('<p class="md-p">after</p>') && around.includes('<table'), 'table separated from surrounding paragraphs');
// Alignment from the delimiter row.
const aligned = renderMarkdown('| L | C | R |\n|:--|:-:|--:|\n| a | b | c |', {});
ok(aligned.includes('<th style="text-align:left">L</th>') && aligned.includes('<th style="text-align:center">C</th>') && aligned.includes('<th style="text-align:right">R</th>'), 'per-column alignment');
// Cells with fewer columns than the header pad to empty; inline formatting works in cells.
const ragged = renderMarkdown('| A | B |\n| - | - |\n| **x** |', {});
ok(ragged.includes('<td><strong>x</strong></td><td></td>'), 'ragged row padded, inline formatting applied in cells');
// A bare rule / non-table pipe content is not a table.
ok(!renderMarkdown('---', {}).includes('<table'), 'horizontal rule is not a table');
ok(!renderMarkdown('a | b\nc | d', {}).includes('<table'), 'pipes without a delimiter row are not a table');
ok(mdIsDelimiterRow('|:--|--:|') && !mdIsDelimiterRow('| a | b |'), 'delimiter-row detection');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

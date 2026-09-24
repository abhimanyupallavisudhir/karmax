// Coverage for the conversation Markdown/MathJax renderer (markdown.js).
// Run: node web/markdown.test.cjs
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'markdown.js'), 'utf8');

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
// Module-level literals the list parser closes over (declared, not eval'd, so the
// eval'd functions can see them in this scope).
const MD_ITEM = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/;
const mdListKind = (marker) => (/^\d/.test(marker) ? 'ol' : 'ul');
for (const fn of ['renderMarkdown', 'sanitizeMarkdownHtml', 'mdBlocks', 'mdInline', 'mdIndent', 'mdParseList', 'mdSplitRow', 'mdIsDelimiterRow', 'mdCellAlign']) eval(extractFn(fn));

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
ok(/<ol class="md-list"><li>a<\/li><li>b<\/li><\/ol>/.test(renderMarkdown('1. a\n2. b', {})), 'ordered list');
ok(/<blockquote class="md-quote">/.test(renderMarkdown('> quoted', {})), 'blockquote');

// Lists — the reported bug: a loose list (blank lines between items) must stay
// ONE list so ordered numbering runs 1,2,3 instead of every item showing "1".
const loose = renderMarkdown('1. First\n\n2. Second\n\n3. Third', {});
ok((loose.match(/<ol/g) || []).length === 1, 'loose ordered list is a single <ol>');
ok((loose.match(/<li>/g) || []).length === 3, 'loose ordered list keeps all three items');
ok(/class="md-list md-loose"/.test(loose), 'loose list is marked loose for spacing');
ok(!/start=/.test(loose), 'a 1-based list needs no start attribute');
// A loose unordered list also stays a single list.
ok((renderMarkdown('- a\n\n- b\n\n- c', {}).match(/<ul/g) || []).length === 1, 'loose unordered list is a single <ul>');
// Ordered lists that begin at N carry start=N so the browser numbers correctly.
ok(/<ol class="md-list" start="3"><li>three<\/li><li>four<\/li><\/ol>/.test(renderMarkdown('3. three\n4. four', {})), 'ordered list preserves its starting number');
ok(/start="0"/.test(renderMarkdown('0. zero\n1. one', {})), 'ordered list starting at 0');
// `)` markers are valid ordered lists too.
ok(/<ol class="md-list"><li>a<\/li><li>b<\/li><\/ol>/.test(renderMarkdown('1) a\n2) b', {})), 'paren-style ordered markers');
// Switching marker type starts a new list rather than merging.
const mixed = renderMarkdown('1. a\n2. b\n- c\n- d', {});
ok(/<ol[^>]*><li>a<\/li><li>b<\/li><\/ol>/.test(mixed) && /<ul[^>]*><li>c<\/li><li>d<\/li><\/ul>/.test(mixed), 'ordered then unordered are separate lists');
// Nested sublists (by indentation) render as real nested lists, tightly.
const nested = renderMarkdown('1. Parent\n   - sub a\n   - sub b\n2. Second', {});
ok(/<ol class="md-list"><li>Parent\s*<ul class="md-list"><li>sub a<\/li><li>sub b<\/li><\/ul><\/li><li>Second<\/li><\/ol>/.test(nested), 'ordered list with a nested unordered sublist');
ok(/<ul class="md-list"><li>top\s*<ol class="md-list"><li>one<\/li><li>two<\/li><\/ol><\/li>/.test(renderMarkdown('- top\n  1. one\n  2. two\n- back', {})), 'unordered list with a nested ordered sublist');
// Multi-line items join with a soft break; surrounding paragraphs stay separate.
ok(/<li>First with<br>a continuation<\/li>/.test(renderMarkdown('1. First with\n   a continuation\n2. Second', {})), 'multi-line item uses a soft break');
const listAround = renderMarkdown('Intro:\n\n1. one\n2. two\n\nOutro.', {});
ok(listAround.includes('<p class="md-p">Intro:</p>') && listAround.includes('<p class="md-p">Outro.</p>') && /<ol/.test(listAround), 'list stays separate from surrounding paragraphs');
// Inline formatting still works inside list items.
ok(/<li><strong>bold<\/strong> item<\/li>/.test(renderMarkdown('- **bold** item', {})), 'inline formatting inside a list item');

// Inline code and fenced code keep their contents verbatim (escaped, unformatted).
ok(renderMarkdown('use `a_b` here', {}).includes('<code class="md-inline">a_b</code>'), 'inline code is not italicised');
const fence = renderMarkdown('```js\nlet x = 1 < 2;\n```', {});
ok(fence.includes('<pre class="md-code"><code>let x = 1 &lt; 2;</code></pre>'), 'fenced code escaped and unwrapped by <p>');

// The placeholder scheme must not collide with ordinary "space number space" text.
ok(renderMarkdown('I have 3 apples and 7 pears', {}).includes('I have 3 apples and 7 pears'), 'digits in prose are untouched');

// Links: only safe schemes; javascript: is neutralised.
ok(renderMarkdown('[x](https://a.com)', {}).includes('href="https://a.com"'), 'http link kept');
ok(renderMarkdown('[x](javascript:alert(1))', {}).includes('href="#"'), 'javascript: link neutralised');
ok(/<a href="https:\/\/a.com"[^>]*>x<\/a>/.test(renderMarkdown('[x](https://a.com "t")', {})), 'link title is dropped');
// Bare URLs autolink; trailing sentence punctuation stays outside; links are not double-wrapped.
ok(/see <a href="http:\/\/x.com"[^>]*>http:\/\/x.com<\/a> now/.test(renderMarkdown('see http://x.com now', {})), 'bare url autolinked');
ok(renderMarkdown('go to https://x.com.', {}).includes('>https://x.com</a>.'), 'trailing period left outside autolink');
ok((renderMarkdown('[s](https://x.com)', {}).match(/<a /g) || []).length === 1, 'a markdown link is not autolinked again');
// Scheme-less relative links (e.g. wiki page paths) are kept as local links: the
// target rides along in data-md-local so an in-app resolver can route it, while
// the href stays inert. A scheme (javascript:/data:) is still neutralised above.
ok(/<a href="#" data-md-local="guides\/e2e-runbook">run<\/a>/.test(renderMarkdown('[run](guides/e2e-runbook)', {})), 'relative wiki link kept as a local link');
ok(/data-md-local="src\/app\.ts:42"/.test(renderMarkdown('[app](src/app.ts:42)', {})), 'relative file citations may carry an editor line suffix');
ok(!renderMarkdown('[run](guides/e2e-runbook)', {}).includes('target="_blank"'), 'a local link does not open a new tab');
ok(renderMarkdown('[x](data:text/html,x)', {}).includes('href="#"') && !renderMarkdown('[x](data:text/html,x)', {}).includes('data-md-local'), 'data: link neutralised, not treated as local');
ok(renderMarkdown('[top](#section)', {}).includes('href="#section"'), 'in-page anchor link kept as-is');

// Bold+italic nests correctly, and backslash escapes suppress formatting.
ok(renderMarkdown('***wow***', {}).includes('<strong><em>wow</em></strong>'), 'triple markers are bold+italic, well nested');
ok(renderMarkdown('\\*not italic\\*', {}).includes('*not italic*') && !renderMarkdown('\\*not italic\\*', {}).includes('<em>'), 'backslash-escaped asterisks are literal');
ok(renderMarkdown('**a\\*b**', {}).includes('<strong>a*b</strong>'), 'escaped asterisk survives inside bold');
ok(renderMarkdown('some_var_name here', {}).includes('some_var_name'), 'mid-word underscores are not emphasis');

// Regression (Task 353): inline markup around a bare URL must not be consumed
// into the generated anchor. The old autolink-first pipeline let the closing
// `**` become part of href, then the bold pass inserted `</strong>` inside the
// attribute. Browsers repair that malformed formatting element across later
// siblings, bolding the follow-up field and subsequent messages.
const boldUrl = renderMarkdown('**karmax is live at https://krmax.io.**', {});
ok(
  boldUrl.includes('<strong>karmax is live at <a href="https://krmax.io"') &&
    boldUrl.includes('>https://krmax.io</a>.</strong>'),
  'bold delimiters around a bare URL remain outside the generated anchor',
);
ok(!/<a\b[^>]*<(?:strong|em|del)\b/i.test(boldUrl), 'formatting tags never appear inside anchor attributes');
ok(
  renderMarkdown('*see https://example.test/path*', {}).includes('<em>see <a href="https://example.test/path"') &&
    renderMarkdown('~~see https://example.test/path~~', {}).includes('<del>see <a href="https://example.test/path"'),
  'italic and strike delimiters around bare URLs remain outside the anchor',
);
const underscoredUrl = renderMarkdown('https://example.test/_private_', {});
ok(
  underscoredUrl.includes('href="https://example.test/_private_"') && !/<a\b[^>]*<em\b/i.test(underscoredUrl),
  'underscores in a URL cannot turn into markup inside href',
);
const markdownLinkUrl = renderMarkdown('[link](https://example.test/_private_)', {});
ok(
  markdownLinkUrl.includes('href="https://example.test/_private_"') &&
    !/<a\b[^>]*<em\b/i.test(markdownLinkUrl),
  'underscores in an explicit Markdown-link destination stay inert',
);
ok(
  !renderMarkdown('**unclosed formatting', {}).includes('<strong>'),
  'unclosed emphasis is rendered literally rather than leaking an open tag',
);

// Math: left intact for MathJax when enabled; treated as plain text when off.
const withMath = renderMarkdown('inline $a_b=c^2$ and $$x+y$$', { math: true });
ok(withMath.includes('<span class="md-math">$a_b=c^2$</span>'), 'inline math span preserved raw');
ok(withMath.includes('<span class="md-math">$$x+y$$</span>'), 'display math span preserved raw');
ok(!withMath.includes('<em>'), 'underscores inside math are not italicised');
const withTexDelimiters = renderMarkdown(
  'Here \\(q_i\\) is reported.\n\n\\[\nV(q)=\\min_{r\\in\\operatorname{conv}(\\Omega)}\n\\sum_i D_{\\mathrm{KL}}\\!\\left(\\operatorname{Ber}(r_i)\\,\\middle\\|\\,\\operatorname{Ber}(q_i)\\right).\n\\]',
  { math: true },
);
ok(withTexDelimiters.includes('<span class="md-math">\\(q_i\\)</span>'), 'TeX inline delimiters preserved raw');
ok(withTexDelimiters.includes('<span class="md-math">\\[\nV(q)=\\min_'), 'TeX display delimiters preserved raw');
ok(withTexDelimiters.includes('\\operatorname{conv}(\\Omega)') && withTexDelimiters.includes('\\middle\\|'), 'TeX commands survive Markdown rendering');
ok(!withTexDelimiters.includes('<em>'), 'underscores inside TeX-delimited math are not italicised');
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

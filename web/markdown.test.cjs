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
for (const fn of ['renderMarkdown', 'mdBlocks', 'mdInline']) eval(extractFn(fn));

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

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);

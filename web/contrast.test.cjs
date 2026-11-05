const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const css = fs.readFileSync(`${__dirname}/styles.css`, 'utf8');
const luminance = hex => hex.match(/\w{2}/g).map(c => parseInt(c,16)/255).map(c => c <= .04045 ? c/12.92 : ((c+.055)/1.055)**2.4).reduce((sum,c,i) => sum+c*[.2126,.7152,.0722][i],0);
test('UI-17: secondary labels meet 4.5:1 on all neutral surfaces', () => {
  for (const section of [css.slice(css.indexOf(':root {'), css.indexOf('html[data-theme="dark"]')), css.slice(css.indexOf('html[data-theme="dark"]'), css.indexOf('html[data-theme="dark"]')+1000)]) {
    const ink = section.match(/--ink-3: #(\w{6})/)[1];
    for (const [, bg] of section.matchAll(/--(?:paper|surface|surface-2): #(\w{6})/g)) {
      const [a,b] = [luminance(ink),luminance(bg)].sort((a,b) => b-a); assert.ok((a+.05)/(b+.05) >= 4.5, `${ink} on ${bg}`);
    }
  }
});

// Every look, light and dark: secondary text, primary buttons and the For me
// counts stay readable (4.5:1) on what they sit on.
test('each look keeps text, primary buttons and counts readable', () => {
  const block = (selector) => { const at = css.indexOf(`${selector} {`); assert.ok(at >= 0, selector); return css.slice(at, css.indexOf('}', at)); };
  const token = (blocks, name) => {
    for (const b of blocks) { const m = b.match(new RegExp(`--${name}: (#\\w{6}|var\\(--([\\w-]+)\\))`)); if (m) return m[2] ? token(blocks, m[2]) : m[1].slice(1); }
    throw new Error(`no --${name}`);
  };
  const ratio = (x, y) => { const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p); return (a + .05) / (b + .05); };
  const looks = {
    'default light': [block(':root')],
    'default dark': [block('html[data-theme="dark"],\n:root.dark'), block(':root')],
    'classic light': [block('html[data-skin="classic"]'), block(':root')],
    'classic dark': [block('html[data-skin="classic"][data-theme="dark"]'), block('html[data-skin="classic"]'), block(':root')],
  };
  for (const [look, blocks] of Object.entries(looks)) {
    for (const bg of ['paper', 'surface', 'surface-2']) assert.ok(ratio(token(blocks, 'ink-3'), token(blocks, bg)) >= 4.5, `${look}: --ink-3 on --${bg}`);
    assert.ok(ratio(token(blocks, 'primary-ink'), token(blocks, 'primary')) >= 4.5, `${look}: primary button`);
    assert.ok(ratio(token(blocks, 'attention-ink'), token(blocks, 'attention')) >= 4.5, `${look}: For me count`);
  }
});

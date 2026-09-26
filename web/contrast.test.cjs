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

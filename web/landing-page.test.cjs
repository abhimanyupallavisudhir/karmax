// The signed-out route is a real product introduction with authentication kept
// close at hand, rather than a login card presented without context.
// Run: node web/landing-page.test.cjs
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

let failed = 0;
function ok(condition, message) {
  if (!condition) {
    failed++;
    console.error('FAIL:', message);
  }
}

ok(/function landingAuthShell\(/.test(app), 'signed-out UI has a dedicated landing shell');
ok(/<main id="top">/.test(app) && /<footer class="landing-footer">/.test(app), 'landing page uses semantic page structure');
ok(/Put the work<br>on a list/.test(app), 'hero explains the task-list thesis');
ok(/class="landing-workbench"/.test(app), 'hero shows work moving through krmax');
ok(/id="how-it-works"/.test(app) && /id="why-krmax"/.test(app), 'product explanation is navigable');
ok(/class="landing-auth-scrim"[\s\S]*?\$\{open \? '' : 'hidden'\}/.test(app), 'authentication stays hidden until requested');
ok(/aria-modal="true"/.test(app) && /event\.key === 'Escape'/.test(app), 'authentication overlay is keyboard-dismissible');
ok(/event\.key !== 'Tab'/.test(app), 'keyboard focus remains inside the open auth dialog');
ok(/@media \(max-width: 560px\)/.test(styles), 'landing page has a phone layout');
ok(/@media \(prefers-reduced-motion: reduce\)/.test(styles), 'landing motion respects reduced-motion preferences');
ok(/\.landing-page \{[\s\S]*?--land-cobalt: #4b57c9/.test(styles), 'landing palette is scoped away from the product console');
ok(/name="description" content="krmax is one durable task list for people and agents\."/.test(html), 'page exposes a useful search description');

console.log(`\n${12 - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

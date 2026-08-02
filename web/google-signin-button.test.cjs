// The Google identity option should be immediately recognizable as Google,
// while remaining a real, accessible button in both supported color schemes.
// Run: node web/google-signin-button.test.cjs
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');

const googleButton = app.match(/const googleBtn = \(id\) => S\.google([\s\S]*?)\n\s*: '';/)?.[1] ?? '';

let failed = 0;
function ok(condition, message) {
  if (!condition) {
    failed++;
    console.error('FAIL:', message);
  }
}

ok(/class="google-signin-btn"/.test(googleButton), 'Google uses a dedicated branded button');
ok(/<svg[^>]+aria-hidden="true"/.test(googleButton), 'button includes a decorative Google G mark');
for (const color of ['#4285f4', '#34a853', '#fbbc05', '#ea4335']) {
  ok(googleButton.toLowerCase().includes(color), `Google G includes ${color}`);
}
ok(/Continue with Google/.test(googleButton), 'button names the Google sign-in action');
ok(/\.google-signin-btn\s*\{[\s\S]*?border:\s*1px solid #747775/.test(styles),
  'light button uses Google’s specified outline');
ok(/\.google-signin-btn\s*\{[\s\S]*?font-size:\s*14px/.test(styles),
  'button uses Google’s specified label size');
ok(/data-theme="dark"[^}]*\.google-signin-btn[\s\S]*?background:\s*#131314/.test(styles),
  'button provides Google’s dark treatment');
ok(/\.google-signin-btn:focus-visible/.test(styles), 'button has a visible keyboard focus treatment');

console.log(`\n${11 - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

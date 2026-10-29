// GitHub login should sit beside Google as a recognizable, accessible identity
// option on the one page that signs in and creates accounts. Run: node web/github-signin-button.test.cjs
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, 'styles.css'), 'utf8');
const githubButton = app.match(/const githubBtn = \(id\) => S\.github([\s\S]*?)\n\s*: '';/)?.[1] ?? '';

let failed = 0;
function ok(condition, message) {
  if (!condition) {
    failed++;
    console.error('FAIL:', message);
  }
}

ok(/class="github-signin-btn"/.test(githubButton), 'GitHub uses a dedicated branded button');
ok(/<svg[^>]+aria-hidden="true"/.test(githubButton), 'button includes a decorative GitHub mark');
ok(/Continue with GitHub/.test(githubButton), 'button names the GitHub sign-in action');
ok(/githubBtn\('github-btn'\)/.test(app), 'GitHub appears on the sign-in page');
ok(/wireSocialBtn\('github-btn',\s*'github'/.test(app), 'the button starts the GitHub provider');
ok(!/signup-github-btn|signup-google-btn/.test(app), 'one pair of social buttons serves sign-in and account creation');
ok(/\.github-signin-btn\s*\{[\s\S]*?background:\s*#24292f/.test(styles), 'light button uses GitHub dark fill');
ok(/data-theme="dark"[^}]*\.github-signin-btn[\s\S]*?background:\s*#f0f6fc/.test(styles),
  'dark theme uses GitHub light treatment');
ok(/\.github-signin-btn:focus-visible/.test(styles), 'button has a visible keyboard focus treatment');

console.log(`\n${9 - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

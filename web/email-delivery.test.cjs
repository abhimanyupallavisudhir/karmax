// Account-email affordances follow what the installation can actually send.
// With no outbound email, the console used to nag "Confirm your email" on every
// page and answer "Resend link" with "sent — check your inbox" (the Better Auth
// hook no-ops without a mailer), and "Forgot password?" led to a dead end.
// Run: node web/email-delivery.test.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
function fn(name) {
  const start = src.search(new RegExp(`^function ${name}\\(`, 'm'));
  if (start < 0) throw new Error(`Missing function: ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`Unterminated function: ${name}`);
}

const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const banner = (S) => Function('S', 'esc', 'profileRoute', `${fn('verificationBanner')}; return verificationBanner();`)(S, esc, () => '/profile');
const unverified = { email: 'ada@example.com', emailVerified: false };

assert.equal(banner({ user: unverified, emailDelivery: false }), '', 'no nag when nothing can be sent');
assert.match(banner({ user: unverified, emailDelivery: true }), /Resend link/, 'the nag when a link can be sent');
assert.equal(banner({ user: { ...unverified, emailVerified: true }, emailDelivery: true }), '');

const login = fn('renderLogin');
assert.match(login, /S\.emailDelivery \? '<div[^']*id="forgot-open"/, '"Forgot password?" only when a reset email can be sent');
assert.match(login, /\$\('#forgot-open'\)\?\.addEventListener/, 'wiring tolerates the hidden link');
assert.match(src, /S\.emailDelivery = session\.emailDelivery === true;/, 'boot reads the gateway’s answer');
assert.match(src, /S\.emailDelivery \? '<button class="btn sm" id="profile-resend-confirmation"/, 'profile resend follows the same rule');
console.log('email delivery affordances: ok');

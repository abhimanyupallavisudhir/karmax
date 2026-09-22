import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IdentityService } from '../../src/auth/identity.js';

/**
 * Runs natively under `tsx` (see tests/identity-hardening.test.ts) because Better
 * Auth dynamically loads Node's built-in SQLite adapter, which Vite rewrites.
 * Prints one JSON line of observations for the test to assert on.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-identity-'));

// ── 1. Rate limiting is on in EVERY deployment ───────────────────────────────
// Better Auth defaults `rateLimit.enabled` to `isProduction`, and karmax never
// sets NODE_ENV=production — so sign-in, password reset and email verification
// were unthrottled everywhere, hosted included.
const rateLimited = await IdentityService.open(':memory:', { baseURL: 'http://localhost:4600' });
const rateLimit = rateLimited.auth.options.rateLimit ?? {};

// ── 2. bootstrap() promotes the account IT created ───────────────────────────
// `hasUsers()` is a TOCTOU check and the promotion used `listUsers()[0]`, so two
// concurrent bootstrap POSTs both created an account and both promoted whichever
// row sorted first: the second requester got a valid session and an "you are the
// administrator" response while actually holding role `user`.
const raced = await IdentityService.open(':memory:', { baseURL: 'http://localhost:4601' });
const results = await Promise.all([
  raced.bootstrap({ name: 'First', email: 'first@example.com', password: 'first-password-long' }).catch((e: Error) => e),
  raced.bootstrap({ name: 'Second', email: 'second@example.com', password: 'second-password-long' }).catch((e: Error) => e),
]);
const promoted = results.map((result) => (result instanceof Error
  ? { error: true }
  : { email: result.user.email, role: result.user.role }));
// Whoever the store actually marked admin, cross-checked against the claims above.
const admins = (await raced.listUsers()).filter((user) => user.role === 'admin').map((user) => user.email).sort();
// Every response that claimed administrator must name an account that IS one.
const claimsHonest = promoted.every((claim) => 'error' in claim || admins.includes(claim.email!));

// ── 3. A secret read failure is NOT treated as first boot ────────────────────
// `catch { /* first boot */ }` around readFileSync meant a transient EACCES/EIO
// regenerated the signing secret — invalidating every live session and every
// outstanding reset link — and then overwrote the real one.
const dbFile = path.join(home, 'auth.db');
const first = await IdentityService.open(dbFile, { baseURL: 'http://localhost:4602' });
const storedSecret = fs.readFileSync(`${dbFile}.secret`, 'utf8').trim();
const reopened = await IdentityService.open(dbFile, { baseURL: 'http://localhost:4602' });
const secretStable = reopened.auth.options.secret === first.auth.options.secret
  && reopened.auth.options.secret === storedSecret;

// Make the secret unreadable in a way that is not ENOENT (a directory → EISDIR).
const broken = path.join(home, 'broken.db');
fs.mkdirSync(`${broken}.secret`);
let unreadableThrew = false;
try { await IdentityService.open(broken, { baseURL: 'http://localhost:4603' }); }
catch { unreadableThrew = true; }
// Crucially, it did not silently mint and persist a replacement.
const secretNotClobbered = fs.statSync(`${broken}.secret`).isDirectory();

fs.rmSync(home, { recursive: true, force: true });
console.log(JSON.stringify({
  rateLimitEnabled: rateLimit.enabled === true,
  bootstrapClaims: promoted.map((claim) => ('error' in claim ? 'error' : claim.email)),
  claimsHonest,
  bootstrapAdmins: admins,
  secretStable,
  unreadableThrew,
  secretNotClobbered,
}));

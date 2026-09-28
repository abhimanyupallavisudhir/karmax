import { memoryTransaction } from './helpers/memory-transaction.js';
import { Store } from '../src/store/db.js';
import { VAULT_USAGE_HALF_LIFE_MS } from '../src/util/vault-usage.js';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import {
  VaultItems,
  VaultItemStore,
  totpCode,
  itemCaps,
  domainMatches,
  itemHandle,
} from '../src/autonomy/vault-items.js';
import { fillViaCdp } from '../src/autonomy/fill.js';

function memStore(): VaultItemStore & { audit: any[] } {
  const kv = new Map<string, string>();
  const audit: any[] = [];
  return {
    transaction: memoryTransaction(kv, audit),
    kvGet: (k) => kv.get(k),
    kvSet: (k, v) => void kv.set(k, v),
    appendAudit: (e) => audit.push(e),
    audit,
  };
}

function makeService(organizationId?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-items-'));
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const store = memStore();
  const items = new VaultItems(store, broker, path.join(dir, 'state'), organizationId);
  return { items, broker, store, dir };
}

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 Appendix B vectors: ASCII secret "12345678901234567890",
  // SHA-1, 8 digits. Base32 of that secret:
  const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  it('matches the RFC test vectors (8 digits via otpauth URI)', () => {
    const uri = (t: number) => totpCode(`otpauth://totp/x?secret=${SEED}&digits=8`, t * 1000);
    expect(uri(59)).toBe('94287082');
    expect(uri(1111111109)).toBe('07081804');
    expect(uri(1234567890)).toBe('89005924');
    expect(uri(20000000000)).toBe('65353130');
  });
  it('rejects HOTP instead of silently generating a time-based code', () => {
    expect(() => totpCode(`otpauth://hotp/x?secret=${SEED}&counter=1`)).toThrow(/Only TOTP/);
  });
  it('defaults to 6 digits for a bare base32 seed', () => {
    expect(totpCode(SEED, 59 * 1000)).toBe('287082');
  });
});

describe('vault items: CRUD + write-only secrets', () => {
  it('stores metadata in kv and secrets in the vault, never echoing them', async () => {
    const { items, broker } = makeService();
    const saved = (await items.save({
      type: 'login',
      label: 'GitHub (alice)',
      domains: ['github.com'],
      username: 'alice',
      secrets: { password: 'hunter2', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' },
    }));
    expect(saved.fields.sort()).toEqual(['password', 'totp']);
    expect(JSON.stringify(saved)).not.toContain('hunter2');
    expect(broker.hasHandle(itemHandle(saved.id, 'password'))).toBe(true);
    // update without secrets keeps the stored ones
    const updated = (await items.save({ id: saved.id, type: 'login', label: 'GitHub — alice' }));
    expect(updated.fields.sort()).toEqual(['password', 'totp']);
    expect((await items.resolveField(updated, 'password', { mode: 'reveal' }))).toBe('hunter2');
    // delete removes the vault handles too
    (await items.delete(saved.id));
    expect((await items.get(saved.id))).toBeUndefined();
    expect(broker.hasHandle(itemHandle(saved.id, 'password'))).toBe(false);
  });

  it('computes a live TOTP code from the stored seed (never returning the seed)', async () => {
    const { items } = makeService();
    const item = (await items.save({ type: 'login', label: 'x', secrets: { totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } }));
    expect((await items.totp(item, {}))).toMatch(/^\d{6}$/);
  });
});

describe('vault usage frequency', () => {
  it('persists successful accesses without treating usage as an edit', async () => {
    const { items, store, broker, dir } = makeService();
    const item = (await items.save({ type: 'login', label: 'Login', secrets: { password: 'secret' } }));
    (await items.resolveField(item, 'password', { mode: 'use' }));
    (await items.resolveField(item, 'password', { mode: 'reveal' }));
    // Reusing the original object must not lose increments.
    expect((await items.get(item.id))).toMatchObject({ useCount: 2, updatedAt: item.updatedAt });
    expect((await items.save({ id: item.id, type: 'login', label: 'Renamed' })).useCount).toBe(2);
    const reopened = new VaultItems(store, broker, path.join(dir, 'state'));
    expect((await reopened.get(item.id))?.useCount).toBe(2);
    expect((await new VaultItems(store, broker, path.join(dir, 'state'), 'other').list())).toEqual([]);
  });

  it('counts legacy items from zero and excludes reads of metadata, internal reads, and failed accesses', async () => {
    const { items, store, broker } = makeService();
    const item = (await items.save({ type: 'login', label: 'Legacy', secrets: { password: 'secret' } }));
    delete item.useCount;
    delete item.frecencyScore;
    delete item.frecencyUpdatedAt;
    (await store.kvSet('vault:items:org_personal', JSON.stringify([item])));
    (await items.list());
    (await items.get(item.id));
    items.readSecret(item, 'password');
    await expect((async () => (await items.resolveField(item, 'totp', { mode: 'use' })))()).rejects.toThrow();
    expect((await items.get(item.id))?.useCount).toBe(0);
    (await items.resolveField(item, 'password', { mode: 'use' }));
    expect((await items.get(item.id))?.useCount).toBe(1);
    (await broker.deleteHandle(itemHandle(item.id, 'password')));
    await expect((async () => (await items.resolveField(item, 'password', { mode: 'use' })))()).rejects.toThrow();
    expect((await items.get(item.id))?.useCount).toBe(1);
  });
});

describe('vault frecency', () => {
  it('decays previous accesses, adds new ones, and preserves usage through edits', async () => {
    const clock = vi.spyOn(Date, 'now');
    try {
      const at = 1_800_000_000_000;
      clock.mockReturnValue(at);
      const { items } = makeService();
      const item = (await items.save({ type: 'login', label: 'Login', secrets: { password: 'secret' } }));
      (await items.resolveField(item, 'password', { mode: 'use' }));
      (await items.resolveField(item, 'password', { mode: 'use' }));
      clock.mockReturnValue(at + VAULT_USAGE_HALF_LIFE_MS);
      (await items.resolveField(item, 'password', { mode: 'reveal' }));
      const usage = { useCount: 3, frecencyScore: 2, frecencyUpdatedAt: Date.now(), lastUsedAt: Date.now() };
      expect((await items.get(item.id))).toMatchObject({ ...usage, updatedAt: at });
      expect((await items.save({ id: item.id, type: 'login', label: 'Renamed', secrets: { password: 'rotated' } })))
        .toMatchObject(usage);
    } finally { clock.mockRestore(); }
  });

  it('backfills all historical accesses once, isolates organizations, and does not double count the next access', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const store = (await Store.create(':memory:'));
    try {
      const { broker, dir } = makeService();
      const items = new VaultItems(store, broker, dir, 'one');
      const legacy = (await items.save({ type: 'login', label: 'Historical', secrets: { password: 'secret' } }));
      delete legacy.frecencyScore;
      delete legacy.frecencyUpdatedAt;
      legacy.useCount = 1; // Old tracking had only counted accesses since release.
      (await store.kvSet('vault:items:one', JSON.stringify([legacy])));
      // Cross the audit query's page boundary; denied requests never count.
      for (let i = 0; i < 1001; i++) (await store.appendAudit({ ts: Date.now() - VAULT_USAGE_HALF_LIFE_MS,
        principalId: 'system', action: 'vault.used', detail: { itemId: legacy.id } }));
      (await store.appendAudit({ principalId: 'system', action: 'vault.revealed', detail: { itemId: legacy.id } }));
      (await store.appendAudit({ principalId: 'system', action: 'vault.requested', detail: { itemId: legacy.id } }));
      (await store.appendAudit({ principalId: 'system', action: 'vault.used', detail: { itemId: 'other-org-item' } }));
      const history = vi.spyOn(store, 'vaultUsageHistory');
      // Resolve directly from a legacy object: migration must precede the new audit entry.
      (await items.resolveField(legacy, 'password', { mode: 'use' }));
      expect((await items.get(legacy.id))).toMatchObject({ useCount: 1003, frecencyScore: 502.5,
        lastUsedAt: Date.now(), updatedAt: legacy.updatedAt });
      const reopened = new VaultItems(store, broker, dir, 'one');
      expect((await reopened.list())[0]?.frecencyScore).toBe(502.5);
      expect(history).toHaveBeenCalledTimes(1);
      expect(history).toHaveBeenCalledWith([legacy.id], Date.now());
      expect((await new VaultItems(store, broker, dir, 'two').list())).toEqual([]);
      expect((await store.vaultUsageHistory([], Date.now()))).toEqual({});
    } finally { (await store.close()); clock.mockRestore(); }
  });
});

describe('organization isolation (tenant boundary)', () => {
  it('items and requests are scoped per organization', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-org-'));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const store = memStore(); // one shared store, two orgs
    const a = new VaultItems(store, broker, path.join(dir, 'state'), 'org_a');
    const b = new VaultItems(store, broker, path.join(dir, 'state'), 'org_b');
    const itemA = (await a.save({ type: 'login', label: 'A secret', secrets: { password: 'pa' } }));
    (await b.save({ type: 'login', label: 'B secret', secrets: { password: 'pb' } }));
    // neither org sees the other's items
    expect((await a.list()).map((i) => i.label)).toEqual(['A secret']);
    expect((await b.list()).map((i) => i.label)).toEqual(['B secret']);
    expect((await b.get(itemA.id))).toBeUndefined();
    // a parked request in org A is invisible to org B
    (await a.request({ taskId: 't1', caps: [], domain: 'x.com', mode: 'use', why: 'x' }));
    expect((await a.requests({ status: 'pending' }))).toHaveLength(1);
    expect((await b.requests({ status: 'pending' }))).toHaveLength(0);
  });
});

describe('grants + access policy (§§5–6)', () => {
  it('grants by item, tag, and domain wildcards', async () => {
    const { items } = makeService();
    const item = (await items.save({ type: 'login', label: 'gh', domains: ['github.com'], tags: ['staging'], secrets: { password: 'p' } }));
    expect(itemCaps(item)).toContain(`use-credential:item:${item.id}`);
    expect((await items.access([`use-credential:item:${item.id}`], 't1', item, 'use')).status).toBe('granted');
    expect((await items.access(['use-credential:tag:staging'], 't1', item, 'use')).status).toBe('granted');
    expect((await items.access(['use-credential:domain:github.com'], 't1', item, 'use')).status).toBe('granted');
    expect((await items.access(['use-credential:*'], 't1', item, 'use')).status).toBe('granted');
    expect((await items.access(['use-credential:item:other'], 't1', item, 'use')).status).toBe('needs_approval');
    expect((await items.access([], 't1', item, 'use')).status).toBe('needs_approval');
  });

  it('enforces per-item policy: use ask, reveal ask/never', async () => {
    const { items } = makeService();
    const item = (await items.save({ type: 'login', label: 'gh', policy: { use: 'ask', reveal: 'never' }, secrets: { password: 'p' } }));
    const caps = [`use-credential:item:${item.id}`];
    expect((await items.access(caps, 't1', item, 'use')).status).toBe('needs_approval');
    expect((await items.access(caps, 't1', item, 'reveal')).status).toBe('denied');
    (await items.setPolicy(item.id, { use: 'auto', reveal: 'ask' }));
    expect((await items.access(caps, 't1', (await items.get(item.id))!, 'use')).status).toBe('granted');
    expect((await items.access(caps, 't1', (await items.get(item.id))!, 'reveal')).status).toBe('needs_approval');
  });

  it('layers sparse policy overrides per task without changing organization defaults', async () => {
    const { items } = makeService();
    const item = (await items.save({
      type: 'login',
      label: 'gh',
      policy: { use: 'ask', reveal: 'never' },
      secrets: { password: 'p' },
    }));
    const caps = [`use-credential:item:${item.id}`];
    (await items.setTaskPolicies('t1', { [item.id]: { use: 'auto', reveal: 'ask' } }));

    expect((await items.effectivePolicy('t1', item))).toEqual({ use: 'auto', reveal: 'ask' });
    expect((await items.access(caps, 't1', item, 'use')).status).toBe('granted');
    expect((await items.access(caps, 't1', item, 'reveal')).status).toBe('needs_approval');
    expect((await items.access(caps, 't2', item, 'use')).status).toBe('needs_approval');
    expect((await items.access(caps, 't2', item, 'reveal')).status).toBe('denied');

    // Missing dimensions keep inheriting the live organization default.
    (await items.setTaskPolicies('t1', { [item.id]: { use: 'auto' } }));
    (await items.setPolicy(item.id, { reveal: 'auto' }));
    expect((await items.effectivePolicy('t1', (await items.get(item.id))!))).toEqual({ use: 'auto', reveal: 'auto' });
  });

  it('drops malformed persisted task policy values instead of weakening access', async () => {
    const { items, store } = makeService();
    const item = (await items.save({ type: 'login', label: 'gh', policy: { reveal: 'never' }, secrets: { password: 'p' } }));
    (await store.kvSet('vault:task-policy:t1', JSON.stringify({ [item.id]: { use: 'yes', reveal: 'always' } })));
    expect((await items.taskPolicies('t1'))).toEqual({});
    expect((await items.access([`use-credential:item:${item.id}`], 't1', item, 'reveal')).status).toBe('denied');
  });

  it('domain matching covers subdomains but not lookalikes', () => {
    expect(domainMatches('github.com', 'github.com')).toBe(true);
    expect(domainMatches('gist.github.com', 'github.com')).toBe(true);
    expect(domainMatches('evilgithub.com', 'github.com')).toBe(false);
  });
});

describe('the pull model: requests + human resolutions (§7)', () => {
  it('parks a not-in-vault request, binds it to a later-added item, and grants for the task', async () => {
    const { items } = makeService();
    const r = (await items.request({ taskId: 't1', caps: [], domain: 'github.com', mode: 'use', why: 'log in' }));
    expect(r.status).toBe('not_in_vault');
    expect((await items.requests({ status: 'pending' }))).toHaveLength(1);
    // duplicate asks dedupe onto the same pending request
    expect((await items.request({ taskId: 't1', caps: [], domain: 'github.com', mode: 'use', why: 'still' })).requestId).toBe(r.requestId);

    const item = (await items.save({ type: 'login', label: 'gh', domains: ['github.com'], secrets: { password: 'p' } }));
    // a grant action without a bound item is rejected
    await expect(items.resolve(r.requestId!, { action: 'task', by: 'user:alice' })).rejects.toThrow('bind this request');
    const resolved = (await items.resolve(r.requestId!, { action: 'task', by: 'user:alice', itemId: item.id }));
    expect(resolved.status).toBe('granted');
    // the task grant extension is durable and covers the item
    expect((await items.extensionCaps('t1'))).toContain(`use-credential:item:${item.id}`);
    expect((await items.access([], 't1', item, 'use')).status).toBe('granted');
    // other tasks gained nothing
    expect((await items.access([], 't2', item, 'use')).status).toBe('needs_approval');
  });

  it('"once" grants exactly one consumed use', async () => {
    const { items } = makeService();
    const item = (await items.save({ type: 'login', label: 'gh', domains: ['gh.com'], policy: { use: 'ask' }, secrets: { password: 'p' } }));
    const r = (await items.request({ taskId: 't1', caps: [`use-credential:item:${item.id}`], itemId: item.id, mode: 'use', why: 'x' }));
    expect(r.status).toBe('needs_approval');
    (await items.resolve(r.requestId!, { action: 'once', by: 'user:alice' }));
    expect((await items.access([], 't1', item, 'use', { consume: true })).status).toBe('granted');
    expect((await items.access([], 't1', item, 'use', { consume: true })).status).toBe('needs_approval');
  });

  it('"always" flips the item policy to auto for the requested mode', async () => {
    const { items } = makeService();
    const item = (await items.save({ type: 'login', label: 'gh', domains: ['gh.com'], policy: { use: 'ask' }, secrets: { password: 'p' } }));
    const r = (await items.request({ taskId: 't1', caps: [`use-credential:item:${item.id}`], itemId: item.id, mode: 'use', why: 'x' }));
    (await items.resolve(r.requestId!, { action: 'always', by: 'user:alice' }));
    expect((await items.get(item.id))!.policy.use).toBe('auto');
    // metadata (domains) survives the policy flip
    expect((await items.get(item.id))!.domains).toEqual(['gh.com']);
  });

  it('an item covered by the grant with auto policy needs no request at all', async () => {
    const { items } = makeService();
    const item = (await items.save({ type: 'login', label: 'gh', secrets: { password: 'p' } }));
    const r = (await items.request({ taskId: 't1', caps: [`use-credential:item:${item.id}`], itemId: item.id, mode: 'use', why: 'x' }));
    expect(r.status).toBe('granted');
    expect((await items.requests({ status: 'pending' }))).toHaveLength(0);
  });

  it('lets a task use its own credential while preserving the reveal policy', async () => {
    const { items } = makeService();
    const item = (await items.save({
      type: 'login',
      label: 'account created by t1',
      policy: { use: 'auto', reveal: 'ask' },
      secrets: { password: 'generated' },
      provenance: { source: 'task:t1', taskId: 't1' },
    }));
    expect((await items.access([], 't1', item, 'use')).status).toBe('granted');
    expect((await items.access([], 't1', item, 'reveal')).status).toBe('needs_approval');
    expect((await items.access([], 't2', item, 'use')).status).toBe('needs_approval');
  });

  it('a reset report always parks, even when the task is fully granted (the secret is wrong)', async () => {
    const { items } = makeService();
    const item = (await items.save({ type: 'login', label: 'gh', secrets: { password: 'stale' } }));
    const caps = [`use-credential:item:${item.id}`]; // covered + policy auto → access would be granted
    const r = (await items.request({ taskId: 't1', caps, itemId: item.id, kind: 'reset', why: 'site rejected the stored password' }));
    expect(r.status).toBe('needs_approval');
    const req = (await items.requests({ status: 'pending' }))[0]!;
    expect(req.kind).toBe('reset');
    // the human fixes the secret, then grants retry — the pass unblocks a re-fill
    (await items.save({ id: item.id, type: 'login', secrets: { password: 'fresh' } }));
    (await items.resolve(req.id, { action: 'once', by: 'user:alice' }));
    expect((await items.access(caps, 't1', (await items.get(item.id))!, 'use', { consume: true })).status).toBe('granted');
    expect((await items.resolveField((await items.get(item.id))!, 'password', { mode: 'reveal' }))).toBe('fresh');
  });

  it('denied requests do not grant and record the resolution', async () => {
    const { items } = makeService();
    const item = (await items.save({ type: 'login', label: 'gh', policy: { use: 'ask' }, secrets: { password: 'p' } }));
    const r = (await items.request({ taskId: 't1', caps: [`use-credential:item:${item.id}`], itemId: item.id, mode: 'use', why: 'x' }));
    const resolved = (await items.resolve(r.requestId!, { action: 'deny', by: 'user:alice' }));
    expect(resolved.status).toBe('denied');
    expect((await items.access([], 't1', item, 'use')).status).toBe('needs_approval');
  });
});

describe('spawn-time materialization (§5A)', () => {
  it('injects env bags, api keys under envVar, and ssh keys as 0600 files', async () => {
    const { items } = makeService();
    const caps = ['use-credential:*'];
    (await items.save({ type: 'env', label: 'proj env', secrets: { env: '# comment\nFOO=bar\nexport QUOTED="a b"\nbad line\n' } }));
    (await items.save({ type: 'api-key', label: 'openai', envVar: 'OPENAI_API_KEY', secrets: { secret: 'sk-123' } }));
    const ssh = (await items.save({ type: 'ssh-key', label: 'deploy', envVar: 'DEPLOY_KEY_FILE', secrets: { privateKey: 'PRIVATE' } }));
    // an `ask` item never injects ambiently
    (await items.save({ type: 'api-key', label: 'guarded', envVar: 'GUARDED', policy: { use: 'ask' }, secrets: { secret: 'nope' } }));

    const env = (await items.envFor('t1', caps));
    expect(env.FOO).toBe('bar');
    expect(env.QUOTED).toBe('a b');
    expect(env.OPENAI_API_KEY).toBe('sk-123');
    expect(env.GUARDED).toBeUndefined();
    expect(fs.readFileSync(env.DEPLOY_KEY_FILE!, 'utf8')).toBe('PRIVATE\n');
    expect(fs.statSync(env.DEPLOY_KEY_FILE!).mode & 0o777).toBe(0o600);
    expect(env.DEPLOY_KEY_FILE).toContain(ssh.id);
    // ungranted task gets nothing
    expect(Object.keys((await items.envFor('t2', [])))).toHaveLength(0);
  });

  it('a one-shot "once" approval never becomes standing env injection', async () => {
    const { items } = makeService();
    const item = (await items.save({ type: 'api-key', label: 'stripe', envVar: 'STRIPE_KEY', policy: { use: 'ask' }, secrets: { secret: 'sk-live' } }));
    // The task was never granted this credential, so it parks for a human…
    const asked = (await items.request({ taskId: 't1', caps: [], itemId: item.id, mode: 'use', why: 'charge once' }));
    expect(asked.status).toBe('needs_approval');
    // …who approves exactly one use. NOT `task`, which is the action that means
    // "for the rest of this task" and grants a durable capability extension.
    (await items.resolve(asked.requestId!, { action: 'once', by: 'user:alice', itemId: item.id }));

    // envFor runs on EVERY agent turn. It used to see the un-consumed one-shot pass
    // and inject the secret each time — for the task's whole life — turning a
    // deliberately single-use approval into a permanent ambient grant.
    expect((await items.envFor('t1', [])).STRIPE_KEY).toBeUndefined();
    expect((await items.envFor('t1', [])).STRIPE_KEY).toBeUndefined();
    // …and the pass is still intact for the one explicit use it was granted for.
    expect((await items.access([], 't1', item, 'use', { consume: true })).status).toBe('granted');
    expect((await items.access([], 't1', item, 'use', { consume: true })).status).toBe('needs_approval');
  });
});

describe('zero-exposure CDP fill (§5B)', () => {
  async function mockBrowser(origin: string) {
    const received: { method: string; params?: any }[] = [];
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        received.push(msg);
        let result: any = {};
        if (msg.method === 'Runtime.evaluate') {
          result = msg.params.expression === 'location.origin'
            ? { result: { value: origin } }
            : { result: { value: true } }; // selector focus succeeds
        }
        socket.send(JSON.stringify({ id: msg.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    server.on('request', (req, res) => {
      if (req.url === '/json/list') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([{ type: 'page', url: origin + '/login', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/page` }]));
      } else res.writeHead(404).end();
    });
    return { port, received, close: () => new Promise((r) => { wss.close(); server.close(r); }) };
  }

  it('types the secret into the page and never returns it', async () => {
    const b = await mockBrowser('https://github.com');
    try {
      const out = await fillViaCdp({ cdpUrl: `http://127.0.0.1:${b.port}`, selector: '#password', text: 's3cret', expectDomains: ['github.com'] });
      expect(out.origin).toBe('https://github.com');
      const insert = b.received.find((m) => m.method === 'Input.insertText');
      expect(insert?.params?.text).toBe('s3cret');
      expect(JSON.stringify(out)).not.toContain('s3cret');
    } finally {
      await b.close();
    }
  });

  it('refuses to fill when the page origin does not match the item domains', async () => {
    const b = await mockBrowser('https://evil.com');
    let resolved = false;
    try {
      // the target list claims evil.com too, so selection fails the domain filter
      await expect(fillViaCdp({ cdpUrl: `http://127.0.0.1:${b.port}`, selector: '#password',
        resolveText: () => { resolved = true; return 's3cret'; }, expectDomains: ['github.com'] }))
        .rejects.toThrow(/no open page matches/);
      expect(resolved).toBe(false);
      expect(b.received.find((m) => m.method === 'Input.insertText')).toBeUndefined();
    } finally {
      await b.close();
    }
  });

  it('re-verifies the live origin over CDP even when the target list lies', async () => {
    // Target list says github.com but the live page evaluates to evil.com.
    const received: any[] = [];
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        received.push(msg);
        const result = msg.method === 'Runtime.evaluate' && msg.params.expression === 'location.origin'
          ? { result: { value: 'https://evil.com' } }
          : { result: { value: true } };
        socket.send(JSON.stringify({ id: msg.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    server.on('request', (req, res) => {
      if (req.url === '/json/list') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([{ type: 'page', url: 'https://github.com/login', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/page` }]));
      } else res.writeHead(404).end();
    });
    try {
      await expect(fillViaCdp({ cdpUrl: `http://127.0.0.1:${port}`, selector: '#password', text: 's3cret', expectDomains: ['github.com'] }))
        .rejects.toThrow(/does not match/);
      expect(received.find((m) => m.method === 'Input.insertText')).toBeUndefined();
    } finally {
      await new Promise((r) => { wss.close(); server.close(r); });
    }
  });

  it('rejects non-loopback endpoints', async () => {
    await expect(fillViaCdp({ cdpUrl: 'http://example.com:9222', selector: 'x', text: 'y' })).rejects.toThrow(/loopback/);
  });

  it('explains how to recover when the browser has no reachable CDP endpoint', async () => {
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await expect(fillViaCdp({
      cdpUrl: `http://127.0.0.1:${port}`,
      selector: '#password',
      text: 's3cret',
    })).rejects.toThrow(/tavya-managed chrome-devtools browser.*cdpUrl/);
  });
});

// RFC 6238 Appendix B: independently published SHA-256 and SHA-512 vectors.
it('matches RFC 6238 SHA-256/SHA-512 vectors and a custom time step', () => {
  const encode = (text: string) => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0; let value = 0; let out = '';
    for (const byte of Buffer.from(text)) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; out += alphabet[(value >>> bits) & 31]; } }
    if (bits) out += alphabet[(value << (5 - bits)) & 31];
    return out;
  };
  const seeds = { SHA256: encode('12345678901234567890123456789012'), SHA512: encode('1234567890123456789012345678901234567890123456789012345678901234') };
  for (const [time, sha256, sha512] of [[59, '46119246', '90693936'], [1111111109, '68084774', '25091201'], [20000000000, '77737706', '47863826']] as const) {
    expect(totpCode(`otpauth://totp/test?secret=${seeds.SHA256}&algorithm=SHA256&digits=8`, time * 1000)).toBe(sha256);
    expect(totpCode(`otpauth://totp/test?secret=${seeds.SHA512}&algorithm=SHA512&digits=8`, time * 1000)).toBe(sha512);
  }
  const seed = encode('12345678901234567890');
  expect(totpCode(`otpauth://totp/test?secret=${seed}&period=60&digits=8`, 119000)).toBe('94287082');
});

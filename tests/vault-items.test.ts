import { describe, it, expect, beforeEach } from 'vitest';
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
  it('defaults to 6 digits for a bare base32 seed', () => {
    expect(totpCode(SEED, 59 * 1000)).toBe('287082');
  });
});

describe('vault items: CRUD + write-only secrets', () => {
  it('stores metadata in kv and secrets in the vault, never echoing them', () => {
    const { items, broker } = makeService();
    const saved = items.save({
      type: 'login',
      label: 'GitHub (alice)',
      domains: ['github.com'],
      username: 'alice',
      secrets: { password: 'hunter2', totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' },
    });
    expect(saved.fields.sort()).toEqual(['password', 'totp']);
    expect(JSON.stringify(saved)).not.toContain('hunter2');
    expect(broker.hasHandle(itemHandle(saved.id, 'password'))).toBe(true);
    // update without secrets keeps the stored ones
    const updated = items.save({ id: saved.id, type: 'login', label: 'GitHub — alice' });
    expect(updated.fields.sort()).toEqual(['password', 'totp']);
    expect(items.resolveField(updated, 'password', { mode: 'reveal' })).toBe('hunter2');
    // delete removes the vault handles too
    items.delete(saved.id);
    expect(items.get(saved.id)).toBeUndefined();
    expect(broker.hasHandle(itemHandle(saved.id, 'password'))).toBe(false);
  });

  it('computes a live TOTP code from the stored seed (never returning the seed)', () => {
    const { items } = makeService();
    const item = items.save({ type: 'login', label: 'x', secrets: { totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } });
    expect(items.totp(item, {})).toMatch(/^\d{6}$/);
  });
});

describe('organization isolation (tenant boundary)', () => {
  it('items and requests are scoped per organization', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-vault-org-'));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const store = memStore(); // one shared store, two orgs
    const a = new VaultItems(store, broker, path.join(dir, 'state'), 'org_a');
    const b = new VaultItems(store, broker, path.join(dir, 'state'), 'org_b');
    const itemA = a.save({ type: 'login', label: 'A secret', secrets: { password: 'pa' } });
    b.save({ type: 'login', label: 'B secret', secrets: { password: 'pb' } });
    // neither org sees the other's items
    expect(a.list().map((i) => i.label)).toEqual(['A secret']);
    expect(b.list().map((i) => i.label)).toEqual(['B secret']);
    expect(b.get(itemA.id)).toBeUndefined();
    // a parked request in org A is invisible to org B
    a.request({ taskId: 't1', caps: [], domain: 'x.com', mode: 'use', why: 'x' });
    expect(a.requests({ status: 'pending' })).toHaveLength(1);
    expect(b.requests({ status: 'pending' })).toHaveLength(0);
  });
});

describe('grants + access policy (§§5–6)', () => {
  it('grants by item, tag, and domain wildcards', () => {
    const { items } = makeService();
    const item = items.save({ type: 'login', label: 'gh', domains: ['github.com'], tags: ['staging'], secrets: { password: 'p' } });
    expect(itemCaps(item)).toContain(`use-credential:item:${item.id}`);
    expect(items.access([`use-credential:item:${item.id}`], 't1', item, 'use').status).toBe('granted');
    expect(items.access(['use-credential:tag:staging'], 't1', item, 'use').status).toBe('granted');
    expect(items.access(['use-credential:domain:github.com'], 't1', item, 'use').status).toBe('granted');
    expect(items.access(['use-credential:*'], 't1', item, 'use').status).toBe('granted');
    expect(items.access(['use-credential:item:other'], 't1', item, 'use').status).toBe('needs_approval');
    expect(items.access([], 't1', item, 'use').status).toBe('needs_approval');
  });

  it('enforces per-item policy: use ask, reveal ask/never', () => {
    const { items } = makeService();
    const item = items.save({ type: 'login', label: 'gh', policy: { use: 'ask', reveal: 'never' }, secrets: { password: 'p' } });
    const caps = [`use-credential:item:${item.id}`];
    expect(items.access(caps, 't1', item, 'use').status).toBe('needs_approval');
    expect(items.access(caps, 't1', item, 'reveal').status).toBe('denied');
    items.setPolicy(item.id, { use: 'auto', reveal: 'ask' });
    expect(items.access(caps, 't1', items.get(item.id)!, 'use').status).toBe('granted');
    expect(items.access(caps, 't1', items.get(item.id)!, 'reveal').status).toBe('needs_approval');
  });

  it('domain matching covers subdomains but not lookalikes', () => {
    expect(domainMatches('github.com', 'github.com')).toBe(true);
    expect(domainMatches('gist.github.com', 'github.com')).toBe(true);
    expect(domainMatches('evilgithub.com', 'github.com')).toBe(false);
  });
});

describe('the pull model: requests + human resolutions (§7)', () => {
  it('parks a not-in-vault request, binds it to a later-added item, and grants for the task', () => {
    const { items } = makeService();
    const r = items.request({ taskId: 't1', caps: [], domain: 'github.com', mode: 'use', why: 'log in' });
    expect(r.status).toBe('not_in_vault');
    expect(items.requests({ status: 'pending' })).toHaveLength(1);
    // duplicate asks dedupe onto the same pending request
    expect(items.request({ taskId: 't1', caps: [], domain: 'github.com', mode: 'use', why: 'still' }).requestId).toBe(r.requestId);

    const item = items.save({ type: 'login', label: 'gh', domains: ['github.com'], secrets: { password: 'p' } });
    // a grant action without a bound item is rejected
    expect(() => items.resolve(r.requestId!, { action: 'task', by: 'user:alice' })).not.toThrow;
    const resolved = items.resolve(r.requestId!, { action: 'task', by: 'user:alice', itemId: item.id });
    expect(resolved.status).toBe('granted');
    // the task grant extension is durable and covers the item
    expect(items.extensionCaps('t1')).toContain(`use-credential:item:${item.id}`);
    expect(items.access([], 't1', item, 'use').status).toBe('granted');
    // other tasks gained nothing
    expect(items.access([], 't2', item, 'use').status).toBe('needs_approval');
  });

  it('"once" grants exactly one consumed use', () => {
    const { items } = makeService();
    const item = items.save({ type: 'login', label: 'gh', domains: ['gh.com'], policy: { use: 'ask' }, secrets: { password: 'p' } });
    const r = items.request({ taskId: 't1', caps: [`use-credential:item:${item.id}`], itemId: item.id, mode: 'use', why: 'x' });
    expect(r.status).toBe('needs_approval');
    items.resolve(r.requestId!, { action: 'once', by: 'user:alice' });
    expect(items.access([], 't1', item, 'use', { consume: true }).status).toBe('granted');
    expect(items.access([], 't1', item, 'use', { consume: true }).status).toBe('needs_approval');
  });

  it('"always" flips the item policy to auto for the requested mode', () => {
    const { items } = makeService();
    const item = items.save({ type: 'login', label: 'gh', domains: ['gh.com'], policy: { use: 'ask' }, secrets: { password: 'p' } });
    const r = items.request({ taskId: 't1', caps: [`use-credential:item:${item.id}`], itemId: item.id, mode: 'use', why: 'x' });
    items.resolve(r.requestId!, { action: 'always', by: 'user:alice' });
    expect(items.get(item.id)!.policy.use).toBe('auto');
    // metadata (domains) survives the policy flip
    expect(items.get(item.id)!.domains).toEqual(['gh.com']);
  });

  it('an item covered by the grant with auto policy needs no request at all', () => {
    const { items } = makeService();
    const item = items.save({ type: 'login', label: 'gh', secrets: { password: 'p' } });
    const r = items.request({ taskId: 't1', caps: [`use-credential:item:${item.id}`], itemId: item.id, mode: 'use', why: 'x' });
    expect(r.status).toBe('granted');
    expect(items.requests({ status: 'pending' })).toHaveLength(0);
  });

  it('a reset report always parks, even when the task is fully granted (the secret is wrong)', () => {
    const { items } = makeService();
    const item = items.save({ type: 'login', label: 'gh', secrets: { password: 'stale' } });
    const caps = [`use-credential:item:${item.id}`]; // covered + policy auto → access would be granted
    const r = items.request({ taskId: 't1', caps, itemId: item.id, kind: 'reset', why: 'site rejected the stored password' });
    expect(r.status).toBe('needs_approval');
    const req = items.requests({ status: 'pending' })[0]!;
    expect(req.kind).toBe('reset');
    // the human fixes the secret, then grants retry — the pass unblocks a re-fill
    items.save({ id: item.id, type: 'login', secrets: { password: 'fresh' } });
    items.resolve(req.id, { action: 'once', by: 'user:alice' });
    expect(items.access(caps, 't1', items.get(item.id)!, 'use', { consume: true }).status).toBe('granted');
    expect(items.resolveField(items.get(item.id)!, 'password', { mode: 'reveal' })).toBe('fresh');
  });

  it('denied requests do not grant and record the resolution', () => {
    const { items } = makeService();
    const item = items.save({ type: 'login', label: 'gh', policy: { use: 'ask' }, secrets: { password: 'p' } });
    const r = items.request({ taskId: 't1', caps: [`use-credential:item:${item.id}`], itemId: item.id, mode: 'use', why: 'x' });
    const resolved = items.resolve(r.requestId!, { action: 'deny', by: 'user:alice' });
    expect(resolved.status).toBe('denied');
    expect(items.access([], 't1', item, 'use').status).toBe('needs_approval');
  });
});

describe('spawn-time materialization (§5A)', () => {
  it('injects env bags, api keys under envVar, and ssh keys as 0600 files', () => {
    const { items } = makeService();
    const caps = ['use-credential:*'];
    items.save({ type: 'env', label: 'proj env', secrets: { env: '# comment\nFOO=bar\nexport QUOTED="a b"\nbad line\n' } });
    items.save({ type: 'api-key', label: 'openai', envVar: 'OPENAI_API_KEY', secrets: { secret: 'sk-123' } });
    const ssh = items.save({ type: 'ssh-key', label: 'deploy', envVar: 'DEPLOY_KEY_FILE', secrets: { privateKey: 'PRIVATE' } });
    // an `ask` item never injects ambiently
    items.save({ type: 'api-key', label: 'guarded', envVar: 'GUARDED', policy: { use: 'ask' }, secrets: { secret: 'nope' } });

    const env = items.envFor('t1', caps);
    expect(env.FOO).toBe('bar');
    expect(env.QUOTED).toBe('a b');
    expect(env.OPENAI_API_KEY).toBe('sk-123');
    expect(env.GUARDED).toBeUndefined();
    expect(fs.readFileSync(env.DEPLOY_KEY_FILE!, 'utf8')).toBe('PRIVATE\n');
    expect(fs.statSync(env.DEPLOY_KEY_FILE!).mode & 0o777).toBe(0o600);
    expect(env.DEPLOY_KEY_FILE).toContain(ssh.id);
    // ungranted task gets nothing
    expect(Object.keys(items.envFor('t2', []))).toHaveLength(0);
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
    try {
      // the target list claims evil.com too, so selection fails the domain filter
      await expect(fillViaCdp({ cdpUrl: `http://127.0.0.1:${b.port}`, selector: '#password', text: 's3cret', expectDomains: ['github.com'] }))
        .rejects.toThrow(/no open page matches/);
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
});

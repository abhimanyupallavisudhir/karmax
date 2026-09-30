import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { PasskeyManager } from '../src/autonomy/passkey.js';
import { openWorldPage } from '../src/autonomy/world-fill.js';
import { openSpawnedPty } from '../src/world/local-execution.js';
import type { World } from '../src/world/types.js';

/** A mock Chromium exposing the CDP WebAuthn domain for one page on github.com. */
async function mockBrowser(origin = 'https://github.com', listed = origin) {
  const state = { authenticators: new Set<string>(), credentials: [] as any[], calls: [] as any[] };
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      state.calls.push(msg);
      let result: any = {};
      if (msg.method === 'Runtime.evaluate') result = { result: { value: origin } };
      else if (msg.method === 'WebAuthn.addVirtualAuthenticator') { const id = `auth-${state.authenticators.size + 1}`; state.authenticators.add(id); result = { authenticatorId: id }; }
      else if (msg.method === 'WebAuthn.addCredential') state.credentials.push(msg.params.credential);
      else if (msg.method === 'WebAuthn.getCredentials') result = { credentials: [{ credentialId: 'cred1', rpId: 'github.com', privateKey: 'PEMKEY', isResidentCredential: true, signCount: 4 }] };
      socket.send(JSON.stringify({ id: msg.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  server.on('request', (req, res) => {
    if (req.url === '/json/list') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ type: 'page', url: listed + '/settings/security', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/page` }]));
    } else res.writeHead(404).end();
  });
  return { port, state, close: () => new Promise((r) => { wss.close(); server.close(r); }) };
}

describe('agent-enrolled passkeys over CDP (§8)', () => {
  it('enroll: preps an authenticator, harvests the created credential, releases the session', async () => {
    const b = await mockBrowser();
    const mgr = new PasskeyManager();
    try {
      const { authenticatorId, origin } = await mgr.begin(`http://127.0.0.1:${b.port}`, { expectDomains: ['github.com'], mode: 'enroll', owner: 'org:a:task:a' });
      expect(origin).toBe('https://github.com');
      expect(authenticatorId).toBeTruthy();
      expect(b.state.authenticators.size).toBe(1);
      // presence simulation is enabled so a headless enroll succeeds
      const addCall = b.state.calls.find((c) => c.method === 'WebAuthn.addVirtualAuthenticator');
      expect(addCall.params.options.automaticPresenceSimulation).toBe(true);

      await expect(mgr.harvest(authenticatorId, 'org:b:task:b')).rejects.toThrow(/owner/);
      await expect(mgr.release(authenticatorId, 'org:b:task:b')).rejects.toThrow(/owner/);
      const creds = await mgr.harvest(authenticatorId, 'org:a:task:a');
      expect(creds).toHaveLength(1);
      expect(creds[0]!.privateKey).toBe('PEMKEY');
      // released → a second harvest fails
      await expect(mgr.harvest(authenticatorId, 'org:a:task:a')).rejects.toThrow(/no held/);
    } finally {
      await b.close();
    }
  });

  it('login: loads a stored credential into a fresh authenticator', async () => {
    const b = await mockBrowser();
    const mgr = new PasskeyManager();
    try {
      const cred = { credentialId: 'cred1', rpId: 'github.com', privateKey: 'PEMKEY' };
      let persisted: any;
      const { authenticatorId } = await mgr.begin(`http://127.0.0.1:${b.port}`, { expectDomains: ['github.com'], mode: 'login', owner: 'org:a:task:a', credential: cred, onCredentials: async value => { persisted = value; } });
      expect(b.state.credentials[0]).toEqual(cred);
      await expect(mgr.harvest(authenticatorId, 'org:a:task:a')).rejects.toThrow(/enrollment/);
      (await mgr.release(authenticatorId, 'org:a:task:a'));
      expect(persisted[0].signCount).toBe(4);
    } finally {
      await b.close();
    }
  });

  // #367 review item 16: each held session keeps a browser session (and, in a
  // remote world, a terminal and the world) open, so there are only so many.
  it('holds only a few sessions per task and overall', async () => {
    const b = await mockBrowser();
    const mgr = new PasskeyManager(180_000, { perOwner: 2, total: 3 });
    let opened = 0;
    const open = `http://127.0.0.1:${b.port}`;
    const counted = async (domains: string[]) => { opened++; return (await import('../src/autonomy/cdp.js')).openPage(open, { expectDomains: domains }); };
    const held: Array<[string, string]> = [];
    const begin = async (owner: string) => {
      const { authenticatorId } = await mgr.begin(counted, { expectDomains: ['github.com'], mode: 'enroll', owner });
      held.push([authenticatorId, owner]);
    };
    try {
      await begin('task:a');
      await begin('task:a');
      await expect(begin('task:a')).rejects.toThrow(/2 passkey sessions open/);
      await begin('task:b');
      await expect(begin('task:c')).rejects.toThrow(/too many passkey sessions/);
      expect(opened).toBe(3);
      await mgr.release(...held.shift()!);
      await begin('task:c');
    } finally {
      for (const [id, owner] of held) await mgr.release(id, owner);
      await b.close();
    }
  });

  it('holds the cap against parallel requests', async () => {
    const b = await mockBrowser();
    const mgr = new PasskeyManager(180_000, { perOwner: 1, total: 64 });
    const url = `http://127.0.0.1:${b.port}`;
    const slow = async (domains: string[]) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return (await import('../src/autonomy/cdp.js')).openPage(url, { expectDomains: domains });
    };
    try {
      const results = await Promise.allSettled([1, 2, 3].map(() => mgr.begin(slow, { expectDomains: ['github.com'], mode: 'enroll', owner: 'task:a' })));
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) if (result.status === 'fulfilled') await mgr.release(result.value.authenticatorId, 'task:a');
    } finally {
      await b.close();
    }
  });

  it('refuses enrollment when the page origin does not match the target domain', async () => {
    const b = await mockBrowser('https://evil.com');
    const mgr = new PasskeyManager();
    try {
      await expect(mgr.begin(`http://127.0.0.1:${b.port}`, { expectDomains: ['github.com'], mode: 'enroll', owner: 'org:a:task:a' })).rejects.toThrow(/no open page matches/);
      expect(b.state.authenticators.size).toBe(0);
    } finally {
      await b.close();
    }
  });
});

// AU-12: a remote world's browser is reached through a world terminal. The
// fake worlds run the bridge in a real PTY: E2B and Daytona type the command
// into an interactive shell (which echoes it), containers run it directly.
describe('passkeys in a remote world’s browser', () => {
  const world = (root: string, typed: boolean): World => ({
    handle: { kind: 'e2b', id: 'task', root, branch: 'b', base: 'main' },
    writeFile: async (rel: string, content: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), content); },
    openPty: async (spec: any) => {
      if (!typed) return openSpawnedPty('bash', ['-lc', spec.command]);
      const pty = await openSpawnedPty('bash', ['--norc', '-i']);
      await pty.write(`${spec.command}\n`);
      return pty;
    },
  }) as any;

  it.each([['typed into a shell', true], ['run directly', false]] as const)('enrolls and logs in over the bridge (%s)', async (_name, typed) => {
    const b = await mockBrowser();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-world-passkey-'));
    const mgr = new PasskeyManager();
    let closed = 0;
    const open = (domains: string[]) => openWorldPage(world(root, typed), { expectDomains: domains, cdpUrl: `http://127.0.0.1:${b.port}`, onClose: () => { closed++; } });
    try {
      const enrolled = await mgr.begin(open, { expectDomains: ['github.com'], mode: 'enroll', owner: 'org:a:task:a' });
      expect(enrolled.origin).toBe('https://github.com');
      expect((await mgr.harvest(enrolled.authenticatorId, 'org:a:task:a'))[0]).toMatchObject({ credentialId: 'cred1', privateKey: 'PEMKEY' });
      expect(b.state.calls.map((c) => c.method)).toEqual(['Runtime.evaluate', 'WebAuthn.enable', 'WebAuthn.addVirtualAuthenticator',
        'WebAuthn.getCredentials', 'WebAuthn.removeVirtualAuthenticator']);
      expect(closed).toBe(1);

      const credential = { credentialId: 'cred1', rpId: 'github.com', privateKey: 'P'.repeat(5000) };
      let persisted: any;
      const login = await mgr.begin(open, { expectDomains: ['github.com'], mode: 'login', owner: 'org:a:task:a', credential, onCredentials: async (value) => { persisted = value; } });
      expect(b.state.credentials[0]).toEqual(credential);
      await mgr.release(login.authenticatorId, 'org:a:task:a');
      expect(persisted[0].signCount).toBe(4);
      expect(closed).toBe(2);
    } finally {
      await b.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // The domains are typed into a shell in some worlds: a control character or
  // newline there could run a command, so only host names get that far.
  it('types only host names into the world terminal', async () => {
    let terminals = 0;
    const world = { handle: { kind: 'e2b', id: 'task', root: '/tmp', branch: 'b', base: 'main' },
      writeFile: async () => {}, openPty: async () => { terminals++; throw new Error('opened'); } } as any;
    for (const domain of ["github.com'\x03\nrm -rf ~\n", 'github.com com', '-github.com', 'a..b'])
      await expect(openWorldPage(world, { expectDomains: [domain], cdpUrl: 'http://127.0.0.1:9222' })).rejects.toThrow(/not a host name/);
    expect(terminals).toBe(0);
    await expect(openWorldPage(world, { expectDomains: ['login.github.com', 'localhost'], cdpUrl: 'http://127.0.0.1:9222' })).rejects.toThrow('opened');
  });

  it('checks the live origin, not the target list', async () => {
    const b = await mockBrowser('https://evil.com', 'https://github.com');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-world-passkey-'));
    let closed = 0;
    try {
      await expect(new PasskeyManager().begin((domains) => openWorldPage(world(root, true), { expectDomains: domains, cdpUrl: `http://127.0.0.1:${b.port}`, onClose: () => { closed++; } }),
        { expectDomains: ['github.com'], mode: 'enroll', owner: 'org:a:task:a' })).rejects.toThrow(/does not match/);
      expect(b.state.authenticators.size).toBe(0);
      expect(closed).toBe(1);
      await expect(openWorldPage(world(root, true), { expectDomains: ['gitlab.com'], cdpUrl: `http://127.0.0.1:${b.port}` })).rejects.toThrow(/no open page matches gitlab.com/);
    } finally {
      await b.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

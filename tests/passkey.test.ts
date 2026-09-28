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

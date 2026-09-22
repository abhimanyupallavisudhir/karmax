import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { PasskeyManager } from '../src/autonomy/passkey.js';

/** A mock Chromium exposing the CDP WebAuthn domain for one page on github.com. */
async function mockBrowser(origin = 'https://github.com') {
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
      else if (msg.method === 'WebAuthn.getCredentials') result = { credentials: [{ credentialId: 'cred1', rpId: 'github.com', privateKey: 'PEMKEY', isResidentCredential: true, signCount: 0 }] };
      socket.send(JSON.stringify({ id: msg.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  server.on('request', (req, res) => {
    if (req.url === '/json/list') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ type: 'page', url: origin + '/settings/security', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/page` }]));
    } else res.writeHead(404).end();
  });
  return { port, state, close: () => new Promise((r) => { wss.close(); server.close(r); }) };
}

describe('agent-enrolled passkeys over CDP (§8)', () => {
  it('enroll: preps an authenticator, harvests the created credential, releases the session', async () => {
    const b = await mockBrowser();
    const mgr = new PasskeyManager();
    try {
      const { authenticatorId, origin } = await mgr.begin(`http://127.0.0.1:${b.port}`, { expectDomains: ['github.com'], mode: 'enroll' });
      expect(origin).toBe('https://github.com');
      expect(authenticatorId).toBeTruthy();
      expect(b.state.authenticators.has(authenticatorId)).toBe(true);
      // presence simulation is enabled so a headless enroll succeeds
      const addCall = b.state.calls.find((c) => c.method === 'WebAuthn.addVirtualAuthenticator');
      expect(addCall.params.options.automaticPresenceSimulation).toBe(true);

      const creds = await mgr.harvest(authenticatorId);
      expect(creds).toHaveLength(1);
      expect(creds[0]!.privateKey).toBe('PEMKEY');
      // released → a second harvest fails
      await expect(mgr.harvest(authenticatorId)).rejects.toThrow(/no held/);
    } finally {
      await b.close();
    }
  });

  it('login: loads a stored credential into a fresh authenticator', async () => {
    const b = await mockBrowser();
    const mgr = new PasskeyManager();
    try {
      const cred = { credentialId: 'cred1', rpId: 'github.com', privateKey: 'PEMKEY' };
      const { authenticatorId } = await mgr.begin(`http://127.0.0.1:${b.port}`, { expectDomains: ['github.com'], mode: 'login', credential: cred });
      expect(b.state.credentials[0]).toEqual(cred);
      (await mgr.release(authenticatorId));
    } finally {
      await b.close();
    }
  });

  it('refuses enrollment when the page origin does not match the target domain', async () => {
    const b = await mockBrowser('https://evil.com');
    const mgr = new PasskeyManager();
    try {
      await expect(mgr.begin(`http://127.0.0.1:${b.port}`, { expectDomains: ['github.com'], mode: 'enroll' })).rejects.toThrow(/no open page matches/);
      expect(b.state.authenticators.size).toBe(0);
    } finally {
      await b.close();
    }
  });
});

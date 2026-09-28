import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { assertLoopback, connect, listPages } from '../src/autonomy/cdp.js';
import { connectorOutboxKey, deleteItemConnectorWrites, readConnectorWrites } from '../src/autonomy/connector-writes.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';

// AU-37: security guards in autonomy that no test pinned down.

describe('CDP stays on loopback', () => {
  it('refuses a non-loopback DevTools endpoint', async () => {
    for (const url of ['http://example.com:9222', 'https://127.0.0.1:9222', 'http://10.0.0.1:9222', 'file:///etc/passwd'])
      expect(() => assertLoopback(url)).toThrow(/loopback/);
    await expect(listPages('http://169.254.169.254:80')).rejects.toThrow(/loopback/);
    expect(assertLoopback('http://127.0.0.1:9222').port).toBe('9222');
  });

  // The page list comes from inside the world; a forged one must not steer
  // the gateway into connecting anywhere else (SSRF).
  it('re-pins a listed page’s WebSocket to loopback', async () => {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ type: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://attacker.example:9222/devtools/page/1' }]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const [page] = await listPages(`http://127.0.0.1:${(server.address() as any).port}`);
      await expect(connect(page!.webSocketDebuggerUrl!)).rejects.toThrow(/loopback ws endpoint/);
      await expect(connect('wss://10.0.0.2/devtools')).rejects.toThrow(/loopback ws endpoint/);
    } finally { server.close(); }
  });
});

describe('deleting a vault item', () => {
  it('drops its queued write-backs and their encrypted copies, and only its own', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-outbox-'));
    try {
      const kv = new Map<string, string>();
      const store = { kvGet: (key: string) => kv.get(key), kvSet: (key: string, value: string) => void kv.set(key, value) };
      const broker = new CredentialBroker(new Vault(path.join(home, 'vault')));
      await broker.registerHandle('outbox:gone', 'pending secret');
      await broker.registerHandle('outbox:shared', 'shared secret');
      await broker.registerHandle('outbox:kept', 'other secret');
      const write = (id: string, itemId: string, snapshotHandle: string) => ({ id, connector: 'pass-git', itemId, externalId: id, target: 't', snapshotHandle, attempts: 0, nextAttemptAt: 0 });
      store.kvSet(connectorOutboxKey('org'), JSON.stringify([write('a', 'gone', 'outbox:gone'), write('b', 'gone', 'outbox:shared'),
        write('c', 'other', 'outbox:shared'), write('d', 'other', 'outbox:kept')]));
      await deleteItemConnectorWrites(store, broker, 'org', 'gone');
      expect((await readConnectorWrites(store, 'org')).map((w) => w.id)).toEqual(['c', 'd']);
      expect(broker.hasHandle('outbox:gone')).toBe(false);
      // A copy another pending write still needs is kept.
      expect(broker.hasHandle('outbox:shared')).toBe(true);
      expect(broker.hasHandle('outbox:kept')).toBe(true);
      // A pass write-back already in flight for the item is superseded.
      expect(JSON.parse(kv.get('pass-writeback:org:gone')!).fields).toEqual({});
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

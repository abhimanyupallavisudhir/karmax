import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretScrubber, secretForms } from '../src/agent/activity.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { TaskSecrets, cardRef, recordSecretRefs, secretValues, taskRef } from '../src/autonomy/task-secrets.js';
import { McpConnections } from '../src/mcp/connections/store.js';
import { Store } from '../src/store/db.js';
import { ExecutionOutput } from '../src/gateway/execution-output.js';
import { publishLocalCodexHistory, readLocalCodexHistory } from '../src/agent/codex-history-files.js';
import { createCodexConversationExport, readCodexConversationExport } from '../src/store/conversation-exports.js';
import { LocalObjectStore } from '../src/store/objects.js';

/**
 * SS-3: a value a task receives while it runs — a revealed vault item, an MCP
 * access token written into its world, a filled card — must be scrubbed from
 * everything tavya keeps or serves about the task, by whichever process writes
 * or serves it. These are the building blocks; tests/secret-scrub.test.ts
 * drives every sink end to end.
 */
const directories: string[] = [];
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-task-secrets-')); directories.push(dir); return dir; };
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('the scrubber', () => {
  const secret = 'Zq9/kW+Lm"p\\T=reveal';

  it('scrubs a value raw, JSON-escaped once and twice, and URL-encoded', () => {
    const scrubber = new SecretScrubber();
    scrubber.add(secret);
    const once = JSON.stringify({ value: secret });
    for (const text of [`key ${secret} end`, once, JSON.stringify({ line: once }),
      `https://example.com/?key=${encodeURIComponent(secret)}&x=1`, `a=${encodeURIComponent(secret).replace(/%20/g, '+')}`]) {
      const scrubbed = scrubber.scrub(text);
      expect(scrubbed, text).toContain('[redacted]');
      expect(scrubbed).not.toContain(secret);
    }
  });

  it('scrubs a value base64-encoded at every byte alignment inside a longer payload', () => {
    const scrubber = new SecretScrubber();
    scrubber.add(secret);
    for (let lead = 0; lead < 6; lead++) {
      const payload = Buffer.from(`${'u'.repeat(lead)}:${secret}:trailing`);
      for (const encoded of [payload.toString('base64'), payload.toString('base64url')]) {
        const scrubbed = scrubber.scrub(`Authorization: Basic ${encoded}`);
        expect(scrubbed, `lead ${lead}`).toContain('[redacted]');
        expect(Buffer.from(scrubbed.slice(21), 'base64').toString('latin1')).not.toContain(secret);
      }
    }
  });

  it('keeps the minimum length, so short values never mangle output', () => {
    const scrubber = new SecretScrubber();
    scrubber.add('1234567', 'true');
    expect(scrubber.size).toBe(0);
    expect(scrubber.scrub('true 1234567')).toBe('true 1234567');
    expect(secretForms('abcdefgh').every((form) => form.length >= 8)).toBe(true);
  });

  it('scrubs inside JSON data without changing its shape', () => {
    const scrubber = new SecretScrubber();
    scrubber.add(secret);
    const journal = { reviewInfo: { caption: `the key is ${secret}`, actions: [{ kind: 'run', command: `echo '${secret}'` }] }, delivered: 3, completed: true };
    expect(scrubber.scrubValue(journal)).toEqual({ reviewInfo: { caption: 'the key is [redacted]',
      actions: [{ kind: 'run', command: "echo '[redacted]'" }] }, delivered: 3, completed: true });
  });

  it('masks a file byte for byte, so native JSONL stays valid and offsets stay put', () => {
    const scrubber = new SecretScrubber();
    const unicode = 'pässwört-gëheim-雪';
    scrubber.add(unicode, secret);
    const file = Buffer.from([JSON.stringify({ type: 'tool_result', content: `${unicode} and ${secret}` }),
      JSON.stringify({ type: 'text', text: JSON.stringify({ value: secret }) })].join('\n') + '\n');
    const masked = scrubber.mask(file);
    expect(masked.length).toBe(file.length);
    expect(masked.toString()).not.toContain(unicode);
    expect(masked.toString()).not.toContain(JSON.stringify(secret).slice(1, -1));
    for (const line of masked.toString().trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('finds every value inside a structured secret, but not the lines of prose', () => {
    expect(secretValues(JSON.stringify({ tokens: { access_token: 'mcp-access-0123456789', refresh_token: 'mcp-refresh-0123456789' } })))
      .toEqual(expect.arrayContaining(['mcp-access-0123456789', 'mcp-refresh-0123456789']));
    expect(secretValues('export API_KEY="sk-env-0123456789"\nDB=postgres://u:pw-0123456789@h/db\n'))
      .toEqual(expect.arrayContaining(['sk-env-0123456789', 'postgres://u:pw-0123456789@h/db']));
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----\n';
    expect(secretValues(key)).toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ');
    expect(secretValues('Use this account for billing\nAsk Sam first')).not.toContain('Use this account for billing');
  });
});

describe('what a task received, across processes', () => {
  it('resolves a reveal recorded by one process in another, storing no plaintext', async () => {
    const dir = temp();
    const dbPath = path.join(dir, 'karmax.db');
    // The gateway that serves /api/vault/resolve…
    const gatewayStore = (await Store.create(dbPath));
    const gatewayBroker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    // …and a worker with its own connection and its own broker.
    const workerStore = (await Store.create(dbPath));
    const workerBroker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    try {
      const project = (await gatewayStore.createProject('Cross process'));
      const task = (await gatewayStore.createTask({ projectId: project.id, title: 'Reveal', workflow: 'software-dev',
        workflowVersion: '1.0.0', params: { prompt: 'x' } }));
      const vault = new VaultItems(gatewayStore, gatewayBroker, undefined, project.organizationId);
      const item = (await vault.save({ type: 'api-key', label: 'Key', policy: { use: 'auto', reveal: 'auto' },
        secrets: { secret: 'sk-cross-process-0123456789' } }));
      const secrets = new TaskSecrets({ store: workerStore, broker: workerBroker }, [task.id]);
      expect((await secrets.refresh()).scrub('sk-cross-process-0123456789')).toBe('sk-cross-process-0123456789');
      // The reveal, mid-turn.
      expect(await vault.resolveField(item, 'secret', { taskId: task.id, mode: 'reveal' })).toBe('sk-cross-process-0123456789');
      expect((await secrets.refresh()).scrub('echo sk-cross-process-0123456789')).toBe('echo [redacted]');
      // Only the reference is stored.
      const rows = JSON.stringify((await workerStore.db.prepare('SELECT * FROM kv').all()));
      expect(rows).toContain(`secretref:${task.id}:handle:item:${item.id}:secret`);
      expect(rows).not.toContain('sk-cross-process');
      // And it goes with the task.
      (await gatewayStore.deleteTask(task.id));
      expect((await workerStore.kvEntries(`secretref:${task.id}:`))).toEqual([]);
    } finally {
      (await workerStore.close());
      (await gatewayStore.close());
    }
  });

  it('includes MCP tokens, filled cards and what a forked-from task received', async () => {
    const dir = temp();
    const store = (await Store.create(':memory:'));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    try {
      const project = (await store.createProject('Sources'));
      const connections = new McpConnections(store, broker, project.organizationId ?? 'org_personal');
      const connection = (await connections.save({ label: 'Tracker', transport: { type: 'http', url: 'https://mcp.example.com/mcp' },
        auth: 'secrets', secrets: { Authorization: 'Bearer mcp-world-token-0123456789' } }, project.id));
      await connections.delivered('task_source', [connection]);
      (await recordSecretRefs(store, 'task_source', [cardRef('card_1')]));
      (await recordSecretRefs(store, 'task_fork', [taskRef('task_source')]));
      const looked: string[] = [];
      const secrets = new TaskSecrets({ store, broker, cardDetails: async (id) => { looked.push(id); return { number: '4242424242424242' }; } },
        ['task_fork']);
      const scrubbed = (await secrets.refresh()).scrub('curl -H "Authorization: Bearer mcp-world-token-0123456789" # 4242424242424242');
      expect(scrubbed).toBe('curl -H "Authorization: [redacted]" # [redacted]');
      (await secrets.refresh());
      expect(looked).toEqual(['card_1']); // a card is read once, not per write
    } finally { (await store.close()); }
  });
});

describe('stored execution output', () => {
  it('never stores a secret split across chunks, and flushes a held tail on close', async () => {
    const scrubber = new SecretScrubber();
    scrubber.add('sk-live-terminal-0123456789');
    const stored: string[] = [];
    const output = new ExecutionOutput(async (data) => { stored.push(data); }, undefined, { refresh: async () => scrubber });
    for (const chunk of ['$ cat .env\r\nKEY=sk-li', 've-term', 'inal-0123456789\r\n$ ', 'sk-l']) {
      output.append(chunk);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await output.close();
    const all = stored.join('');
    expect(all).toBe('$ cat .env\r\nKEY=[redacted]\r\n$ sk-l');
    for (const frame of stored) expect(frame).not.toMatch(/sk-live|ve-term|inal-0123/);
  });
});

describe('Codex conversation exports', () => {
  it('freezes a masked copy and leaves the native rollout intact for resume', async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const home = temp(), objects = new LocalObjectStore(temp());
    const line = (record: unknown) => JSON.stringify(record);
    const content = Buffer.from([
      line({ ordinal: 0, type: 'session_meta', payload: { id, history_mode: 'paginated', timestamp: '2026-10-02T00:00:00Z' } }),
      line({ ordinal: 1, type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: '{"status":"granted","value":"sk-codex-export-0123456789"}' } }),
    ].join('\n') + '\n');
    publishLocalCodexHistory(home, { file: `rollout-2026-10-02T00-00-00-${id}.jsonl`, content }, id);
    const scrubber = new SecretScrubber();
    scrubber.add('sk-codex-export-0123456789');
    const exported = await createCodexConversationExport(objects, 'task_a', 'do', id, { home }, scrubber);
    const frozen = (await readCodexConversationExport(objects, 'task_a', 'do', exported.exportId)).data;
    for (const data of [exported.data, frozen]) {
      expect(data.toString()).not.toContain('sk-codex-export');
      for (const record of data.toString().trim().split('\n')) expect(() => JSON.parse(record)).not.toThrow();
    }
    expect(readLocalCodexHistory(home, id).content.toString()).toContain('sk-codex-export-0123456789');
  });
});

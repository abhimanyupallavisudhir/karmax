import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretScrubber, secretForms } from '../src/agent/activity.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { organizationScope } from '../src/autonomy/vault-keys.js';
import { TaskSecrets, cardRef, handleRef, recordSecretRefs, secretScope, secretValues, taskRef } from '../src/autonomy/task-secrets.js';
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
      .toEqual(expect.arrayContaining(['sk-env-0123456789', 'postgres://u:pw-0123456789@h/db', 'pw-0123456789']));
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----\n';
    expect(secretValues(key)).toContain('b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ');
    expect(secretValues('Use this account for billing\nAsk Sam first')).not.toContain('Use this account for billing');
  });

  // The rule (wiki features/secret-scrubbing): a part of a secret is scrubbed
  // when it is secret by its name or by its shape; its public metadata is not.
  const scrubberFor = (plaintext: string) => { const scrubber = new SecretScrubber(); scrubber.add(...secretValues(plaintext)); return scrubber; };

  it('scrubs a Google service-account key, not its project, e-mail, client id or googleapis.com URLs', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const email = 'tavya-agent@tavya-prod-472915.iam.gserviceaccount.com';
    const serviceAccount = {
      type: 'service_account', project_id: 'tavya-prod-472915',
      private_key_id: '3f1c9a7e0b2d4c6e8a1f3b5d7c9e0a2b4d6f8a1c', private_key: pem,
      client_email: email, client_id: '108215374620193847562',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token',
      auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
      client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(email)}`,
      universe_domain: 'googleapis.com',
    };
    const scrubber = scrubberFor(JSON.stringify(serviceAccount, null, 2));
    const advice = [
      'gcloud services enable cloudquotas.googleapis.com --project tavya-prod-472915',
      `gcloud projects add-iam-policy-binding tavya-prod-472915 --member serviceAccount:${email} --role roles/owner`,
      `client ${serviceAccount.client_id}, type service_account, token from ${serviceAccount.token_uri}`,
      `${serviceAccount.auth_uri} ${serviceAccount.auth_provider_x509_cert_url} ${serviceAccount.client_x509_cert_url}`,
    ].join('\n');
    expect(scrubber.scrub(advice)).toBe(advice);
    // What is secret still is: the key, its id, any one line of it, the file.
    const body = pem.split('\n')[5]!;
    expect(scrubber.scrub(`private_key_id ${serviceAccount.private_key_id}; ${body}`)).toBe('private_key_id [redacted]; [redacted]');
    expect(scrubber.scrub(JSON.stringify({ text: pem }))).not.toContain(body);
    expect(scrubber.scrub(`cat key.json\n${JSON.stringify(serviceAccount, null, 2)}`)).toBe('cat key.json\n[redacted]');
  });

  it('scrubs the secret half of an AWS ID:SECRET key, but not the key id', () => {
    const scrubber = scrubberFor('AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(scrubber.scrub('aws configure set aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toBe('aws configure set aws_secret_access_key [redacted]');
    expect(scrubber.scrub('using key AKIAIOSFODNN7EXAMPLE')).toBe('using key AKIAIOSFODNN7EXAMPLE');
    expect(scrubber.scrub('AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe('[redacted]');
    // The same key as JSON (an IAM CreateAccessKey response), and as a credentials file.
    const json = scrubberFor(JSON.stringify({ AccessKey: { UserName: 'deploy-bot', AccessKeyId: 'AKIAIOSFODNN7EXAMPLE', Status: 'Active',
      SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', CreateDate: '2026-10-20T12:00:00Z' } }));
    expect(json.scrub('deploy-bot Active 2026-10-20T12:00:00Z wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'))
      .toBe('deploy-bot Active 2026-10-20T12:00:00Z [redacted]');
    const file = scrubberFor('[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nregion = europe-west1\n');
    expect(file.scrub('[default] europe-west1 wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe('[default] europe-west1 [redacted]');
  });

  it('scrubs an MCP connection\'s tokens and client secret, not its endpoints, scopes or expiry', () => {
    const accessToken = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0YXZ5YSIsImV4cCI6MTc5MjAwMDAwMH0.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
    const connection = {
      client: { client_id: 'tavya-mcp-client', client_secret: 'cs_live_hunter2hunter2', client_name: 'tavya',
        redirect_uris: ['https://tavya.io/api/mcp/oauth/callback'], token_endpoint_auth_method: 'client_secret_basic' },
      tokens: { access_token: accessToken, token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-notion-0123456789', scope: 'read:content write:content' },
      expiresAt: 1792000000000,
      discovery: { authorizationServerMetadata: { issuer: 'https://mcp.notion.com', token_endpoint: 'https://mcp.notion.com/token',
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'], code_challenge_methods_supported: ['S256'] } },
      pending: { verifier: 'vrf-0123456789-abcdefghij' },
    };
    const scrubber = scrubberFor(JSON.stringify(connection));
    const publicText = 'POST https://mcp.notion.com/token with client_secret_basic for tavya-mcp-client, scope read:content write:content, '
      + 'redirect https://tavya.io/api/mcp/oauth/callback at 1792000000000';
    expect(scrubber.scrub(publicText)).toBe(publicText);
    expect(scrubber.scrub(`Bearer ${accessToken} rt-notion-0123456789 cs_live_hunter2hunter2 vrf-0123456789-abcdefghij`))
      .toBe('Bearer [redacted] [redacted] [redacted] [redacted]');
  });

  it('scrubs a card\'s number, not its brand, holder or expiry', () => {
    const scrubber = scrubberFor(JSON.stringify({ brand: 'mastercard', number: '5555 5555 5555 4444', exp_month: 12, exp_year: 2029,
      cvc: '123', name: 'Abhimanyu Cardholder', billing_address: { line1: '1 Market Street', city: 'San Francisco' } }));
    expect(scrubber.scrub('mastercard 12/2029 Abhimanyu Cardholder, 1 Market Street, San Francisco'))
      .toBe('mastercard 12/2029 Abhimanyu Cardholder, 1 Market Street, San Francisco');
    expect(scrubber.scrub('card 5555 5555 5555 4444')).toBe('card [redacted]');
    expect(scrubberFor(JSON.stringify({ number: 5555555555554444 })).scrub('5555555555554444')).toBe('[redacted]');
  });

  it('scrubs a .env bag\'s secrets, not its configuration', () => {
    // Assembled, so the file holds nothing GitHub push protection takes for a live Stripe key.
    const stripeKey = 'sk_' + 'live_51Hx0123456789abcdefABCDEF';
    const scrubber = scrubberFor([
      'NODE_ENV=production', 'AWS_REGION=us-east-1', 'GOOGLE_CLOUD_PROJECT=tavya-prod-472915', 'SMTP_USER=agent@tavya.io',
      `STRIPE_SECRET_KEY=${stripeKey}`, 'DB_PASSWORD=correcthorsebattery', 'GITHUB_PAT=ghp_aBcD1234567890EfGhIjKlMnOpQrStUvWx',
      'SENTRY_DSN=https://3f1c9a7e0b2d4c6e8a1f3b5d7c9e0a2b@o1.ingest.sentry.io/42', 'SESSION_SIGNING=Zx8kQ2mN5pR7tV9wY1bC3dF6gH',
    ].join('\n') + '\n');
    const config = 'NODE_ENV=production gcloud --project tavya-prod-472915 aws --region us-east-1 mail agent@tavya.io';
    expect(scrubber.scrub(config)).toBe(config);
    for (const secret of [stripeKey, 'correcthorsebattery', 'ghp_aBcD1234567890EfGhIjKlMnOpQrStUvWx',
      '3f1c9a7e0b2d4c6e8a1f3b5d7c9e0a2b', 'Zx8kQ2mN5pR7tV9wY1bC3dF6gH']) expect(scrubber.scrub(`x ${secret} x`)).toBe('x [redacted] x');
  });

  it('scrubs a saved browser session\'s cookie values and storage, not cookie names or domains', () => {
    const scrubber = scrubberFor(JSON.stringify({ version: 1, capturedAt: 1792000000000,
      cookies: [{ name: '__Secure-session', value: 'opaque-session-cookie', domain: '.console.cloud.google.com', path: '/', httpOnly: true, secure: true }],
      storage: [{ origin: 'https://console.cloud.google.com', localStorage: [['last-project', 'tavya-prod-472915-recent']] }] }));
    expect(scrubber.scrub('__Secure-session on .console.cloud.google.com, https://console.cloud.google.com'))
      .toBe('__Secure-session on .console.cloud.google.com, https://console.cloud.google.com');
    expect(scrubber.scrub('opaque-session-cookie tavya-prod-472915-recent')).toBe('[redacted] [redacted]');
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

  it('scrubs what one attempt received from its sibling attempts, found under their shared intent', async () => {
    const dir = temp();
    const store = (await Store.create(':memory:'));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    try {
      const project = (await store.createProject('Attempts'));
      const first = (await store.createTask({ projectId: project.id, title: 'Attempt 1', workflow: 'software-dev', workflowVersion: '1', params: { prompt: '' } }));
      const second = (await store.createTask({ projectId: project.id, title: 'Attempt 2', workflow: 'software-dev', workflowVersion: '1',
        params: { prompt: '' }, intentId: first.intentId ?? first.id }));
      (await broker.registerHandle('item:vi_x:secret', 'sibling-secret-0123456789', organizationScope(project.organizationId ?? 'org_personal')));
      (await recordSecretRefs(store, second.id, [handleRef('item:vi_x:secret')]));
      const firstTask = (await store.getTask(first.id));
      const scope = (await secretScope(store, first.id, firstTask));
      expect(scope).toEqual([first.intentId ?? first.id]);
      const secrets = new TaskSecrets({ store, broker }, scope);
      expect((await secrets.refresh()).scrub('echo sibling-secret-0123456789')).toBe('echo [redacted]');
    } finally { (await store.close()); }
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
    const exported = await createCodexConversationExport(objects, 'task_a', 'do', id, { home }, undefined, scrubber);
    const frozen = (await readCodexConversationExport(objects, 'task_a', 'do', exported.exportId)).data;
    for (const data of [exported.data, frozen]) {
      expect(data.toString()).not.toContain('sk-codex-export');
      for (const record of data.toString().trim().split('\n')) expect(() => JSON.parse(record)).not.toThrow();
    }
    expect(readLocalCodexHistory(home, id).content.toString()).toContain('sk-codex-export-0123456789');
  });
});

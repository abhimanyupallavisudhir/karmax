/** Codex 0.166 refuses to resume a thread whose saved provider is not the one it
 * is configured with ("This chat uses ollama, but your current provider is
 * openai", `modelProviderMismatch`); 0.162 resumed it. A Codex conversation
 * someone uploads from their own machine may carry any provider. tavya forks an
 * imported session rather than resuming it, and a fork takes tavya's provider,
 * so the upload keeps working. Real pinned Codex, no model calls. */
import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CodexAppServerClient } from '../src/agent/codex-app-server-client.js';
import { localProviderCli } from '../src/agent/provider-cli.js';

const uploaded = '0199bbbb-0000-7000-8000-000000000001';

it('forks and then resumes an uploaded Codex conversation saved under another provider', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-codex-provider-'));
  const sessions = path.join(home, 'sessions', '2026', '10', '10');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, `rollout-2026-10-10T00-00-00-${uploaded}.jsonl`), [
    { timestamp: '2026-10-10T00:00:00Z', type: 'session_meta', payload: { id: uploaded, timestamp: '2026-10-10T00:00:00Z',
      cwd: '/tmp', originator: 'codex_cli_rs', cli_version: '0.166.0', source: 'cli', model_provider: 'ollama' } },
    { timestamp: '2026-10-10T00:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'uploaded-user-marker' }] } },
    { timestamp: '2026-10-10T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'uploaded-assistant-marker' }] } },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  const child = spawn(process.execPath, [localProviderCli('codex'), 'app-server'], {
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  const client = new CodexAppServerClient(child.stdin, child.stdout);
  try {
    await client.request('initialize', { clientInfo: { name: 'karmax-test', version: '1' }, capabilities: { experimentalApi: true } });
    client.notify('initialized');
    // The parameters src/agent/codex.ts sends for a fork, then for the next turn's resume.
    const posture = { cwd: home, sandbox: 'danger-full-access', approvalPolicy: 'never', excludeTurns: true };
    const fork: string = (await client.request<any>('thread/fork', { threadId: uploaded, ...posture })).thread.id;
    expect(fork).not.toBe(uploaded);
    await expect(client.request('thread/resume', { threadId: fork, ...posture })).resolves.toBeTruthy();
  } finally {
    client.close();
    child.kill('SIGTERM');
    await exited;
    fs.rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

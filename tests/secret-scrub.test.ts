import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootHarness, type Harness } from './helpers/harness.js';
import { VaultItems } from '../src/autonomy/vault-items.js';

/**
 * SS-3 (wiki reviews/2026-10-02-secret-storage): a secret revealed to a task
 * while its agent runs used to be archived in plaintext wherever the agent
 * printed it. Real workflow, real gateway serving `/api/vault/resolve`, real
 * worktree world; the mock agent reveals a vault item mid-turn through the
 * platform API exactly as `get_credential` does, then prints, runs, attaches
 * and saves it. Every sink tavya keeps or serves about the task is checked.
 */
const SECRET = 'sk-live/R3vealed+MidTurn=01234567'; // 33 bytes: base64 has no padding
const forms = [SECRET, Buffer.from(SECRET).toString('base64'), encodeURIComponent(SECRET), SECRET.slice(0, 20)];
const leaks = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return forms.filter((form) => text.includes(form));
};

function socket() {
  const ws = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, send: vi.fn(), bufferedAmount: 0,
    close: vi.fn(function (this: any) { this.readyState = 3; this.emit('close', 1000, Buffer.from('')); }),
    terminate: vi.fn(function (this: any) { this.readyState = 3; this.emit('close', 1006, Buffer.from('')); }) });
  return ws as any;
}

describe('a secret revealed mid-turn is scrubbed from everything kept about the task (SS-3)', () => {
  let h: Harness;
  let gateway: Awaited<ReturnType<Harness['startGateway']>>;
  let token: string;
  let project: Awaited<ReturnType<Harness['store']['createProject']>>;
  let task: { id: string };
  const previous = { url: process.env.KARMAX_GATEWAY_URL, floor: process.env.KARMAX_AGENT_MIN_FREE_MB, load: process.env.KARMAX_AGENT_MAX_LOAD_FACTOR };
  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  const homes: string[] = [];
  const view = (taskId: string) => h.client.workflow.getHandle(taskId).query('view') as Promise<any>;

  /** Plant the provider's native session file, as a real Claude turn leaves it. */
  const plantTranscript = async (taskId: string) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-scrub-home-'));
    homes.push(home);
    const session = '5ec2e7aa-0000-4000-8000-000000000003';
    const file = path.join(home, 'projects', '-world', `${session}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', sessionId: session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1',
        content: JSON.stringify({ status: 'granted', value: SECRET }) }] } }),
      JSON.stringify({ type: 'assistant', sessionId: session, message: { role: 'assistant', content: [{ type: 'text', text: `The key is ${SECRET}` }] } }),
    ].join('\n') + '\n');
    (await h.store.kvSet(`session:${taskId}:do`, session));
    (await h.store.kvSet(`sessionmeta:${taskId}:do`, JSON.stringify({ home, provider: 'claude' })));
    return file;
  };

  beforeAll(async () => {
    process.env.KARMAX_AGENT_MIN_FREE_MB = '0';
    process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
    h = await bootHarness('mock', undefined, { checkpoints: true });
    gateway = await h.startGateway();
    process.env.KARMAX_GATEWAY_URL = gateway.internalUrl;
    token = (await (await fetch(`${gateway.url}/api/session`)).json() as any).token;

    const repo = await h.makeRepo('secret-scrub');
    project = (await h.store.createProject('Secret scrub', { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false }));
    const vault = new VaultItems(h.store, h.broker, undefined, project.organizationId);
    const item = (await vault.save({ type: 'api-key', label: 'Live key', policy: { use: 'ask', reveal: 'auto' }, secrets: { secret: SECRET } }));
    const apiToken = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    task = await h.api.createTask(apiToken, { projectId: project.id, title: 'Use the live key', draft: true,
      params: { 'agent:do': { provider: 'mock' } },
      prompt: [
        `@reveal ${item.id}`,
        '@run mkdir -p .karmax-injection && echo {{secret}} > .karmax-injection/leak.txt && echo {{secret}} | base64',
        '@runaction Show the key :: cat .karmax-injection/leak.txt',
        '@review The key is {{secret}}',
        '@skill leaked-key :: use {{secret}}',
      ].join('\n') } as any);
    // A person grants this task the item for its whole life, as from the inbox.
    const asked = (await vault.request({ taskId: task.id, caps: [], itemId: item.id, mode: 'reveal', why: 'deploy' }));
    (await vault.resolve(asked.requestId!, { action: 'task', by: 'user:a' }));
    (await h.api.queueTask(apiToken, task.id));
    await vi.waitFor(async () => expect((await view(task.id))?.stage).toBe('review'), { timeout: 60_000, interval: 250 });
  }, 120_000);

  afterAll(async () => {
    await h?.stop();
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
    for (const [name, value] of [['KARMAX_GATEWAY_URL', previous.url], ['KARMAX_AGENT_MIN_FREE_MB', previous.floor],
      ['KARMAX_AGENT_MAX_LOAD_FACTOR', previous.load]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  it('revealed the secret to the agent through the real platform API', async () => {
    const events = (await h.store.eventsSince(task.id, 0));
    const reveal = events.find((event) => event.type === 'agent.activity' && (event.payload as any).id?.startsWith('reveal-'));
    expect(reveal).toBeTruthy();
    // The agent printed it: the scrubbed form proves it reached every sink below.
    expect(JSON.stringify(events)).toContain('[redacted]');
  });

  it('keeps it out of the events table', async () => {
    expect(leaks(await h.store.eventsSince(task.id, 0))).toEqual([]);
  });

  it('keeps it out of the messages and the stored task view', async () => {
    const current = await view(task.id);
    expect(current.messages.some((message: any) => message.text.includes('revealed [redacted]'))).toBe(true);
    expect(leaks(current.messages)).toEqual([]);
    expect(leaks((await h.store.getTask(task.id))?.lastView)).toEqual([]);
  });

  it('keeps it out of the turn journal', async () => {
    const entries = (await h.store.kvEntries(`turnsession:${task.id}`));
    expect(entries.some((entry) => entry.key.endsWith(':journal'))).toBe(true);
    expect(leaks(entries)).toEqual([]);
  });

  it('keeps it out of the review info', async () => {
    const current = await view(task.id);
    expect(current.reviewInfo.caption).toBe('The key is [redacted]');
    expect(leaks(current.reviewInfo)).toEqual([]);
  });

  it('keeps it out of workflow history (later turns read the final answer from there)', async () => {
    expect(leaks(await h.client.workflow.getHandle(task.id).fetchHistory())).toEqual([]);
  });

  it('keeps it out of stored review-action output', async () => {
    const started: any = await (await fetch(`${gateway.url}/api/tasks/${task.id}/review-action`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ index: 0 }) })).json();
    expect(started.procId).toBeTruthy();
    let status: any;
    await expect.poll(async () => {
      status = await (await fetch(`${gateway.url}/api/tasks/${task.id}/review-action/${started.procId}`, { headers: auth() })).json();
      return status.running;
    }, { timeout: 20_000 }).toBe(false);
    expect(status.output).toContain('[redacted]');
    expect(leaks(status)).toEqual([]);
    expect(leaks(await h.store.executionFrames(started.procId))).toEqual([]);
  });

  it('keeps it out of stored terminal output', async () => {
    const shellToken = (await h.tokens.mintPrincipal('user:a', ['task:edit', 'task:read'], project.id, 60 * 60_000, project.organizationId)).token;
    const session = { user: 'a', apiToken: shellToken };
    const shell = gateway.gateway as any;
    const spies = [vi.spyOn(shell, 'socketAuth').mockResolvedValue(session), vi.spyOn(shell, 'auth').mockResolvedValue(session)];
    try {
      const ws = socket();
      await shell.terminal(ws, { headers: {}, url: `/ws/terminal?taskId=${task.id}` });
      ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'cat .karmax-injection/leak.txt; exit\n' })));
      const terminal = async () => (await h.store.listExecutions(task.id)).find((execution) => execution.kind === 'terminal');
      await expect.poll(async () => (await terminal())?.state, { timeout: 20_000 }).not.toMatch(/starting|running/);
      // The person at the shell saw it live; nothing stored did.
      expect(ws.send.mock.calls.map(([data]: any) => data).join('')).toContain(SECRET.slice(0, 20));
      const frames = (await h.store.executionFrames((await terminal())!.id));
      expect(frames.map((frame) => frame.data).join('')).toContain('[redacted]');
      expect(leaks(frames)).toEqual([]);
    } finally { for (const spy of spies) spy.mockRestore(); }
  });

  it('keeps it out of the organization export', async () => {
    const exported = (await h.store.exportOrganization(project.organizationId!));
    expect(JSON.stringify(exported)).toContain('execution_frames');
    expect(leaks(exported)).toEqual([]);
  });

  it('masks the served native transcript but leaves the provider file intact for resume', async () => {
    const file = await plantTranscript(task.id);
    const native = fs.readFileSync(file);
    const response = await fetch(`${gateway.url}/api/tasks/${task.id}/conversation.jsonl?role=do`, { headers: auth() });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-karmax-conversation-source')).toBe('native');
    const served = Buffer.from(await response.arrayBuffer());
    expect(leaks(served.toString())).toEqual([]);
    expect(served.length).toBe(native.length);
    for (const line of served.toString().trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
    expect(fs.readFileSync(file)).toEqual(native);
  });

  it('scrubs what a fork serves of the conversation it carries', async () => {
    const apiToken = (await h.tokens.mintPrincipal('user:a', ['*'], project.id)).token;
    const fork = await h.api.forkTaskAgent(apiToken, { taskId: task.id, role: 'do', message: 'carry on', provider: 'mock' });
    await expect.poll(async () => (await view(fork.id).catch(() => undefined))?.stage, { timeout: 60_000 }).toBe('review');
    expect(leaks(await view(fork.id))).toEqual([]);
    expect(leaks(await h.store.eventsSince(fork.id, 0))).toEqual([]);
    // The fork's own provider file holds the source's history; what is served is masked.
    await plantTranscript(fork.id);
    const served = await (await fetch(`${gateway.url}/api/tasks/${fork.id}/conversation.jsonl?role=do`, { headers: auth() })).text();
    expect(served).toContain('*'.repeat(SECRET.length));
    expect(leaks(served)).toEqual([]);
  }, 90_000);
});

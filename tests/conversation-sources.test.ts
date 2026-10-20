import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as network from '../src/mcp/connections/http.js';
import { importConversationShare, importConversationUpload } from '../src/agent/conversation-sources.js';
import { conversationImportObjectKey } from '../src/store/conversation-imports.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Store } from '../src/store/db.js';
import { createShare } from '../src/gateway/conversation-sharing.js';
import type { AgentSpec } from '../src/domain/types.js';
/** The main agent's fork source as stored in a task's params. */
const resumeOf = (params: Record<string, unknown>) =>
  (params['agent:do'] as { resumeFrom: NonNullable<AgentSpec['resumeFrom']> }).resumeFrom;


const fixture = (name: string) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const json = (body: Buffer | string) => new Response(body, { headers: { 'content-type': 'application/json' } });

let dir: string;
let store: Store;
let objects: LocalObjectStore;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-sources-'));
  store = await Store.create(':memory:');
  objects = new LocalObjectStore(path.join(dir, 'objects'));
  vi.spyOn(network, 'publicShareFetch').mockRejectedValue(new Error('Unexpected share request'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// A source is read when it is given, exactly as the agent's first turn reads it,
// and kept: the turn starts from this copy (lvpm#4 failed only at that turn).
describe('checking a conversation to fork from', () => {
  it('reads a Claude share now and keeps what it read, content-addressed', async () => {
    vi.mocked(network.publicShareFetch).mockImplementation(async () => json(fixture('claude-chat-snapshot.json')));
    const link = 'https://claude.ai/share/e510a898-8e59-4423-b613-12c7c5ac37a5';
    const ref = await importConversationShare({ store, objects }, 'proj_a', link);
    expect(ref).toMatchObject({ format: 'claude-share', share: link, title: 'Latent variable experiments', messages: 4, projectId: 'proj_a' });
    expect(await objects.get(conversationImportObjectKey('proj_a', ref.id))).toEqual(fixture('claude-chat-snapshot.json'));
    expect((await importConversationShare({ store, objects }, 'proj_a', link)).id).toBe(ref.id);
  });

  it('follows a Gemini short link to its share, then asks the RPC its page asks', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.mocked(network.publicShareFetch).mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === 'https://share.gemini.google/4gF2GfgiLKzw')
        return new Response(null, { status: 301, headers: { location: 'https://gemini.google.com/share/50a32fbbfd3c?social_preview=false' } });
      return new Response(fixture('gemini-share.txt'), { headers: { 'content-type': 'application/json; charset=utf-8' } });
    });
    const ref = await importConversationShare({ store, objects }, 'proj_a', 'https://share.gemini.google/4gF2GfgiLKzw');
    expect(ref).toMatchObject({ format: 'gemini-share', title: 'Self-location fixture', messages: 4 });
    expect(calls[0]!.init).toMatchObject({ redirect: 'manual' });
    expect(calls[1]!.url).toBe('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=ujx1Bf&source-path=%2Fshare%2F50a32fbbfd3c&hl=en-US&rt=c');
    expect(calls[1]!.init).toMatchObject({ method: 'POST', headers: expect.objectContaining({ 'x-same-domain': '1' }) });
    expect(String(calls[1]!.init!.body)).toBe(`f.req=${encodeURIComponent(JSON.stringify([[['ujx1Bf', '[null,"50a32fbbfd3c",[4]]', null, 'generic']]]))}`);
  });

  it('never follows a Gemini link off Gemini', async () => {
    vi.mocked(network.publicShareFetch).mockImplementation(async () =>
      new Response(null, { status: 302, headers: { location: 'https://evil.example/share/x' } }));
    await expect(importConversationShare({ store, objects }, 'proj_a', 'https://g.co/gemini/share/50a32fbbfd3c'))
      .rejects.toThrow('This Gemini link leads outside Gemini (evil.example)');
    expect(network.publicShareFetch).toHaveBeenCalledOnce();
  });

  it.each([
    ['a Gemini share that was unshared', 'https://gemini.google.com/share/000000000000',
      () => new Response(fixture('gemini-share-unavailable.txt')), /deleted or unshared/],
    ['a Claude share claude.ai refuses', 'https://claude.ai/share/e510a898-8e59-4423-b613-12c7c5ac37a5',
      () => new Response('<title>Just a moment...</title>', { status: 403, headers: { 'content-type': 'text/html' } }),
      /claude\.ai refused to send this share to tavya \(HTTP 403\)\. Open https:\/\/claude\.ai\/api\/chat_snapshots\//],
    ['a deleted ChatGPT share', 'https://chatgpt.com/share/gone', () => new Response('', { status: 404 }), /Share link not found/],
    ['a link to something else', 'https://example.com/share/x', () => new Response(''), /Use a public HTTPS ChatGPT, Claude, Gemini or tavya share link/],
  ])('says what to do with %s, keeping nothing', async (_name, link, answer, error) => {
    vi.mocked(network.publicShareFetch).mockImplementation(async () => answer());
    await expect(importConversationShare({ store, objects }, 'proj_a', link)).rejects.toThrow(error);
    expect(fs.existsSync(path.join(dir, 'objects', 'conversation-imports'))).toBe(false);
  });

  it('reads a share of this installation from the store, never the network', async () => {
    await store.claimPersonalOrganization('owner');
    const project = await store.createProject('Shares');
    await store.kvSet('conversation-sharing:organization:org_personal', 'enabled');
    const source = await store.createTask({ projectId: project.id, title: 'Source', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'source' } });
    const share = await createShare(store, source.id, 'do', [
      { id: 'a', role: 'user', text: 'Which index?', ts: 1 }, { id: 'b', role: 'agent', text: 'Drop idx_old.', ts: 2 }] as any);
    const ref = await importConversationShare({ store, objects }, project.id, `https://tavya.io/share/conversations/${share.id}`);
    expect(ref).toMatchObject({ format: 'tavya-share', messages: 2 });
    expect(network.publicShareFetch).not.toHaveBeenCalled();
  });

  it('checks an uploaded file by converting it, and names what it holds', async () => {
    const ref = await importConversationUpload(objects, 'proj_a', fixture('claude-chat-snapshot.json'), 'saved.json');
    expect(ref).toMatchObject({ format: 'claude-export', title: 'Latent variable experiments', messages: 4, name: 'saved.json' });
    expect(ref.share).toBeUndefined();
    // A Claude Code log with no message in it is a recognised file but no conversation.
    const empty = Buffer.from(`${JSON.stringify({ type: 'summary', sessionId: '11111111-1111-4111-8111-111111111111', summary: 'x' })}\n`);
    await expect(importConversationUpload(objects, 'proj_a', empty, 'empty.jsonl')).rejects.toThrow('This conversation has no messages');
  });
});

describe('a task given a share link by the API', () => {
  const link = 'https://claude.ai/share/e510a898-8e59-4423-b613-12c7c5ac37a5';
  async function harness() {
    const { KarmaxApi, ValidationError } = await import('../src/platform/api.js');
    const { TokenAuthority } = await import('../src/platform/tokens.js');
    const { WorldRegistry } = await import('../src/world/registry.js');
    const tokens = new TokenAuthority();
    const org = await store.createOrganization({ name: 'Acme', ownerUserId: 'a' });
    const project = (await store.createProject('Mine', {}, org.id)).id;
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'karmax', tokens, contentDir: dir, worlds: new WorldRegistry(), objects });
    const token = (await tokens.mintPrincipal('user:a', ['task:*'], project, 60_000, org.id)).token;
    return { api, project, token, ValidationError };
  }

  it('reads it when the task is saved and keeps what it read instead', async () => {
    vi.mocked(network.publicShareFetch).mockImplementation(async () => json(fixture('claude-chat-snapshot.json')));
    const { api, project, token } = await harness();
    const draft = await api.createTask(token, { projectId: project, title: 'Resume', prompt: 'go', draft: true,
      params: { 'agent:do': { provider: 'mock', resumeFrom: { sessionId: link } } } });
    const resumeFrom = resumeOf((await store.getTask(draft.id))!.params);
    expect(resumeFrom).toEqual({ upload: expect.objectContaining({ share: link, format: 'claude-share', messages: 4, projectId: project }) });
    expect(await objects.get(conversationImportObjectKey(project, resumeFrom.upload!.id))).toEqual(fixture('claude-chat-snapshot.json'));
    // Editing the draft with a link reads that one too.
    await api.updateArmedParams(token, draft.id, { prompt: 'go', 'agent:do': { provider: 'mock', resumeFrom: { sessionId: link } } });
    expect(resumeOf((await store.getTask(draft.id))!.params).upload!.share).toBe(link);
  });

  it('refuses an unreadable one before anything is created or queued', async () => {
    vi.mocked(network.publicShareFetch).mockImplementation(async () => new Response('', { status: 404 }));
    const { api, project, token, ValidationError } = await harness();
    const error = await api.createTask(token, { projectId: project, title: 'Resume', prompt: 'go',
      params: { 'agent:do': { provider: 'mock', resumeFrom: { sessionId: link } } } }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('Share link not found; it may have been deleted or unshared');
    expect(await store.listTasks(project)).toEqual([]);
  });

  it('refuses an uploaded conversation of another project', async () => {
    const { api, project, token, ValidationError } = await harness();
    const upload = await importConversationUpload(objects, 'proj_other', fixture('claude-chat-snapshot.json'), 'saved.json');
    await expect(api.createTask(token, { projectId: project, title: 'Resume', prompt: 'go', draft: true,
      params: { 'agent:do': { provider: 'mock', resumeFrom: { upload } } } })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('the first turn of a task forked from a checked share', () => {
  it('starts from the copy read when it was given, as guarded context, with no second fetch', async () => {
    const { makeCoreActivities } = await import('../src/activities/core.js');
    const { WorldRegistry } = await import('../src/world/registry.js');
    const { ProfileResolver } = await import('../src/agent/profiles.js');
    vi.mocked(network.publicShareFetch).mockImplementation(async () => new Response(fixture('gemini-share.txt')));
    await store.claimPersonalOrganization('owner');
    const project = await store.createProject('Shares');
    const upload = await importConversationShare({ store, objects }, project.id, 'https://gemini.google.com/share/fixture');
    vi.mocked(network.publicShareFetch).mockClear().mockRejectedValue(new Error('Unexpected share request'));
    const task = await store.createTask({ projectId: project.id, title: 'Fork', workflow: 'software-dev',
      workflowVersion: '1.26.0', params: { prompt: 'x' } });
    const seen: string[] = [];
    const adapters = new Map([['mock', { provider: 'mock', async runTurn(input: any) {
      seen.push(input.messages.map((m: any) => m.text).join('\n'));
      return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: 'ok' };
    } }]]) as any;
    const worlds = new WorldRegistry();
    const core = makeCoreActivities({ store, worlds, adapters, objects, profiles: new ProfileResolver(store, 'mock') } as any);
    const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
    try {
      await core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#0`, agentSlotGranted: true,
        worldHandle: world.handle, messages: [{ id: 'm1', role: 'user', text: 'continue', ts: 0 }],
        task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'x', project: {}, workflow: 'software-dev',
          agents: { do: { provider: 'mock', resumeFrom: { upload } } } },
      } as any);
    } finally { await world.destroy(); }
    expect(seen.at(-1)).toContain('UDT chooses a policy before observing.');
    expect(seen.at(-1)).toContain('untrusted context');
    expect(network.publicShareFetch).not.toHaveBeenCalled();
    expect((await store.eventsOfType(task.id, 'session.imported')).map((event: any) => event.payload))
      .toEqual([expect.objectContaining({ source: 'share', format: 'gemini-share' })]);
  });
});

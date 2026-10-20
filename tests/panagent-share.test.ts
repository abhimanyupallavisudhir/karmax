import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importWithPanagent, publicConversationShare } from '../src/agent/panagent.js';
import * as network from '../src/mcp/connections/http.js';
import { createShare, publicConversationHtml, revokeShare } from '../src/gateway/conversation-sharing.js';
import { Store } from '../src/store/db.js';

beforeEach(() => { vi.spyOn(network, 'publicShareFetch').mockRejectedValue(new Error('Unexpected share request')); });
afterEach(() => vi.restoreAllMocks());

const importShare = (url: string) => importWithPanagent({ source: { url }, provider: 'claude',
  forkHome: '/unused', worldPath: '/work', mode: 'context', native: false });

describe('Karmax conversation share acquisition', () => {
  it.each(['https://user:pass@chatgpt.com/share/abc', 'https://claude.ai:8443/share/abc',
    'https://claude.ai/share/abc#secret', 'file:///etc/passwd', 'https://127.0.0.1/share/abc'])('rejects %s at validation and acquisition', async url => {
    expect(publicConversationShare(url)).toBeUndefined();
    await expect(importShare(url)).rejects.toThrow(/public HTTPS ChatGPT, Claude, Gemini or tavya share/);
    expect(network.publicShareFetch).not.toHaveBeenCalled();
  });
  it('stops at the guarded fetch when DNS or redirect validation fails', async () => {
    vi.mocked(network.publicShareFetch).mockRejectedValue(new Error('Endpoint redirects are not allowed'));
    await expect(importShare('https://chatgpt.com/share/abc')).rejects.toThrow(/redirects/);
    expect(network.publicShareFetch).toHaveBeenCalledOnce();
  });
  // claude.ai's share page is an app shell; the conversation is the JSON it loads.
  it('imports a Claude share from the snapshot JSON its page loads, asking as a navigation', async () => {
    const id = 'e510a898-8e59-4423-b613-12c7c5ac37a5';
    vi.mocked(network.publicShareFetch).mockImplementation(async () => new Response(
      fs.readFileSync(new URL('./fixtures/claude-chat-snapshot.json', import.meta.url)), { headers: { 'content-type': 'application/json' } }));
    const result = await importShare(`https://claude.ai/share/${id}`);
    expect(network.publicShareFetch).toHaveBeenCalledWith(
      `https://claude.ai/api/chat_snapshots/${id}?rendering_mode=messages&render_all_tools=true`,
      { headers: expect.objectContaining({ 'user-agent': 'tavya', 'sec-fetch-mode': 'navigate' }) });
    expect(result.kind).toBe('context');
    if (result.kind === 'context') {
      expect(result.message.text).toContain('# Latent variable experiments');
      expect(result.message.text).toContain('Build the testbed first, then the evaluations.');
    }
  });
  it('names the file to save and upload when claude.ai refuses the share', async () => {
    const id = 'e510a898-8e59-4423-b613-12c7c5ac37a5';
    vi.mocked(network.publicShareFetch).mockImplementation(async () => new Response(
      '<!DOCTYPE html><title>Just a moment...</title>', { status: 403, headers: { 'content-type': 'text/html' } }));
    await expect(importShare(`https://claude.ai/share/${id}`)).rejects.toThrow(
      `claude.ai refused to send this share to tavya (HTTP 403). Open https://claude.ai/api/chat_snapshots/${id}?rendering_mode=messages&render_all_tools=true in your browser`);
  });
  it.each(['chatgpt.com'])('converts guarded %s HTML locally into context and native history', async host => {
    vi.mocked(network.publicShareFetch).mockImplementation(async () => new Response('<html><div data-message-author-role="user">Guarded share message</div></html>'));
    const result = await importShare(`https://${host}/share/abc`);
    expect(result.kind).toBe('context');
    expect(result.warnings?.some(warning => warning.code === 'dom_fallback')).toBe(true);
    if (result.kind === 'context') expect(result.message.text).toContain('Guarded share message');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'share-home-'));
    try {
      const native = await importWithPanagent({ source: { url: `https://${host}/share/abc` }, provider: 'claude',
        forkHome: home, worldPath: '/work', mode: 'context', native: true });
      expect(native.kind).toBe('native');
      expect(native.warnings?.some(warning => warning.code === 'dom_fallback')).toBe(true);
      expect(network.publicShareFetch).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
  it('imports a tavya share link and reports a revoked one as not found', async () => {
    const url = `https://tavya.io/share/conversations/${'C'.repeat(43)}`;
    vi.mocked(network.publicShareFetch).mockImplementation(async () => new Response(publicConversationHtml({
      id: 'C'.repeat(43), taskId: 't', projectId: 'p', role: 'do', title: 'Shared plan', createdAt: 0,
      messages: [{ role: 'user', text: 'Plan the migration.' }, { role: 'agent', text: 'Step 1: back up.' }] })));
    const result = await importShare(url);
    expect(result.kind).toBe('context');
    if (result.kind === 'context') expect(result.message.text).toContain('Step 1: back up.');
    expect(network.publicShareFetch).toHaveBeenCalledWith(url);
    vi.mocked(network.publicShareFetch).mockImplementation(async () => new Response(publicConversationHtml(), { status: 404 }));
    await expect(importShare(url)).rejects.toThrow(/not found; it may have been deleted or unshared/);
  });

  it('resumes from a share of this installation through the store, never the network', async () => {
    const store = await Store.create(':memory:');
    const { makeCoreActivities } = await import('../src/activities/core.js');
    const { WorldRegistry } = await import('../src/world/registry.js');
    const { ProfileResolver } = await import('../src/agent/profiles.js');
    try {
      await store.claimPersonalOrganization('owner');
      const project = await store.createProject('Shares');
      await store.kvSet('conversation-sharing:organization:org_personal', 'enabled');
      const source = await store.createTask({ projectId: project.id, title: 'Source', workflow: 'software-dev',
        workflowVersion: '1.26.0', params: { prompt: 'source' } });
      const share = await createShare(store, source.id, 'do', [
        { id: 'a', role: 'user', text: 'Which **index** do we drop?', ts: 1 },
        { id: 'b', role: 'agent', text: 'Drop `idx_old`; keep    the other.', ts: 2 }] as any);
      const seen: string[] = [];
      const adapters = new Map([['mock', { provider: 'mock', async runTurn(input: any) {
        seen.push(input.messages.map((m: any) => m.text).join('\n'));
        return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: 'ok' };
      } }]]) as any;
      const worlds = new WorldRegistry();
      const core = makeCoreActivities({ store, worlds, adapters, profiles: new ProfileResolver(store, 'mock') } as any);
      const run = async () => {
        const task = await store.createTask({ projectId: project.id, title: 'Fork', workflow: 'software-dev',
          workflowVersion: '1.26.0', params: { prompt: 'x' } });
        const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
        try {
          return await core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#0`, agentSlotGranted: true,
            worldHandle: world.handle, messages: [{ id: 'm1', role: 'user', text: 'continue', ts: 0 }],
            task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'x', project: {}, workflow: 'software-dev',
              agents: { do: { provider: 'mock', resumeFrom: { sessionId: `https://tavya.io/share/conversations/${share.id}` } } } },
          } as any);
        } finally { await world.destroy(); }
      };
      await run();
      expect(seen.at(-1)).toContain('Drop `idx_old`; keep    the other.');
      expect(seen.at(-1)).toContain('untrusted context');
      expect(network.publicShareFetch).not.toHaveBeenCalled();
      // Once revoked it is no longer this installation's to read: the link goes
      // through the guarded public fetch like any other.
      await revokeShare(store, source.id, 'do');
      await expect(run()).rejects.toThrow(/Unexpected share request/);
      expect(network.publicShareFetch).toHaveBeenCalledOnce();
    } finally { await store.close(); }
  });

  it('starts a task resuming from a Claude share link from its conversation', async () => {
    vi.mocked(network.publicShareFetch).mockImplementation(async () => new Response(
      fs.readFileSync(new URL('./fixtures/claude-chat-snapshot.json', import.meta.url)), { headers: { 'content-type': 'application/json' } }));
    const store = await Store.create(':memory:');
    const { makeCoreActivities } = await import('../src/activities/core.js');
    const { WorldRegistry } = await import('../src/world/registry.js');
    const { ProfileResolver } = await import('../src/agent/profiles.js');
    try {
      await store.claimPersonalOrganization('owner');
      const project = await store.createProject('Shares');
      const task = await store.createTask({ projectId: project.id, title: 'Fork', workflow: 'software-dev',
        workflowVersion: '1.26.0', params: { prompt: 'x' } });
      const seen: string[] = [];
      const adapters = new Map([['mock', { provider: 'mock', async runTurn(input: any) {
        seen.push(input.messages.map((m: any) => m.text).join('\n'));
        return { termination: { kind: 'success' as const, status: 'mock.completed' }, output: 'ok' };
      } }]]) as any;
      const worlds = new WorldRegistry();
      const core = makeCoreActivities({ store, worlds, adapters, profiles: new ProfileResolver(store, 'mock') } as any);
      const world = await worlds.create('memory', { taskId: task.id, base: 'main' });
      try {
        await core.runAgentTurn({ taskId: task.id, role: 'do', agentTurnId: `${task.id}#0`, agentSlotGranted: true,
          worldHandle: world.handle, messages: [{ id: 'm1', role: 'user', text: 'continue', ts: 0 }],
          task: { taskId: task.id, projectId: project.id, title: task.title, prompt: 'x', project: {}, workflow: 'software-dev',
            agents: { do: { provider: 'mock', resumeFrom: { sessionId: 'https://claude.ai/share/e510a898-8e59-4423-b613-12c7c5ac37a5' } } } },
        } as any);
      } finally { await world.destroy(); }
      expect(seen.at(-1)).toContain('Plan the oversight experiments.');
      expect(seen.at(-1)).toContain('untrusted context');
    } finally { await store.close(); }
  });
});

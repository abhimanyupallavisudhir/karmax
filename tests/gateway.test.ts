import * as __asyncCollections from '../src/util/async-collections.js';
import { platformToolHandlers } from '../src/agent/tools.js';
import { AuthorizationService } from '../src/platform/authorization.js';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootHarness, Harness } from './helpers/harness.js';
import { git } from '../src/world/git.js';
import { previewLeaseOrigin } from '../src/gateway/previews.js';
import { GitHubAppService, GITHUB_APP_PRIVATE_KEY_HANDLE } from '../src/integrations/github-app.js';
import { detectConversationImport } from '../src/store/conversation-imports.js';
import { makeCoordinatorActivities } from '../src/activities/coordinator.js';
import { TASK_QUEUE } from '../src/temporal/config.js';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';

const webDir = fileURLToPath(new URL('../web', import.meta.url));

describe('gateway HTTP API (real server end-to-end)', () => {
  let h: Harness;
  let base: string;
  let token: string;
  let loginRoot: string;
  let loginHomes: ConfigHomeManager;
  const auth = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

  beforeAll(async () => {
    loginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-login-homes-'));
    loginHomes = new ConfigHomeManager(loginRoot);
    h = await bootHarness('mock', undefined, { configHomes: loginHomes });
    const gw = await h.startGateway();
    base = gw.url;
    const session: any = await (await fetch(`${base}/api/session`)).json();
    token = session.token;
    expect(session.authRequired).toBe(false);
  }, 60_000);
  afterAll(async () => {
    await h?.stop();
    if (loginRoot) fs.rmSync(loginRoot, { recursive: true, force: true });
  });

  it('changes the principal attempt through HTTP and preserves the Merge winner', async () => {
    const project = (await h.store.createProject('Principal selection'));
    const first = (await h.store.createTask({ projectId: project.id, title: 'Attempts', workflow: 'script-exec', workflowVersion: '1.0.0', params: { prompt: 'test' } }));
    const second = (await h.store.createTask({ projectId: project.id, title: 'Attempts', workflow: 'script-exec', workflowVersion: '1.0.0', params: { prompt: 'test', draft: true }, intentId: first.intentId }));
    const select = (id: string) => fetch(`${base}/api/tasks/${id}/principal`, { method: 'POST', headers: auth(), body: '{}' });
    const response = await select(second.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ principalAttemptId: second.id });
    expect((await h.store.listTasks(project.id))[0]!.id).toBe(second.id);
    (await h.store.claimAttempt(first.id));
    expect((await select(second.id)).status).toBe(400);
    expect((await h.store.attemptGroup(first.id))!.principalAttemptId).toBe(first.id);
    expect((await select('missing-attempt')).status).toBe(404);
  });

  it('serves meta with the detected agent provider', async () => {
    const meta: any = await (await fetch(`${base}/api/meta`)).json();
    expect(meta.version).toBeTruthy();
    expect(meta.agent.provider).toBeTruthy();
    expect(meta.resolveAgentEnabled).toBe(false);
    // The console needs to know whether host-machine affordances are worth showing.
    expect(meta.hostLocal).toBe(true);
  });

  it('exposes the new models to the browser through the authenticated catalog API', async () => {
    const response = await fetch(`${base}/api/models`, { headers: auth() });
    expect(response.status).toBe(200);
    const catalog: any = await response.json();
    expect(catalog.providers.claude.map((m: any) => m.id)).toContain('claude-opus-5-5');
    expect(catalog.providers.codex.map((m: any) => m.id))
      .toEqual(expect.arrayContaining(['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna']));
  });

  it('accepts only recognized project-scoped conversation files', async () => {
    const project = (await h.store.createProject('Conversation imports'));
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const history = Buffer.from(JSON.stringify({
      parentUuid: null, isSidechain: false, userType: 'external', cwd: '/tmp/source',
      sessionId, version: '2.1.0', gitBranch: 'main', type: 'user',
      message: { role: 'user', content: 'Carry this context forward.' },
      uuid: '10000000-0000-4000-8000-000000000001', timestamp: '2026-08-01T10:00:00Z',
    }) + '\n');
    const uploaded = await fetch(`${base}/api/conversation-imports?projectId=${project.id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent('Claude conversation.jsonl') },
      body: history,
    });
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toMatchObject({
      name: 'Claude conversation.jsonl', bytes: history.length, format: 'claude-code', projectId: project.id,
    });
    const invalid = await fetch(`${base}/api/conversation-imports?projectId=${project.id}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: Buffer.from('not a conversation'),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as any).error).toContain('Codex or Claude');
  });

  it('downloads a frozen standalone native Codex history with matching handoff metadata', async () => {
    const project = (await h.store.createProject('Native conversation export'));
    const task = (await h.store.createTask({
      projectId: project.id, title: 'Export this agent', workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: 'Keep the native history', draft: true },
    }));
    (await h.store.saveView(task.id, {
      taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
      messages: [{ id: 'm1', role: 'agent', text: 'Visible reply', ts: 1 }],
      transcripts: [{ role: 'do', label: 'Agent', messages: [{ id: 'm1', role: 'agent', text: 'Visible reply', ts: 1 }] }],
      actions: [],
    } as any));
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-native-download-'));
    const sessionDir = path.join(nativeHome, 'sessions', '2026', '08', '25');
    const nativeHistory = Buffer.from('{"type":"session_meta","payload":{"id":"22222222-2222-4222-8222-222222222222"}}\n{"type":"response_item","payload":{"role":"assistant"}}\n');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, `rollout-2026-08-25T00-00-00-${sessionId}.jsonl`), nativeHistory);
    (await h.store.kvSet(`session:${task.id}:do`, sessionId));
    // Historical tasks may predate provider-in-sessionmeta. The gateway should
    // infer it from the retained native file instead of hiding the handoff.
    (await h.store.kvSet(`sessionmeta:${task.id}:do`, JSON.stringify({ home: nativeHome })));
    try {
      const read = vi.spyOn(fs, 'readFileSync');
      try {
        const metadata: any = await (await fetch(`${base}/api/tasks/${task.id}/sessions?metadata=1`, { headers: auth() })).json();
        expect(metadata.do).toMatchObject({ id: sessionId, provider: 'codex', downloadable: true });
        expect(metadata.do.exportId).toBeUndefined();
        expect(metadata.do.downloadUrl).toBeUndefined();
        expect(read.mock.calls.some(([file]) => String(file).includes(sessionId))).toBe(false);
      } finally { read.mockRestore(); }
      const sessions: any = await (await fetch(`${base}/api/tasks/${task.id}/sessions`, { headers: auth() })).json();
      expect(sessions.do).toMatchObject({ id: sessionId, provider: 'codex', downloadable: true, requiredCodexVersion: '0.156.1' });
      const response = await fetch(`${base}${sessions.do.downloadUrl}`, { headers: auth() });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/x-ndjson');
      expect(response.headers.get('content-disposition')).toContain(sessions.do.filename);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('x-karmax-conversation-source')).toBe('native');
      const downloaded = Buffer.from(await response.arrayBuffer());
      const records = downloaded.toString().trim().split('\n').map((line) => JSON.parse(line));
      expect(records[0].payload.id).toBe(sessions.do.exportId);
      expect(records[0].payload.history_base).toBeUndefined();
      expect(records[1].payload).toEqual(JSON.parse(nativeHistory.toString().trim().split('\n')[1]!).payload);
      expect(fs.readFileSync(path.join(sessionDir, `rollout-2026-08-25T00-00-00-${sessionId}.jsonl`))).toEqual(nativeHistory);
      fs.appendFileSync(path.join(sessionDir, `rollout-2026-08-25T00-00-00-${sessionId}.jsonl`), '{"type":"response_item","payload":{"role":"user"}}\n');
      const again = await fetch(`${base}${sessions.do.downloadUrl}`, { headers: auth() });
      expect(Buffer.from(await again.arrayBuffer())).toEqual(downloaded);
    } finally {
      fs.rmSync(nativeHome, { recursive: true, force: true });
    }
  });

  it('keeps task-native downloads available after deleting and reconnecting the source login', async () => {
    const project = (await h.store.createProject('Disconnected source history'));
    const task = (await h.store.createTask({ projectId: project.id, title: 'Completed source',
      workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'source', draft: true } }));
    (await h.store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow,
      stage: 'done', status: 'done', messages: [], actions: [] } as any));
    const session = crypto.randomUUID();
    const home = loginHomes.ensure('codex', 'retention');
    fs.mkdirSync(path.join(home, 'sessions'));
    fs.writeFileSync(path.join(home, 'sessions', `rollout-2026-08-14T00-00-00-${session}.jsonl`),
      JSON.stringify({ type: 'session_meta', payload: { id: session, timestamp: '2026-08-14T00:00:00Z' } }) + '\n' +
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'Retain this native context.' },
      ] } }) + '\n');
    fs.writeFileSync(path.join(home, 'auth.json'), '{"token":"old-token"}');
    (await h.store.kvSet(`session:${task.id}:do`, session));
    (await h.store.kvSet(`sessionmeta:${task.id}:do`, JSON.stringify({ home, provider: 'codex' })));
    const deleted = await fetch(`${base}/api/organizations/org_personal/accounts/logins/codex/retention`, {
      method: 'DELETE', headers: auth(),
    });
    expect(deleted.status).toBe(200);
    expect(loginHomes.list().some(login => login.account === 'retention')).toBe(false);
    expect(fs.existsSync(path.join(home, 'auth.json'))).toBe(false);
    // Request the first export AFTER deletion, so an already-frozen export cannot mask data loss.
    const sessions: any = await (await fetch(`${base}/api/tasks/${task.id}/sessions`, { headers: auth() })).json();
    expect(sessions.do).toMatchObject({ id: session, provider: 'codex', downloadable: true });
    const downloaded = await fetch(`${base}${sessions.do.downloadUrl}`, { headers: auth() });
    expect(downloaded.status, await downloaded.clone().text()).toBe(200);
    expect(downloaded.headers.get('x-karmax-conversation-source')).toBe('native');
    expect(await downloaded.text()).toContain('Retain this native context.');
    const reconnected = await fetch(`${base}/api/organizations/org_personal/accounts/connect`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ provider: 'codex', account: 'retention' }),
    });
    expect(reconnected.status).toBe(200);
    expect(loginHomes.list().some(login => login.account === 'retention')).toBe(true);
    expect((await h.store.kvGet(`sessionmeta:${task.id}:do`))).toBe(JSON.stringify({ home, provider: 'codex' }));
    const after: any = await (await fetch(`${base}/api/tasks/${task.id}/sessions`, { headers: auth() })).json();
    expect(after.do).toMatchObject({ id: session, downloadable: true });
  });

  it('generates forkable JSONL for a new API-backed conversation with no config home', async () => {
    const project = (await h.store.createProject('Generated conversation export'));
    const task = (await h.store.createTask({
      projectId: project.id, title: 'API-backed agent', workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: 'Export the durable transcript', draft: true },
    }));
    (await h.store.saveView(task.id, {
      taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'done', actions: [],
      agents: { do: { provider: 'codex' } },
      messages: [
        { id: 'u1', role: 'user', text: 'This came through the API rail.', ts: Date.parse('2026-08-25T11:00:00Z') },
        { id: 'a1', role: 'agent', text: 'It is still portable.', ts: Date.parse('2026-08-25T11:00:01Z') },
      ],
      transcripts: [{ role: 'do', label: 'Agent', messages: [
        { id: 'u1', role: 'user', text: 'This came through the API rail.', ts: Date.parse('2026-08-25T11:00:00Z') },
        { id: 'a1', role: 'agent', text: 'It is still portable.', ts: Date.parse('2026-08-25T11:00:01Z') },
      ] }],
    } as any));

    const sessions: any = await (await fetch(`${base}/api/tasks/${task.id}/sessions`, { headers: auth() })).json();
    expect(sessions.do).toMatchObject({ provider: 'codex', downloadable: true, generated: true });
    expect(sessions.do.exportId).toMatch(/^[a-f0-9-]{36}$/);
    expect(sessions.do.home).toBeUndefined();

    const response = await fetch(`${base}${sessions.do.downloadUrl}`, { headers: auth() });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-karmax-conversation-source')).toBe('generated');
    expect(response.headers.get('content-disposition')).toContain(sessions.do.filename);
    const data = Buffer.from(await response.arrayBuffer());
    expect(detectConversationImport(data)).toBe('codex');
    expect(data.toString('utf8')).toContain('It is still portable.');
    expect(JSON.parse(data.toString('utf8').split('\n')[0]!).payload.id).toBe(sessions.do.exportId);
  });

  it('uploads ordinary prompt files with project scope and durable task references', async () => {
    const project = (await h.store.createProject('Prompt files'));
    const other = (await h.store.createProject('Other prompt files'));
    const data = Buffer.from('customer,value\nAda,42\n');
    const uploaded = await fetch(`${base}/api/files?projectId=${project.id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/csv; charset=utf-8',
        'x-file-name': encodeURIComponent('../customer?.csv') },
      body: data,
    });
    expect(uploaded.status).toBe(200);
    const ref: any = await uploaded.json();
    expect(ref).toMatchObject({ name: 'customer_.csv', mediaType: 'text/csv', bytes: data.length });

    const download = await fetch(`${base}/api/attachments/${ref.id}?projectId=${project.id}&name=${encodeURIComponent(ref.name)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(data);
    expect(download.headers.get('content-disposition')).toContain("filename*=UTF-8''customer_.csv");
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');

    const hidden = await fetch(`${base}/api/attachments/${ref.id}?projectId=${other.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(hidden.status).toBe(404);

    const task = await fetch(`${base}/api/projects/${project.id}/tasks`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ title: 'Read CSV', prompt: 'Inspect it', files: [ref], draft: true }),
    });
    expect(task.status).toBe(200);
    expect((await task.json() as any).params.files).toEqual([ref]);
  });

  it('reports private-install entitlements without hosted restrictions', async () => {
    const organizationId = (await h.store.getProject((await h.store.listProjects())[0]?.id ?? ''))?.organizationId ?? 'org_personal';
    const currentMemberCount = (await h.store.listOrganizationMemberships(organizationId)).length;
    const response = await fetch(`${base}/api/organizations/${organizationId}/entitlements`, { headers: auth() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      deployment: 'private', plan: null, maxMembers: null, maxActiveAgentRuns: null,
      currentMemberCount, overMemberLimit: false,
      memberAdmissionAllowed: true, agentRunAdmissionAllowed: true,
      unlimitedProjects: true, activeAgentRuns: 0, queuedAgentRuns: 0,
    });
  });

  it('keeps untrusted preview hosts outside the app/API origin', async () => {
    const previous = process.env.KARMAX_PREVIEW_ORIGIN;
    process.env.KARMAX_PREVIEW_ORIGIN = 'http://preview.invalid';
    try {
      const target = new URL(base);
      const blocked = await new Promise<number>((resolve, reject) => {
        const request = http.request({ hostname: target.hostname, port: target.port, path: '/api/meta',
          headers: { host: 'p-deadbeef.preview.invalid' } }, (response) => {
          response.resume(); resolve(response.statusCode ?? 0);
        });
        request.on('error', reject); request.end();
      });
      expect(blocked).toBe(404);
      // A stopped preview answers a person with a page and a program with JSON
      // (task 364: the tab showed a TLS error and nothing else).
      const stopped = (accept: string) => new Promise<{ status: number; type: string; body: string }>((resolve, reject) => {
        const request = http.request({ hostname: target.hostname, port: target.port, path: '/preview/lease-gone/',
          headers: { host: new URL(previewLeaseOrigin('lease-gone')).host, accept } }, (response) => {
          let body = '';
          response.on('data', (chunk) => { body += chunk; });
          response.on('end', () => resolve({ status: response.statusCode ?? 0,
            type: String(response.headers['content-type']), body }));
        });
        request.on('error', reject); request.end();
      });
      const page = await stopped('text/html,application/xhtml+xml');
      expect(page).toMatchObject({ status: 404, type: expect.stringContaining('text/html') });
      expect(page.body).toContain('This preview has stopped');
      expect(JSON.parse((await stopped('application/json')).body)).toEqual({ error: 'preview not found or expired' });
      const redirected = await fetch(`${base}/preview/lease-1/`, { redirect: 'manual' });
      expect(redirected.status).toBe(307);
      expect(redirected.headers.get('location')).toMatch(/^http:\/\/p-[a-f0-9]{24}\.preview\.invalid\/preview\/lease-1\/$/);
    } finally {
      if (previous === undefined) delete process.env.KARMAX_PREVIEW_ORIGIN;
      else process.env.KARMAX_PREVIEW_ORIGIN = previous;
    }
  });

  it('exposes contributions (slots, commands, event schemas)', async () => {
    const c: any = await (await fetch(`${base}/api/contributions`, { headers: auth() })).json();
    expect(c.commands.find((x: any) => x.id === 'nav.newTask')).toBeTruthy();
    expect(c.commands.find((x: any) => x.id === 'nav.notifications')?.keybinding).toBe('g N');
    expect(c.commands.find((x: any) => x.id === 'nav.activity')).toBeUndefined();
    expect(c.slots.some((s: any) => s.contribution.slot === 'task-detail')).toBe(true);
    expect(c.events.some((e: any) => e.type === 'software-dev.merged')).toBe(true);
    expect(c.slots.some((s: any) => s.workflow === 'agent-queue' && s.contribution.slot === 'queue-panel')).toBe(true);
    const platform: any = await (await fetch(`${base}/api/platform`, { headers: auth() })).json();
    expect(platform.conversations).toContain('GET /api/tasks/:taskId/agents');
    expect(platform.administration).toContain('GET|POST /api/users');
  });

  it('persists host capacity and applies it to the agent-queue workflow', async () => {
    const saved = await fetch(`${base}/api/settings/global/agent-queue`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ values: { capacity: 2 } }),
    });
    expect(saved.status).toBe(200);
    expect(await (await fetch(`${base}/api/settings/global/agent-queue`, { headers: auth() })).json()).toEqual({ capacity: 2 });
    await expect.poll(async () => {
      const q: any = await (await fetch(`${base}/api/agent-queue`, { headers: auth() })).json();
      return q.capacity;
    }, { timeout: 10_000 }).toBe(2);

    const invalid = await fetch(`${base}/api/settings/global/agent-queue`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ values: { capacity: 0 } }),
    });
    expect(invalid.status).toBe(400);
  });

  it('inherits explanation defaults from organization to project', async () => {
    const project = (await h.store.createProject('Explanation defaults'));
    const organizationId = project.organizationId ?? 'org_personal';
    const initial: any = await (await fetch(`${base}/api/projects/${project.id}/explanation-settings`, { headers: auth() })).json();
    expect(initial.effective).toMatchObject({
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'google/gemini-3.6-flash',
    });

    const organizationSave = await fetch(`${base}/api/organizations/${organizationId}/explanation-settings`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ values: { model: 'google/gemini-custom' } }),
    });
    expect(organizationSave.status).toBe(200);
    const inherited: any = await (await fetch(`${base}/api/projects/${project.id}/explanation-settings`, { headers: auth() })).json();
    expect(inherited.own).toEqual({});
    expect(inherited.effective.model).toBe('google/gemini-custom');

    const projectSave = await fetch(`${base}/api/projects/${project.id}/explanation-settings`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ values: { model: 'anthropic/claude-haiku' } }),
    });
    expect(projectSave.status).toBe(200);
    const overridden: any = await projectSave.json();
    expect(overridden.effective.model).toBe('anthropic/claude-haiku');
    expect(overridden.effective.endpoint).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('returns an explanation source that aged out of the bounded conversation window', async () => {
    const project = (await h.store.createProject('Explanation source recovery'));
    const task = (await h.store.createTask({
      projectId: project.id,
      title: 'Long-running conversation',
      workflow: 'software-dev',
      workflowVersion: '1.0.0',
      params: { prompt: 'Explain the old response', draft: true },
    }));
    const sourceSeq = (await h.store.appendEvent({ taskId: task.id, type: 'agent.activity', ts: 10, payload: {
      role: 'do', turnId: 'turn-old', attempt: 1, id: 'reply-old', kind: 'message', phase: 'completed', title: 'Old response',
    } }));
    (await h.store.appendEvent({ taskId: task.id, type: 'conversation.explanation', ts: 20, payload: {
      role: 'do', sourceKey: `activity:${sourceSeq}`, text: 'Plain-language version',
    } }));

    const response = await fetch(`${base}/api/tasks/${task.id}/explanations`, { headers: auth() });
    expect(response.status).toBe(200);
    const explanations = await response.json() as any[];
    expect(explanations[0]).toMatchObject({
      payload: {
        sourceKey: `activity:${sourceSeq}`,
        sourceEvent: { seq: sourceSeq, type: 'agent.activity', payload: { id: 'reply-old', title: 'Old response' } },
      },
    });
  });

  it('serves brand assets resolved against the instance-wide icon setting', async () => {
    const asset = (p: string) => fetch(`${base}${p}`); // deliberately unauthenticated: the sign-in screen needs these
    const bytes = async (p: string) => Buffer.from(await (await asset(p)).arrayBuffer());
    const variant = (icon: string) =>
      fs.readFileSync(path.join(webDir, 'brand', icon, 'icon-192.png'));

    // Unset → the diamond, and its vector art is available.
    expect(await bytes('/brand/icon-192.png')).toEqual(variant('diamond'));
    const svg = await asset('/brand/icon.svg');
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');

    const saved = await fetch(`${base}/api/settings/global/appearance`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ values: { icon: 'knot' } }),
    });
    expect(saved.status).toBe(200);
    expect(await (await fetch(`${base}/api/settings/global/appearance`, { headers: auth() })).json()).toEqual({ icon: 'knot' });

    // The same URLs now serve the new artwork — that is what reskins the favicon.
    const png = await asset('/brand/icon-192.png');
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('cache-control')).toBe('no-cache');
    expect(Buffer.from(await png.arrayBuffer())).toEqual(variant('knot'));
    expect(await bytes('/brand/apple-touch-icon.png'))
      .toEqual(fs.readFileSync(path.join(webDir, 'brand', 'knot', 'apple-touch-icon.png')));
    // The knot ships no SVG, so the browser falls through to the PNG <link>.
    expect((await asset('/brand/icon.svg')).status).toBe(404);

    // Per-variant paths stay addressable, so the settings picker can preview them.
    expect(await bytes('/brand/diamond/icon-192.png')).toEqual(variant('diamond'));

    const invalid = await fetch(`${base}/api/settings/global/appearance`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ values: { icon: '../diamond' } }),
    });
    expect(invalid.status).toBe(400);
    // A rejected write leaves the previous choice intact.
    expect(await bytes('/brand/icon-192.png')).toEqual(variant('knot'));

    // The mark is instance-wide, so changing it is the operator's alone: a
    // developer holds neither settings:read nor settings:write, which is also
    // what makes the settings card hide itself below that level.
    const dev = (await h.tokens.mintPrincipal('user:dev', ['task:*', 'project:read'])).token;
    const devAuth = { authorization: `Bearer ${dev}`, 'content-type': 'application/json' };
    expect((await fetch(`${base}/api/settings/global/appearance`, {
      method: 'PUT', headers: devAuth, body: JSON.stringify({ values: { icon: 'clover' } }),
    })).status).toBe(403);
    expect((await fetch(`${base}/api/settings/global/appearance`, { headers: devAuth })).status).toBe(403);
    // …and the unauthorized attempt changed nothing.
    expect(await bytes('/brand/icon-192.png')).toEqual(variant('knot'));

    await fetch(`${base}/api/settings/global/appearance`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ values: { icon: 'diamond' } }),
    });
  });

  it('selects every gold logo and serves its preview, favicon and installed app assets', async () => {
    for (const icon of ['gold-check', 'gold-arrow', 'bold-gold-check', 'bold-gold-arrow', 'royal-gold-check', 'royal-gold-arrow']) {
      const saved = await fetch(`${base}/api/settings/global/appearance`, {
        method: 'PUT', headers: auth(), body: JSON.stringify({ values: { icon } }),
      });
      expect(saved.status, icon).toBe(200);
      expect(await (await fetch(`${base}/api/settings/global/appearance`, { headers: auth() })).json()).toEqual({ icon });
      for (const file of ['icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
        const expected = fs.readFileSync(path.join(webDir, 'brand', icon, file));
        for (const url of [`/brand/${icon}/${file}`, `/brand/${file}`]) {
          const response = await fetch(`${base}${url}`);
          expect(response.status, url).toBe(200);
          expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
        }
      }
    }
    await fetch(`${base}/api/settings/global/appearance`, {
      method: 'PUT', headers: auth(), body: JSON.stringify({ values: { icon: 'diamond' } }),
    });
  });

  it('omits the disabled Resolve agent from schemas and profiles', async () => {
    const schemas = (await (await fetch(`${base}/api/schema`, { headers: auth() })).json()) as any[];
    const softwareDev = schemas.find((s) => s.name === 'software-dev');
    expect(softwareDev.params.some((f: any) => f.role === 'resolve' || f.name === 'agent:resolve')).toBe(false);
    expect(softwareDev.stages.some((s: any) => s.key === 'resolve' || s.aliases?.includes('resolve'))).toBe(false);

    const profiles = (await (await fetch(`${base}/api/profiles`, { headers: auth() })).json()) as any[];
    expect(profiles.some((p) => p.role === 'resolve')).toBe(false);

    const rejected = await fetch(`${base}/api/profiles`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ id: 'resolve-default', role: 'resolve', name: 'Resolve agent', provider: 'mock' }),
    });
    expect(rejected.status).toBe(400);

    // Historical session rows may remain in SQLite, but the disabled role must
    // not leak back into the task UI's session payload.
    (await h.store.kvSet('session:legacy-task:resolve', 'legacy-session'));
    const sessions: any = await (await fetch(`${base}/api/tasks/legacy-task/sessions`, { headers: auth() })).json();
    expect(sessions.resolve).toBeUndefined();
  });

  it('rejects unauthenticated API calls', async () => {
    const res = await fetch(`${base}/api/projects`);
    expect(res.status).toBe(401);
  });

  it('enforces capability, delegated-subject, interactive-presence, scope, and audit independently', async () => {
    const organization = (await h.store.createOrganization({ name: 'Delegated identity' }));
    const project = (await h.store.createProject('Delegated project', {}, organization.id));
    const human = (await h.tokens.mintPrincipal('user:delegator', ['project:read', 'repository:read', 'repository:write'],
      project.id, 60_000, organization.id));
    const delegation = (await h.tokens.delegateHuman(human.token, {
      taskId: 'task-delegated', projectId: project.id, organizationId: organization.id,
      externalIdentities: { githubAccountId: 'acct-42' },
    }))!;
    const delegated = (await h.tokens.mint({
      taskId: 'task-delegated', profileId: 'maintainer', role: 'do', principal: 'user:delegator',
      projectId: project.id, organizationId: organization.id,
      ceiling: ['project:read', 'repository:read', 'repository:write'],
      grantorCaps: ['project:read', 'repository:read', 'repository:write'], delegationId: delegation.id,
    }));
    const delegatedAuth = { authorization: `Bearer ${delegated.token}`, 'content-type': 'application/json' };

    // The subject check passes. This test gateway has no GitHub App, so the
    // request reaches integration availability instead of the old browser-only gate.
    const create = await fetch(`${base}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST', headers: delegatedAuth, body: JSON.stringify({ gitConnectionId: 'missing', name: 'delegated-repo' }),
    });
    expect(create.status).toBe(503);
    expect(await create.json()).toMatchObject({ error: expect.stringMatching(/GitHub App/i) });

    const repository = (await h.store.upsertRepository({ organizationId: organization.id, provider: 'github',
      owner: 'acme', name: 'delegated-repo', sshUrl: 'git@github.com:acme/delegated-repo.git',
      defaultBranch: 'main', private: true }));
    const attach = await fetch(`${base}/api/projects/${project.id}/repositories`, {
      method: 'POST', headers: delegatedAuth, body: JSON.stringify({ repositoryId: repository.id }),
    });
    expect(attach.status).toBe(200);
    expect(((await attach.json()) as any).repositoryId).toBe(repository.id);

    const capabilityDenied = (await h.tokens.mint({
      taskId: 'task-capability-denied', profileId: 'developer', role: 'do', principal: 'user:delegator',
      projectId: project.id, organizationId: organization.id, ceiling: ['project:read'], grantorCaps: ['project:read'],
      delegationId: (await h.tokens.deriveHumanDelegation(delegation.id, {
        taskId: 'task-capability-denied', projectId: project.id, organizationId: organization.id,
      })).id,
    }));
    expect((await fetch(`${base}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST', headers: { authorization: `Bearer ${capabilityDenied.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })).status).toBe(403);

    const noSubject = (await h.tokens.mint({ taskId: 'task-autonomous', profileId: 'maintainer', role: 'do',
      principal: 'autonomous:worker', projectId: project.id, organizationId: organization.id,
      ceiling: ['repository:write'], grantorCaps: ['repository:write'] }));
    const noSubjectResponse = await fetch(`${base}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST', headers: { authorization: `Bearer ${noSubject.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(noSubjectResponse.status).toBe(403);
    expect(await noSubjectResponse.json()).toMatchObject({ error: expect.stringMatching(/verified human subject/i) });

    const interactiveOnly = await fetch(`${base}/api/user/export`, { headers: delegatedAuth });
    expect(interactiveOnly.status).toBe(401);
    expect(await interactiveOnly.json()).toMatchObject({ error: 'a signed-in user account is required' });

    const audit = (await h.store.auditSince(0, 2000)).find((event) =>
      event.action === 'http.post.repository:write' && event.detail.path.endsWith('/repositories/create')
      && event.principalId === 'task-agent:task-delegated:do');
    expect(audit).toMatchObject({
      detail: { actor: { kind: 'task-agent', taskId: 'task-delegated' },
        humanSubject: { kind: 'user', userId: 'delegator', presence: 'delegated' } },
    });
  });

  it('carries a verified pinned subject into the next token after an existing task is elevated', async () => {
    const organization = (await h.store.createOrganization({ name: 'Authorization delegation repair', ownerUserId: 'delegator' }));
    const project = (await h.store.createProject('Authorization delegation project', {}, organization.id));
    const legacy = (await h.store.createTask({
      projectId: project.id, title: 'Existing repository task', workflow: 'software-dev', workflowVersion: '1.0.0',
      createdBy: { kind: 'user', userId: 'delegator' },
      params: { prompt: 'create the repository', draft: true, _githubAccountId: 'acct-42',
        _authorization: { profileId: 'developer', capabilities: ['task:*'], principal: 'user:delegator' } } as any,
    }));
    const human = (await h.tokens.mintPrincipal('user:delegator',
      ['task:create', 'task:edit', 'repository:write'], project.id, 60_000, organization.id));
    const elevatedResponse = await fetch(`${base}/api/tasks/${legacy.id}/authorization`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${human.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'maintainer' }),
    });
    expect(elevatedResponse.status).toBe(200);
    const elevated: any = await elevatedResponse.json();
    expect(elevated.params._authorization).toMatchObject({
      capabilities: expect.arrayContaining(['repository:write']),
      delegationId: expect.stringMatching(/^dlg_/),
    });
    expect(elevated.params._githubAccountId).toBe('acct-42');

    // This is the same mint performed when Retry/Resume schedules the next agent
    // turn: it reloads the updated grant + delegation from the durable task.
    const resumed = (await h.tokens.mint({
      taskId: legacy.id, profileId: 'do', role: 'do', principal: 'user:delegator',
      projectId: project.id, organizationId: organization.id,
      ceiling: ['repository:write'], grantorCaps: elevated.params._authorization.capabilities,
      delegationId: elevated.params._authorization.delegationId,
    }));
    expect(resumed.record.humanSubject).toMatchObject({
      userId: 'delegator', presence: 'delegated', externalIdentities: { githubAccountId: 'acct-42' },
    });
    const passedSubjectGate = await fetch(`${base}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${resumed.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'must-not-be-created' }),
    });
    // No GitHub App is wired in this gateway. Reaching its availability check
    // proves the repository route accepted the delegated human subject.
    expect(passedSubjectGate.status).toBe(503);
    expect(await passedSubjectGate.json()).toMatchObject({ error: expect.stringMatching(/GitHub App/i) });

    const autonomousTask = (await h.store.createTask({
      projectId: project.id, title: 'Autonomous repository task', workflow: 'software-dev', workflowVersion: '1.0.0',
      params: { prompt: 'create the repository', draft: true,
        _authorization: { profileId: 'developer', capabilities: ['task:*'], principal: 'autonomous:scheduler' } } as any,
    }));
    const autonomous = (await h.tokens.mintPrincipal('autonomous:scheduler',
      ['task:create', 'task:edit', 'repository:write'], project.id, 60_000, organization.id));
    const autonomousUpdate: any = await (await fetch(`${base}/api/tasks/${autonomousTask.id}/authorization`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${autonomous.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ profileId: 'maintainer' }),
    })).json();
    expect(autonomousUpdate.params._authorization.delegationId).toBeUndefined();
    const autonomousRetry = (await h.tokens.mint({
      taskId: autonomousTask.id, profileId: 'do', role: 'do', principal: 'autonomous:scheduler',
      projectId: project.id, organizationId: organization.id,
      ceiling: ['repository:write'], grantorCaps: autonomousUpdate.params._authorization.capabilities,
    }));
    const rejected = await fetch(`${base}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${autonomousRetry.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'must-not-be-created' }),
    });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ error: expect.stringMatching(/verified human subject/i) });
  });

  it('creates and attaches a repository for a delegated task with its authority-pinned GitHub account', async () => {
    const organization = (await h.store.createOrganization({ name: 'Delegated repository creation' }));
    const project = (await h.store.createProject('Delegated repository project', {}, organization.id));
    const calls: Array<{ path: string; method: string; authorization?: string }> = [];
    const fakeFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const authorization = new Headers(init.headers).get('authorization') ?? undefined;
      calls.push({ path: url.pathname, method: init.method ?? 'GET', authorization });
      if (url.pathname === '/user' && authorization === 'Bearer pinned-token')
        return Response.json({ id: 42, login: 'pinned-user' });
      if (url.pathname === '/user' && authorization === 'Bearer active-token')
        return Response.json({ id: 99, login: 'active-user' });
      if (url.pathname === '/orgs/acme/repos' && init.method === 'POST' && authorization === 'Bearer pinned-token')
        return Response.json({ id: 77, name: 'delegated-repo', private: true,
          ssh_url: 'git@github.com:acme/delegated-repo.git', default_branch: 'main', owner: { login: 'acme' } });
      if (url.pathname === '/orgs/acme/repos' && init.method === 'POST' && authorization === 'Bearer active-token')
        return Response.json({ id: 78, name: 'unpinned-repo', private: true,
          ssh_url: 'git@github.com:acme/unpinned-repo.git', default_branch: 'main', owner: { login: 'acme' } });
      if (url.pathname === '/user/installations/123/repositories/78' && init.method === 'PUT'
        && authorization === 'Bearer active-token') return new Response(null, { status: 204 });
      if (url.pathname === '/user/installations/123/repositories/77' && init.method === 'PUT'
        && authorization === 'Bearer pinned-token') return new Response(null, { status: 204 });
      if (url.pathname === '/app/installations/123/access_tokens' && init.method === 'POST')
        return Response.json({ token: 'installation-token', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    };
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
    (await h.broker.registerHandle(GITHUB_APP_PRIVATE_KEY_HANDLE, privateKey));
    const githubApp = (await GitHubAppService.create(h.store, h.broker,
      { appId: '1', fetch: fakeFetch as typeof fetch }));
    await githubApp.adoptUserAuthorization('delegator', '42', { accessToken: 'pinned-token' });
    await githubApp.adoptUserAuthorization('delegator', '99', { accessToken: 'active-token' });
    await githubApp.setActiveUserAccount('delegator', '99');
    const connection = (await h.store.upsertGitConnection({ organizationId: organization.id, provider: 'github',
      installationId: '123', accountLogin: 'acme', accountType: 'Organization' }));
    const githubGateway = await h.startGateway({ githubApp });

    const capabilities = ['project:read', 'repository:read', 'repository:write'] as const;
    const human = (await h.tokens.mintPrincipal('user:delegator', [...capabilities], project.id, 60_000, organization.id));
    const delegation = (await h.tokens.delegateHuman(human.token, {
      taskId: 'task-create-repository', projectId: project.id, organizationId: organization.id,
      externalIdentities: { githubAccountId: '42' },
    }))!;
    const delegated = (await h.tokens.mint({
      taskId: 'task-create-repository', profileId: 'maintainer', role: 'do', principal: 'user:delegator',
      projectId: project.id, organizationId: organization.id, ceiling: [...capabilities],
      grantorCaps: [...capabilities], delegationId: delegation.id,
    }));

    const delegatedAuth = { authorization: `Bearer ${delegated.token}`, 'content-type': 'application/json' };
    const createdResponse = await fetch(
      `${githubGateway.url}/api/organizations/${organization.id}/repositories/create`, {
        method: 'POST', headers: delegatedAuth, body: JSON.stringify({
          gitConnectionId: connection.id, name: 'delegated-repo', description: 'Created by a delegated task', private: true,
        }),
      });
    const repository = await createdResponse.json() as any;
    expect({ status: createdResponse.status, error: repository.error }).toEqual({ status: 200, error: undefined });
    expect(repository).toMatchObject({ owner: 'acme', name: 'delegated-repo', private: true,
      gitConnectionId: connection.id });
    expect(calls).toContainEqual({ path: '/orgs/acme/repos', method: 'POST', authorization: 'Bearer pinned-token' });
    expect(calls.some((call) => call.authorization === 'Bearer active-token' && call.method === 'POST')).toBe(false);

    const attachedResponse = await fetch(`${base}/api/projects/${project.id}/repositories`, {
      method: 'POST', headers: delegatedAuth, body: JSON.stringify({ repositoryId: repository.id }),
    });
    expect(attachedResponse.status).toBe(200);
    expect(await attachedResponse.json()).toMatchObject({ projectId: project.id, repositoryId: repository.id });
    expect((await h.store.listProjectRepositories(project.id))).toEqual([
      expect.objectContaining({ projectId: project.id, repositoryId: repository.id,
        repository: expect.objectContaining({ name: 'delegated-repo' }) }),
    ]);

    const denied = (await h.tokens.mint({ taskId: 'task-repository-denied', profileId: 'developer', role: 'do',
      principal: 'user:delegator', projectId: project.id, organizationId: organization.id,
      ceiling: ['project:read'], grantorCaps: ['project:read'] }));
    expect((await fetch(`${githubGateway.url}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST', headers: { authorization: `Bearer ${denied.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ gitConnectionId: connection.id, name: 'denied-repo' }),
    })).status).toBe(403);

    const unpinnedDelegation = (await h.tokens.delegateHuman(human.token, {
      taskId: 'task-repository-unpinned', projectId: project.id, organizationId: organization.id,
    }))!;
    const unpinned = (await h.tokens.mint({ taskId: 'task-repository-unpinned', profileId: 'maintainer', role: 'do',
      principal: 'user:delegator', projectId: project.id, organizationId: organization.id,
      ceiling: ['repository:write'], grantorCaps: ['repository:write'], delegationId: unpinnedDelegation.id }));
    const unpinnedResponse = await fetch(`${githubGateway.url}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST', headers: { authorization: `Bearer ${unpinned.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ gitConnectionId: connection.id, name: 'unpinned-repo' }),
    });
    expect(unpinnedResponse.status).toBe(200);
    expect(await unpinnedResponse.json()).toMatchObject({ name: 'unpinned-repo' });
    expect(calls).toContainEqual({ path: '/orgs/acme/repos', method: 'POST', authorization: 'Bearer active-token' });

    const substitutedDelegation = (await h.tokens.delegateHuman(human.token, {
      taskId: 'task-repository-substituted', projectId: project.id, organizationId: organization.id,
      externalIdentities: { githubAccountId: '404' },
    }))!;
    const substituted = (await h.tokens.mint({ taskId: 'task-repository-substituted', profileId: 'maintainer', role: 'do',
      principal: 'user:delegator', projectId: project.id, organizationId: organization.id,
      ceiling: ['repository:write'], grantorCaps: ['repository:write'], delegationId: substitutedDelegation.id }));
    const substitutedResponse = await fetch(`${githubGateway.url}/api/organizations/${organization.id}/repositories/create`, {
      method: 'POST', headers: { authorization: `Bearer ${substituted.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ gitConnectionId: connection.id, name: 'substituted-repo' }),
    });
    expect(substitutedResponse.status).toBe(400);
    expect(await substitutedResponse.json()).toMatchObject({ error: expect.stringMatching(/pinned GitHub account is not connected/i) });
    expect(calls.filter((call) => call.path === '/orgs/acme/repos' && call.method === 'POST')).toHaveLength(2);

    const audits = (await h.store.auditSince(0, 5000)).filter((event) =>
      event.principalId === 'task-agent:task-create-repository:do');
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'http.post.repository:write', scopeKey: `organization:${organization.id}`,
        detail: expect.objectContaining({ path: `/api/organizations/${organization.id}/repositories/create`,
          actor: expect.objectContaining({ kind: 'task-agent', taskId: 'task-create-repository' }),
          humanSubject: { kind: 'user', userId: 'delegator', presence: 'delegated' } }) }),
      expect.objectContaining({ action: 'http.post.repository:write', scopeKey: `project:${project.id}`,
        detail: expect.objectContaining({ path: `/api/projects/${project.id}/repositories`,
          actor: expect.objectContaining({ kind: 'task-agent', taskId: 'task-create-repository' }) }) }),
    ]));
  });

  it('reorders projects for the sidebar', async () => {
    const make = async (name: string) => (await (await fetch(`${base}/api/projects`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ name }) })).json()) as any;
    const [one, two, three] = [await make('Ord one'), await make('Ord two'), await make('Ord three')];
    const listed = async () => ((await (await fetch(`${base}/api/projects`, { headers: auth() })).json()) as any[])
      .map((p) => p.name).filter((n: string) => n.startsWith('Ord '));
    expect(await listed()).toEqual(['Ord one', 'Ord two', 'Ord three']);

    // The drop names the project the dragged one now sits above.
    const moved = await fetch(`${base}/api/projects/${three.id}/reorder`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ before: one.id }) });
    expect(moved.status).toBe(200);
    expect(await listed()).toEqual(['Ord three', 'Ord one', 'Ord two']);

    // Omitting `before` drops it past the last project, and the new order sticks.
    await fetch(`${base}/api/projects/${three.id}/reorder`, { method: 'POST', headers: auth(), body: JSON.stringify({}) });
    expect(await listed()).toEqual(['Ord one', 'Ord two', 'Ord three']);
    await fetch(`${base}/api/projects/${two.id}/reorder`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ before: one.id }) });
    expect(await listed()).toEqual(['Ord two', 'Ord one', 'Ord three']);

    // A drop can also carry the sidebar folder the row landed in…
    const filed = async () => ((await (await fetch(`${base}/api/projects`, { headers: auth() })).json()) as any[])
      .find((p) => p.id === two.id);
    await fetch(`${base}/api/projects/${two.id}/reorder`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ before: one.id, folder: 'Ops/Internal' }) });
    expect((await filed()).folder).toBe('Ops/Internal');
    // …and the settings form sends one path; the store infers both fields.
    const patched = await fetch(`${base}/api/projects/${two.id}`, { method: 'PATCH', headers: auth(),
      body: JSON.stringify({ name: 'Archive/Ord two' }) });
    expect(patched.status).toBe(200);
    expect(await filed()).toMatchObject({ name: 'Ord two', folder: 'Archive' });

    // Folder headers rename their whole subtree in one operation.
    const nested = await make('Archive/Nested/Ord nested');
    const folderRenamed = await fetch(`${base}/api/projects/${two.id}/folder`, { method: 'PATCH', headers: auth(),
      body: JSON.stringify({ folder: 'Archive', name: 'Filed' }) });
    expect(folderRenamed.status).toBe(200);
    expect(await folderRenamed.json()).toMatchObject({ folder: 'Filed' });
    expect(await filed()).toMatchObject({ name: 'Ord two', folder: 'Filed' });
    const afterFolderRename = (await (await fetch(`${base}/api/projects`, { headers: auth() })).json()) as any[];
    expect(afterFolderRename.find((project) => project.id === nested.id)).toMatchObject({ folder: 'Filed/Nested' });

    // The leaf name remains unique across folders in the same organization.
    const duplicate = await fetch(`${base}/api/projects/${two.id}`, { method: 'PATCH', headers: auth(),
      body: JSON.stringify({ name: 'Elsewhere/Ord one' }) });
    expect(duplicate.status).toBe(400);
    expect(((await duplicate.json()) as any).error).toMatch(/already exists/i);

    const missing = await fetch(`${base}/api/projects/proj_nope/reorder`, { method: 'POST', headers: auth(),
      body: JSON.stringify({}) });
    expect(missing.status).toBe(400);
    expect((await fetch(`${base}/api/projects/${one.id}/reorder`, { method: 'POST' })).status).toBe(401);
  });

  it('deletes provider worlds before committing project deletion', async () => {
    const project: any = await (await fetch(`${base}/api/projects`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ name: 'Disposable' }) })).json();
    const task = (await h.store.createTask({ projectId: project.id, title: 'Draft', workflow: 'just-do',
      workflowVersion: '1.0.0', params: { prompt: 'x', draft: true } }));
    const world = await h.worlds.create('memory', { taskId: task.id, base: 'main' });
    await world.writeFile('private.txt', 'private');
    (await h.store.registerWorld(world.handle, project.id));
    expect(fs.existsSync(world.handle.root)).toBe(true);

    const deleted = await fetch(`${base}/api/projects/${project.id}`, { method: 'DELETE', headers: auth() });
    expect(deleted.status).toBe(200);
    expect(fs.existsSync(world.handle.root)).toBe(false);
    expect((await h.store.getProject(project.id))).toBeUndefined();
    expect((await h.store.getTask(task.id))).toBeUndefined();
  });

  it('drives a full task lifecycle over HTTP and lands work', async () => {
    const repo = await h.makeRepo('gw');
    // create a project pointed at the repo
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'GW', config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }),
      })
    ).json();

    // create a software-dev task
    const task: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          title: 'HTTP task',
          prompt: '@write http.txt :: via the gateway\n@review http task done',
          workflow: 'software-dev',
        }),
      })
    ).json();
    expect(task.id).toMatch(/^task_/);

    // poll the view until Review
    let stage = '';
    for (let i = 0; i < 60 && stage !== 'review'; i++) {
      const v: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
      stage = v?.stage;
      if (stage !== 'review') await new Promise((r) => setTimeout(r, 250));
    }
    expect(stage).toBe('review');

    // tier-2 declarative widgets resolve against the live view-model (SPEC §10.2)
    const widgets: any = await (await fetch(`${base}/api/tasks/${task.id}/widgets`, { headers: auth() })).json();
    expect(widgets.length).toBeGreaterThan(0);
    const progress = widgets.find((g: any) => g.title === 'Progress');
    expect(progress).toBeTruthy();
    const byType = Object.fromEntries(progress.widgets.map((w: any) => [w.type, w]));
    expect(byType.badge.data).toBe('review'); // bound to view.stage
    expect(byType.gauge.data).toBeTruthy(); // merge-queue gauge
    expect(Array.isArray(byType.list.data)).toBe(true); // bound to changedFiles
    // the conversation thread is intentionally NOT duplicated here — the drawer's
    // (collapsible) conversation floor already shows it (task 1b).
    expect(byType.thread).toBeUndefined();

    // events endpoint returns a live log
    const events: any = await (await fetch(`${base}/api/tasks/${task.id}/events?since=0`, { headers: auth() })).json();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event: any) => event.type === 'agent.activity' && event.payload?.kind === 'file')).toBe(true);
    const reviewView: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
    expect(reviewView.messages[0].role).toBe('user');
    expect(reviewView.messages[0].ts).toBeGreaterThan(1_000_000_000_000);

    // confirm → merges
    await fetch(`${base}/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ signal: 'confirm' }),
    });
    for (let i = 0; i < 60; i++) {
      const v: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
      if (v?.stage === 'done') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const onMain = await git(repo, ['show', 'main:http.txt']);
    expect(onMain.stdout).toContain('via the gateway');

    // The task drawer can race the workflow's final close. Reproduce a stale
    // non-terminal snapshot left behind after the execution has completed.
    await h.client.workflow.getHandle(task.id).result();
    (await h.store.saveView(task.id, {
      ...(await h.store.getTask(task.id))!.lastView!,
      stage: 'resolve',
      status: 'waiting',
      actions: [{ name: 'cancel', kind: 'signal', label: 'Cancel', enabled: true, danger: true }],
    }));
    const lateCancel = await fetch(`${base}/api/tasks/${task.id}/signal`, {
      method: 'POST',
      headers: auth(),
      body: JSON.stringify({ signal: 'cancel' }),
    });
    expect(lateCancel.status).toBe(200);
    expect(await lateCancel.json()).toEqual({ ok: true });
    expect((await h.store.getTask(task.id))!.lastView).toMatchObject({
      stage: 'cancelled',
      status: 'cancelled',
      actions: [],
      state: { cancelled: true },
    });

    // insights reflect the project + task (started today, cancelled so not open)
    const insights: any = await (await fetch(`${base}/api/organizations/org_personal/insights?days=7`, { headers: auth() })).json();
    expect(insights.totals.created).toBeGreaterThanOrEqual(1);
    expect(insights.daily).toHaveLength(7);
    expect(insights.totals.spendMicros).toBeGreaterThanOrEqual(0);
  });

  it('runs a review "run" action in the world and serves an "open" artifact', async () => {
    const repo = await h.makeRepo('gw-actions');
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'GWA', config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }),
      })
    ).json();
    const task: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({
          title: 'Action task',
          prompt:
            '@write out.txt :: hello-artifact\n' +
            '@runaction print :: cat out.txt && echo DONE_MARKER\n' +
            '@openaction the file :: out.txt\n' +
            '@review verify the output',
          workflow: 'software-dev',
        }),
      })
    ).json();

    // poll to Review
    let view: any;
    for (let i = 0; i < 60; i++) {
      view = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
      if (view?.stage === 'review') break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(view.stage).toBe('review');
    // the terse caption + accumulated actions are on the review info
    expect(view.reviewInfo.caption).toContain('verify');
    expect(view.reviewInfo.actions.map((a: any) => a.kind)).toEqual(['run', 'open']);

    // run action (index 0) → executes `cat out.txt && echo DONE_MARKER` in the world
    const started: any = await (
      await fetch(`${base}/api/tasks/${task.id}/review-action`, { method: 'POST', headers: auth(), body: JSON.stringify({ index: 0 }) })
    ).json();
    expect(started.kind).toBe('run');
    expect(started.procId).toBeTruthy();
    let status: any;
    for (let i = 0; i < 40; i++) {
      status = await (await fetch(`${base}/api/tasks/${task.id}/review-action/${started.procId}`, { headers: auth() })).json();
      if (status && status.running === false) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(status.running).toBe(false);
    expect(status.exitCode).toBe(0);
    expect(status.output).toContain('hello-artifact');
    expect(status.output).toContain('DONE_MARKER');

    // open action (index 1) → resolves to an artifact URL served from the world
    const opened: any = await (
      await fetch(`${base}/api/tasks/${task.id}/review-action`, { method: 'POST', headers: auth(), body: JSON.stringify({ index: 1 }) })
    ).json();
    expect(opened.kind).toBe('open');
    expect(opened.external).toBe(false);
    const artifact = await fetch(`${base}${opened.url}`, { headers: auth() });
    expect(artifact.status).toBe(200);
    expect(await artifact.text()).toContain('hello-artifact');

    // Agent-authored absolute paths are resolved back into this task's world by
    // the conversation file endpoint; source files open inline as text.
    const file = await fetch(`${base}/api/tasks/${task.id}/file?path=${encodeURIComponent(`${view.worldPath}/out.txt`)}`, { headers: auth() });
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toContain('text/plain');
    expect(await file.text()).toContain('hello-artifact');

    // Conversation clicks never navigate to the absolute world path. The host
    // resolves it to its checkout and returns a pasteable editor command.
    const openCommand = await fetch(`${base}/api/tasks/${task.id}/open-command`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ path: `${view.worldPath}/out.txt`, line: 1 }),
    });
    expect(openCommand.status).toBe(200);
    expect(await openCommand.json()).toMatchObject({
      path: `${view.worldPath}/out.txt`,
      command: `code --goto '${view.worldPath}/out.txt:1'`,
      materialized: false,
    });

    // A still-running tool can checkpoint another attachment before TurnResult.
    // The drawer reads the snapshot; clicking the button queries the live workflow,
    // which still has its old actions. Both must resolve the checkpoint.
    (await h.store.checkpointReviewInfo(task.id, { caption: 'New attachment before turn completion',
      actions: [{ kind: 'open', label: 'New attachment', target: 'out.txt' }] }));
    const updated: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
    expect(updated.reviewInfo.actions[0].label).toBe('New attachment');
    const pendingOpen: any = await (await fetch(`${base}/api/tasks/${task.id}/review-action`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ index: 0 }),
    })).json();
    expect(pendingOpen.kind).toBe('open');
    const pendingArtifact = await fetch(`${base}${pendingOpen.url}`, { headers: auth() });
    expect(pendingArtifact.status).toBe(200);
    expect(await pendingArtifact.text()).toContain('hello-artifact');

    // A bad index is rejected; neither artifact nor conversation-file paths may
    // traverse outside the task world.
    const bad = await fetch(`${base}/api/tasks/${task.id}/review-action`, { method: 'POST', headers: auth(), body: JSON.stringify({ index: 99 }) });
    expect(bad.status).toBe(404);
    const escape = await fetch(`${base}/api/tasks/${task.id}/artifact?path=${encodeURIComponent('../../../etc/passwd')}`, { headers: auth() });
    expect(escape.status).toBe(400);
    const fileEscape = await fetch(`${base}/api/tasks/${task.id}/file?path=${encodeURIComponent('/etc/passwd')}`, { headers: auth() });
    expect(fileEscape.status).toBe(400);
    const commandEscape = await fetch(`${base}/api/tasks/${task.id}/open-command`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ path: '/etc/passwd' }),
    });
    expect(commandEscape.status).toBe(409);
    await fs.promises.symlink('/etc/passwd', `${view.worldPath}/escape-link`);
    const symlinkEscape = await fetch(`${base}/api/tasks/${task.id}/file?path=escape-link`, { headers: auth() });
    expect(symlinkEscape.status).toBe(400);
    await fs.promises.unlink(`${view.worldPath}/escape-link`);
    // A file past the cap is refused, not loaded whole into the gateway (AD-1).
    fs.writeFileSync(`${view.worldPath}/huge.bin`, '');
    fs.truncateSync(`${view.worldPath}/huge.bin`, 101 * 1024 * 1024);
    const huge = await fetch(`${base}/api/tasks/${task.id}/file?path=huge.bin`, { headers: auth() });
    expect(huge.status).toBe(413);
    await fs.promises.unlink(`${view.worldPath}/huge.bin`);

    // Land through the real workflow and release the Git worktree. The same
    // authenticated attachment URL must survive; no Git fallback can supply
    // the saved review bytes after this file is changed in the target checkout.
    const confirmed = await fetch(`${base}/api/tasks/${task.id}/signal`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ signal: 'confirm' }),
    });
    expect(confirmed.status).toBe(200);
    let landed: any;
    for (let i = 0; i < 80; i++) {
      landed = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
      if (landed.stage === 'done' && !fs.existsSync(view.worldPath)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(landed.stage).toBe('done');
    expect(fs.existsSync(view.worldPath)).toBe(false);
    await fs.promises.writeFile(path.join(repo, 'out.txt'), 'later target edits');
    const retained = await fetch(`${base}${opened.url}`, { headers: auth() });
    expect(retained.status).toBe(200);
    expect(await retained.text()).toContain('hello-artifact');
  });

  it('inherits defaults live: drafts store only overrides and re-resolve when queued', async () => {
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'Inherit', config: {} }),
      })
    ).json();

    // A draft with only a prompt must persist ONLY its own overrides — never a
    // baked snapshot of the resolved defaults (which would freeze inheritance).
    const draft: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ prompt: 'inherit me', workflow: 'software-dev', draft: true }),
      })
    ).json();
    const stored = (await h.store.getTask(draft.id))!;
    expect(stored.params.prompt).toBe('inherit me');
    expect(stored.params.draft).toBe(true);
    // none of the inheritable defaults should be baked onto the task
    expect(stored.params.worldProvider).toBeUndefined();
    expect(stored.params.openGithubPr).toBeUndefined();
    expect(stored.params.base).toBeUndefined();
    expect((stored.params._authorization as any)?.profileId).toBe('caller');

    // Form replacement cannot erase or forge platform authorization metadata,
    // while the dedicated pre-start endpoint can safely re-attenuate it.
    await fetch(`${base}/api/tasks/${draft.id}/params`, {
      method: 'PATCH', headers: auth(),
      body: JSON.stringify({ replace: true, params: { prompt: 'inherit me edited', _authorization: { profileId: 'forged', capabilities: ['*'] } } }),
    });
    expect(((await h.store.getTask(draft.id))!.params._authorization as any)?.profileId).toBe('caller');
    await fetch(`${base}/api/tasks/${draft.id}/authorization`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ profileId: 'developer' }),
    });
    expect(((await h.store.getTask(draft.id))!.params._authorization as any)?.profileId).toBe('developer');

    // Changing a project default now flows into the (still unqueued) task's
    // resolved defaults — the /api/defaults task scope reflects it immediately.
    await fetch(`${base}/api/settings/project/${project.id}/software-dev`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ values: { base: 'develop' } }),
    });
    const defs: any = await (await fetch(`${base}/api/defaults/${project.id}/software-dev`, { headers: auth() })).json();
    expect(defs.task.inherited.base).toBe('develop');

    // A project override, in turn, still inherits from a global default it does
    // not set (here: copyGlobs), proving the full task→project→global chain.
    await fetch(`${base}/api/settings/global/software-dev`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ values: { copyGlobs: ['.env'] } }),
    });
    const defs2: any = await (await fetch(`${base}/api/defaults/${project.id}/software-dev`, { headers: auth() })).json();
    expect(defs2.task.inherited.copyGlobs).toEqual(['.env']); // global reaches the task through the project
    expect(defs2.task.inherited.base).toBe('develop'); // project override still wins
  });

  it('stores cosmetic human notes on a task and never mixes them into params/prompt', async () => {
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'Notes', config: {} }),
      })
    ).json();
    const draft: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ prompt: 'do the thing', workflow: 'software-dev', draft: true }),
      })
    ).json();

    // set notes
    const set: any = await (
      await fetch(`${base}/api/tasks/${draft.id}/notes`, {
        method: 'PATCH',
        headers: auth(),
        body: JSON.stringify({ notes: 'ask design about the empty state' }),
      })
    ).json();
    expect(set.ok).toBe(true);

    // notes land on the record, not in params (so they never reach the prompt)
    const stored = (await h.store.getTask(draft.id))!;
    expect(stored.notes).toBe('ask design about the empty state');
    expect(stored.params.notes).toBeUndefined();
    expect(stored.params.prompt).toBe('do the thing');

    // the task list surfaces notes for the UI (drafts are edited via the form,
    // which reads the record — the view-mirroring is covered by the terminal test)
    const list: any = await (await fetch(`${base}/api/projects/${project.id}/tasks?includeArchived=1`, { headers: auth() })).json();
    expect(list.find((t: any) => t.id === draft.id)?.notes).toBe('ask design about the empty state');

    // clearing removes them
    await fetch(`${base}/api/tasks/${draft.id}/notes`, { method: 'PATCH', headers: auth(), body: JSON.stringify({ notes: '' }) });
    expect((await h.store.getTask(draft.id))!.notes).toBeUndefined();
  });

  it('accepts notes on the create-task form and keeps them off params/prompt', async () => {
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'FormNotes', config: {} }),
      })
    ).json();
    // The full task form (the "…More" surface) POSTs notes alongside params.
    const created: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ params: { prompt: 'build the thing' }, notes: 'reminder from the form', workflow: 'software-dev', draft: true }),
      })
    ).json();

    // notes are returned on the created record and persisted off params
    expect(created.notes).toBe('reminder from the form');
    const stored = (await h.store.getTask(created.id))!;
    expect(stored.notes).toBe('reminder from the form');
    expect(stored.params.notes).toBeUndefined();
    expect(stored.params.prompt).toBe('build the thing');
  });

  it('allows editing notes on a task at any stage — including after it is done', async () => {
    const repo = await h.makeRepo('notes-terminal');
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'NotesTerminal', config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }),
      })
    ).json();
    const task: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ title: 'Terminal notes', prompt: '@write t.txt :: hi\n@review done', workflow: 'software-dev' }),
      })
    ).json();
    // drive it to Review, then confirm to a terminal (done) stage
    let stage = '';
    for (let i = 0; i < 60 && stage !== 'review'; i++) {
      const v: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
      stage = v?.stage;
      if (stage !== 'review') await new Promise((r) => setTimeout(r, 250));
    }
    await fetch(`${base}/api/tasks/${task.id}/signal`, { method: 'POST', headers: auth(), body: JSON.stringify({ signal: 'confirm' }) });
    for (let i = 0; i < 60; i++) {
      const v: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
      if (['done', 'merge', 'pr'].includes(v?.stage) || v?.status === 'done') { stage = v.stage; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    // editing notes must still succeed on the finished task
    const res = await fetch(`${base}/api/tasks/${task.id}/notes`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ notes: 'post-mortem: shipped' }),
    });
    expect(res.status).toBe(200);
    expect((await h.store.getTask(task.id))!.notes).toBe('post-mortem: shipped');
    // and the live view mirrors them, so the drawer renders the current value
    const view: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
    expect(view.notes).toBe('post-mortem: shipped');
  });

  it('a newly created project inherits the global branch default (no baked "main" override)', async () => {
    // Set a global branch default that differs from the field default ("main").
    await fetch(`${base}/api/settings/global/software-dev`, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({ values: { base: 'master', target: 'master' } }),
    });
    // Create a project exactly the way the New Project UI now does: empty config.
    const project: any = await (
      await fetch(`${base}/api/projects`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ name: 'FreshProject', config: {} }),
      })
    ).json();
    // The project must NOT have baked a defaultBase/defaultTarget of its own.
    expect(project.config.defaultBase).toBeUndefined();
    expect(project.config.defaultTarget).toBeUndefined();

    // Resolved defaults at the task scope must reflect the GLOBAL value, not "main".
    const defs: any = await (await fetch(`${base}/api/defaults/${project.id}/software-dev`, { headers: auth() })).json();
    expect(defs.task.inherited.base).toBe('master');
    expect(defs.task.inherited.target).toBe('master');
    // And the project scope owns nothing for base/target (it purely inherits).
    expect(defs.project.own.base).toBeUndefined();
    expect(defs.project.own.target).toBeUndefined();

    // A task created in this project resolves its branches to the global default too.
    const task: any = await (
      await fetch(`${base}/api/projects/${project.id}/tasks`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ prompt: 'inherit branch', workflow: 'software-dev', draft: true }),
      })
    ).json();
    // Stored sparsely — no baked branch override.
    expect((await h.store.getTask(task.id))!.params.base).toBeUndefined();
    expect((await h.store.getTask(task.id))!.params.target).toBeUndefined();
  });

  it('connects an account login and lists it without leaking the config-home path', async () => {
    const r: any = await (
      await fetch(`${base}/api/accounts/connect`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ provider: 'claude', account: 'work', browserMcp: 'chrome-devtools' }),
      })
    ).json();
    expect(r.status).toBe('awaiting_oauth');
    expect(r.loginUrl).toBe('https://example.com/dev?code=TEST');
    expect(r.configHome).toBeUndefined(); // absolute path never crosses the wire

    const accounts: any = await (await fetch(`${base}/api/accounts`, { headers: auth() })).json();
    const login = accounts.logins.find((l: any) => l.provider === 'claude' && l.account === 'work');
    expect(login).toBeTruthy();
    expect(login.path).toBeUndefined(); // listing also hides the path
    expect(typeof login.loggedIn).toBe('boolean');
  });

  it('adds a device login to the runnable pool when OAuth completes after the connect response', async () => {
    const delayedGateway = await h.startGateway({
      loginCommand: (_provider, home) => ({
        cmd: process.execPath,
        args: ['-e', [
          "console.log('open https://example.com/device')",
          "setTimeout(() => {",
          "  require('node:fs').writeFileSync(require('node:path').join(process.env.LOGIN_HOME, 'auth.json'), '{}')",
          "}, 350)",
        ].join(';')],
        env: { LOGIN_HOME: home },
      }),
    });
    const delayedSession: any = await fetch(`${delayedGateway.url}/api/session`).then((response) => response.json());
    const delayedAuth = { authorization: `Bearer ${delayedSession.token}`, 'content-type': 'application/json' };

    const connected: any = await fetch(`${delayedGateway.url}/api/accounts/connect`, {
      method: 'POST',
      headers: delayedAuth,
      body: JSON.stringify({ provider: 'codex', account: 'delayed' }),
    }).then((response) => response.json());
    expect(connected.status).toBe('awaiting_oauth');

    await expect.poll(async () => {
      const status: any = await fetch(`${delayedGateway.url}/api/organizations/org_personal/accounts/status`, {
        headers: delayedAuth,
      }).then((response) => response.json());
      return status.accounts.some((account: any) => account.id === 'login:codex:delayed');
    }, { timeout: 4_000 }).toBe(true);
  });

  it('validates a completed re-authentication before clearing automatic quarantine', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login-health-'));
    const usage = path.join(dir, 'claude-usage.cjs');
    fs.writeFileSync(usage, [
      '#!/usr/bin/env node',
      "console.log('You are currently using your subscription to power your Claude Code usage')",
      "console.log('Current session: 1% used · resets Aug 28, 10:30am (UTC)')",
      "console.log('Current week (all models): 0% used · resets Sep 3, 12pm (UTC)')",
    ].join('\n'));
    fs.chmodSync(usage, 0o700);
    const previousUsageCommand = process.env.KARMAX_CLAUDE_USAGE_CMD;
    process.env.KARMAX_CLAUDE_USAGE_CMD = usage;
    try {
      const reauthGateway = await h.startGateway({
        loginCommand: (_provider, home) => ({
          cmd: process.execPath,
          args: ['-e', [
            "console.log('open https://example.com/claude-login');",
            "setTimeout(() => require('node:fs').writeFileSync(",
            "  require('node:path').join(process.env.LOGIN_HOME, '.credentials.json'),",
            "  JSON.stringify({ claudeAiOauth: { accessToken: 'fresh', refreshToken: 'canonical', expiresAt: Date.now() + 3600000 } })",
            '), 250)',
          ].join(' ')],
          env: { LOGIN_HOME: home },
        }),
      });
      const session: any = await fetch(`${reauthGateway.url}/api/session`).then((response) => response.json());
      const headers = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };
      const connect = () => fetch(`${reauthGateway.url}/api/accounts/connect`, {
        method: 'POST', headers,
        body: JSON.stringify({ provider: 'claude', account: 'reauth', force: true }),
      }).then((response) => response.json());

      await expect(connect()).resolves.toMatchObject({ status: 'awaiting_oauth' });
      await expect.poll(async () => {
        const status: any = await fetch(`${reauthGateway.url}/api/organizations/org_personal/accounts/status`, { headers })
          .then((response) => response.json());
        return status.accounts.find((account: any) => account.id === 'login:claude:reauth')?.status;
      }, { timeout: 5_000 }).toBe('available');

      const coordinator = makeCoordinatorActivities({ client: h.client, taskQueue: TASK_QUEUE });
      await coordinator.setAccountAvailability({ accountId: 'login:claude:reauth', status: 'needs-attention' });
      await expect(connect()).resolves.toMatchObject({ status: 'awaiting_oauth' });
      await expect.poll(async () => {
        const status: any = await fetch(`${reauthGateway.url}/api/organizations/org_personal/accounts/status`, { headers })
          .then((response) => response.json());
        return status.accounts.find((account: any) => account.id === 'login:claude:reauth')?.status;
      }, { timeout: 5_000 }).toBe('available');
    } finally {
      if (previousUsageCommand === undefined) delete process.env.KARMAX_CLAUDE_USAGE_CMD;
      else process.env.KARMAX_CLAUDE_USAGE_CMD = previousUsageCommand;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['human', 'agent'])('%s attaches redacted resources and completes a resumable binary upload', async (kind) => {
    const project: any = await fetch(`${base}/api/projects`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ name: `Resource API ${kind}` }) }).then((response) => response.json());
    const agent = (await h.tokens.mint({ taskId: 'resource-admin', profileId: 'maintainer',
      principal: 'task:resource-admin', organizationId: project.organizationId,
      ceiling: ['project:settings:read', 'project:settings:write'],
      grantorCaps: ['project:settings:read', 'project:settings:write'] }));
    const resourceAuth = () => kind === 'agent'
      ? { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' } : auth();
    const secretResponse = await fetch(`${base}/api/projects/${project.id}/resources`, { method: 'POST', headers: resourceAuth(),
      body: JSON.stringify({ name: 'Token', driver: 'secret@1', target: { kind: 'environment', name: 'MODEL_TOKEN' },
        access: 'read', isolation: 'fork', publish: 'discard', secret: 'never-return-this' }) });
    expect(secretResponse.status).toBe(200);
    const secret: any = await secretResponse.json();
    expect(secret.credentialConfigured).toBe(true);
    expect(JSON.stringify(secret)).not.toContain('never-return-this');
    expect(secret.credentialHandles).toBeUndefined();

    const volume: any = await fetch(`${base}/api/projects/${project.id}/resources`, { method: 'POST', headers: resourceAuth(),
      body: JSON.stringify({ name: 'Model', driver: 'volume@1', target: { kind: 'path', path: 'resources/model' },
        access: 'write', isolation: 'fork', publish: 'review' }) }).then((response) => response.json());
    const upload: any = await fetch(`${base}/api/projects/${project.id}/resources/${volume.id}/uploads`,
      { method: 'POST', headers: resourceAuth() }).then((response) => response.json());
    const bytes = Buffer.from('fine-tuned-model-weights');
    const part = await fetch(`${base}/api/resource-uploads/${upload.id}?projectId=${project.id}&path=model.bin&part=0`,
      { method: 'PUT', headers: { ...resourceAuth(), 'content-type': 'application/octet-stream' }, body: bytes });
    expect(part.status).toBe(200);
    const empty = await fetch(`${base}/api/resource-uploads/${upload.id}?projectId=${project.id}&path=empty.txt&part=0`,
      { method: 'PUT', headers: { ...auth(), 'content-type': 'application/octet-stream' }, body: Buffer.alloc(0) });
    expect(empty.status).toBe(200);
    const extraEmpty = await fetch(`${base}/api/resource-uploads/${upload.id}?projectId=${project.id}&path=model.bin&part=1`,
      { method: 'PUT', headers: { ...auth(), 'content-type': 'application/octet-stream' }, body: Buffer.alloc(0) });
    expect(extraEmpty.status).toBe(400);
    const complete = await fetch(`${base}/api/resource-uploads/${upload.id}?projectId=${project.id}`,
      { method: 'POST', headers: resourceAuth() });
    expect(complete.status).toBe(200);
    const revision: any = await complete.json();
    expect(revision.bytes).toBe(bytes.length);
    expect(revision.sealedRef).toBeUndefined();
    const listed = await fetch(`${base}/api/projects/${project.id}/resources`, { headers: resourceAuth() }).then((response) => response.json()) as any[];
    expect(listed.find((resource) => resource.id === volume.id).revision.bytes).toBe(bytes.length);
    expect(JSON.stringify(listed)).not.toContain('sealedRef');
    expect((await fetch(`${base}/api/projects/${project.id}/resources/${volume.id}`, {
      method: 'PATCH', headers: resourceAuth(), body: JSON.stringify({ name: 'Updated model' }),
    })).status).toBe(200);
    expect((await fetch(`${base}/api/projects/${project.id}/resources/${volume.id}/import`, {
      method: 'POST', headers: resourceAuth(), body: JSON.stringify({ files: [{ path: 'new.txt', data: Buffer.from('new').toString('base64') }] }),
    })).status).toBe(200);
    expect((await fetch(`${base}/api/projects/${project.id}/secrets`, {
      method: 'POST', headers: resourceAuth(), body: JSON.stringify({ name: 'EXTRA_KEY', value: 'secret-value' }),
    })).status).toBe(200);
    expect((await fetch(`${base}/api/projects/${project.id}/secrets/EXTRA_KEY`, {
      method: 'DELETE', headers: resourceAuth(),
    })).status).toBe(200);
    expect((await fetch(`${base}/api/projects/${project.id}/resources/${volume.id}`, {
      method: 'DELETE', headers: resourceAuth(),
    })).status).toBe(200);
  });

  it('authorizes historical byte verification in the exact project scope', async () => {
    const project = (await h.store.createProject('Verify history'));
    const other = (await h.store.createProject('Other history'));
    const resource = (await h.store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
      name: 'History', driver: 'volume@1', target: { kind: 'path', path: 'history' },
      access: 'write', isolation: 'fork', source: {}, credentialHandles: [], publish: 'review' }));
    const revision = await h.resources.importFiles(resource.id, [{ path: 'empty', data: Buffer.alloc(0) }]);
    const head = await h.resources.importFiles(resource.id, [{ path: 'later', data: Buffer.from('later') }]);
    const headers = async (caps: string[], projectId = project.id, organizationId = project.organizationId) => ({
      authorization: `Bearer ${(await h.tokens.mint({ taskId: 'historical-reader', profileId: 'do',
        principal: 'task:historical-reader', projectId, organizationId, ceiling: caps, grantorCaps: caps })).token}`,
    });
    const route = `/api/projects/${project.id}/resources/${resource.id}/revisions/${revision.id}/verify`;
    for (const denied of [(await headers([])), (await headers(['project:settings:read'], other.id)),
      (await headers(['project:settings:read'], project.id, 'org_foreign'))]) {
      expect((await fetch(`${base}${route}`, { headers: denied })).status).toBe(403);
    }
    expect((await fetch(`${base}${route}?organizationId=org_foreign`, {
      headers: (await headers(['project:settings:read'], project.id, 'org_foreign')),
    })).status).toBe(403);
    const allowed = (await headers(['project:settings:read']));
    const response = await fetch(`${base}${route}`, { headers: allowed });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const evidence: any = await response.json();
    expect(evidence).toMatchObject({ revisionId: revision.id, status: 'complete', verifiedFiles: 1, verifiedBytes: 0 });
    expect(JSON.stringify(evidence)).not.toMatch(/sealedRef|objectKey|credential|chunks/);
    const handlers = platformToolHandlers({} as any, { platformRequest: async (method: string, requestPath: string) => {
      const response = await fetch(`${base}${requestPath}`, { method, headers: allowed });
      expect(response.status).toBe(200); return response.json();
    } } as any);
    expect(JSON.parse(await handlers.verify_resource_revision!({ project_id: project.id,
      resource_id: resource.id, revision_id: revision.id }))).toEqual(evidence);

    expect((await fetch(`${base}${route}?limit=1001`, { headers: allowed })).status).toBe(400);
    expect((await fetch(`${base}${route.replace(revision.id, 'unknown')}`, { headers: allowed })).status).toBe(404);
    expect((await fetch(`${base}${route.replace(resource.id, 'unknown')}`, { headers: allowed })).status).toBe(404);
    expect((await h.store.getResourceAttachment(resource.id))?.currentRevisionId).toBe(head.id);
  });

  it('keeps direct resource administration scoped and unavailable to proposal-only agents', async () => {
    const project = (await h.store.createProject('Scoped resources'));
    const other = (await h.store.createProject('Other resources'));
    const headersFor = async (caps: string[], projectId: string) => ({
      authorization: `Bearer ${(await h.tokens.mint({ taskId: 'scoped-resource-agent', profileId: 'do',
        principal: 'task:scoped-resource-agent', projectId, organizationId: project.organizationId,
        ceiling: caps, grantorCaps: caps })).token}`, 'content-type': 'application/json',
    });
    const routes = [
      `/api/projects/${project.id}/resources`, `/api/projects/${project.id}/secrets`,
    ];
    for (const route of routes) {
      expect((await fetch(`${base}${route}`, { method: 'POST',
        headers: (await headersFor(['task:review:write'], project.id)), body: '{}' })).status).toBe(403);
      expect((await fetch(`${base}${route}`, { method: 'POST',
        headers: (await headersFor(['project:settings:write'], other.id)), body: '{}' })).status).toBe(403);
    }
  });

  it('uses verified identity for personal settings without extra agent permissions', async () => {
    const human = (await h.tokens.mintPrincipal('user:personal-owner', ['user:read', 'user:write']));
    const delegation = (await h.tokens.delegateHuman(human.token, { taskId: 'personal-agent' }))!;
    const mint = async (caps: string[], delegated = true) => (await h.tokens.mint({ taskId: 'personal-agent', profileId: 'do',
      principal: 'task:personal-agent', ceiling: caps, grantorCaps: caps,
      ...(delegated ? { delegationId: delegation.id } : {}) }));
    const call = (agent: Awaited<ReturnType<typeof mint>>) => fetch(`${base}/api/user/default-organization`, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    expect((await call((await mint([])))).status).toBe(200);
    expect((await call((await mint(['user:read'], false)))).status).toBe(403);
    const response = await call((await mint(['user:read'])));
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('organizationId');
  });

  it('defaults Avatars off and allows projects to override the organization default', async () => {
    const project = (await h.store.createProject('Experimental Avatars'));
    const orgUrl = `${base}/api/organizations/${project.organizationId}/avatar-settings`;
    const projectUrl = `${base}/api/projects/${project.id}/avatar-settings`;
    const put = async (url: string, body: object) => {
      const response = await fetch(url, { method: 'PUT', headers: auth(), body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await (await fetch(orgUrl, { headers: auth() })).json()).toEqual({ enabled: false });
    expect(await (await fetch(projectUrl, { headers: auth() })).json())
      .toEqual({ organization: false, project: 'inherit', effective: false });
    expect((await fetch(orgUrl, { method: 'PUT', headers: auth(), body: '{}' })).status).toBe(400);
    expect(await put(projectUrl, { value: 'enabled' })).toMatchObject({ effective: true, organization: false });
    expect(await put(projectUrl, { value: 'inherit' })).toMatchObject({ effective: false });
    await put(orgUrl, { enabled: true });
    expect(await put(projectUrl, { value: 'inherit' })).toMatchObject({ effective: true });
    expect(await put(projectUrl, { value: 'disabled' })).toMatchObject({ effective: false, organization: true });
    await put(orgUrl, { enabled: false });
  });

  it('allows delegated Avatar administration without widening the agent grant', async () => {
    const project = (await h.store.createProject('Delegated Avatars'));
    (await h.store.kvSet(`avatars:project:${project.id}`, 'enabled'));
    (await h.store.setOrganizationMembership(project.organizationId!, 'avatar-owner', 'member'));
    const authorization = (await AuthorizationService.create(h.store));
    (await authorization.grant('system:test', { principalId: 'user:avatar-owner', scopeKey: `project:${project.id}`,
      profileId: 'maintainer' }));
    const ownerCaps = (await authorization.capabilities('user:avatar-owner', project.id, project.organizationId));
    const human = (await h.tokens.mintPrincipal('user:avatar-owner', ownerCaps, project.id, undefined, project.organizationId));
    const delegation = (await h.tokens.delegateHuman(human.token, { taskId: 'avatar-admin', projectId: project.id,
      organizationId: project.organizationId }))!;
    const mint = async (caps: string[]) => (await h.tokens.mint({ taskId: 'avatar-admin', profileId: 'do',
      principal: 'task:avatar-admin', projectId: project.id, organizationId: project.organizationId,
      ceiling: caps, grantorCaps: caps, delegationId: delegation.id }));
    const create = async (caps: string[]) => fetch(`${base}/api/projects/${project.id}/avatars`, {
      method: 'POST', headers: { authorization: `Bearer ${(await mint(caps)).token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Delegated helper', prompt: 'Help with project work.', runtime: { provider: 'mock' } }),
    });
    const limited = await create(['task:create']);
    expect(limited.status).toBe(403);
    expect((await h.store.listAvatars(project.id))).toHaveLength(0);
    const permitted = await create(ownerCaps);
    expect(permitted.status).toBe(201);
    expect((await h.store.listAvatars(project.id))).toHaveLength(1);
  });

  it('offers proposal-driven secrets, environment, and per-world services over typed resources', async () => {
    const repo = await h.makeRepo('project-onboarding');
    fs.mkdirSync(`${repo}/.devcontainer`);
    fs.writeFileSync(`${repo}/.env.example`, 'DATABASE_URL=\nMODEL_TOKEN=\n');
    fs.writeFileSync(`${repo}/package-lock.json`, '{}');
    fs.writeFileSync(`${repo}/.devcontainer/devcontainer.json`, JSON.stringify({
      image: 'node:22-slim',
      postCreateCommand: 'npm run setup',
      dockerComposeFile: '../compose.yaml',
    }));
    fs.writeFileSync(`${repo}/compose.yaml`, `services:
  database:
    image: postgres:16
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: local
      POSTGRES_DB: app
`);
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'add project declarations']);

    const project: any = await fetch(`${base}/api/projects`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ name: 'Onboarding API', config: { repos: [repo], worldProvider: 'container' } }) })
      .then((response) => response.json());

    const suggested: any = await fetch(`${base}/api/projects/${project.id}/secrets`, { headers: auth() })
      .then((response) => response.json());
    expect(suggested.suggestions).toEqual(['DATABASE_URL', 'MODEL_TOKEN']);
    const imported = await fetch(`${base}/api/projects/${project.id}/secrets`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ env: 'MODEL_TOKEN=private-value\nDATABASE_URL=postgres://external' }) });
    expect(imported.status).toBe(200);
    expect(JSON.stringify(await imported.json())).not.toContain('private-value');

    const proposal: any = await fetch(`${base}/api/projects/${project.id}/environment/proposal`, { headers: auth() })
      .then((response) => response.json());
    expect(proposal.spec).toMatchObject({ image: 'node:22-slim', setup: ['npm run setup', 'npm ci'] });
    const savedEnvironment = await fetch(`${base}/api/projects/${project.id}/environment`, {
      method: 'PUT', headers: auth(), body: JSON.stringify(proposal.spec),
    });
    expect(savedEnvironment.status).toBe(200);

    const compose: any = await fetch(`${base}/api/projects/${project.id}/services/compose-import`, { headers: auth() })
      .then((response) => response.json());
    expect(compose.proposals[0]).toMatchObject({
      name: 'database', kind: 'per-world', image: 'postgres:16', containerPort: 5432,
      urlEnv: 'DATABASE_URL',
    });
    const service = await fetch(`${base}/api/projects/${project.id}/services`, {
      method: 'POST', headers: auth(), body: JSON.stringify(compose.proposals[0]),
    });
    expect(service.status).toBe(200);

    const secrets: any = await fetch(`${base}/api/projects/${project.id}/secrets`, { headers: auth() })
      .then((response) => response.json());
    expect(secrets.suggestions).toEqual([]);
    expect(secrets.secrets.every((secret: any) => secret.credentialConfigured)).toBe(true);
    expect(JSON.stringify(secrets)).not.toContain('postgres://external');
  });

  it('migrates copyGlobs through the typed resource API and returns no secret values', async () => {
    const repo = await h.makeRepo('copyglobs-api');
    fs.writeFileSync(`${repo}/.env.local`, 'LEGACY_TOKEN=private-legacy-value\n');
    fs.writeFileSync(`${repo}/model.bin`, Buffer.from([0, 1, 2, 255]));
    const project: any = await fetch(`${base}/api/projects`, { method: 'POST', headers: auth(),
      body: JSON.stringify({ name: 'copyGlobs migration', config: {
        repos: [repo], copyGlobs: ['.env*', '*.bin'],
      } }) }).then((response) => response.json());
    const migrated = await fetch(`${base}/api/projects/${project.id}/resources/import-copyglobs`, {
      method: 'POST', headers: auth(), body: '{}',
    });
    expect(migrated.status).toBe(200);
    const result: any = await migrated.json();
    expect(result).toMatchObject({ environmentSecrets: ['LEGACY_TOKEN'], data: ['model.bin'], skipped: [] });
    expect(JSON.stringify(result)).not.toContain('private-legacy-value');
    expect((await h.store.getProject(project.id))?.config.copyGlobs).toEqual([]);
    const attachments = await fetch(`${base}/api/projects/${project.id}/resources`, { headers: auth() })
      .then((response) => response.json()) as any[];
    expect(attachments.some((attachment) => attachment.target?.name === 'LEGACY_TOKEN')).toBe(true);
    expect(attachments.some((attachment) => attachment.target?.path === 'model.bin'
      && attachment.revision?.bytes === 4)).toBe(true);
    expect(JSON.stringify(attachments)).not.toContain('private-legacy-value');
  });

  it('seeds a brand-new project with the tavya init task', async () => {
    // A new project's tasks default to software-dev, so creation spawns that
    // workflow's current onActivate prep task automatically (SPEC §4.6) —
    // no manual "activate workflow" step. Covers both create-project routes.
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: auth(), body: JSON.stringify(body) }).then((r) => r.json());
    const prepTitle = 'tavya init';
    for (const path of ['/api/organizations/org_personal/projects', '/api/projects']) {
      const name = path.includes('/organizations/') ? 'Fresh via organization route' : 'Fresh via legacy route';
      const project: any = await post(path, { name });
      const tasks: any = await fetch(`${base}/api/projects/${project.id}/tasks`, { headers: auth() }).then((r) => r.json());
      const prep = tasks.find((t: any) => t.title === prepTitle);
      expect(prep, `new project via ${path} should get the prep task`).toBeTruthy();
      expect(prep.workflow).toBe('software-dev');
      expect(prep.params.prompt).toContain('Migrate AGENTS.md, CLAUDE.md');
      expect(prep.params.prompt).toContain('compile a new wiki page');
      expect(prep.params.prompt).toContain('use the "default" tag');
      expect(prep.params.prompt).toContain('hardcoded resources (e.g. ports)');
      expect(prep.params.prompt).not.toContain('Ensure git is initialized');
      expect(prep.params.prompt).toContain('Just press "Queue"');
    }
  });

  it('drives tags, saved views, and query search over HTTP (a view is a saved query)', async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: auth(), body: JSON.stringify(body) }).then((r) => r.json());
    const get = (path: string) => fetch(`${base}${path}`, { headers: auth() }).then((r) => r.json());

    const project: any = await post('/api/projects', { name: 'Org', config: { defaultBase: 'main' } });

    // The searchable-field registry drives the UI menus.
    const fields: any = await get('/api/search/fields');
    expect(fields.find((f: any) => f.key === 'status').groupable).toBe(true);
    expect(fields.find((f: any) => f.key === 'tag')).toBeTruthy();

    // Hierarchical tags: frontend/web + a bug label.
    const front: any = await post(`/api/projects/${project.id}/tags`, { name: 'frontend', kind: 'topic', description: 'All client work.' });
    const web: any = await post(`/api/projects/${project.id}/tags`, { name: 'web', parentId: front.id, kind: 'topic', description: 'Browser client work.' });
    const bug: any = await post(`/api/projects/${project.id}/tags`, { name: 'bug', kind: 'type' });
    expect(web.parentId).toBe(front.id);

    // Two draft tasks (no workflow needed) to organize.
    const mk = (title: string) =>
      post(`/api/projects/${project.id}/tasks`, { title, prompt: title, workflow: 'software-dev', draft: true });
    const t1: any = await mk('Fix web bug');
    const t2: any = await mk('Write docs');

    // Assign tags + priority (organization only — editable while draft).
    await fetch(`${base}/api/tasks/${t1.id}/tags`, { method: 'PUT', headers: auth(), body: JSON.stringify({ tagIds: [web.id, bug.id] }) });
    await fetch(`${base}/api/tasks/${t1.id}/priority`, { method: 'PUT', headers: auth(), body: JSON.stringify({ priority: 4 }) });

    // Search by a parent tag matches the child-tagged task (hierarchy expansion).
    const byParent: any = await get(`/api/projects/${project.id}/search?q=${encodeURIComponent('tag:frontend')}`);
    expect(byParent.tasks.map((t: any) => t.id)).toEqual([t1.id]);

    // Search by label + priority, grouped by tag.
    const byBug: any = await get(`/api/projects/${project.id}/search?q=${encodeURIComponent('tag:bug priority:>=3 group:tag')}`);
    expect(byBug.total).toBe(1);
    expect(byBug.groups.some((g: any) => g.key === bug.id)).toBe(true);
    const byHierarchy: any = await get(`/api/projects/${project.id}/search?q=${encodeURIComponent('group:tag')}`);
    const frontendGroup = byHierarchy.groups.find((g: any) => g.key === front.id);
    expect(byHierarchy.hierarchical).toBe(true);
    expect(frontendGroup).toMatchObject({ label: 'frontend', description: 'All client work.', count: 1 });
    expect(frontendGroup.children[0]).toMatchObject({ key: web.id, label: 'web', description: 'Browser client work.', count: 1 });

    // A negated/free-text query finds the other task.
    const docs: any = await get(`/api/projects/${project.id}/search?q=${encodeURIComponent('docs -tag:bug')}`);
    expect(docs.tasks.map((t: any) => t.id)).toEqual([t2.id]);

    // Slash path creates (and reuses) a hierarchy in one call — no parent picker.
    const checkout: any = await post(`/api/projects/${project.id}/tags`, { name: 'frontend/web/checkout' });
    expect(checkout.name).toBe('checkout');
    const allTags = (await get(`/api/projects/${project.id}/tags`)) as any[];
    const webParent: any = allTags.find((t: any) => t.id === checkout.parentId);
    expect(webParent.name).toBe('web'); // reused the existing frontend/web, not duplicated
    expect(allTags.filter((t: any) => t.name === 'web')).toHaveLength(1);

    // Workflow params are searchable via param.<key>: both drafts carry prompt=title.
    const byParam: any = await get(`/api/projects/${project.id}/search?q=${encodeURIComponent('param.prompt:docs')}`);
    expect(byParam.tasks.map((t: any) => t.id)).toEqual([t2.id]);

    // The agent-facing add/remove-by-name endpoint (what the platform MCP forwards to).
    const added: any = await post(`/api/tasks/${t2.id}/tag`, { add: ['frontend/web', 'chore'] });
    expect(added.tags.sort()).toEqual(['chore', 'frontend/web']);
    const removed: any = await post(`/api/tasks/${t2.id}/tag`, { remove: ['chore'] });
    expect(removed.tags).toEqual(['frontend/web']);

    // Saved view = persisted query; it round-trips and lists back.
    const view: any = await post(`/api/projects/${project.id}/views`, {
      name: 'Urgent frontend',
      query: { filters: [{ field: 'tag', op: 'is', values: ['frontend'] }], sort: [{ field: 'priority', dir: 'desc' }] },
      icon: '🔥',
    });
    const views: any = await get(`/api/projects/${project.id}/views`);
    expect(views.map((v: any) => v.name)).toContain('Urgent frontend');
    expect(views.find((v: any) => v.id === view.id).query.filters[0].field).toBe('tag');
  });

  // ── vault items + the credential pull model over HTTP (wiki plans/PLAN-passwords) ──
  it('persists task credential policies and applies edits to agent access', async () => {
    const item: any = await (await fetch(`${base}/api/vault/items`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        type: 'login', label: 'Task-specific policy', domains: 'policy.example.com',
        policy: { use: 'ask', reveal: 'never' }, secrets: { password: 'task-secret', note: 'Username: administrator\nprivate recovery text' },
      }),
    })).json();
    const project: any = await (await fetch(`${base}/api/projects`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ name: 'Vault policy project' }),
    })).json();
    const cap = `use-credential:item:${item.id}`;
    const task: any = await (await fetch(`${base}/api/projects/${project.id}/tasks`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        workflow: 'just-do', command: 'later', draft: true,
        credentialGrants: [cap],
        credentialPolicies: { [item.id]: { use: 'auto', reveal: 'ask' } },
      }),
    })).json();
    expect(task.params._authorization.credentialPolicies[item.id]).toEqual({ use: 'auto', reveal: 'ask' });

    const minted = (await h.tokens.mint({
      taskId: task.id, profileId: 'do', principal: 'user:test',
      ceiling: ['credential:read', 'use-credential:*'], grantorCaps: ['credential:read', cap],
    }));
    const agentAuth = { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' };
    const asked: any = await (await fetch(`${base}/api/vault/resolve`, {
      method: 'POST', headers: agentAuth, body: JSON.stringify({ itemId: item.id }),
    })).json();
    expect(JSON.stringify(asked)).not.toContain('private recovery text');
    expect(asked.status).toBe('needs_approval'); // task "ask" overrides global "never"

    const patched: any = await (await fetch(`${base}/api/tasks/${task.id}/authorization`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({
        profileId: 'developer', credentialGrants: [cap],
        credentialPolicies: { [item.id]: { use: 'auto', reveal: 'auto' } },
      }),
    })).json();
    expect(patched.params._authorization.credentialPolicies[item.id].reveal).toBe('auto');
    const revealed: any = await (await fetch(`${base}/api/vault/resolve`, {
      method: 'POST', headers: agentAuth, body: JSON.stringify({ itemId: item.id }),
    })).json();
    expect(revealed).toMatchObject({ status: 'granted', value: 'task-secret', notes: 'Username: administrator\nprivate recovery text' });
    const explicit: any = await (await fetch(`${base}/api/vault/resolve`, {
      method: 'POST', headers: agentAuth, body: JSON.stringify({ itemId: item.id, field: 'password' }),
    })).json();
    expect(explicit.value).toBe('task-secret');
    expect(explicit.notes).toBeUndefined();
    const notes: any = await (await fetch(`${base}/api/vault/resolve`, {
      method: 'POST', headers: agentAuth, body: JSON.stringify({ itemId: item.id, field: 'note' }),
    })).json();
    expect(notes.value).toBe(revealed.notes);
  });

  it('changes a running task authorization + vault grants in-flight, freezes once terminal', async () => {
    const repo = await h.makeRepo('auth-inflight-gw');
    const project: any = await (await fetch(`${base}/api/projects`, {
      method: 'POST', headers: auth(),
      body: JSON.stringify({ name: 'In-flight auth', config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false } }),
    })).json();
    const item: any = await (await fetch(`${base}/api/vault/items`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        type: 'login', label: 'In-flight grant', domains: 'inflight.example.com',
        policy: { use: 'ask', reveal: 'ask' }, secrets: { password: 'inflight-secret' },
      }),
    })).json();
    const cap = `use-credential:item:${item.id}`;
    // A running task (paused at Review) — no longer a draft, so previously frozen.
    const task: any = await (await fetch(`${base}/api/projects/${project.id}/tasks`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        title: 'in-flight authorization', prompt: '@write auth.txt :: ok\n@review authorization edit', workflow: 'software-dev',
      }),
    })).json();
    await expect.poll(async () => ((await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json()) as any)?.stage,
      { timeout: 15_000 }).toBe('review');

    // Attach a vault credential + raise the policy in-flight — the same PATCH the
    // task form uses, now accepted while the task runs.
    const patched: any = await (await fetch(`${base}/api/tasks/${task.id}/authorization`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({
        profileId: 'developer', credentialGrants: [cap],
        credentialPolicies: { [item.id]: { use: 'auto', reveal: 'auto' } },
      }),
    })).json();
    expect(patched.params._authorization.profileId).toBe('developer');
    expect(patched.params._authorization.capabilities).toContain(cap);
    expect(patched.params._authorization.credentialPolicies[item.id].reveal).toBe('auto');

    // Drive to terminal, then the same edit is frozen (no live grant to re-point).
    await fetch(`${base}/api/tasks/${task.id}/signal`, { method: 'POST', headers: auth(), body: JSON.stringify({ signal: 'confirm' }) });
    await expect.poll(async () => ((await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json()) as any)?.stage,
      { timeout: 15_000 }).toBe('done');
    const frozen = await fetch(`${base}/api/tasks/${task.id}/authorization`, {
      method: 'PATCH', headers: auth(), body: JSON.stringify({ profileId: 'reader', credentialGrants: [] }),
    });
    expect(frozen.status).toBe(409);
  });

  it('vault item lifecycle: add, list without secrets, policy-gated reveal, delete', async () => {
    const created: any = await (await fetch(`${base}/api/vault/items`, { method: 'POST', headers: auth(), body: JSON.stringify({
      type: 'login', label: 'GitHub (test)', domains: 'github.com', username: 'octo',
      policy: { use: 'auto', reveal: 'ask' }, secrets: { password: 'hunter2' },
    }) })).json();
    expect(created.id).toBeTruthy();
    expect(created.fields).toEqual(['password']);
    expect(JSON.stringify(created)).not.toContain('hunter2');
    const items: any = await (await fetch(`${base}/api/vault/items`, { headers: auth() })).json();
    expect(JSON.stringify(items)).not.toContain('hunter2');
    expect(items.map((i: any) => i.id)).toContain(created.id);

    // A vault administrator may explicitly inspect a stored field without
    // weakening the independent "agent sees" policy. The inspection is still
    // a plaintext reveal, so it is audited.
    const inspectedResponse = await fetch(`${base}/api/vault/items/${created.id}/reveal`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ field: 'password' }),
    });
    expect(inspectedResponse.headers.get('cache-control')).toBe('private, no-store');
    const inspected: any = await inspectedResponse.json();
    expect(inspected).toMatchObject({ itemId: created.id, field: 'password', value: 'hunter2' });
    expect((await h.store.auditSince()).some((entry: any) => entry.action === 'vault.revealed'
      && entry.detail.itemId === created.id && entry.detail.field === 'password')).toBe(true);

    // Explicit administrative authority permits inspection for agents too.
    const taskAgent = (await h.tokens.mint({
      taskId: 'task_admin_reveal', profileId: 'do', principal: 'user:test', organizationId: 'org_personal',
      ceiling: ['credential:write'], grantorCaps: ['credential:write'],
    }));
    const agentInspection = await fetch(`${base}/api/vault/items/${created.id}/reveal`, {
      method: 'POST',
      headers: { authorization: `Bearer ${taskAgent.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'password' }),
    });
    expect(agentInspection.status).toBe(200);
    const agentInspectionBody: any = await agentInspection.json();
    expect(agentInspectionBody).toMatchObject({ itemId: created.id, value: 'hunter2' });

    // reveal policy 'ask' gates even an all-capability caller
    const asked: any = await (await fetch(`${base}/api/vault/resolve`, { method: 'POST', headers: auth(), body: JSON.stringify({ domain: 'github.com' }) })).json();
    expect(asked.status).toBe('needs_approval');
    await fetch(`${base}/api/vault/items`, { method: 'POST', headers: auth(), body: JSON.stringify({ id: created.id, type: 'login', label: created.label, domains: created.domains, policy: { reveal: 'auto' } }) });
    const revealed: any = await (await fetch(`${base}/api/vault/resolve`, { method: 'POST', headers: auth(), body: JSON.stringify({ domain: 'github.com' }) })).json();
    expect(revealed.status).toBe('granted');
    expect(revealed.value).toBe('hunter2');
    expect(revealed.username).toBe('octo');

    // escalation requests are for task agents, not human sessions
    const noTask: any = await (await fetch(`${base}/api/vault/requests`, { method: 'POST', headers: auth(), body: JSON.stringify({ domain: 'github.com', why: 'x' }) })).json();
    expect(noTask.error).toMatch(/task-agent/);

    await fetch(`${base}/api/vault/items/${created.id}`, { method: 'DELETE', headers: auth() });
    const after: any = await (await fetch(`${base}/api/vault/items`, { headers: auth() })).json();
    expect(after.map((i: any) => i.id)).not.toContain(created.id);
  });

  it('lists only non-secret credential metadata granted to the calling task', async () => {
    const granted: any = await (await fetch(`${base}/api/vault/items`, { method: 'POST', headers: auth(), body: JSON.stringify({
      type: 'login', label: 'Amazon UK', domains: 'www.amazon.co.uk', username: 'buyer@example.com',
      policy: { use: 'auto', reveal: 'never' }, secrets: { password: 'granted-secret' },
    }) })).json();
    const hidden: any = await (await fetch(`${base}/api/vault/items`, { method: 'POST', headers: auth(), body: JSON.stringify({
      type: 'login', label: 'Hidden account', domains: 'hidden.example.com', secrets: { password: 'hidden-secret' },
    }) })).json();
    const taskToken = (await h.tokens.mint({
      taskId: 'task_credential_inventory', profileId: 'do', principal: 'user:test',
      ceiling: ['credential:read', 'use-credential:*'],
      grantorCaps: ['credential:read', `use-credential:item:${granted.id}`],
    }));
    const response = await fetch(`${base}/api/vault/available`, {
      headers: { authorization: `Bearer ${taskToken.token}` },
    });
    expect(response.status).toBe(200);
    const available: any = await response.json();
    expect(available).toEqual([{
      id: granted.id,
      type: 'login',
      label: 'Amazon UK',
      domains: ['www.amazon.co.uk'],
      username: 'buyer@example.com',
      fields: ['password'],
      policy: { use: 'auto', reveal: 'never' },
    }]);
    expect(JSON.stringify(available)).not.toContain('granted-secret');
    expect(available.map((item: any) => item.id)).not.toContain(hidden.id);

    const humanResponse = await fetch(`${base}/api/vault/available`, { headers: auth() });
    expect(humanResponse.status).toBe(400);
  });

  it('agent pull model: needs_approval → human grants for the task → retry succeeds', async () => {
    const item: any = await (await fetch(`${base}/api/vault/items`, { method: 'POST', headers: auth(), body: JSON.stringify({
      type: 'api-key', label: 'Service key', policy: { use: 'auto', reveal: 'auto' }, secrets: { secret: 'sk-999' },
    }) })).json();
    // A task-agent bearer whose grant does NOT cover the item (the do-role
    // ceiling admits use-credential:*, but the task grant carries no item cap).
    const minted = (await h.tokens.mint({ taskId: 'task_vaulttest', profileId: 'do', principal: 'user:test',
      ceiling: ['credential:read', 'use-credential:*'], grantorCaps: ['credential:read'] }));
    const agentAuth = { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' };

    const first: any = await (await fetch(`${base}/api/vault/resolve`, { method: 'POST', headers: agentAuth, body: JSON.stringify({ itemId: item.id }) })).json();
    expect(first.status).toBe('needs_approval');
    // The blocked reveal auto-raises the request — no separate request_credential
    // call is needed for it to surface to the human.
    expect(first.requestId).toBeTruthy();
    // An explicit request_credential dedupes onto that same pending request.
    const req: any = await (await fetch(`${base}/api/vault/requests`, { method: 'POST', headers: agentAuth, body: JSON.stringify({ itemId: item.id, mode: 'reveal', why: 'need the key' }) })).json();
    expect(req.status).toBe('needs_approval');
    expect(req.requestId).toBe(first.requestId);
    // the human resolves it for the whole task (durable grant extension)
    const resolved: any = await (await fetch(`${base}/api/vault/requests/${req.requestId}/resolve`, { method: 'POST', headers: auth(), body: JSON.stringify({ action: 'task' }) })).json();
    expect(resolved.status).toBe('granted');
    const second: any = await (await fetch(`${base}/api/vault/resolve`, { method: 'POST', headers: agentAuth, body: JSON.stringify({ itemId: item.id }) })).json();
    expect(second.status).toBe('granted');
    expect(second.value).toBe('sk-999');
    // and only for that task — a sibling task with the same shape stays parked
    const other = (await h.tokens.mint({ taskId: 'task_other', profileId: 'do', principal: 'user:test',
      ceiling: ['credential:read', 'use-credential:*'], grantorCaps: ['credential:read'] }));
    const third: any = await (await fetch(`${base}/api/vault/resolve`, { method: 'POST', headers: { authorization: `Bearer ${other.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ itemId: item.id }) })).json();
    expect(third.status).toBe('needs_approval');
  });

  it('lists task approval counts without hydrating each task conversation', async () => {
    const project = (await h.store.createProject('Compact approval list'));
    const taskIds = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const task = (await h.store.createTask({ projectId: project.id, title: `Task ${i}`, workflow: 'software-dev',
        workflowVersion: '1.0.0', params: { prompt: 'x', draft: true } }));
      taskIds.add(task.id);
      (await h.store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow,
        stage: 'done', status: 'done', messages: [{ id: 'large', text: 'x'.repeat(10_000), role: 'agent', ts: 1 }],
        actions: [], state: {}, updatedAt: 1 }));
    }
    const hydrate = vi.spyOn(h.store, 'getTask');
    try {
      const response = await fetch(`${base}/api/projects/${project.id}/tasks?includeArchived=1`, { headers: auth() });
      expect(response.status).toBe(200);
      const listed: any = await response.json();
      expect(listed).toHaveLength(30);
      expect(listed.every((task: any) => !task.lastView.messages)).toBe(true);
      expect(hydrate.mock.calls.filter(([id]) => taskIds.has(id))).toHaveLength(0);
    } finally { hydrate.mockRestore(); }
  });

  it('opens task details and numbered links without hydrating conversations for routing', async () => {
    const project = (await h.store.createProject('Async detail'));
    const task = (await h.store.createTask({ projectId: project.id, title: 'Detail', workflow: 'just-do', workflowVersion: '1',
      params: { prompt: 'fixture' } }));
    (await h.store.saveView(task.id, { taskId: task.id, title: task.title, workflow: task.workflow, stage: 'do', status: 'active',
      messages: [{ id: 'm', text: 'history', role: 'agent', ts: 1 }], actions: [], state: {}, updatedAt: 1 }));
    const hydrate = vi.spyOn(h.store, 'getTask');
    const snapshot = vi.spyOn(h.store, 'taskSnapshotAsync');
    try {
      const response = await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ taskId: task.id, num: task.num, messages: [{ text: 'history' }] });
      const numbered = await fetch(`${base}/api/projects/${project.id}/tasks/by-num/${task.num}`, { headers: auth() });
      expect(await numbered.json()).toEqual({ id: task.id, num: task.num, projectId: project.id });
      expect(hydrate.mock.calls.filter(([id]) => id === task.id)).toHaveLength(0);
      expect(snapshot.mock.calls.filter(([id]) => id === task.id)).toHaveLength(1);
    } finally { hydrate.mockRestore(); snapshot.mockRestore(); }
  });

  it('serves bounded task pages and rejects invalid pagination', async () => {
    const project = (await h.store.createProject('Paged task list'));
    for (let i = 0; i < 4; i++) (await h.store.createTask({ projectId: project.id, title: `Page ${i}`,
      workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'fixture', draft: true, archived: i === 0 } }));
    const route = `${base}/api/projects/${project.id}/tasks?page=1`;
    const response = await fetch(`${route}&limit=2&offset=1`, { headers: auth() });
    expect(response.status).toBe(200);
    const page: any = await response.json();
    expect(page.total).toBe(3);
    expect(page.tasks.map((task: any) => task.title)).toEqual(['Page 2', 'Page 3']);
    for (const query of ['limit=201', 'limit=NaN', 'offset=-1', 'offset=1.5'])
      expect((await fetch(`${route}&${query}`, { headers: auth() })).status).toBe(400);
  });

  it('projects credential approvals onto the task, notifies its human, and resumes it after resolution', async () => {
    const repo = await h.makeRepo('gw-credential-approval');
    const project: any = await (await fetch(`${base}/api/projects`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        name: 'Credential approval lifecycle',
        config: { repos: [repo], defaultBase: 'main', defaultTarget: 'main', openGithubPr: false },
      }),
    })).json();
    const task: any = await (await fetch(`${base}/api/projects/${project.id}/tasks`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        workflow: 'software-dev', title: 'Use an approval-gated credential',
        prompt: '@review waiting for a credential decision',
      }),
    })).json();
    await expect.poll(async () => {
      const view: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
      return view?.stage;
    }, { timeout: 15_000 }).toBe('review');

    const item: any = await (await fetch(`${base}/api/vault/items`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        type: 'login', label: 'Approval lifecycle login', domains: 'approval.example.com',
        policy: { use: 'auto', reveal: 'auto' }, secrets: { password: 'secret' },
      }),
    })).json();
    const minted = (await h.tokens.mint({ taskId: task.id, profileId: 'do', principal: 'user:test',
      ceiling: ['credential:read', 'use-credential:*'], grantorCaps: ['credential:read'] }));
    const agentAuth = { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' };
    const requested: any = await (await fetch(`${base}/api/vault/requests`, {
      method: 'POST', headers: agentAuth,
      body: JSON.stringify({ itemId: item.id, mode: 'reveal', why: 'verify the approval lifecycle' }),
    })).json();
    expect(requested).toMatchObject({ status: 'needs_approval', itemId: item.id });

    const requests: any = await (await fetch(
      `${base}/api/vault/requests?taskId=${task.id}&organizationId=org_personal`,
      { headers: auth() },
    )).json();
    expect(requests.find((request: any) => request.id === requested.requestId)).toMatchObject({
      task: { id: task.id, num: task.num, title: 'Use an approval-gated credential', projectId: project.id },
    });
    const taskView: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
    expect(taskView.approvalRequests).toBe(1);
    const listed: any = await (await fetch(`${base}/api/projects/${project.id}/tasks`, { headers: auth() })).json();
    expect(listed.find((candidate: any) => candidate.id === task.id).lastView.approvalRequests).toBe(1);
    const inbox = (await __asyncCollections.flatMap((await h.store.listOrganizationMemberships(project.organizationId)), async (membership) => (await h.store.listInbox(membership.userId, project.organizationId))));
    expect(inbox).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: task.id, kind: 'approval-requested', actionable: true, unread: true }),
    ]));

    const resolved: any = await (await fetch(`${base}/api/vault/requests/${requested.requestId}/resolve`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ action: 'task' }),
    })).json();
    expect(resolved).toMatchObject({ status: 'granted', resume: { resumed: true } });
    expect((await h.store.eventsSince(task.id, 0))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'conversation.message',
        payload: expect.objectContaining({ message: expect.objectContaining({ text: expect.stringContaining('Retry the blocked reveal operation now') }) }),
      }),
      expect.objectContaining({ type: 'credential.approval-resolved', payload: expect.objectContaining({ resumed: true }) }),
    ]));
    const after: any = await (await fetch(`${base}/api/tasks/${task.id}`, { headers: auth() })).json();
    expect(after.approvalRequests).toBeUndefined();
  });

  it('rotation rides the use-grant: a granted task updates a foreign item\'s secret, nothing else', async () => {
    const item: any = await (await fetch(`${base}/api/vault/items`, { method: 'POST', headers: auth(), body: JSON.stringify({
      type: 'login', label: 'Rotatable', domains: 'rot.example.com', policy: { use: 'auto', reveal: 'auto' }, secrets: { password: 'old' },
    }) })).json();
    const granted = (await h.tokens.mint({ taskId: 'task_rot', profileId: 'do', principal: 'user:test',
      ceiling: ['credential:read', 'vault:store', 'use-credential:*'], grantorCaps: ['credential:read', 'vault:store', `use-credential:item:${item.id}`] }));
    const grantedAuth = { authorization: `Bearer ${granted.token}`, 'content-type': 'application/json' };
    // secrets-only update on an item this task did NOT create → allowed by the grant
    const rotated: any = await (await fetch(`${base}/api/vault/store`, { method: 'POST', headers: grantedAuth, body: JSON.stringify({ id: item.id, type: 'login', secrets: { password: 'new' } }) })).json();
    expect(rotated.id).toBe(item.id);
    const value: any = await (await fetch(`${base}/api/vault/resolve`, { method: 'POST', headers: auth(), body: JSON.stringify({ itemId: item.id }) })).json();
    expect(value.value).toBe('new');
    // metadata-only update on a foreign item → refused
    const meta = await fetch(`${base}/api/vault/store`, { method: 'POST', headers: grantedAuth, body: JSON.stringify({ id: item.id, type: 'login', label: 'hijacked' }) });
    expect(meta.status).toBe(403);
    const listed: any = await (await fetch(`${base}/api/vault/items`, { headers: auth() })).json();
    expect(listed.find((i: any) => i.id === item.id).label).toBe('Rotatable');
    // an UNgranted task cannot rotate
    const ungranted = (await h.tokens.mint({ taskId: 'task_norot', profileId: 'do', principal: 'user:test',
      ceiling: ['credential:read', 'vault:store', 'use-credential:*'], grantorCaps: ['credential:read', 'vault:store'] }));
    const denied = await fetch(`${base}/api/vault/store`, { method: 'POST', headers: { authorization: `Bearer ${ungranted.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: item.id, type: 'login', secrets: { password: 'evil' } }) });
    expect(denied.status).toBe(403);
    // a reset report parks with its kind for the human
    const reset: any = await (await fetch(`${base}/api/vault/requests`, { method: 'POST', headers: grantedAuth, body: JSON.stringify({ itemId: item.id, kind: 'reset', why: 'site rejected it' }) })).json();
    expect(reset.status).toBe('needs_approval');
    const reqs: any = await (await fetch(`${base}/api/vault/requests?status=pending`, { headers: auth() })).json();
    expect(reqs.find((r: any) => r.id === reset.requestId).kind).toBe('reset');
  });

  it('propagates an agent-created item rotation to its write-back entry without clobbering notes', async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-fake-pass-'));
    const fakePass = path.join(fakeHome, 'pass');
    const entryFile = path.join(fakeHome, 'entry');
    fs.writeFileSync(fakePass, `#!/bin/sh
case "$1" in
  show) cat "$KARMAX_TEST_PASS_ENTRY" ;;
  insert) cat > "$KARMAX_TEST_PASS_ENTRY"; mkdir -p "$PASSWORD_STORE_DIR"; touch "$PASSWORD_STORE_DIR/export.gpg" ;;
  *) exit 1 ;;
esac
`);
    fs.chmodSync(fakePass, 0o755);
    const previousPath = process.env.PATH;
    const previousEntry = process.env.KARMAX_TEST_PASS_ENTRY;
    const previousStore = process.env.PASSWORD_STORE_DIR;
    process.env.PASSWORD_STORE_DIR = fakeHome;
    process.env.PATH = `${fakeHome}${path.delimiter}${previousPath ?? ''}`;
    process.env.KARMAX_TEST_PASS_ENTRY = entryFile;
    try {
      const configured = await fetch(`${base}/api/vault/connectors/pass/config`, {
        method: 'POST', headers: auth(), body: JSON.stringify({ writeBack: true }),
      });
      expect(configured.status).toBe(200);
      const agent = (await h.tokens.mint({
        taskId: 'task_agent_writeback_rotation',
        profileId: 'do',
        principal: 'user:test',
        ceiling: ['credential:read', 'vault:store'],
        grantorCaps: ['credential:read', 'vault:store'],
      }));
      const agentAuth = { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' };
      const created: any = await (await fetch(`${base}/api/vault/store`, {
        method: 'POST',
        headers: agentAuth,
        body: JSON.stringify({
          type: 'login',
          label: 'Agent-created pass rotation',
          domains: ['rotation.example.com'],
          username: 'agent@example.com',
          secrets: { password: 'initial' },
        }),
      })).json();
      expect(created.writeBack).toEqual([
        { connector: 'pass', externalId: `tavya/${created.id}.login` },
      ]);
      expect(fs.readFileSync(entryFile, 'utf8')).toBe('initial\nusername: agent@example.com\n');

      // Real pass entries often contain notes below line 1. Rotation must use
      // updateSecret, not push, so those lines survive.
      fs.appendFileSync(entryFile, 'keep this note\n');
      const rotated: any = await (await fetch(`${base}/api/vault/store`, {
        method: 'POST',
        headers: agentAuth,
        body: JSON.stringify({
          id: created.id,
          type: 'login',
          label: 'Agent-created pass rotation',
          secrets: { password: 'rotated' },
        }),
      })).json();
      expect(rotated.propagated).toEqual({ connector: 'pass', fields: ['password'] });
      expect(fs.readFileSync(entryFile, 'utf8')).toBe(
        'rotated\nusername: agent@example.com\nkeep this note\n',
      );
      const { PasskeyManager } = await import('../src/autonomy/passkey.js');
      const { parsePassItem } = await import('../src/autonomy/pass-format.js');
      const credentials = [{ credentialId: 'test-id', privateKey: 'test-key', rpId: 'example.com', userHandle: 'test-user', signCount: 0 }];
      const harvest = vi.spyOn(PasskeyManager.prototype, 'harvest').mockResolvedValue(credentials);
      try {
        const response = await fetch(`${base}/api/vault/passkey/save`, {
          method: 'POST', headers: agentAuth, body: JSON.stringify({authenticatorId:'test',label:'Enrolled passkey'}),
        });
        expect(response.status).toBe(200);
        const saved: any = await response.json();
        expect(saved.writeBack).toEqual([{connector:'pass',externalId:`tavya/${saved.itemId}.passkey`}]);
        expect(parsePassItem(fs.readFileSync(entryFile,'utf8')).secrets.passkey).toBe(JSON.stringify(credentials));
      } finally { harvest.mockRestore(); }

    } finally {
      await fetch(`${base}/api/vault/connectors/pass/config`, {
        method: 'POST', headers: auth(), body: JSON.stringify({ writeBack: false }),
      }).catch(() => {});
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousEntry === undefined) delete process.env.KARMAX_TEST_PASS_ENTRY;
      else process.env.KARMAX_TEST_PASS_ENTRY = previousEntry;
      if (previousStore === undefined) delete process.env.PASSWORD_STORE_DIR;
      else process.env.PASSWORD_STORE_DIR=previousStore;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('lists the external-store connectors (describe, unauthenticated CLIs report not-ready)', async () => {
    const conns: any = await (await fetch(`${base}/api/vault/connectors`, { headers: auth() })).json();
    expect(conns.map((c: any) => c.name).sort()).toEqual(['1password', 'bitwarden', 'pass', 'pass-git']);
    // In CI none of the CLIs are configured, so each reports a clear reason.
    for (const c of conns) { expect(typeof c.available).toBe('boolean'); expect(c.detail).toBeTruthy(); }
  });

  it('requires connector administration for retrying or discarding pending writes', async () => {
    const reader=(await h.tokens.mint({taskId:'task_retry_reader',profileId:'do',principal:'user:test',ceiling:['credential:read'],grantorCaps:['credential:read']}));
    for(const action of ['retry-writes','discard-writes']){
      const denied=await fetch(`${base}/api/vault/connectors/pass-git/${action}`,{method:'POST',headers:{authorization:`Bearer ${reader.token}`,'content-type':'application/json'},body:'{}'});
      expect(denied.status).toBe(403);
      const allowed=await fetch(`${base}/api/vault/connectors/pass-git/${action}`,{method:'POST',headers:auth(),body:'{}'});
      expect(allowed.status).toBe(200);
    }
  });

  it('agent mailbox: per-org address, shared-secret ingest, reads, and tenant isolation', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    expect(orgId).toBeTruthy();
    const addr: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail`, { headers: auth() })).json();
    expect(addr.address).toMatch(/@/);
    // the webhook secret is MINTED by karmax and rides in the copy-pasted URL
    const providers: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail/providers`, { headers: auth() })).json();
    expect(providers.webhookUrl).toContain('/api/agent-mail/ingest?secret=');
    expect(providers.cloudflareWorker).toContain('async email(message');
    const hook = new URL(providers.webhookUrl);
    const ingest = `${base}${hook.pathname}${hook.search}`;
    const rejected = await fetch(`${base}/api/agent-mail/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: addr.address, from: 'x@y.com', text: 'code 314159' }) });
    expect(rejected.status).toBe(401);
    const ok: any = await (await fetch(ingest, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: addr.address, from: 'noreply@github.com', subject: 'Verify', text: 'Your code is 314159' }) })).json();
    expect(ok.delivered).toBe(true);
    // provider-shaped payloads normalize too (Mailgun urlencoded)
    const mg: any = await (await fetch(ingest, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ recipient: addr.address, sender: 'no-reply@stripe.com', subject: 'Code', 'body-plain': 'Your code is 271828' }).toString() })).json();
    expect(mg.delivered).toBe(true);
    // mail to an address no organization owns is dropped
    const dropped: any = await (await fetch(ingest, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'stranger@agent.local', from: 'x@y.com', text: 'code 999999' }) })).json();
    expect(dropped.delivered).toBe(false);
    const inbox: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail?match=github`, { headers: auth() })).json();
    expect(inbox.messages[0].code).toBe('314159');
    const inbox2: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail?match=stripe`, { headers: auth() })).json();
    expect(inbox2.messages[0].code).toBe('271828');
    // an agent token scoped to ANOTHER organization cannot read this inbox
    const foreign = (await h.tokens.mint({ taskId: 'task_mail', profileId: 'do', principal: 'user:test',
      organizationId: 'org_other', ceiling: ['credential:read'], grantorCaps: ['credential:read'] }));
    const denied = await fetch(`${base}/api/organizations/${orgId}/agent-mail`, { headers: { authorization: `Bearer ${foreign.token}` } });
    expect(denied.status).toBe(403);
  });

  it('mailbox provider: connect a domain in Settings (no env var) and addresses adopt it', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    const providers: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail/providers`, { headers: auth() })).json();
    expect(providers.providers.map((p: any) => p.name).sort()).toEqual(['agentmail', 'hosted', 'imap', 'self-managed']);
    const connect = await fetch(`${base}/api/organizations/${orgId}/agent-mail/connect`, { method: 'POST', headers: auth(), body: JSON.stringify({ provider: 'self-managed', domain: 'agents.test.co' }) });
    expect(connect.status).toBe(200);
    // a fresh org now mints its address on the connected domain
    const addr: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail`, { headers: auth() })).json();
    expect(addr.address.endsWith('@agents.test.co')).toBe(true);
    expect(addr.configured).toBe(true);
    // an invalid domain is rejected with a clear reason, not stored
    const bad = await fetch(`${base}/api/organizations/${orgId}/agent-mail/connect`, { method: 'POST', headers: auth(), body: JSON.stringify({ provider: 'self-managed', domain: 'nonsense' }) });
    expect(bad.status).toBe(400);
    // pull providers are flagged so the UI can group them (work on localhost)
    expect(providers.providers.find((p: any) => p.name === 'imap').pull).toBe(true);
    expect(providers.providers.find((p: any) => p.name === 'self-managed').pull).toBe(false);
    // connect a pull provider (IMAP): addresses ride +tags on the mailbox
    const imapOk = await fetch(`${base}/api/organizations/${orgId}/agent-mail/connect`, { method: 'POST', headers: auth(), body: JSON.stringify({ provider: 'imap', address: 'agentbox@gmail.com', apiKey: 'app-pass' }) });
    expect(imapOk.status).toBe(200);
    const imapAddr: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail`, { headers: auth() })).json();
    expect(imapAddr.address).toMatch(/^agentbox\+agent-[0-9a-f]+@gmail\.com$/);
  });

  it('connects an existing AgentMail inbox for only that organization', async () => {
    const originalFetch = globalThis.fetch;
    let verified = 0;
    const provider = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== 'api.agentmail.to') return originalFetch(input, init);
      expect(url.pathname).toBe('/v0/inboxes/myinbox%40agentmail.to');
      verified++;
      const authorized = new Headers(init?.headers).get('authorization') === 'Bearer am-test-key';
      return Response.json(authorized ? { inbox_id: 'myinbox@agentmail.to' } : { error: 'forbidden' },
        { status: authorized ? 200 : 403 });
    });
    try {
      const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
      const orgId = orgs[0]?.id;
      const before = await h.store.kvGet(`agent-mail:provider:${orgId}`);
      const denied = await fetch(`${base}/api/organizations/${orgId}/agent-mail/connect`, {
        method: 'POST', headers: auth(),
        body: JSON.stringify({ provider: 'agentmail', domain: 'MyInbox@agentmail.to', apiKey: 'am-denied' }),
      });
      expect(denied.status).toBe(400);
      expect(await h.store.kvGet(`agent-mail:provider:${orgId}`)).toBe(before);
      const connect = await fetch(`${base}/api/organizations/${orgId}/agent-mail/connect`, {
        method: 'POST',
        headers: auth(),
        body: JSON.stringify({ provider: 'agentmail', domain: 'MyInbox@agentmail.to', apiKey: 'am-test-key' }),
      });
      expect(connect.status).toBe(200);
      expect(verified).toBe(2);
      const mailbox: any = await (await fetch(`${base}/api/organizations/${orgId}/agent-mail`, { headers: auth() })).json();
      expect(mailbox.address).toBe('myinbox@agentmail.to');
      expect(mailbox.configured).toBe(true);
      expect((await h.store.kvGet(`agent-mail:provider:${orgId}`))).toContain('mailbox:agentmail:');
      expect((await h.store.kvGet('agent-mail:provider'))).toBeUndefined();
    } finally { provider.mockRestore(); }
  });

  it('configures the shared Stripe Connect application from the operator API without returning secrets', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    const endpoint = `${base}/api/organizations/${orgId}/payments/stripe/platform`;
    const before: any = await (await fetch(endpoint, { headers: auth() })).json();
    expect(before).toMatchObject({
      canManage: true,
      callbackUrl: `${base}/api/payments/stripe/callback`,
      webhookUrl: `${base}/api/payments/stripe/webhook`,
    });
    const organizationPaymentAdmin = (await h.tokens.mint({
      taskId: 'task_payment_admin',
      profileId: 'operator',
      principal: 'user:organization-payment-admin',
      organizationId: orgId,
      ceiling: ['payment:read', 'payment:write'],
      grantorCaps: ['payment:read', 'payment:write'],
    }));
    const forbidden = await fetch(endpoint, {
      method: 'PUT',
      headers: { authorization: `Bearer ${organizationPaymentAdmin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'ca_forbidden', secretKey: 'sk_test_forbidden' }),
    });
    expect(forbidden.status).toBe(403);

    const saved = await fetch(endpoint, {
      method: 'PUT',
      headers: auth(),
      body: JSON.stringify({
        clientId: 'ca_gateway_managed',
        secretKey: 'sk_test_gateway_managed',
        webhookSecret: 'whsec_gateway_managed',
      }),
    });
    expect(saved.status).toBe(200);
    const status: any = await saved.json();
    expect(status).toMatchObject({
      configured: true, clientId: 'ca_gateway_managed', secretKeyConfigured: true,
      webhookConfigured: true, source: 'ui',
    });
    expect(JSON.stringify(status)).not.toContain('sk_test_gateway_managed');
    expect(JSON.stringify(status)).not.toContain('whsec_gateway_managed');
    expect(JSON.stringify((await h.store.exportOrganization(orgId)))).not.toContain('sk_test_gateway_managed');

    const providers: any = await (await fetch(`${base}/api/organizations/${orgId}/payments/providers`,
      { headers: auth() })).json();
    expect(providers.providers.find((provider: any) => provider.name === 'stripe'))
      .toMatchObject({ available: true, connected: false });
  });

  it('cards are organization-scoped: one org never sees or spends another\'s card', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    const other = (await h.store.createOrganization({ name: 'Other payments org' }));
    const made: any = await (await fetch(`${base}/api/cards?organizationId=${orgId}`, { method: 'POST', headers: auth(), body: JSON.stringify({ scope: 'organization', label: 'Org card', cap: 100000 }) })).json();
    expect(made.scope).toBe('organization');
    expect(made.scopeId).toBe(orgId);
    const mine: any = await (await fetch(`${base}/api/cards?organizationId=${orgId}`, { headers: auth() })).json();
    expect(mine.map((c: any) => c.id)).toContain(made.id);
    // a different org's card listing does not include it
    const others: any = await (await fetch(`${base}/api/cards?organizationId=${other.id}`, { headers: auth() })).json();
    expect(others.map((c: any) => c.id)).not.toContain(made.id);
    const crossFund = await fetch(`${base}/api/cards/${made.id}/fund?organizationId=${other.id}`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ amount: 100 }),
    });
    expect(crossFund.status).toBe(404);
    expect((await h.store.getCard(made.id)).available).toBe(0);
    const invalidFund = await fetch(`${base}/api/cards/${made.id}/fund?organizationId=${orgId}`, {
      method: 'POST', headers: auth(), body: JSON.stringify({ amount: -100 }),
    });
    expect(invalidFund.status).toBe(400);
  });

  it('registers a vault card without ever handing the number back out', async () => {
    const orgs: any = await (await fetch(`${base}/api/organizations`, { headers: auth() })).json();
    const orgId = orgs[0]?.id;
    const register = (details: unknown) => fetch(`${base}/api/cards?organizationId=${orgId}`, {
      method: 'POST', headers: auth(), body: JSON.stringify({
        scope: 'organization', label: 'Household', cap: 50_000, provider: 'vault-card', details }),
    });
    const bad = await register({ number: '4242424242424241', cvc: '123', expMonth: 12, expYear: 2031 });
    expect(bad.status).toBe(400);
    expect((await bad.json() as any).error).toMatch(/card number/i);

    const response = await register({ number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2031,
      billing: { line1: '1 High St', city: 'London', postalCode: 'SW1A 1AA', country: 'GB' } });
    expect(response.status).toBe(200);
    const card: any = await response.json();
    expect(card).toMatchObject({ provider: 'vault-card', last4: '4242', available: 50_000 });
    // The secret half lives only in the vault — not the response, not the index.
    expect(JSON.stringify(card)).not.toContain('4242424242424242');
    const listed = await (await fetch(`${base}/api/cards?organizationId=${orgId}`, { headers: auth() })).text();
    expect(listed).not.toContain('4242424242424242');
    expect(h.broker.hasHandle(`payment:card:${card.id}`)).toBe(true);

    // Revoking destroys the secret rather than merely hiding the row.
    expect((await fetch(`${base}/api/cards/${card.id}?organizationId=${orgId}`,
      { method: 'DELETE', headers: auth() })).status).toBe(200);
    expect(h.broker.hasHandle(`payment:card:${card.id}`)).toBe(false);
  });
});

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { Client } from '@temporalio/client';
import { KarmaxApi, CapabilityError } from '../platform/api.js';
import { Store } from '../store/db.js';
import { KarmaxBus } from '../contrib/bus.js';
import { TokenAuthority } from '../platform/tokens.js';
import { ContributionRegistry } from '../contrib/registry.js';
import { Overlays } from '../store/overlays.js';
import { manifest, MANIFESTS } from '../contrib/manifests.js';
import { projectSettingsFor, globalSettingsFor, settingsToProjectConfig, resolveParams } from '../platform/params.js';
import { defaultProvider } from '../agent/adapters.js';
import { defaultModel } from '../agent/profiles.js';
import { defaultBranch } from '../world/git.js';
import { accountCoordinatorId } from '../coordinators/names.js';
import { findFreePort } from '../util/ports.js';
import { expandPath } from '../util/expand.js';
import { Provider, ProjectConfig } from '../domain/types.js';

export interface GatewayDeps {
  api: KarmaxApi;
  store: Store;
  bus: KarmaxBus;
  tokens: TokenAuthority;
  contributions: ContributionRegistry;
  overlays: Overlays;
  client: Client;
  taskQueue: string;
  staticDir: string;
  agentInfo: { provider: Provider; reason: string };
  broker?: import('../autonomy/broker.js').CredentialBroker;
  password?: string;
  version?: string;
}

const USER_CAPS = ['*'];
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

interface Session {
  user: string;
  apiToken: string;
}

export class Gateway {
  private sessions = new Map<string, Session>();
  private server?: http.Server;
  private safeMode = process.env.KARMAX_SAFE_MODE === '1';

  constructor(private deps: GatewayDeps) {}

  private newSession(user = 'me'): { sid: string; session: Session } {
    const sid = `s_${crypto.randomBytes(18).toString('hex')}`;
    const apiToken = this.deps.tokens.mintPrincipal(`user:${user}`, USER_CAPS).token;
    const session: Session = { user, apiToken };
    this.sessions.set(sid, session);
    return { sid, session };
  }

  async listen(preferredPort?: number): Promise<{ url: string; port: number; close: () => Promise<void> }> {
    const port = preferredPort ?? (await findFreePort());
    const server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.fail(res, e)));
    this.server = server;

    // Two WebSocket endpoints, routed by path on upgrade:
    //  /ws          — the live event stream (SPEC §3.3 transport).
    //  /ws/terminal — a PTY against the task's world (cheap check-in, SPEC §5.5).
    const wssEvents = new WebSocketServer({ noServer: true });
    const wssTerm = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      if (pathname === '/ws') wssEvents.handleUpgrade(req, socket, head, (ws) => wssEvents.emit('connection', ws, req));
      else if (pathname === '/ws/terminal') wssTerm.handleUpgrade(req, socket, head, (ws) => wssTerm.emit('connection', ws, req));
      else socket.destroy();
    });
    wssEvents.on('connection', (ws) => {
      const off = this.deps.bus.onAny((ev) => {
        try { ws.send(JSON.stringify(ev)); } catch { /* ignore */ }
      });
      ws.on('close', off);
      ws.on('error', off);
    });
    wssTerm.on('connection', (ws, req) => this.terminal(ws, req));

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
    return {
      url: `http://127.0.0.1:${port}`,
      port,
      close: () =>
        new Promise<void>((resolve) => {
          wssEvents.close();
          wssTerm.close();
          server.close(() => resolve());
        }),
    };
  }

  /** PTY check-in (SPEC §5.5): an ephemeral terminal in the task's on-disk world. */
  private async terminal(ws: import('ws').WebSocket, req: http.IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const taskId = url.searchParams.get('taskId') ?? '';
    const cwd = this.deps.store.getTask(taskId)?.lastView?.worldPath;
    if (!cwd) {
      ws.send(JSON.stringify({ type: 'data', data: 'No world for this task yet.\r\n' }));
      ws.close();
      return;
    }
    let pty: any;
    try {
      pty = await import('node-pty');
    } catch {
      ws.send(JSON.stringify({ type: 'data', data: 'PTY unavailable (node-pty not installed).\r\n' }));
      ws.close();
      return;
    }
    // Use bash with a clean prompt for a predictable check-in terminal.
    const term = pty.spawn('bash', ['--norc', '-i'], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, PS1: 'karmax:\\W$ ' },
    });
    term.onData((d: string) => { try { ws.send(JSON.stringify({ type: 'data', data: d })); } catch {} });
    term.onExit(() => { try { ws.close(); } catch {} });
    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'input') term.write(msg.data);
      else if (msg.type === 'resize') term.resize(msg.cols || 80, msg.rows || 24);
    });
    ws.on('close', () => { try { term.kill(); } catch {} });
  }

  // ─── request handling ────────────────────────────────────────────────────────
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (p.startsWith('/api/')) return this.api(req, res, url);
    if (p === '/ws') return; // handled by ws
    return this.static(p, res);
  }

  private async api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const p = url.pathname;
    const method = req.method ?? 'GET';

    // ── unauthenticated endpoints ──
    if (p === '/api/session' && method === 'GET') {
      const authRequired = !!this.deps.password;
      if (!authRequired) {
        const { sid } = this.newSession();
        return this.json(res, 200, { authRequired: false, token: sid, user: 'me' });
      }
      return this.json(res, 200, { authRequired: true });
    }
    if (p === '/api/login' && method === 'POST') {
      const b = await this.body(req);
      if (this.deps.password && b.password === this.deps.password) {
        const { sid } = this.newSession();
        return this.json(res, 200, { token: sid, user: 'me' });
      }
      return this.json(res, 401, { error: 'invalid password' });
    }
    if (p === '/api/meta' && method === 'GET') {
      return this.json(res, 200, {
        agent: this.deps.agentInfo,
        version: this.deps.version ?? '1.0.0',
        safeMode: this.safeMode,
      });
    }

    // ── authenticated endpoints ──
    const session = this.auth(req);
    if (!session) return this.json(res, 401, { error: 'unauthorized' });
    const token = session.apiToken;
    const { api, store } = this.deps;

    try {
      // projects
      if (p === '/api/projects' && method === 'GET') return this.json(res, 200, store.listProjects());
      if (p === '/api/projects' && method === 'POST') {
        const b = await this.body(req);
        return this.json(res, 200, store.createProject(b.name ?? 'New project', normalizeConfig(b.config)));
      }
      const projMatch = p.match(/^\/api\/projects\/([^/]+)$/);
      if (projMatch) {
        const id = projMatch[1]!;
        if (method === 'GET') return this.json(res, 200, store.getProject(id) ?? null);
        if (method === 'PATCH') {
          const b = await this.body(req);
          return this.json(res, 200, store.updateProjectConfig(id, normalizeConfig(b.config)));
        }
        if (method === 'DELETE') {
          store.deleteProject(id);
          return this.json(res, 200, { ok: true });
        }
      }
      const tasksMatch = p.match(/^\/api\/projects\/([^/]+)\/tasks$/);
      if (tasksMatch) {
        const projectId = tasksMatch[1]!;
        if (method === 'GET') {
          const tasks = await api.listTasks(token, projectId);
          // enrich with the freshest live view where possible
          const enriched = await Promise.all(
            tasks.map(async (t) => {
              const view = await api.getTaskView(token, t.id).catch(() => t.lastView);
              return { ...t, lastView: view ?? t.lastView };
            }),
          );
          return this.json(res, 200, enriched);
        }
        if (method === 'POST') {
          const b = await this.body(req);
          const task = await api.createTask(token, { projectId, ...b });
          return this.json(res, 200, task);
        }
      }
      const activateMatch = p.match(/^\/api\/projects\/([^/]+)\/activate-workflow$/);
      if (activateMatch && method === 'POST') {
        const projectId = activateMatch[1]!;
        const b = await this.body(req);
        return this.json(res, 200, await this.activateWorkflow(token, projectId, b.workflow));
      }

      // tasks
      const viewMatch = p.match(/^\/api\/tasks\/([^/]+)$/);
      if (viewMatch && method === 'GET') {
        return this.json(res, 200, (await api.getTaskView(token, viewMatch[1]!)) ?? null);
      }
      const queueMatch = p.match(/^\/api\/tasks\/([^/]+)\/queue$/);
      if (queueMatch && method === 'POST') {
        return this.json(res, 200, await api.queueTask(token, queueMatch[1]!));
      }
      const editMatch = p.match(/^\/api\/tasks\/([^/]+)\/params$/);
      if (editMatch && method === 'PATCH') {
        const b = await this.body(req);
        const t = store.getTask(editMatch[1]!);
        if (t) store.updateTaskParams(editMatch[1]!, { ...t.params, ...b.params });
        return this.json(res, 200, store.getTask(editMatch[1]!) ?? null);
      }
      const signalMatch = p.match(/^\/api\/tasks\/([^/]+)\/signal$/);
      if (signalMatch && method === 'POST') {
        const b = await this.body(req);
        await api.signalTask(token, signalMatch[1]!, b.signal, b.text);
        return this.json(res, 200, { ok: true });
      }
      const targetMatch = p.match(/^\/api\/tasks\/([^/]+)\/target$/);
      if (targetMatch && method === 'POST') {
        const b = await this.body(req);
        return this.json(res, 200, { ok: await api.setTarget(token, targetMatch[1]!, b.branch) });
      }
      const eventsMatch = p.match(/^\/api\/tasks\/([^/]+)\/events$/);
      if (eventsMatch && method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? '0');
        return this.json(res, 200, store.eventsSince(eventsMatch[1]!, since));
      }
      const sessMatch = p.match(/^\/api\/tasks\/([^/]+)\/sessions$/);
      if (sessMatch && method === 'GET') {
        const id = sessMatch[1]!;
        const out: Record<string, string> = {};
        for (const role of ['do', 'merge', 'resolve', 'confirm']) {
          const s = store.kvGet(`session:${id}:${role}`);
          if (s) out[role] = s;
        }
        return this.json(res, 200, out);
      }

      // merge queue
      if (p === '/api/queue' && method === 'GET') {
        const domain = url.searchParams.get('domain') ?? '';
        return this.json(res, 200, await api.queueView(token, domain));
      }
      if (p === '/api/queue/prioritize' && method === 'POST') {
        const b = await this.body(req);
        await api.reorderQueue(token, b.domain, b.taskId);
        return this.json(res, 200, { ok: true });
      }

      // profiles (agent role profiles: provider/model/effort/capabilities/auth)
      if (p === '/api/profiles' && method === 'GET') return this.json(res, 200, store.listProfiles());
      if (p === '/api/profiles' && method === 'PUT') {
        const b = await this.body(req);
        if (!b.id || !b.role) return this.json(res, 400, { error: 'profile needs id + role' });
        store.upsertProfile({ provider: 'claude', capabilities: [], ...b });
        return this.json(res, 200, store.getProfile(b.id) ?? null);
      }

      // accounts (credential handles in the broker; secrets are write-only)
      if (p === '/api/accounts' && method === 'GET') {
        return this.json(res, 200, { handles: this.deps.broker?.listHandles() ?? [] });
      }
      if (p === '/api/accounts' && method === 'POST') {
        const b = await this.body(req);
        if (!this.deps.broker) return this.json(res, 400, { error: 'no credential broker configured' });
        if (!b.provider || !b.account || !b.apiKey) return this.json(res, 400, { error: 'provider, account, apiKey required' });
        const handle = `${b.provider}:${b.account}`;
        this.deps.broker.registerHandle(handle, String(b.apiKey));
        return this.json(res, 200, { handle }); // never echoes the secret
      }

      // workflow parameter schemas (SPEC §10.4) — drives task forms + settings forms
      if (p === '/api/schema' && method === 'GET') {
        return this.json(
          res,
          200,
          MANIFESTS.filter((m) => m.kind !== 'coordinator').map((m) => ({ name: m.name, description: m.description, params: m.params })),
        );
      }

      // resolved/inherited defaults per scope — drives form placeholders (SPEC §10.4)
      const defs = p.match(/^\/api\/defaults\/([^/]+)\/([^/]+)$/);
      if (defs && method === 'GET') {
        const projectId = defs[1]!;
        const wf = defs[2]!;
        const m = manifest(wf);
        if (!m) return this.json(res, 404, { error: 'no workflow' });
        const gs = (s: string, w: string) => store.getSettings(s, w);
        const project = store.getProject(projectId);
        const globalVals = globalSettingsFor(gs, wf);
        const projectVals = project ? projectSettingsFor(gs, project, wf) : {};
        // Detect the repo's real default branch so placeholders show it (not "main").
        const repo0 = project?.config.repos?.[0] ? expandPath(project.config.repos[0]) : undefined;
        const db = repo0 ? await defaultBranch(repo0).catch(() => undefined) : undefined;
        const enrich = (vals: Record<string, unknown>, lower: Record<string, unknown>) => {
          const out = this.enrichAgentDefaults(m, vals);
          if (db) {
            if (lower.base === undefined && globalVals.base === undefined && projectVals.base === undefined) out.base = db;
            if (lower.target === undefined && globalVals.target === undefined && projectVals.target === undefined) out.target = db;
          }
          return out;
        };
        return this.json(res, 200, {
          task: { own: {}, inherited: enrich(resolveParams(m, { project: projectVals, global: globalVals }), {}) },
          project: { own: projectVals, inherited: enrich(resolveParams(m, { global: globalVals }), projectVals) },
          global: { own: globalVals, inherited: enrich(resolveParams(m, {}), { ...projectVals, ...globalVals }) },
        });
      }

      // settings (global + per-project, per workflow)
      const gset = p.match(/^\/api\/settings\/global\/([^/]+)$/);
      if (gset) {
        const wf = gset[1]!;
        if (method === 'GET') return this.json(res, 200, globalSettingsFor((s, w) => store.getSettings(s, w), wf));
        if (method === 'PUT') {
          const b = await this.body(req);
          store.setSettings('global', wf, b.values ?? {});
          return this.json(res, 200, { ok: true });
        }
      }
      const pset = p.match(/^\/api\/settings\/project\/([^/]+)\/([^/]+)$/);
      if (pset) {
        const projectId = pset[1]!;
        const wf = pset[2]!;
        if (method === 'GET') {
          const project = store.getProject(projectId);
          if (!project) return this.json(res, 404, { error: 'no project' });
          return this.json(res, 200, projectSettingsFor((s, w) => store.getSettings(s, w), project, wf));
        }
        if (method === 'PUT') {
          const b = await this.body(req);
          const values = b.values ?? {};
          store.setSettings(projectId, wf, values);
          // Mirror bound-project fields into ProjectConfig for back-compat.
          const m = manifest(wf);
          if (m) store.updateProjectConfig(projectId, settingsToProjectConfig(m, values));
          return this.json(res, 200, { ok: true });
        }
      }

      // contributions (slots / commands / event schemas)
      if (p === '/api/contributions' && method === 'GET') {
        return this.json(res, 200, {
          slots: this.deps.contributions.slots(),
          commands: this.deps.contributions.commands(),
          events: this.deps.contributions.eventSchemas(),
        });
      }

      // activity feed (all events)
      if (p === '/api/activity' && method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? '0');
        return this.json(res, 200, store.allEventsSince(since).slice(-300));
      }

      // dashboard
      if (p === '/api/dashboard' && method === 'GET') {
        return this.json(res, 200, await this.dashboard());
      }

      // safe mode toggle
      if (p === '/api/safe-mode' && method === 'POST') {
        const b = await this.body(req);
        this.safeMode = !!b.enabled;
        return this.json(res, 200, { safeMode: this.safeMode });
      }

      return this.json(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof CapabilityError) return this.json(res, 403, { error: e.message });
      throw e;
    }
  }

  private async activateWorkflow(token: string, projectId: string, workflow: string) {
    const m = manifest(workflow);
    const spawned: string[] = [];
    if (m?.onActivate?.spawnTask) {
      const t = m.onActivate.spawnTask;
      const task = await this.deps.api.createTask(token, {
        projectId,
        title: t.title,
        prompt: t.prompt,
        workflow: t.workflow,
      });
      spawned.push(task.id);
    }
    return { activated: workflow, requires: m?.requires ?? [], spawnedTasks: spawned };
  }

  /** For each agent field, resolve the concrete provider/model the server would
   *  actually run (setting → seeded profile → code default), so the form can show
   *  it as the inherited default. */
  private enrichAgentDefaults(m: import('../contrib/manifests.js').WorkflowManifest, vals: Record<string, unknown>) {
    const out = { ...vals };
    for (const f of m.params) {
      if (f.type !== 'agent' || !f.role) continue;
      const spec = (out[f.name] as any) || {};
      const prof = this.deps.store.getProfile(`${f.role}-default`);
      const provider = spec.provider ?? prof?.provider ?? defaultProvider().provider;
      const model = spec.model ?? prof?.model ?? defaultModel(provider);
      out[f.name] = { provider, ...(model ? { model } : {}), ...(spec.effort ? { effort: spec.effort } : {}) };
    }
    return out;
  }

  private async dashboard() {
    let accounts: unknown = { accounts: [], waiting: 0 };
    try {
      accounts = await this.deps.client.workflow.getHandle(accountCoordinatorId()).query('accounts');
    } catch {
      /* coordinator not running */
    }
    const projects = this.deps.store.listProjects();
    const allTasks = projects.flatMap((pr) => this.deps.store.listTasks(pr.id));
    const byStage: Record<string, number> = {};
    for (const t of allTasks) {
      const stage = t.lastView?.stage ?? 'unknown';
      byStage[stage] = (byStage[stage] ?? 0) + 1;
    }
    return { accounts, projects: projects.length, tasks: allTasks.length, byStage };
  }

  // ── static SPA ──
  private async static(p: string, res: http.ServerResponse) {
    let rel = p === '/' ? '/index.html' : p;
    let file = path.join(this.deps.staticDir, rel);
    if (!file.startsWith(this.deps.staticDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(this.deps.staticDir, 'index.html'); // SPA fallback
    }
    try {
      const data = await fs.promises.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  }

  // ── helpers ──
  private auth(req: http.IncomingMessage): Session | undefined {
    const h = req.headers['authorization'];
    const sid = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    return sid ? this.sessions.get(sid) : undefined;
  }
  private json(res: http.ServerResponse, status: number, obj: unknown) {
    const body = JSON.stringify(obj ?? null);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  }
  private async body(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return {};
    }
  }
  private fail(res: http.ServerResponse, e: unknown) {
    try {
      this.json(res, 500, { error: String((e as Error)?.message ?? e) });
    } catch {
      /* ignore */
    }
  }
}

/** Expand ~ / $HOME in repo paths so a configured repo resolves to a real dir. */
function normalizeConfig(config: ProjectConfig = {}): ProjectConfig {
  if (Array.isArray(config.repos)) {
    return { ...config, repos: config.repos.filter(Boolean).map(expandPath) };
  }
  return config;
}

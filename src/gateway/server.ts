import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import type { Client } from '@temporalio/client';
import { KarmaxApi, CapabilityError } from '../platform/api.js';
import { Store } from '../store/db.js';
import { AttachmentStore, AttachmentError, MAX_IMAGE_BYTES } from '../store/attachments.js';
import { KarmaxBus } from '../contrib/bus.js';
import { TokenAuthority } from '../platform/tokens.js';
import { ContributionRegistry } from '../contrib/registry.js';
import { Overlays } from '../store/overlays.js';
import { manifest } from '../contrib/manifests.js';
import { projectSettingsFor, globalSettingsFor, settingsToProjectConfig, resolveParams } from '../platform/params.js';
import { defaultProvider } from '../agent/adapters.js';
import { defaultModel, defaultEffort } from '../agent/profiles.js';
import { defaultBranch } from '../world/git.js';
import { accountCoordinatorId } from '../coordinators/names.js';
import { findFreePortFrom } from '../util/ports.js';
import { expandPath } from '../util/expand.js';
import { withTimeout } from '../util/timeout.js';
import { Provider, ProjectConfig } from '../domain/types.js';
import { ReviewActionRunner } from './review-actions.js';

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
  payments?: import('../autonomy/payments.js').PaymentProvider;
  paymentRegistry?: import('../autonomy/payments.js').PaymentRegistry;
  login?: import('../autonomy/login.js').LoginManager;
  configHomes?: import('../autonomy/config-homes.js').ConfigHomeManager;
  password?: string;
  version?: string;
}

/** Conventional gateway port. If it's taken we walk upward (findFreePortFrom),
 *  so the UI URL stays stable across restarts. Override with KARMAX_PORT. */
export const DEFAULT_GATEWAY_PORT = 4505;

const USER_CAPS = ['*'];
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Content types for review "open" artifacts (a superset of the static MIME map). */
const ARTIFACT_MIME: Record<string, string> = {
  ...MIME,
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.ipynb': 'application/json; charset=utf-8',
};

interface Session {
  user: string;
  apiToken: string;
}

export class Gateway {
  private sessions = new Map<string, Session>();
  private server?: http.Server;
  private safeMode = process.env.KARMAX_SAFE_MODE === '1';
  /** Runs review "run" actions (dev servers, scripts) in the task's world. */
  private reviewActions = new ReviewActionRunner();
  private attachments = new AttachmentStore();

  constructor(private deps: GatewayDeps) {}

  private newSession(user = 'me'): { sid: string; session: Session } {
    const sid = `s_${crypto.randomBytes(18).toString('hex')}`;
    const apiToken = this.deps.tokens.mintPrincipal(`user:${user}`, USER_CAPS).token;
    const session: Session = { user, apiToken };
    this.sessions.set(sid, session);
    return { sid, session };
  }

  async listen(preferredPort = DEFAULT_GATEWAY_PORT): Promise<{ url: string; port: number; close: () => Promise<void> }> {
    const port = await findFreePortFrom(preferredPort);
    const server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.fail(res, e)));
    this.server = server;

    // Two WebSocket endpoints, routed by path on upgrade:
    //  /ws          — the live event stream (SPEC §3.3 transport).
    //  /ws/terminal — a PTY against the task's world (cheap check-in, SPEC §5.5).
    const wssEvents = new WebSocketServer({ noServer: true });
    const wssTerm = new WebSocketServer({ noServer: true });
    const wssAction = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      if (pathname === '/ws') wssEvents.handleUpgrade(req, socket, head, (ws) => wssEvents.emit('connection', ws, req));
      else if (pathname === '/ws/terminal') wssTerm.handleUpgrade(req, socket, head, (ws) => wssTerm.emit('connection', ws, req));
      else if (pathname === '/ws/review-action') wssAction.handleUpgrade(req, socket, head, (ws) => wssAction.emit('connection', ws, req));
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
    wssAction.on('connection', (ws, req) => this.reviewActionStream(ws, req));

    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
    return {
      url: `http://127.0.0.1:${port}`,
      port,
      close: () =>
        new Promise<void>((resolve) => {
          this.reviewActions.stopAll();
          wssEvents.close();
          wssTerm.close();
          wssAction.close();
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

  /** Stream a running review action's output to the UI. `procId` names a process
   *  the client already started via POST /review-action. We replay the buffered
   *  output first, then push the live tail until it exits or the socket closes. */
  private reviewActionStream(ws: import('ws').WebSocket, req: http.IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const procId = url.searchParams.get('procId') ?? '';
    const rec = this.reviewActions.get(procId);
    if (!rec) {
      try { ws.send(JSON.stringify({ type: 'exit', code: -1, data: 'No such action process.\n' })); } catch {}
      ws.close();
      return;
    }
    const send = (obj: unknown) => { try { ws.send(JSON.stringify(obj)); } catch {} };
    if (rec.output) send({ type: 'data', data: rec.output });
    if (!rec.running) {
      send({ type: 'exit', code: rec.exitCode });
      ws.close();
      return;
    }
    const off = this.reviewActions.attach(procId, (chunk, done, code) => {
      if (chunk) send({ type: 'data', data: chunk });
      if (done) { send({ type: 'exit', code }); try { ws.close(); } catch {} }
    });
    ws.on('close', off);
    ws.on('error', off);
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

    // Serve an image attachment. Auth via `?token=` (session id) because a plain
    // <img src> can't set an Authorization header; the token is the same session
    // secret used everywhere else, so this is no weaker than the Bearer path.
    const attGet = p.match(/^\/api\/attachments\/([^/]+)$/);
    if (attGet && method === 'GET') {
      const sid = url.searchParams.get('token') ?? '';
      if (!this.sessions.has(sid)) return this.json(res, 401, { error: 'unauthorized' });
      const got = this.attachments.read(attGet[1]!);
      if (!got) return void res.writeHead(404).end('not found');
      res.writeHead(200, {
        'content-type': got.mediaType,
        'cache-control': 'private, max-age=31536000, immutable',
      });
      return void res.end(got.buf);
    }

    // ── authenticated endpoints ──
    const session = this.auth(req);
    if (!session) return this.json(res, 401, { error: 'unauthorized' });
    const token = session.apiToken;
    const { api, store } = this.deps;

    try {
      // Host diagnostics + agent-turn admission state (SPEC §12): loadavg,
      // free/total memory, and whether either pressure gate is currently holding
      // new agent leases back. Reporting only — the gate itself lives in
      // src/activities/agent-slots.ts (same process as the worker).
      if (p === '/api/diagnostics' && method === 'GET') {
        const { hostStats, agentSlotStats } = await import('../activities/agent-slots.js');
        return this.json(res, 200, { host: hostStats(), agentSlots: agentSlotStats(), ts: Date.now() });
      }

      // image attachments (image prompts). The ONLY endpoints that handle raw
      // image bytes; everything downstream carries lightweight ImageRef handles.
      if (p === '/api/attachments' && method === 'POST') {
        const ctype = String(req.headers['content-type'] ?? '');
        try {
          let ref;
          if (ctype.includes('application/json')) {
            const b = await this.body(req);
            if (typeof b.dataUrl !== 'string') return this.json(res, 400, { error: 'expected { dataUrl }' });
            ref = this.attachments.putDataUrl(b.dataUrl);
          } else {
            // Raw binary upload — content-type is the image MIME.
            const buf = await this.rawBody(req, MAX_IMAGE_BYTES);
            ref = this.attachments.put(buf, ctype || undefined);
          }
          return this.json(res, 200, ref);
        } catch (e) {
          if (e instanceof AttachmentError) return this.json(res, 400, { error: e.message });
          throw e;
        }
      }

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
          const all = await api.listTasks(token, projectId);
          // Archived tasks are hidden from the default list (SPEC §11 housekeeping).
          const includeArchived = url.searchParams.get('includeArchived') === '1';
          const filtered = includeArchived ? all : all.filter((t) => !t.params?.archived);
          // Optional pagination (?limit=&offset=); returns the page + total count.
          const limit = Number(url.searchParams.get('limit') ?? '0');
          const offset = Number(url.searchParams.get('offset') ?? '0');
          const page = limit > 0 ? filtered.slice(offset, offset + limit) : filtered;
          // enrich with the freshest live view where possible
          const enriched = await Promise.all(
            page.map(async (t) => {
              const view = await api.getTaskView(token, t.id).catch(() => t.lastView);
              return { ...t, lastView: view ?? t.lastView };
            }),
          );
          if (limit > 0) return this.json(res, 200, { tasks: enriched, total: filtered.length, offset });
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
      // Resolve a per-project sequential number (SPEC §10.6) → its canonical id, so a
      // `/projects/<name>/tasks/<num>` permalink can be opened even when the task
      // isn't in the client's loaded list (e.g. an archived task).
      const byNumMatch = p.match(/^\/api\/projects\/([^/]+)\/tasks\/by-num\/(\d+)$/);
      if (byNumMatch && method === 'GET') {
        const rec = store.getTaskByNum(byNumMatch[1]!, Number(byNumMatch[2]!));
        if (!rec) return this.json(res, 404, { error: 'no such task' });
        return this.json(res, 200, { id: rec.id, num: rec.num, projectId: rec.projectId });
      }
      const viewMatch = p.match(/^\/api\/tasks\/([^/]+)$/);
      if (viewMatch && method === 'GET') {
        const view = await api.getTaskView(token, viewMatch[1]!);
        if (!view) return this.json(res, 200, null);
        // Mirror the record's sequential number onto the view (the workflow only
        // knows the opaque id) so the drawer can show `#num` + a permalink.
        const rec = store.getTask(viewMatch[1]!);
        return this.json(res, 200, rec?.num != null ? { ...view, num: rec.num } : view);
      }
      if (viewMatch && method === 'DELETE') {
        // Hard-delete is for drafts only (they never started a workflow). Running
        // tasks must be cancelled, not deleted out from under their workflow.
        const t = store.getTask(viewMatch[1]!);
        if (!t) return this.json(res, 404, { error: 'no such task' });
        if (!t.params?.draft) return this.json(res, 400, { error: 'only drafts can be deleted; cancel a running task instead' });
        store.deleteTask(viewMatch[1]!);
        return this.json(res, 200, { ok: true });
      }
      const queueMatch = p.match(/^\/api\/tasks\/([^/]+)\/queue$/);
      if (queueMatch && method === 'POST') {
        return this.json(res, 200, await api.queueTask(token, queueMatch[1]!));
      }
      const editMatch = p.match(/^\/api\/tasks\/([^/]+)\/params$/);
      if (editMatch && method === 'PATCH') {
        const b = await this.body(req);
        const id = editMatch[1]!;
        const t = store.getTask(id);
        if (!t) return this.json(res, 404, { error: 'no such task' });
        // A draft has no running workflow — edit its stored params in place; they
        // re-resolve at queue time (SPEC §10.4).
        if (t.params?.draft) {
          // Replace the workflow-field overrides wholesale (b.params is the form's
          // full set of own overrides) so a field reset to its default is actually
          // removed — a merge would leave the stale override behind. Lifecycle meta
          // (draft/archived/profiles) is preserved across the edit.
          const { draft, archived, profiles } = t.params;
          const meta = { ...(draft !== undefined ? { draft } : {}), ...(archived !== undefined ? { archived } : {}), ...(profiles !== undefined ? { profiles } : {}) };
          const replace = b.replace === true;
          store.updateTaskParams(id, replace ? { ...meta, ...b.params } : { ...t.params, ...b.params });
          return this.json(res, 200, store.getTask(id) ?? null);
        }
        // Once queued, params are frozen except the ones the workflow declares
        // in-flight-editable (SPEC §4.5/§5.5). Forward to its validated update and
        // let the validator reject anything frozen — a clear 409, never a silent
        // no-op on the stored record (which the running workflow would ignore).
        try {
          const applied = await api.updateParams(token, id, b.params ?? {});
          return this.json(res, 200, { ...applied, view: await api.getTaskView(token, id) });
        } catch (e) {
          return this.json(res, 409, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      const archiveMatch = p.match(/^\/api\/tasks\/([^/]+)\/archive$/);
      if (archiveMatch && method === 'POST') {
        const b = await this.body(req);
        const t = store.getTask(archiveMatch[1]!);
        if (!t) return this.json(res, 404, { error: 'no such task' });
        const archived = b.archived !== false; // default: archive
        // Archiving only hides; refuse to hide a task that's still progressing on
        // its own (running) or awaiting review — it would vanish mid-flight. A
        // stuck/terminal task (done/cancelled/blocked/failed) can be archived.
        const live = t.lastView?.status === 'active' || t.lastView?.status === 'waiting';
        if (archived && live) return this.json(res, 400, { error: 'cannot archive a running task; cancel or finish it first' });
        store.updateTaskParams(archiveMatch[1]!, { ...t.params, archived });
        return this.json(res, 200, { ok: true, archived });
      }
      const notesMatch = p.match(/^\/api\/tasks\/([^/]+)\/notes$/);
      if (notesMatch && method === 'PATCH') {
        const b = await this.body(req);
        const t = store.getTask(notesMatch[1]!);
        if (!t) return this.json(res, 404, { error: 'no such task' });
        // Purely cosmetic human notes — stored on the record, never sent to any agent.
        const notes = typeof b.notes === 'string' ? b.notes : '';
        store.setTaskNotes(notesMatch[1]!, notes);
        return this.json(res, 200, { ok: true, notes });
      }
      const signalMatch = p.match(/^\/api\/tasks\/([^/]+)\/signal$/);
      if (signalMatch && method === 'POST') {
        const b = await this.body(req);
        await api.signalTask(token, signalMatch[1]!, b.signal, b.text, b.role, b.images);
        return this.json(res, 200, { ok: true });
      }
      const targetMatch = p.match(/^\/api\/tasks\/([^/]+)\/target$/);
      if (targetMatch && method === 'POST') {
        const b = await this.body(req);
        return this.json(res, 200, { ok: await api.setTarget(token, targetMatch[1]!, b.branch) });
      }
      // ── review actions (SPEC §5.5): click-to-verify affordances ──
      // Start a "run" action (or resolve an "open" one). The command is looked up
      // from the task's stored review info by index — the client only sends the
      // index, so it can never inject an arbitrary command.
      const raStartMatch = p.match(/^\/api\/tasks\/([^/]+)\/review-action$/);
      if (raStartMatch && method === 'POST') {
        const taskId = raStartMatch[1]!;
        const b = await this.body(req);
        // Resolve the action from the AUTHORITATIVE live view (the stored lastView
        // can lag the workflow), by index — the client never supplies the command,
        // so only agent-authored actions are runnable.
        const view = (await api.getTaskView(token, taskId).catch(() => undefined)) ?? store.getTask(taskId)?.lastView;
        const action = view?.reviewInfo?.actions?.[Number(b.index)];
        if (!action) return this.json(res, 404, { error: 'no such review action' });
        const worldPath = view?.worldPath;
        if (action.kind === 'open') {
          const target = String(action.target ?? '');
          if (/^https?:\/\//i.test(target)) return this.json(res, 200, { kind: 'open', url: target, external: true });
          if (!target) return this.json(res, 400, { error: 'open action has no target' });
          const url2 = `/api/tasks/${encodeURIComponent(taskId)}/artifact?path=${encodeURIComponent(target)}`;
          return this.json(res, 200, { kind: 'open', url: url2, external: false });
        }
        // kind: 'run'
        if (!action.command) return this.json(res, 400, { error: 'run action has no command' });
        if (!worldPath) return this.json(res, 400, { error: 'no world for this task yet' });
        const rec = this.reviewActions.start({
          taskId,
          cwd: worldPath,
          label: action.label,
          command: action.command,
          server: action.server,
          openUrls: action.openUrls,
        });
        return this.json(res, 200, { kind: 'run', procId: rec.procId, server: rec.server, openUrls: rec.openUrls });
      }
      const raStopMatch = p.match(/^\/api\/tasks\/([^/]+)\/review-action\/([^/]+)\/stop$/);
      if (raStopMatch && method === 'POST') {
        return this.json(res, 200, { ok: this.reviewActions.stop(raStopMatch[2]!) });
      }
      const raStatusMatch = p.match(/^\/api\/tasks\/([^/]+)\/review-action\/([^/]+)$/);
      if (raStatusMatch && method === 'GET') {
        const st = this.reviewActions.status(raStatusMatch[2]!);
        return this.json(res, st ? 200 : 404, st ?? { error: 'no such action process' });
      }
      const artifactMatch = p.match(/^\/api\/tasks\/([^/]+)\/artifact$/);
      if (artifactMatch && method === 'GET') {
        return this.serveArtifact(res, artifactMatch[1]!, url.searchParams.get('path') ?? '');
      }
      const eventsMatch = p.match(/^\/api\/tasks\/([^/]+)\/events$/);
      if (eventsMatch && method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? '0');
        return this.json(res, 200, store.eventsSince(eventsMatch[1]!, since));
      }
      const sessMatch = p.match(/^\/api\/tasks\/([^/]+)\/sessions$/);
      if (sessMatch && method === 'GET') {
        const id = sessMatch[1]!;
        // Each role → { id, home?, provider? } so the UI can build a CLI resume
        // command targeting the right CONFIG_DIR/CODEX_HOME (provider sessions are
        // home-bound). `home` is omitted for API-key/stateless sessions.
        const out: Record<string, { id: string; home?: string; provider?: string }> = {};
        for (const role of ['do', 'merge', 'resolve', 'confirm']) {
          const s = store.kvGet(`session:${id}:${role}`);
          if (!s) continue;
          let home: string | undefined;
          let provider: string | undefined;
          const meta = store.kvGet(`sessionmeta:${id}:${role}`);
          if (meta) { try { const m = JSON.parse(meta); home = m.home || undefined; provider = m.provider || undefined; } catch { /* ignore */ } }
          out[role] = { id: s, ...(home ? { home } : {}), ...(provider ? { provider } : {}) };
        }
        return this.json(res, 200, out);
      }
      // Tier-2 declarative widgets (SPEC §10.2): resolve each contribution's
      // declared widget tree against the live view-model, server-side, so the UI
      // is a pure host widget library (draws descriptors, owns no resolve logic).
      const widgetsMatch = p.match(/^\/api\/tasks\/([^/]+)\/widgets$/);
      if (widgetsMatch && method === 'GET') {
        const id = widgetsMatch[1]!;
        const t = store.getTask(id);
        const view = (await api.getTaskView(token, id).catch(() => undefined)) ?? t?.lastView;
        if (!t || !view) return this.json(res, 200, []);
        const { resolveWidgets } = await import('../contrib/widgets.js');
        const slot = (url.searchParams.get('slot') ?? 'task-detail') as any;
        const groups = this.deps.contributions
          .slots(slot)
          .filter((s) => s.workflow === t.workflow && s.contribution.tier === 2 && s.contribution.widgets?.length)
          .map((s) => ({ workflow: s.workflow, title: s.contribution.title, widgets: resolveWidgets(s.contribution.widgets, view) }));
        return this.json(res, 200, groups);
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
      // platform API surface used by the MCP server (save skill / propose edit)
      if (p === '/api/skills' && method === 'POST') {
        const b = await this.body(req);
        return this.json(res, 200, await api.saveSkill(token, { name: String(b.name), content: String(b.content ?? '') }));
      }
      const proposeMatch = p.match(/^\/api\/projects\/([^/]+)\/propose-workflow-edit$/);
      if (proposeMatch && method === 'POST') {
        const b = await this.body(req);
        return this.json(res, 200, await api.proposeWorkflowEdit(token, { projectId: proposeMatch[1]!, title: b.title, repo: b.repo, branch: b.branch, target: b.target }));
      }

      // Installed + built-in workflows, and installing a new one from a git repo (§21d).
      if (p === '/api/workflows' && method === 'GET') return this.json(res, 200, api.listWorkflows(token));
      if (p === '/api/workflows/install' && method === 'POST') {
        const b = await this.body(req);
        if (!b.url) return this.json(res, 400, { error: 'url required' });
        try {
          return this.json(res, 200, await api.installWorkflow(token, { url: String(b.url), ref: b.ref ? String(b.ref) : undefined, name: b.name ? String(b.name) : undefined }));
        } catch (e) {
          if (e instanceof CapabilityError) throw e;
          // fetch/validation/collision failures are user-facing input errors
          return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      // Per-project version pins (§21d): hold a project on a specific version.
      const pinsMatch = p.match(/^\/api\/projects\/([^/]+)\/workflow-pins$/);
      if (pinsMatch && method === 'GET') return this.json(res, 200, api.workflowPins(token, pinsMatch[1]!));
      if (pinsMatch && method === 'POST') {
        const b = await this.body(req);
        if (!b.workflow) return this.json(res, 400, { error: 'workflow required' });
        return this.json(res, 200, api.pinWorkflow(token, { projectId: pinsMatch[1]!, workflow: String(b.workflow), version: b.version ? String(b.version) : undefined }));
      }

      // profiles (agent role profiles). Global scope by default; a project overlay
      // (id `<projectId>::<role>-default`) overrides global per project (SPEC §7/§9).
      if (p === '/api/profiles' && method === 'GET') {
        // Annotate each profile with the workflow(s) that declare its role, so the
        // UI can show a role belongs to (e.g.) software-dev + merge-only (SPEC §7.1).
        const { roleDef } = await import('../contrib/manifests.js');
        const withRole = (pr: any) => ({ ...pr, roleWorkflows: roleDef(pr.role)?.workflows ?? [] });
        const pid = url.searchParams.get('projectId') ?? undefined;
        if (!pid) return this.json(res, 200, store.listProfiles().filter((pr) => !pr.id.includes('::')).map(withRole));
        // effective per-role view: the project override if present, else global (inherited)
        const globals = store.listProfiles().filter((pr) => !pr.id.includes('::'));
        const view = globals.map((g) => {
          const proj = store.getProfile(`${pid}::${g.role}-default`);
          return withRole({ ...(proj ?? g), id: `${pid}::${g.role}-default`, role: g.role, scope: proj ? 'project' : 'inherited', inherited: g });
        });
        return this.json(res, 200, view);
      }
      if (p === '/api/profiles' && method === 'PUT') {
        const b = await this.body(req);
        if (!b.role) return this.json(res, 400, { error: 'profile needs a role' });
        const id = b.projectId ? `${b.projectId}::${b.role}-default` : b.id;
        if (!id) return this.json(res, 400, { error: 'profile needs id or projectId' });
        const { projectId: _pid, scope: _s, inherited: _i, ...rest } = b;
        store.upsertProfile({ provider: 'claude', capabilities: [], ...rest, id });
        return this.json(res, 200, store.getProfile(id) ?? null);
      }
      // reset a project profile override back to the global default
      const profDelMatch = p.match(/^\/api\/profiles\/(.+)$/);
      if (profDelMatch && method === 'DELETE') {
        store.deleteProfile(decodeURIComponent(profDelMatch[1]!));
        return this.json(res, 200, { ok: true });
      }

      // payment providers (SPEC §7.6): how a user connects funding. Local (mock)
      // needs nothing; Stripe Issuing connects via OAuth (karmax never sees card data).
      if (p === '/api/payments/providers' && method === 'GET') {
        const list = this.deps.paymentRegistry?.list() ?? (this.deps.payments ? [this.deps.payments.describe()] : []);
        return this.json(res, 200, { providers: list, active: this.deps.payments?.name ?? null });
      }
      if (p === '/api/payments/connect' && method === 'POST') {
        const b = await this.body(req);
        const prov = this.deps.paymentRegistry?.get(b.provider) ?? this.deps.payments;
        if (!prov) return this.json(res, 400, { error: 'no payment provider configured' });
        return this.json(res, 200, await prov.connect());
      }

      // cards (payment resources; SPEC §7.6). Provision/list/fund.
      if (p === '/api/cards' && method === 'GET') {
        const pid = url.searchParams.get('projectId') ?? undefined;
        return this.json(res, 200, store.listCards(pid));
      }
      if (p === '/api/cards' && method === 'POST') {
        if (!this.deps.payments) return this.json(res, 400, { error: 'no payment provider configured' });
        const b = await this.body(req);
        const card = await this.deps.payments.provisionCard({
          scope: b.scope === 'global' ? 'global' : 'project',
          scopeId: b.scope === 'global' ? undefined : b.projectId,
          label: b.label ?? 'Card',
          cap: Number(b.cap ?? 0),
          merchantLock: Array.isArray(b.merchantLock) ? b.merchantLock : undefined,
        });
        return this.json(res, 200, card);
      }
      const fundMatch = p.match(/^\/api\/cards\/([^/]+)\/fund$/);
      if (fundMatch && method === 'POST') {
        if (!this.deps.payments) return this.json(res, 400, { error: 'no payment provider configured' });
        const b = await this.body(req);
        await this.deps.payments.fund(fundMatch[1]!, Number(b.amount ?? 0));
        return this.json(res, 200, store.getCard(fundMatch[1]!) ?? null);
      }

      // accounts: API-key handles (broker; secrets write-only) + config-home
      // logins (SPEC §7.3 — switchable per-account subscriptions).
      if (p === '/api/accounts' && method === 'GET') {
        return this.json(res, 200, {
          handles: this.deps.broker?.listHandles() ?? [],
          // never expose the home's absolute path to the browser
          logins: (this.deps.configHomes?.list() ?? []).map((a) => ({ provider: a.provider, account: a.account, loggedIn: a.loggedIn })),
        });
      }
      if (p === '/api/accounts' && method === 'POST') {
        const b = await this.body(req);
        if (!this.deps.broker) return this.json(res, 400, { error: 'no credential broker configured' });
        if (!b.provider || !b.account || !b.apiKey) return this.json(res, 400, { error: 'provider, account, apiKey required' });
        const handle = `${b.provider}:${b.account}`;
        this.deps.broker.registerHandle(handle, String(b.apiKey));
        return this.json(res, 200, { handle }); // never echoes the secret
      }
      // connect an account login: mint a config home + launch the provider's own
      // OAuth, return the device URL for the user to complete (we never type creds).
      if (p === '/api/accounts/connect' && method === 'POST') {
        if (!this.deps.login) return this.json(res, 400, { error: 'no login manager configured' });
        const b = await this.body(req);
        const provider = b.provider === 'codex' ? 'codex' : 'claude';
        if (!b.account) return this.json(res, 400, { error: 'account required' });
        const result = await this.deps.login.connect(provider, String(b.account));
        // Seed the config home's MCP baseline (SPEC §7.5/§3.4): the karmax platform
        // MCP (always) + an optional browser MCP. The scoped token is injected at
        // spawn; here we bake in the gateway URL only.
        if (this.deps.configHomes) {
          const { platformMcpSpec } = await import('../autonomy/config-homes.js');
          const gatewayUrl = process.env.KARMAX_GATEWAY_URL || `http://${req.headers.host ?? '127.0.0.1'}`;
          this.deps.configHomes.writeMcpConfig(result.configHome, provider, {
            browser: b.browserMcp === 'chrome-devtools' || b.browserMcp === 'playwright' ? b.browserMcp : 'none',
            platform: platformMcpSpec(gatewayUrl),
          });
        }
        await this.refreshLoginPool();
        // strip the absolute configHome path from the response
        const { configHome, ...safe } = result;
        return this.json(res, 200, safe);
      }
      // edit (rename) / delete a connected login
      const loginMatch = p.match(/^\/api\/accounts\/logins\/([^/]+)\/(.+)$/);
      if (loginMatch && (method === 'DELETE' || method === 'PATCH')) {
        if (!this.deps.configHomes) return this.json(res, 400, { error: 'no config homes configured' });
        const provider = (loginMatch[1] === 'codex' ? 'codex' : 'claude') as Provider;
        const account = decodeURIComponent(loginMatch[2]!);
        if (method === 'DELETE') {
          this.deps.configHomes.remove(provider, account);
        } else {
          const b = await this.body(req);
          if (!b.account) return this.json(res, 400, { error: 'new account name required' });
          this.deps.configHomes.rename(provider, account, String(b.account));
        }
        await this.refreshLoginPool();
        return this.json(res, 200, { ok: true });
      }

      // Manual availability override for an agent login (SPEC §6.2): force a login
      // on/off or edit its reset time (e.g. after upgrading a plan) without waiting
      // for the old refresh. Signals the account coordinator directly.
      if (p === '/api/accounts/availability' && method === 'POST') {
        if (!this.deps.client) return this.json(res, 400, { error: 'no temporal client' });
        const b = await this.body(req);
        if (!b.accountId || !b.status) return this.json(res, 400, { error: 'accountId and status required' });
        const status = ['available', 'manual-off', 'needs-attention', 'exhausted'].includes(b.status) ? b.status : 'exhausted';
        const { makeCoordinatorActivities } = await import('../activities/coordinator.js');
        await makeCoordinatorActivities({ client: this.deps.client, taskQueue: this.deps.taskQueue }).setAccountAvailability({
          accountId: String(b.accountId),
          status,
          ...(b.resetAt != null ? { resetAt: Number(b.resetAt) } : {}),
        });
        return this.json(res, 200, { ok: true });
      }

      // Per-login concurrency cap — how many agent turns may run on this login at once.
      // `max` = a positive integer, or null/empty for unlimited. Persisted + re-applied
      // to the coordinator immediately (concurrency doesn't cost extra quota).
      if (p === '/api/accounts/concurrency' && method === 'POST') {
        const b = await this.body(req);
        if (!b.accountId) return this.json(res, 400, { error: 'accountId required' });
        const { concurrencyKey } = await import('../platform/credential-sources.js');
        const { UNLIMITED_CONCURRENCY } = await import('../coordinators/names.js');
        const n = b.max == null || b.max === '' ? UNLIMITED_CONCURRENCY : Math.floor(Number(b.max));
        if (!Number.isFinite(n) || n < 1) return this.json(res, 400, { error: 'max must be a positive integer, or empty for unlimited' });
        store.kvSet(concurrencyKey(String(b.accountId)), String(n));
        await this.refreshLoginPool();
        return this.json(res, 200, { ok: true, maxConcurrent: n });
      }

      // Proactive quota (#6): real usage % + reset for each pollable Claude login.
      // GET returns the cached snapshots; recheck re-probes on demand (the button).
      // Codex/API-key/setup-token creds aren't pollable → they show reactive status.
      if (p === '/api/accounts/usage' && method === 'GET') {
        const { enumerateCredentials } = await import('../platform/credentials.js');
        const { gatherCredentialSources } = await import('../platform/credential-sources.js');
        const { isUsagePollable } = await import('../agent/usage.js');
        const creds = enumerateCredentials(gatherCredentialSources({ configHomes: this.deps.configHomes, broker: this.deps.broker }));
        const usage: Record<string, unknown> = {};
        const pollable: string[] = [];
        for (const c of creds) {
          const canPoll = isUsagePollable(c);
          if (canPoll) pollable.push(c.key);
          const cached = store.kvGet(`usage:${c.key}`);
          if (cached) usage[c.key] = JSON.parse(cached);
          // Explain absence on a Claude login that CAN'T be polled (setup-token, no
          // full `.credentials.json`) so the dashboard shows a reason, not a blank.
          else if (!canPoll && c.provider === 'claude' && c.kind !== 'key') usage[c.key] = { ok: false, reason: 'setup-token' };
        }
        return this.json(res, 200, { usage, pollable });
      }
      if (p === '/api/accounts/usage/recheck' && method === 'POST') {
        const b = await this.body(req);
        const only = b.accountId ? String(b.accountId) : undefined;
        const usage = await this.refreshUsage(only);
        return this.json(res, 200, { usage });
      }

      // Credential policy (SPEC §7/§9): list every credential + its effective
      // enablement per scope (global→project→task), and set a scope's ordering /
      // enable-disable overrides.
      if (p === '/api/credentials' && method === 'GET') {
        const { enumerateCredentials, resolveCredentials } = await import('../platform/credentials.js');
        const { gatherCredentialSources, parsePolicy, credPolicyKey } = await import('../platform/credential-sources.js');
        const creds = enumerateCredentials(gatherCredentialSources({ configHomes: this.deps.configHomes, broker: this.deps.broker }));
        const projectId = url.searchParams.get('projectId') ?? undefined;
        const taskId = url.searchParams.get('taskId') ?? undefined;
        const g = parsePolicy(store.kvGet(credPolicyKey.global()));
        const pr = projectId ? parsePolicy(store.kvGet(credPolicyKey.project(projectId))) : undefined;
        const tk = taskId ? parsePolicy(store.kvGet(credPolicyKey.task(taskId))) : undefined;
        const enabledKeys = (layers: { global?: unknown; project?: unknown; task?: unknown }) =>
          resolveCredentials(creds, layers as any).map((c) => c.key);
        return this.json(res, 200, {
          credentials: creds.map((c) => ({ key: c.key, label: c.label, provider: c.provider, kind: c.kind })),
          global: { own: g ?? {}, enabled: enabledKeys({ global: g }) },
          ...(projectId ? { project: { own: pr ?? {}, enabled: enabledKeys({ global: g, project: pr }) } } : {}),
          ...(taskId ? { task: { own: tk ?? {}, enabled: enabledKeys({ global: g, project: pr, task: tk }) } } : {}),
        });
      }
      if (p === '/api/credentials/policy' && method === 'POST') {
        const b = await this.body(req);
        const { credPolicyKey } = await import('../platform/credential-sources.js');
        const key =
          b.scope === 'task' && b.taskId ? credPolicyKey.task(String(b.taskId))
          : b.scope === 'project' && b.projectId ? credPolicyKey.project(String(b.projectId))
          : credPolicyKey.global();
        store.kvSet(key, JSON.stringify(b.policy ?? {}));
        return this.json(res, 200, { ok: true });
      }

      // workflow parameter schemas (SPEC §10.4) — drives task forms + settings forms
      if (p === '/api/schema' && method === 'GET') {
        // Built-in + installed workflows, so the New Task form offers both (§21d).
        return this.json(res, 200, api.workflowSchemas());
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
          const out = this.enrichAgentDefaults(m, vals, projectId);
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
  /** Re-register the connected-login pool with the account coordinator so lease
   *  rotation reflects the current set (called after connect/rename/delete). */
  private async refreshLoginPool(): Promise<void> {
    if (!this.deps.configHomes || !this.deps.client) return;
    const { gatherCredentialSources, concurrencyFor } = await import('../platform/credential-sources.js');
    const { enumerateCredentials } = await import('../platform/credentials.js');
    const creds = enumerateCredentials(gatherCredentialSources({ configHomes: this.deps.configHomes, broker: this.deps.broker }));
    const pool = creds.map((c) => {
      const maxConcurrent = concurrencyFor((k) => this.deps.store.kvGet(k), c.key);
      return { id: c.key, configHome: c.configHome ?? '', provider: c.provider, kind: c.kind, ...(c.apiKeyHandle ? { apiKeyHandle: c.apiKeyHandle } : {}), ...(maxConcurrent != null ? { maxConcurrent } : {}) };
    });
    if (!pool.length) return;
    const { makeCoordinatorActivities } = await import('../activities/coordinator.js');
    await makeCoordinatorActivities({ client: this.deps.client, taskQueue: this.deps.taskQueue }).registerAccounts(pool).catch(() => undefined);
  }

  /** Probe usage for the pollable Claude logins (all, or just `only`) and cache the
   *  snapshots in kv under `usage:<credKey>`. Drives the dashboard's real %; a probe
   *  shells out `claude -p '/usage'` in an isolated dir so it can't race a leased home. */
  private async refreshUsage(only?: string): Promise<Record<string, unknown>> {
    const { store } = this.deps;
    const { enumerateCredentials } = await import('../platform/credentials.js');
    const { gatherCredentialSources } = await import('../platform/credential-sources.js');
    const { probeClaudeUsage, isUsagePollable } = await import('../agent/usage.js');
    const creds = enumerateCredentials(gatherCredentialSources({ configHomes: this.deps.configHomes, broker: this.deps.broker }))
      .filter((c) => isUsagePollable(c) && (!only || c.key === only));
    const out: Record<string, unknown> = {};
    await Promise.all(creds.map(async (c) => {
      // ambient uses ~/.claude (no configHome); a login uses its own home.
      const snap = await probeClaudeUsage({ configHome: c.kind === 'ambient' ? undefined : c.configHome });
      store.kvSet(`usage:${c.key}`, JSON.stringify(snap));
      out[c.key] = snap;
    }));
    return out;
  }

  private enrichAgentDefaults(m: import('../contrib/manifests.js').WorkflowManifest, vals: Record<string, unknown>, projectId?: string) {
    const out = { ...vals };
    for (const f of m.params) {
      if ((f.type !== 'agent' && f.type !== 'confirmer') || !f.role) continue;
      const spec = (out[f.name] as any) || {};
      // The project's role-default overlay overrides the global one (SPEC §9), so a
      // per-project model/provider default flows through to new tasks' inherited value.
      const prof =
        (projectId ? this.deps.store.getProfile(`${projectId}::${f.role}-default`) : undefined) ??
        this.deps.store.getProfile(`${f.role}-default`);
      const provider = spec.provider ?? prof?.provider ?? defaultProvider().provider;
      const model = spec.model ?? prof?.model ?? defaultModel(provider);
      const effort = spec.effort ?? prof?.effort ?? defaultEffort(provider);
      const agent = { provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
      // A confirmer also carries a MODE (human/auto/agent) that inherits normally; the
      // agent knobs above are the defaults shown once "agent" mode is selected.
      out[f.name] = f.type === 'confirmer' ? { mode: spec.mode ?? (f.default as any)?.mode ?? 'human', ...agent, ...(spec.resumeFrom ? { resumeFrom: spec.resumeFrom } : {}) } : agent;
    }
    return out;
  }

  private async dashboard() {
    let accounts: unknown = { accounts: [], waiting: 0 };
    try {
      accounts = await withTimeout(this.deps.client.workflow.getHandle(accountCoordinatorId()).query('accounts'), 3000);
    } catch {
      /* coordinator not running or wedged — show empty rather than hang */
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

  /** Serve a produced artifact (an `open` action's file target) from the task's
   *  world, so the UI can open a PDF/image/video/notebook it generated. Path is
   *  confined to the world root — no traversal outside it. */
  private async serveArtifact(res: http.ServerResponse, taskId: string, relPath: string) {
    const worldPath = this.deps.store.getTask(taskId)?.lastView?.worldPath;
    if (!worldPath) return this.json(res, 404, { error: 'no world for this task' });
    if (!relPath) return this.json(res, 400, { error: 'missing path' });
    const root = path.resolve(worldPath);
    const file = path.resolve(root, relPath);
    if (file !== root && !file.startsWith(root + path.sep)) return this.json(res, 400, { error: 'path escapes world' });
    try {
      const stat = await fs.promises.stat(file);
      if (stat.isDirectory()) return this.json(res, 400, { error: 'path is a directory' });
      const data = await fs.promises.readFile(file);
      res.writeHead(200, {
        'content-type': ARTIFACT_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(data.length),
      });
      res.end(data);
    } catch {
      this.json(res, 404, { error: 'artifact not found' });
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
  /** Read a request body into a Buffer, aborting if it exceeds `maxBytes`
   *  (the JSON `body()` reader is unbounded — binary uploads must be capped). */
  private async rawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of req) {
      total += (c as Buffer).length;
      if (total > maxBytes) {
        req.destroy();
        throw new AttachmentError(`upload too large (> ${maxBytes} bytes)`);
      }
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
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

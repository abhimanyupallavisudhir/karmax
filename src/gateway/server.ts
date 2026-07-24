import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
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
import { projectSettingsFor, globalSettingsFor, quickProjectSettingsFor, quickGlobalSettingsFor, quickScopeKey, settingsToProjectConfig, resolveParams, resolveParamsLayers } from '../platform/params.js';
import { defaultProvider } from '../agent/adapters.js';
import { defaultModel, defaultEffort } from '../agent/profiles.js';
import { defaultBranch } from '../world/git.js';
import { accountCoordinatorId } from '../coordinators/names.js';
import { findFreePortFrom } from '../util/ports.js';
import { expandPath } from '../util/expand.js';
import { withTimeout } from '../util/timeout.js';
import { Provider, ProjectConfig } from '../domain/types.js';
import { confirmLayersOf } from '../domain/confirm.js';
import { ReviewActionRunner } from './review-actions.js';
import { acpModels, claudeModels, codexModels, opencodeModels, mergeModels, type ModelCatalog } from '../agent/models.js';
import type { IdentityService } from '../auth/identity.js';
import type { AuthorizationService } from '../platform/authorization.js';
import { TOOL_CAPABILITY, CAPABILITY_GROUPS, allows } from '../platform/capabilities.js';
import { PLATFORM_API_CATALOG } from '../platform/catalog.js';
import { RESOLVE_AGENT_ENABLED } from '../config/features.js';
import { credentialAliases, isAgentProvider, isLoginProvider } from '../agent/provider-registry.js';

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
  identity?: IdentityService;
  authorization?: AuthorizationService;
}

/** Coarse HTTP operation → capability binding. KarmaxApi performs the same check
 * again for task operations; this layer covers the direct administrative routes. */
function capabilityForRequest(method: string, p: string, url?: URL): string | undefined {
  const read = method === 'GET';
  if (p === '/api/meta' || p === '/api/session') return undefined;
  if (p === '/api/platform') return 'workflow:read';
  if (p === '/api/logout') return undefined;
  if (p === '/api/dashboard') return 'diagnostic:read';
  if (p.startsWith('/api/diagnostics')) return 'diagnostic:read';
  if (p.startsWith('/api/processes')) return read ? 'process:read' : 'process:kill';
  if (p.startsWith('/api/users')) return read ? 'user:read' : 'user:write';
  if (p === '/api/authorization/profiles' && read) return 'task:create';
  if (p.startsWith('/api/authorization') || p.startsWith('/api/audit')) return read ? 'authorization:read' : 'authorization:write';
  if (p.startsWith('/api/accounts') || p.startsWith('/api/git-profiles')) return read ? 'credential:read' : 'credential:write';
  if (p === '/api/credentials/policy') {
    if (url?.searchParams.get('taskId')) return 'task:edit';
    if (url?.searchParams.get('projectId')) return 'project:settings:write';
    return 'credential:write';
  }
  if (p.startsWith('/api/credentials')) return read ? 'credential:read' : 'credential:write';
  if (p.startsWith('/api/cards') || p.startsWith('/api/payments')) return read ? 'payment:read' : 'payment:write';
  if (p === '/api/safe-mode') return 'safe-mode:write';
  if (/^\/api\/settings\/(?:quick\/)?project\//.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (p.startsWith('/api/settings')) return read ? 'settings:read' : 'settings:write';
  if (p.startsWith('/api/defaults/')) return 'task:read';
  if (p.startsWith('/api/profiles')) return read ? 'profile:read' : 'profile:write';
  if (p === '/api/models' || p === '/api/schema' || p === '/api/events/catalog' || p === '/api/contributions') return 'workflow:read';
  if (p === '/api/search/fields') return 'task:read';
  if (p === '/api/attachments') return 'task:create';
  if (p.startsWith('/api/workflows')) return read ? 'workflow:read' : (p.includes('/install') ? 'workflow:install' : 'workflow:edit');
  if (p.startsWith('/api/queue')) return read ? 'queue:read' : 'queue:write';
  if (p === '/api/projects') return read ? 'project:read' : 'project:create';
  if (/^\/api\/projects\/[^/]+$/.test(p)) return read ? 'project:read' : method === 'DELETE' ? 'project:delete' : 'project:edit';
  if (/^\/api\/projects\/[^/]+\/(defaults|settings|quick-settings)/.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (/^\/api\/projects\/[^/]+\/tasks/.test(p)) return read ? 'task:read' : 'task:create';
  if (/^\/api\/projects\/[^/]+\/search$/.test(p)) return 'task:read';
  if (/^\/api\/projects\/[^/]+\/(tags|views)$/.test(p)) return read ? 'task:read' : 'task:edit';
  if (/^\/api\/(tags|views)\//.test(p)) return read ? 'task:read' : 'task:edit';
  if (/^\/api\/projects\/[^/]+\/activate-workflow$/.test(p)) return 'workflow:install';
  if (/^\/api\/projects\/[^/]+\/workflow-pins$/.test(p)) return read ? 'workflow:read' : 'workflow:edit';
  if (/^\/api\/projects\/[^/]+\/propose-workflow-edit$/.test(p)) return 'workflow:edit';
  if (/\/events$/.test(p) || p === '/api/activity') return 'task:event:read';
  if (/\/(sessions|agents|conversation)$/.test(p)) return 'task:conversation:read';
  if (/\/fork-agent$/.test(p)) return 'task:conversation:fork';
  if (/\/file$/.test(p)) return 'task:conversation:read';
  if (/\/review-action/.test(p) || /\/artifact$/.test(p)) return 'task:review:execute';
  if (/\/signal$/.test(p)) return 'task:signal';
  if (p.startsWith('/api/tasks/')) return read ? 'task:read' : method === 'DELETE' ? 'task:delete' : 'task:edit';
  if (p === '/api/skills') return 'skill:write';
  return read ? 'project:read' : 'settings:write';
}

function requestHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const v of value) out.append(key, v);
    else if (value !== undefined) out.set(key, value);
  }
  return out;
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
  '.cjs': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.tsx': 'text/plain; charset=utf-8',
  '.jsx': 'text/javascript; charset=utf-8',
  '.py': 'text/plain; charset=utf-8',
  '.rs': 'text/plain; charset=utf-8',
  '.go': 'text/plain; charset=utf-8',
  '.java': 'text/plain; charset=utf-8',
  '.rb': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.toml': 'text/plain; charset=utf-8',
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
  userId?: string;
}

export class Gateway {
  private sessions = new Map<string, Session>();
  private server?: http.Server;
  private safeMode = process.env.KARMAX_SAFE_MODE === '1';
  /** Runs review "run" actions (dev servers, scripts) in the task's world. */
  private reviewActions = new ReviewActionRunner();
  private attachments = new AttachmentStore();
  private modelCatalog?: { at: number; value: ModelCatalog };
  private identityTokens = new Map<string, { apiToken: string; fingerprint: string }>();

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
    wssEvents.on('connection', async (ws, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const auth = await this.socketAuth(req, url);
      if (!auth) { ws.close(4401, 'unauthorized'); return; }
      const scoped = this.deps.tokens.verify(auth.apiToken);
      const off = this.deps.bus.onAny((ev) => {
        const projectId = this.deps.store.getTask(ev.taskId)?.projectId;
        if (scoped?.projectId && projectId !== scoped.projectId) return;
        if (!this.deps.tokens.check(auth.apiToken, 'task:event:read', projectId ? { projectId, taskId: ev.taskId } : undefined).ok) {
          const humanCaps = auth.userId && projectId ? this.deps.authorization?.capabilities(`user:${auth.userId}`, projectId) : [];
          if (!allows(humanCaps ?? [], 'task:event:read')) return;
        }
        try { ws.send(JSON.stringify(ev)); } catch { /* ignore */ }
      });
      ws.on('close', off);
      ws.on('error', off);
    });
    wssTerm.on('connection', (ws, req) => {
      ws.on('error', () => {});
      void this.terminal(ws, req).catch(() => { try { ws.close(); } catch {} });
    });
    wssAction.on('connection', (ws, req) => this.reviewActionStream(ws, req));

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        // Keep an operational listener after the startup race; errors are exposed
        // by endpoint-specific handling instead of becoming uncaught events.
        server.on('error', () => {});
        resolve();
      });
    });
    return {
      url: `http://127.0.0.1:${port}`,
      port,
      close: () =>
        new Promise<void>((resolve) => {
          this.reviewActions.stopAll();
          // `WebSocketServer.close()` does not terminate existing upgraded
          // sockets, and `http.Server.close()` waits for them forever. A stale
          // browser/test connection therefore used to wedge shutdown and leave
          // the Temporal worker/runtime installed. Close clients explicitly,
          // then force any remaining HTTP keep-alive sockets to drain.
          for (const wss of [wssEvents, wssTerm, wssAction]) {
            for (const ws of wss.clients) ws.terminate();
          }
          wssEvents.close();
          wssTerm.close();
          wssAction.close();
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    };
  }

  /** PTY check-in (SPEC §5.5): an ephemeral terminal in the task's on-disk world. */
  private async terminal(ws: import('ws').WebSocket, req: http.IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const taskId = url.searchParams.get('taskId') ?? '';
    const task = this.deps.store.getTask(taskId);
    const auth = await this.socketAuth(req, url, task?.projectId);
    if (!auth) { ws.close(4401, 'unauthorized'); return; }
    if (!this.deps.tokens.check(auth.apiToken, 'task:edit', { projectId: task?.projectId, taskId }).ok) {
      ws.close(4403, 'forbidden'); return;
    }
    const cwd = task?.lastView?.worldPath;
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
    // Task-manager registry: the PTY (and anything the user runs in it) shows up
    // in the dashboard Processes panel under its task, and can be killed there.
    const { trackProcess } = await import('../util/processes.js');
    const untrack = term.pid
      ? trackProcess({
          pid: term.pid,
          kind: 'terminal',
          label: 'task terminal (bash)',
          taskId,
          startedAt: Date.now(),
          kill: () => { try { term.kill(); } catch { /* already gone */ } },
        })
      : () => {};
    term.onData((d: string) => { try { ws.send(JSON.stringify({ type: 'data', data: d })); } catch {} });
    term.onExit(() => { untrack(); try { ws.close(); } catch {} });
    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'input') term.write(msg.data);
      else if (msg.type === 'resize') term.resize(msg.cols || 80, msg.rows || 24);
    });
    // Closing the socket (navigating away OR the user hitting "Kill terminal")
    // tears the whole thing down — not just the shell, but every process it
    // spawned. node-pty runs the shell as a session leader (its pid == the
    // session id), so we kill the entire session: `pkill -s` reaps foreground
    // AND background jobs, which a bare process-group kill would miss (bash job
    // control puts each pipeline in its own group). The group kill + term.kill()
    // are belt-and-suspenders fallbacks.
    ws.on('close', () => killPtySession(term));
  }

  /** Stream a running review action's output to the UI. `procId` names a process
   *  the client already started via POST /review-action. We replay the buffered
   *  output first, then push the live tail until it exits or the socket closes. */
  private async reviewActionStream(ws: import('ws').WebSocket, req: http.IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const procId = url.searchParams.get('procId') ?? '';
    const rec = this.reviewActions.get(procId);
    if (!rec) {
      try { ws.send(JSON.stringify({ type: 'exit', code: -1, data: 'No such action process.\n' })); } catch {}
      ws.close();
      return;
    }
    const task = this.deps.store.getTask(rec.taskId);
    const auth = await this.socketAuth(req, url, task?.projectId);
    if (!auth) { ws.close(4401, 'unauthorized'); return; }
    if (!this.deps.tokens.check(auth.apiToken, 'task:review:execute', { projectId: task?.projectId, taskId: rec.taskId }).ok) {
      ws.close(4403, 'forbidden'); return;
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
      if (this.deps.identity) {
        const current = await this.deps.identity.session(requestHeaders(req.headers));
        if (current) return this.json(res, 200, { authRequired: true, authenticated: true, user: current.user });
        return this.json(res, 200, {
          authRequired: true,
          authenticated: false,
          setupRequired: !this.deps.identity.hasUsers(),
          signupAvailable: this.deps.identity.hasUsers(),
        });
      }
      const authRequired = !!this.deps.password;
      if (!authRequired) {
        const { sid } = this.newSession();
        return this.json(res, 200, { authRequired: false, token: sid, user: 'me' });
      }
      return this.json(res, 200, { authRequired: true });
    }
    if (p === '/api/login' && method === 'POST') {
      const b = await this.body(req);
      if (this.deps.identity) {
        try {
          const response = await this.deps.identity.signIn(String(b.email ?? ''), String(b.password ?? ''), requestHeaders(req.headers));
          return this.sendWebResponse(res, response);
        } catch { return this.json(res, 401, { error: 'invalid email or password' }); }
      }
      if (this.deps.password && b.password === this.deps.password) {
        const { sid } = this.newSession();
        return this.json(res, 200, { token: sid, user: 'me' });
      }
      return this.json(res, 401, { error: 'invalid password' });
    }
    if (p === '/api/setup' && method === 'POST' && this.deps.identity) {
      if (this.deps.identity.hasUsers()) return this.json(res, 409, { error: 'karmax has already been set up' });
      const b = await this.body(req);
      try {
        const { response, user } = await this.deps.identity.bootstrap(
          { name: String(b.name ?? ''), email: String(b.email ?? ''), password: String(b.password ?? '') },
          requestHeaders(req.headers),
        );
        this.deps.authorization?.bootstrapAdministrator(user.id);
        return this.sendWebResponse(res, response);
      } catch (e) { return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (p === '/api/signup' && method === 'POST' && this.deps.identity) {
      // The first account must still go through /setup so it becomes the one
      // explicit trust root. Later signups create authenticated, no-access
      // identities that an administrator can grant into projects.
      if (!this.deps.identity.hasUsers()) return this.json(res, 409, { error: 'set up the first administrator before signing up' });
      const b = await this.body(req);
      try {
        const response = await this.deps.identity.signUp(
          { name: String(b.name ?? ''), email: String(b.email ?? ''), password: String(b.password ?? '') },
          requestHeaders(req.headers),
        );
        return this.sendWebResponse(res, response);
      } catch (e) { return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (p === '/api/meta' && method === 'GET') {
      return this.json(res, 200, {
        agent: this.deps.agentInfo,
        version: this.deps.version ?? '1.0.0',
        safeMode: this.safeMode,
        resolveAgentEnabled: RESOLVE_AGENT_ENABLED,
      });
    }

    // Serve an image attachment. Auth via `?token=` (session id) because a plain
    // <img src> can't set an Authorization header; the token is the same session
    // secret used everywhere else, so this is no weaker than the Bearer path.
    const attGet = p.match(/^\/api\/attachments\/([^/]+)$/);
    if (attGet && method === 'GET') {
      const sid = url.searchParams.get('token') ?? '';
      const projectId = url.searchParams.get('projectId') ?? undefined;
      let attachmentSession = await this.auth(req, projectId);
      if (!attachmentSession && sid) {
        attachmentSession = this.sessions.get(sid);
        const agent = this.deps.tokens.verify(sid);
        if (!attachmentSession && agent) attachmentSession = { user: agent.principal, apiToken: sid };
      }
      if (!attachmentSession) return this.json(res, 401, { error: 'unauthorized' });
      if (projectId && !this.deps.tokens.check(attachmentSession.apiToken, 'task:read', { projectId }).ok)
        return this.json(res, 403, { error: 'missing capability task:read' });
      // New uploads are project-scoped. Unscoped rows are legacy attachments
      // created before the ACL table existed and remain readable for migration.
      if (this.deps.store.attachmentIsScoped(attGet[1]!) && (!projectId || !this.deps.store.attachmentAllowed(attGet[1]!, projectId)))
        return this.json(res, 404, { error: 'attachment not found' });
      const got = this.attachments.read(attGet[1]!);
      if (!got) return void res.writeHead(404).end('not found');
      res.writeHead(200, {
        'content-type': got.mediaType,
        'cache-control': 'private, max-age=31536000, immutable',
      });
      return void res.end(got.buf);
    }

    // ── authenticated endpoints ──
    const requestedScope = this.requestScope(p, url);
    const session = await this.auth(req, requestedScope.projectId);
    if (!session) return this.json(res, 401, { error: 'unauthorized' });
    const token = session.apiToken;
    const { api, store } = this.deps;

    const required = capabilityForRequest(method, p, url);
    let authRecord = this.deps.tokens.verify(token);
    if (required) {
      const scope = requestedScope;
      const checked = this.deps.tokens.check(token, required, scope);
      // The project collection has no single scope. A project-only human may
      // enter it when at least one project grant permits discovery; the response
      // below is filtered project-by-project. No other unscoped route gets this
      // exception.
      const collectionAllowed = !checked.ok && p === '/api/projects' && method === 'GET' && !!session.userId &&
        this.deps.store.listProjects().some((project) => allows(this.deps.authorization?.capabilities(`user:${session.userId}`, project.id) ?? [], required));
      if (!checked.ok && !collectionAllowed) return this.json(res, 403, { error: checked.reason ?? `missing capability ${required}` });
      if (checked.ok) authRecord = checked.record;
      const principal = checked.record?.principal ?? (session.userId ? `user:${session.userId}` : session.user);
      this.deps.authorization?.audit(principal, `http.${method.toLowerCase()}.${required}`, scope.projectId ? `project:${scope.projectId}` : 'global', { path: p });
    }

    try {
      if (p === '/api/logout' && method === 'POST') {
        const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
        if (bearer) this.sessions.delete(bearer);
        if (this.deps.identity) return this.sendWebResponse(res, await this.deps.identity.signOut(requestHeaders(req.headers)));
        return this.json(res, 200, { ok: true });
      }
      if (p === '/api/platform' && method === 'GET') return this.json(res, 200, PLATFORM_API_CATALOG);
      // Multiple human accounts + karmax authorization. Better Auth owns the
      // account/session records; these routes only attach karmax grants.
      if (p === '/api/users' && method === 'GET') {
        return this.json(res, 200, (this.deps.identity?.listUsers() ?? []).map((u) => ({ ...u, grants: this.deps.authorization?.grants(`user:${u.id}`) ?? [] })));
      }
      if (p === '/api/users' && method === 'POST') {
        if (!this.deps.identity) return this.json(res, 400, { error: 'identity service unavailable' });
        const b = await this.body(req);
        const user = await this.deps.identity.createUser({ name: String(b.name ?? ''), email: String(b.email ?? ''), password: String(b.password ?? '') });
        if (b.profileId) this.deps.authorization?.grant(`user:${session.userId}`, { principalId: `user:${user.id}`, scopeKey: b.projectId ? `project:${b.projectId}` : 'global', profileId: String(b.profileId) });
        return this.json(res, 200, user);
      }
      const userMatch = p.match(/^\/api\/users\/([^/]+)$/);
      if (userMatch && method === 'DELETE') {
        if (userMatch[1] === session.userId) return this.json(res, 400, { error: 'cannot delete the current account' });
        await this.deps.identity?.removeUser(userMatch[1]!);
        for (const g of this.deps.authorization?.grants(`user:${userMatch[1]}`) ?? []) this.deps.authorization?.revoke(`user:${session.userId}`, g.principalId, g.scopeKey);
        return this.json(res, 200, { ok: true });
      }
      if (p === '/api/authorization/profiles' && method === 'GET') {
        const projectId = url.searchParams.get('projectId') ?? undefined;
        return this.json(res, 200, {
          profiles: this.deps.authorization?.profiles(projectId) ?? [],
          defaultProfile: this.deps.authorization?.defaultProfile(projectId),
          capabilityGroups: CAPABILITY_GROUPS,
        });
      }
      if (p === '/api/authorization/profiles' && method === 'PUT') {
        const b = await this.body(req);
        const scopeKey = (b.projectId ? `project:${b.projectId}` : 'global') as import('../platform/authorization.js').AuthorizationScope;
        return this.json(res, 200, this.deps.authorization?.saveProfile(`user:${session.userId}`, scopeKey, b.profile));
      }
      if (p === '/api/authorization/default' && method === 'PUT') {
        const b = await this.body(req);
        this.deps.authorization?.setDefault(`user:${session.userId}`, String(b.profileId), b.projectId ? String(b.projectId) : undefined);
        return this.json(res, 200, { ok: true });
      }
      if (p === '/api/authorization/grants' && method === 'GET') return this.json(res, 200, this.deps.authorization?.grants() ?? []);
      if (p === '/api/authorization/grants' && method === 'PUT') {
        const b = await this.body(req);
        return this.json(res, 200, this.deps.authorization?.grant(`user:${session.userId}`, {
          principalId: String(b.principalId), scopeKey: b.projectId ? `project:${b.projectId}` : 'global',
          profileId: String(b.profileId), ...(Array.isArray(b.capabilities) ? { capabilities: b.capabilities } : {}),
        }));
      }
      if (p === '/api/audit' && method === 'GET') return this.json(res, 200, store.auditSince(Number(url.searchParams.get('since') ?? 0), Number(url.searchParams.get('limit') ?? 500)));

      // Host diagnostics + agent-turn admission state (SPEC §12): loadavg,
      // free/total memory, and whether either pressure gate is currently holding
      // new agent leases back. Reporting only — the gate itself lives in
      // src/activities/agent-slots.ts (same process as the worker).
      if (p === '/api/diagnostics' && method === 'GET') {
        const { hostStats, agentSlotStats } = await import('../activities/agent-slots.js');
        const safety = agentSlotStats();
        const queue = await api.agentQueueView(token);
        return this.json(res, 200, {
          host: hostStats(),
          agentSlots: { ...safety, capacity: queue.capacity, inUse: queue.current.length, waiting: queue.queue.length },
          ts: Date.now(),
        });
      }

      // Task manager (dashboard Processes panel): every process karmax is
      // responsible for — agent subprocesses and their tool children, embedded-
      // terminal PTYs and what runs in them, the Temporal server, git/exec
      // helpers — grouped by owning entity with live CPU/RSS. See
      // src/util/processes.ts for the coverage model.
      if (p === '/api/processes' && method === 'GET') {
        const { sampleProcesses } = await import('../util/processes.js');
        return this.json(res, 200, sampleProcesses());
      }
      if (p === '/api/processes/kill' && method === 'POST') {
        const b = await this.body(req);
        const { killTracked } = await import('../util/processes.js');
        const out = await killTracked(Number(b.pid), b.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
        return this.json(res, out.ok ? 200 : 400, out);
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
          if (requestedScope.projectId) store.grantAttachment(ref.id, requestedScope.projectId);
          return this.json(res, 200, ref);
        } catch (e) {
          if (e instanceof AttachmentError) return this.json(res, 400, { error: e.message });
          throw e;
        }
      }

      // projects
      if (p === '/api/projects' && method === 'GET') {
        const projects = store.listProjects();
        if (authRecord?.projectId) return this.json(res, 200, projects.filter((x) => x.id === authRecord!.projectId));
        if (session.userId && this.deps.authorization) {
          const principal = `user:${session.userId}`;
          return this.json(res, 200, projects.filter((x) => allows(this.deps.authorization!.capabilities(principal, x.id), 'project:read')));
        }
        return this.json(res, 200, projects);
      }
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

      // ── search / organization (a view is a saved query — PLAN-search-views) ──
      // The searchable-field registry the UI reads to build its filter/sort/group menus.
      if (p === '/api/search/fields' && method === 'GET') return this.json(res, 200, api.searchFields(token));

      // Evaluate a query against a project: `?q=<query string>` (Linear-style token
      // syntax) → { tasks, groups, total }. Every list surface — the default list
      // included — is just an evaluation of one of these.
      const searchMatch = p.match(/^\/api\/projects\/([^/]+)\/search$/);
      if (searchMatch && method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const r = await api.searchTasks(token, searchMatch[1]!, q);
        return this.json(res, 200, r);
      }

      // Tags (labels + topics, hierarchical) — project-scoped catalogue.
      const tagsMatch = p.match(/^\/api\/projects\/([^/]+)\/tags$/);
      if (tagsMatch) {
        const projectId = tagsMatch[1]!;
        if (method === 'GET') return this.json(res, 200, await api.listTags(token, projectId));
        if (method === 'POST') {
          const b = await this.body(req);
          return this.json(res, 200, await api.createTag(token, { projectId, name: b.name, parentId: b.parentId, color: b.color, kind: b.kind }));
        }
      }
      const tagMatch = p.match(/^\/api\/tags\/([^/]+)$/);
      if (tagMatch) {
        const id = tagMatch[1]!;
        if (method === 'PATCH') {
          const b = await this.body(req);
          try {
            return this.json(res, 200, await api.updateTag(token, id, b));
          } catch (e) {
            return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (method === 'DELETE') {
          await api.deleteTag(token, id);
          return this.json(res, 200, { ok: true });
        }
      }

      // Saved views — named, persisted queries shown in the project's view switcher.
      const viewsMatch = p.match(/^\/api\/projects\/([^/]+)\/views$/);
      if (viewsMatch) {
        const projectId = viewsMatch[1]!;
        if (method === 'GET') return this.json(res, 200, await api.listViews(token, projectId));
        if (method === 'POST') {
          const b = await this.body(req);
          return this.json(res, 200, await api.createView(token, { projectId, name: b.name, query: b.query ?? {}, icon: b.icon }));
        }
      }
      const savedViewMatch = p.match(/^\/api\/views\/([^/]+)$/);
      if (savedViewMatch) {
        const id = savedViewMatch[1]!;
        if (method === 'PATCH') {
          const b = await this.body(req);
          return this.json(res, 200, await api.updateView(token, id, b));
        }
        if (method === 'DELETE') {
          await api.deleteView(token, id);
          return this.json(res, 200, { ok: true });
        }
      }
      const viewReorderMatch = p.match(/^\/api\/views\/([^/]+)\/reorder$/);
      if (viewReorderMatch && method === 'POST') {
        const b = await this.body(req);
        await api.reorderView(token, viewReorderMatch[1]!, Number(b.ord ?? 0));
        return this.json(res, 200, { ok: true });
      }

      // Per-task organization: tag set + priority (both purely organizational —
      // never assembled into any agent prompt, so editable at any lifecycle stage).
      const taskTagsMatch = p.match(/^\/api\/tasks\/([^/]+)\/tags$/);
      if (taskTagsMatch && method === 'PUT') {
        const b = await this.body(req);
        const tags = await api.setTaskTags(token, taskTagsMatch[1]!, Array.isArray(b.tagIds) ? b.tagIds : []);
        return this.json(res, 200, { tags });
      }
      // Agent-facing add/remove by tag name or path (used by the platform MCP).
      const tagEditMatch = p.match(/^\/api\/tasks\/([^/]+)\/tag$/);
      if (tagEditMatch && method === 'POST') {
        const b = await this.body(req);
        try {
          const out = await api.tagTask(token, tagEditMatch[1]!, { add: b.add, remove: b.remove });
          return this.json(res, 200, out);
        } catch (e) {
          return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      const priorityMatch = p.match(/^\/api\/tasks\/([^/]+)\/priority$/);
      if (priorityMatch && method === 'PUT') {
        const b = await this.body(req);
        await api.setTaskPriority(token, priorityMatch[1]!, Number(b.priority ?? 0));
        return this.json(res, 200, { ok: true });
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
        const rec = store.getTask(viewMatch[1]!);
        // Draft attempts have no Temporal execution, but are still selectable in
        // the drawer. Keep that synthetic projection separate from getTaskView so
        // list snapshots continue to truthfully report no execution view.
        const view = rec?.params?.draft
          ? api.getDraftView(token, viewMatch[1]!)
          : await api.getTaskView(token, viewMatch[1]!);
        if (!view) return this.json(res, 200, null);
        // Mirror the record's sequential number onto the view (the workflow only
        // knows the opaque id) so the drawer can show `#num` + a permalink.
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
      const attemptsMatch = p.match(/^\/api\/tasks\/([^/]+)\/attempts$/);
      if (attemptsMatch && method === 'GET') {
        return this.json(res, 200, api.attemptGroup(token, attemptsMatch[1]!) ?? null);
      }
      if (attemptsMatch && method === 'POST') {
        try {
          return this.json(res, 200, await api.addAttempt(token, attemptsMatch[1]!));
        } catch (e) {
          return this.json(res, 409, { error: e instanceof Error ? e.message : String(e) });
        }
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
        // A waiting (armed) task or a repeatable series hasn't started its own
        // workflow — edit its stored params + triggers in place, then re-arm (or
        // drop to a draft). `keepArmed:false` (Save as draft) disarms it.
        if (t.params?.triggerState === 'armed' || t.params?.repeatable) {
          try {
            const updated = await api.updateArmedParams(token, id, b.params ?? {}, { replace: b.replace === true, keepArmed: b.keepArmed !== false });
            return this.json(res, 200, updated);
          } catch (e) {
            return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        // A draft has no running workflow — edit its stored params in place; they
        // re-resolve at queue time (SPEC §10.4).
        if (t.params?.draft) {
          const confirmerField = manifest(t.workflow)?.params.find((f) => f.type === 'confirmer');
          if (confirmerField && Object.prototype.hasOwnProperty.call(b.params ?? {}, confirmerField.name)) {
            try {
              store.setIntentConfirmer(t.intentId ?? t.id, confirmerField.name, b.params[confirmerField.name]);
            } catch (e) {
              return this.json(res, 409, { error: e instanceof Error ? e.message : String(e) });
            }
          }
          // Replace the workflow-field overrides wholesale (b.params is the form's
          // full set of own overrides) so a field reset to its default is actually
          // removed — a merge would leave the stale override behind. Lifecycle +
          // organizational meta (draft/archived/profiles/priority) is preserved across
          // the edit — priority is set via its own endpoint and must survive a form save.
          const { draft, archived, profiles, priority, _authorization } = t.params;
          const meta = { ...(draft !== undefined ? { draft } : {}), ...(archived !== undefined ? { archived } : {}), ...(profiles !== undefined ? { profiles } : {}), ...(priority !== undefined ? { priority } : {}), ...(_authorization !== undefined ? { _authorization } : {}) };
          const replace = b.replace === true;
          const next = replace ? { ...meta, ...b.params } : { ...t.params, ...b.params };
          // Never trust workflow-form JSON for platform authorization metadata.
          if (_authorization !== undefined) next._authorization = _authorization;
          store.updateTaskParams(id, next);
          // Keep the title tracking the edited prompt (title was derived from it).
          const prompt = b.params?.prompt;
          if (typeof prompt === 'string' && prompt.trim()) store.setTaskTitle(id, (prompt.split('\n')[0] ?? '').slice(0, 80));
          return this.json(res, 200, store.getTask(id) ?? null);
        }
        // Once queued, params are frozen except the ones the workflow declares
        // in-flight-editable (SPEC §4.5/§5.5). Forward to its validated update and
        // let the validator reject anything frozen — a clear 409, never a silent
        // no-op on the stored record (which the running workflow would ignore).
        try {
          const applied = await api.updateParams(token, id, b.params ?? {});
          // Authoritative read: reflect the just-applied update, not a snapshot that
          // may pre-date the workflow's next publish.
          return this.json(res, 200, { ...applied, view: await api.getTaskView(token, id, { live: true }) });
        } catch (e) {
          return this.json(res, 409, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      const taskAuthMatch = p.match(/^\/api\/tasks\/([^/]+)\/authorization$/);
      if (taskAuthMatch && method === 'PATCH') {
        const b = await this.body(req);
        return this.json(res, 200, api.setTaskAuthorization(token, taskAuthMatch[1]!, String(b.profileId ?? '')));
      }
      const archiveMatch = p.match(/^\/api\/tasks\/([^/]+)\/archive$/);
      if (archiveMatch && method === 'POST') {
        const b = await this.body(req);
        const t = store.getTask(archiveMatch[1]!);
        if (!t) return this.json(res, 404, { error: 'no such task' });
        const archived = b.archived !== false; // default: archive
        // Archiving only hides from the default list; it never touches the task's
        // execution. Any task can be archived/un-archived regardless of status —
        // a running task keeps running while hidden, and the built-in `is:archived`
        // view (or `includeArchived=1`) brings it back into view at any time.
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
      const cancelTrigMatch = p.match(/^\/api\/tasks\/([^/]+)\/cancel-trigger$/);
      if (cancelTrigMatch && method === 'POST') {
        return this.json(res, 200, await api.cancelTrigger(token, cancelTrigMatch[1]!));
      }
      const runNowMatch = p.match(/^\/api\/tasks\/([^/]+)\/run-now$/);
      if (runNowMatch && method === 'POST') {
        return this.json(res, 200, await api.runArmedNow(token, runNowMatch[1]!));
      }
      const runAgainMatch = p.match(/^\/api\/tasks\/([^/]+)\/run-again$/);
      if (runAgainMatch && method === 'POST') {
        return this.json(res, 200, await api.runAgain(token, runAgainMatch[1]!));
      }
      const runsMatch = p.match(/^\/api\/tasks\/([^/]+)\/runs$/);
      if (runsMatch && method === 'GET') {
        return this.json(res, 200, store.runsOf(runsMatch[1]!));
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
        const view = (await api.getTaskView(token, taskId, { live: true }).catch(() => undefined)) ?? store.getTask(taskId)?.lastView;
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
      // Conversation file links are readable wherever the conversation itself
      // is readable. They use the same world confinement as review artifacts,
      // but unknown extensions default to inline text for a useful source view.
      const fileMatch = p.match(/^\/api\/tasks\/([^/]+)\/file$/);
      if (fileMatch && method === 'GET') {
        return this.serveArtifact(res, fileMatch[1]!, url.searchParams.get('path') ?? '', true);
      }
      const eventsMatch = p.match(/^\/api\/tasks\/([^/]+)\/events$/);
      if (eventsMatch && method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? '0');
        return this.json(res, 200, await api.taskEvents(token, eventsMatch[1]!, since));
      }
      const agentsMatch = p.match(/^\/api\/tasks\/([^/]+)\/agents$/);
      if (agentsMatch && method === 'GET') return this.json(res, 200, await api.listTaskAgents(token, agentsMatch[1]!));
      const conversationMatch = p.match(/^\/api\/tasks\/([^/]+)\/conversation$/);
      if (conversationMatch && method === 'GET') return this.json(res, 200, await api.taskConversation(token, conversationMatch[1]!, url.searchParams.get('role') ?? 'do'));
      const forkAgentMatch = p.match(/^\/api\/tasks\/([^/]+)\/fork-agent$/);
      if (forkAgentMatch && method === 'POST') {
        const b = await this.body(req);
        return this.json(res, 200, await api.forkTaskAgent(token, { ...b, taskId: forkAgentMatch[1]! }));
      }
      const sessMatch = p.match(/^\/api\/tasks\/([^/]+)\/sessions$/);
      if (sessMatch && method === 'GET') {
        const id = sessMatch[1]!;
        const t = store.getTask(id);
        // Each role → { id, home?, provider? } so the UI can build a CLI resume
        // command targeting the right CONFIG_DIR/CODEX_HOME (provider sessions are
        // home-bound). `home` is omitted for API-key/stateless sessions.
        const out: Record<string, { id: string; home?: string; provider?: string }> = {};
        for (const role of ['do', 'merge', ...(RESOLVE_AGENT_ENABLED ? ['resolve'] : []), 'confirm']) {
          const sessionTaskId = role === 'confirm' ? (t?.intentId ?? id) : id;
          const s = store.kvGet(`session:${sessionTaskId}:${role}`);
          if (!s) continue;
          let home: string | undefined;
          let provider: string | undefined;
          const meta = store.kvGet(`sessionmeta:${sessionTaskId}:${role}`);
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
        return this.json(res, 200, await api.queueView(token, domain, url.searchParams.get('projectId') ?? undefined));
      }
      if (p === '/api/queue/prioritize' && method === 'POST') {
        const b = await this.body(req);
        await api.reorderQueue(token, b.domain, b.taskId);
        return this.json(res, 200, { ok: true });
      }
      if (p === '/api/queue/move' && method === 'POST') {
        const b = await this.body(req);
        await api.moveQueueItem(token, b.domain, b.taskId, b.beforeTaskId || undefined);
        return this.json(res, 200, { ok: true });
      }
      if (p === '/api/agent-queue' && method === 'GET') {
        return this.json(res, 200, await api.agentQueueView(token));
      }
      if (p === '/api/agent-queue/move' && method === 'POST') {
        const b = await this.body(req);
        await api.moveAgentQueueItem(token, String(b.turnId), b.beforeTurnId ? String(b.beforeTurnId) : undefined);
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
        const visible = (pr: { role: string }) => !!roleDef(pr.role);
        const pid = url.searchParams.get('projectId') ?? undefined;
        if (!pid) return this.json(res, 200, store.listProfiles().filter((pr) => !pr.id.includes('::') && visible(pr)).map(withRole));
        // effective per-role view: the project override if present, else global (inherited)
        const globals = store.listProfiles().filter((pr) => !pr.id.includes('::') && visible(pr));
        const view = globals.map((g) => {
          const proj = store.getProfile(`${pid}::${g.role}-default`);
          return withRole({ ...(proj ?? g), id: `${pid}::${g.role}-default`, role: g.role, scope: proj ? 'project' : 'inherited', inherited: g });
        });
        return this.json(res, 200, view);
      }
      // Provider-native, account-aware model pickers. Both the Claude Agent SDK and
      // Codex app-server expose this metadata; cache it because each refresh boots a
      // short-lived provider subprocess for every distinct connected login.
      if (p === '/api/models' && method === 'GET') {
        return this.json(res, 200, await this.availableModels(url.searchParams.get('refresh') === '1'));
      }
      if (p === '/api/profiles' && method === 'PUT') {
        const b = await this.body(req);
        if (!b.role) return this.json(res, 400, { error: 'profile needs a role' });
        if (b.provider !== undefined && !isAgentProvider(b.provider)) {
          return this.json(res, 400, { error: `unknown agent provider "${String(b.provider)}"` });
        }
        const { roleDef } = await import('../contrib/manifests.js');
        if (!roleDef(String(b.role))) return this.json(res, 400, { error: `unknown or disabled agent role "${String(b.role)}"` });
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
        const provider = String(b.provider);
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(provider)) {
          return this.json(res, 400, { error: 'model provider must be a simple id (letters, numbers, dot, underscore, hyphen)' });
        }
        const handle = `${provider}:${b.account}`;
        this.deps.broker.registerHandle(handle, String(b.apiKey));
        return this.json(res, 200, { handle }); // never echoes the secret
      }
      // connect an account login: mint a config home + launch the provider's own
      // OAuth, return the device URL for the user to complete (we never type creds).
      if (p === '/api/accounts/connect' && method === 'POST') {
        if (!this.deps.login) return this.json(res, 400, { error: 'no login manager configured' });
        const b = await this.body(req);
        if (!isLoginProvider(b.provider)) return this.json(res, 400, { error: `unsupported login provider: ${String(b.provider ?? '')}` });
        const provider = b.provider;
        if (!b.account) return this.json(res, 400, { error: 'account required' });
        const modelProvider = b.modelProvider === undefined ? undefined : String(b.modelProvider);
        const authMethod = b.authMethod === undefined ? undefined : String(b.authMethod);
        if (provider === 'opencode') {
          if (!modelProvider || !/^[a-z0-9][a-z0-9._-]*$/i.test(modelProvider)) {
            return this.json(res, 400, { error: 'OpenCode login requires a simple model-provider id' });
          }
          if (!authMethod || authMethod.length > 160 || /[\r\n\0]/.test(authMethod)) {
            return this.json(res, 400, { error: 'OpenCode login requires a valid auth-method label' });
          }
        }
        const result = await this.deps.login.connect(provider, String(b.account), { modelProvider, authMethod });
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
        const rawProvider = loginMatch[1];
        if (!isLoginProvider(rawProvider)) return this.json(res, 400, { error: `unsupported login provider: ${rawProvider}` });
        const provider = rawProvider;
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

      // Git profiles (PLAN-git-config.md §3): named git identity + credentials for
      // the repos karmax works on. The registry is public; secrets are write-only
      // into the vault (never echoed) and resolved JIT by the broker at use time.
      if (p === '/api/git-profiles' && method === 'GET') {
        const { GitProfiles } = await import('../autonomy/git-profiles.js');
        const gp = new GitProfiles(store, this.deps.broker);
        return this.json(res, 200, { profiles: gp.list(), defaultProfile: gp.defaultProfile() ?? null });
      }
      if (p === '/api/git-profiles' && method === 'POST') {
        const b = await this.body(req);
        if (!this.deps.broker) return this.json(res, 400, { error: 'no credential broker configured' });
        if (!b.name || !b.userName || !b.userEmail) return this.json(res, 400, { error: 'name, userName, userEmail required' });
        const { GitProfiles } = await import('../autonomy/git-profiles.js');
        const gp = new GitProfiles(store, this.deps.broker);
        try {
          const rec = gp.save({
            name: String(b.name),
            userName: String(b.userName),
            userEmail: String(b.userEmail),
            sshKey: b.sshKey ? String(b.sshKey) : undefined,
            signingKey: b.signingKey ? String(b.signingKey) : undefined,
            githubToken: b.githubToken ? String(b.githubToken) : undefined,
          });
          if (b.default) gp.setDefault(rec.name);
          return this.json(res, 200, { profile: rec }); // never echoes the secrets
        } catch (e) {
          return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      const gitProfileMatch = p.match(/^\/api\/git-profiles\/([^/]+)$/);
      if (gitProfileMatch && method === 'DELETE') {
        const { GitProfiles } = await import('../autonomy/git-profiles.js');
        new GitProfiles(store, this.deps.broker).delete(decodeURIComponent(gitProfileMatch[1]!));
        return this.json(res, 200, { ok: true });
      }
      // The doctor check (PLAN-git-config.md §7): which tier a project's remote
      // ops resolve to (profile / host fallback) and whether it can reach the
      // repos' remotes non-interactively. Read-only.
      if (p === '/api/git-profiles/preflight' && method === 'GET') {
        const projectId = url.searchParams.get('projectId') ?? undefined;
        const project = projectId ? store.getProject(projectId) : undefined;
        const { GitProfiles } = await import('../autonomy/git-profiles.js');
        return this.json(res, 200, await new GitProfiles(store, this.deps.broker).preflight(project?.config));
      }
      if (p === '/api/git-profiles/default' && method === 'POST') {
        const b = await this.body(req);
        const { GitProfiles } = await import('../autonomy/git-profiles.js');
        new GitProfiles(store, this.deps.broker).setDefault(b.name ? String(b.name) : undefined);
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
        const { isUsagePollable, isUsageStale } = await import('../agent/usage.js');
        const creds = enumerateCredentials(gatherCredentialSources({ configHomes: this.deps.configHomes, broker: this.deps.broker }));
        const usage: Record<string, unknown> = {};
        const pollable: string[] = [];
        for (const c of creds) {
          const canPoll = isUsagePollable(c);
          if (canPoll) pollable.push(c.key);
          const cached = store.kvGet(`usage:${c.key}`);
          // `stale` = a window already reset or the probe outlived its TTL; the
          // dashboard auto-rechecks stale snapshots instead of presenting them as
          // current (a week-old 15% once masqueraded as live while the login was
          // actually exhausted).
          if (cached) {
            const snap = JSON.parse(cached);
            usage[c.key] = canPoll ? { ...snap, stale: isUsageStale(snap, Date.now()) } : snap;
          }
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
      if (p === '/api/events/catalog' && method === 'GET') {
        // Workflow + platform events for the event-trigger picker (SPEC §5).
        return this.json(res, 200, api.eventCatalog());
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
        // Quick-task defaults (SPEC §10.4): a separate overlay that only applies to
        // tasks added from the quick box. Global-quick inherits from global-general;
        // project-quick inherits from global-quick (primary) with project-general as
        // the alternative source (the two "Reset to inherited" buttons in the UI).
        const globalQuickVals = quickGlobalSettingsFor(gs, wf);
        const projectQuickVals = project ? quickProjectSettingsFor(gs, project.id, wf) : {};
        return this.json(res, 200, {
          task: { own: {}, inherited: enrich(resolveParams(m, { project: projectVals, global: globalVals }), {}) },
          project: { own: projectVals, inherited: enrich(resolveParams(m, { global: globalVals }), projectVals) },
          global: { own: globalVals, inherited: enrich(resolveParams(m, {}), { ...projectVals, ...globalVals }) },
          globalQuick: { own: globalQuickVals, inherited: enrich(resolveParams(m, { global: globalVals }), globalQuickVals) },
          projectQuick: {
            own: projectQuickVals,
            // Primary inherited: the full quick chain minus project-quick itself
            // (global-quick → project-general → global-general → default).
            inherited: enrich(resolveParamsLayers(m, [globalQuickVals, projectVals, globalVals]), { ...projectVals, ...globalVals, ...globalQuickVals, ...projectQuickVals }),
            // Alternative inherited source: the project's general defaults.
            inheritedAlt: enrich(resolveParams(m, { project: projectVals, global: globalVals }), { ...projectVals, ...globalVals, ...projectQuickVals }),
          },
        });
      }

      // settings (global + per-project, per workflow)
      const gset = p.match(/^\/api\/settings\/global\/([^/]+)$/);
      if (gset) {
        const wf = gset[1]!;
        if (method === 'GET') return this.json(res, 200, globalSettingsFor((s, w) => store.getSettings(s, w), wf));
        if (method === 'PUT') {
          const b = await this.body(req);
          if (wf === 'agent-queue' && (!Number.isFinite(Number(b.values?.capacity)) || Number(b.values.capacity) < 1)) {
            return this.json(res, 400, { error: 'Concurrent agent turns must be at least 1' });
          }
          store.setSettings('global', wf, b.values ?? {});
          if (wf === 'agent-queue') await api.setAgentCapacity(Number(b.values?.capacity));
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

      // quick-task defaults (SPEC §10.4) — a separate opt-in overlay stored under a
      // `quick:` namespaced scope; applied only to tasks from the quick-add box.
      const qgset = p.match(/^\/api\/settings\/quick\/global\/([^/]+)$/);
      if (qgset) {
        const wf = qgset[1]!;
        if (method === 'GET') return this.json(res, 200, quickGlobalSettingsFor((s, w) => store.getSettings(s, w), wf));
        if (method === 'PUT') {
          const b = await this.body(req);
          store.setSettings(quickScopeKey('global'), wf, b.values ?? {});
          return this.json(res, 200, { ok: true });
        }
      }
      const qpset = p.match(/^\/api\/settings\/quick\/project\/([^/]+)\/([^/]+)$/);
      if (qpset) {
        const projectId = qpset[1]!;
        const wf = qpset[2]!;
        if (method === 'GET') {
          const project = store.getProject(projectId);
          if (!project) return this.json(res, 404, { error: 'no project' });
          return this.json(res, 200, quickProjectSettingsFor((s, w) => store.getSettings(s, w), projectId, wf));
        }
        if (method === 'PUT') {
          const b = await this.body(req);
          // Quick-task defaults are UI-only overlays (never mirrored into ProjectConfig,
          // which drives full-form/general resolution), so just persist the row.
          store.setSettings(quickScopeKey(projectId), wf, b.values ?? {});
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
        let events = store.allEventsSince(since).slice(-300);
        if (authRecord?.projectId) events = events.filter((e) => store.getTask(e.taskId)?.projectId === authRecord?.projectId);
        return this.json(res, 200, events);
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

  private async availableModels(refresh = false): Promise<{ providers: ModelCatalog; refreshedAt: number }> {
    if (!refresh && this.modelCatalog && Date.now() - this.modelCatalog.at < 5 * 60_000) {
      return { providers: this.modelCatalog.value, refreshedAt: this.modelCatalog.at };
    }
    const { gatherCredentialSources } = await import('../platform/credential-sources.js');
    const { enumerateCredentials } = await import('../platform/credentials.js');
    const creds = enumerateCredentials(gatherCredentialSources({ configHomes: this.deps.configHomes, broker: this.deps.broker }));
    type CatalogProvider = Exclude<Provider, 'mock'>;
    const homes = (provider: CatalogProvider) => {
      const values = creds.filter((c) => c.provider === provider && c.kind !== 'key').map((c) => c.configHome);
      // No subscription login: let the provider process use the ambient API key.
      if (!values.length && creds.some((c) => credentialAliases(provider).includes(c.provider) && c.kind === 'key')) values.push(undefined);
      return [...new Set(values)];
    };
    const settled = async (provider: CatalogProvider) => {
      const fn =
        provider === 'claude' ? claudeModels
        : provider === 'codex' ? codexModels
        : provider === 'opencode' ? opencodeModels
        : (home?: string) => acpModels(provider, home);
      const results = await Promise.all(homes(provider).map((home) => fn(home).catch(() => [])));
      return mergeModels(results);
    };
    const [claude, codex, opencode] = await Promise.all([
      settled('claude'), settled('codex'), settled('opencode'),
    ]);
    // Discovery is best-effort (offline/old CLI/expired login). Keep the existing
    // safe presets so forms never degrade to an empty, non-actionable picker.
    const value: ModelCatalog = {
      claude: claude.length ? claude : [
        { id: 'claude-sonnet-5' }, { id: 'claude-opus-4-8' }, { id: 'claude-haiku-4-5' }, { id: 'claude-fable-5' },
      ],
      codex: codex.length ? codex : [{ id: 'gpt-5.5' }, { id: 'gpt-5.4-mini' }],
      opencode: opencode.length ? opencode : [
        { id: 'kimi/kimi-for-coding' },
        { id: 'kimi/k3', effort: ['low', 'high', 'max'] },
        { id: 'google/gemini-3.6-pro' },
        { id: 'xai/grok-4.5' },
      ],
      // Retained only for stored-profile/backward-compatible typing. The native
      // Kimi harness is disabled until its ACP server supports session/fork.
      kimi: [],
      // Retained only for stored-profile/backward-compatible typing. Grok's
      // current ACP server does not advertise session/fork.
      grok: [],
      mock: [{ id: 'mock' }],
    };
    this.modelCatalog = { at: Date.now(), value };
    return { providers: value, refreshedAt: this.modelCatalog.at };
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
   *  shells out `claude -p '/usage'` in an isolated dir so it can't race a leased home.
   *  Overlapping rechecks (auto-refresh + button, multiple tabs) share one in-flight
   *  probe per login rather than spawning duplicate CLIs. */
  private usageProbes = new Map<string, Promise<unknown>>();
  private async refreshUsage(only?: string): Promise<Record<string, unknown>> {
    const { store } = this.deps;
    const { enumerateCredentials } = await import('../platform/credentials.js');
    const { gatherCredentialSources } = await import('../platform/credential-sources.js');
    const { probeClaudeUsage, isUsagePollable } = await import('../agent/usage.js');
    const creds = enumerateCredentials(gatherCredentialSources({ configHomes: this.deps.configHomes, broker: this.deps.broker }))
      .filter((c) => isUsagePollable(c) && (!only || c.key === only));
    const out: Record<string, unknown> = {};
    await Promise.all(creds.map(async (c) => {
      let probe = this.usageProbes.get(c.key);
      if (!probe) {
        // ambient uses ~/.claude (no configHome); a login uses its own home.
        probe = probeClaudeUsage({ configHome: c.kind === 'ambient' ? undefined : c.configHome })
          .then((snap) => { store.kvSet(`usage:${c.key}`, JSON.stringify(snap)); return snap; })
          .finally(() => this.usageProbes.delete(c.key));
        this.usageProbes.set(c.key, probe);
      }
      out[c.key] = await probe;
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
      const agent = { provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(spec.resumeFrom ? { resumeFrom: spec.resumeFrom } : {}) };
      // A confirmer carries the ordered confirm LAYERS (legacy {mode} values
      // normalize). Each agent layer gets the role-default agent knobs filled in,
      // same as a bare agent field; `agentDefault` rides along so the form can
      // prefill a NEWLY added agent layer the same way (display-only — collectForm
      // never stores it).
      out[f.name] = f.type === 'confirmer'
        ? {
            layers: confirmLayersOf(Object.keys(spec).length ? spec : (f.default as any)).map((l) => {
              if (l.kind !== 'agent') return { kind: l.kind };
              const lprov = l.provider ?? prof?.provider ?? defaultProvider().provider;
              const lmodel = l.model ?? prof?.model ?? defaultModel(lprov);
              const leffort = l.effort ?? prof?.effort ?? defaultEffort(lprov);
              return { ...l, provider: lprov, ...(lmodel ? { model: lmodel } : {}), ...(leffort ? { effort: leffort } : {}) };
            }),
            agentDefault: agent,
          }
        : agent;
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
  private async serveArtifact(res: http.ServerResponse, taskId: string, relPath: string, sourceFile = false) {
    const worldPath = this.deps.store.getTask(taskId)?.lastView?.worldPath;
    if (!worldPath) return this.json(res, 404, { error: 'no world for this task' });
    if (!relPath) return this.json(res, 400, { error: 'missing path' });
    try {
      const root = await fs.promises.realpath(path.resolve(worldPath));
      const requested = path.resolve(root, relPath);
      if (requested !== root && !requested.startsWith(root + path.sep)) return this.json(res, 400, { error: 'path escapes world' });
      // A lexical prefix check does not catch a symlink in the world pointing
      // outside it. Confine the resolved target too before reading any bytes.
      const file = await fs.promises.realpath(requested);
      if (file !== root && !file.startsWith(root + path.sep)) return this.json(res, 400, { error: 'path escapes world' });
      const stat = await fs.promises.stat(file);
      if (stat.isDirectory()) return this.json(res, 400, { error: 'path is a directory' });
      const data = await fs.promises.readFile(file);
      const inferredType = ARTIFACT_MIME[path.extname(file).toLowerCase()];
      const looksTextual = !data.subarray(0, 8192).includes(0);
      res.writeHead(200, {
        'content-type': inferredType ?? (sourceFile && looksTextual ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
        'content-length': String(data.length),
        'content-disposition': `inline; filename="${path.basename(file).replace(/["\\\r\n]/g, '_')}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(data);
    } catch {
      this.json(res, 404, { error: 'artifact not found' });
    }
  }

  // ── helpers ──
  private async auth(req: http.IncomingMessage, projectId?: string): Promise<Session | undefined> {
    const h = req.headers['authorization'];
    const sid = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    if (sid) {
      const legacy = this.sessions.get(sid);
      if (legacy) return legacy;
      const agent = this.deps.tokens.verify(sid);
      if (agent) return { user: agent.principal, apiToken: sid };
    }
    if (!this.deps.identity) return undefined;
    const identity = await this.deps.identity.session(requestHeaders(req.headers));
    if (!identity) return undefined;
    const principal = `user:${identity.user.id}`;
    const caps = this.deps.authorization?.capabilities(principal, projectId) ?? [];
    const fingerprint = JSON.stringify(caps.slice().sort());
    const cacheKey = `${identity.session.id}:${projectId ?? 'global'}`;
    let cached = this.identityTokens.get(cacheKey);
    if (!cached || cached.fingerprint !== fingerprint || !this.deps.tokens.verify(cached.apiToken)) {
      if (cached) this.deps.tokens.revoke(cached.apiToken);
      cached = { apiToken: this.deps.tokens.mintPrincipal(principal, caps, projectId, 10 * 60 * 1000).token, fingerprint };
      this.identityTokens.set(cacheKey, cached);
    }
    return { user: identity.user.name, userId: identity.user.id, apiToken: cached.apiToken };
  }
  /** Browser WebSockets carry Better Auth cookies. The legacy test/embed gateway
   * instead has a JSON session id, which may be passed explicitly in the query
   * just like attachment URLs; production task tokens are never synthesized. */
  private async socketAuth(req: http.IncomingMessage, url: URL, projectId?: string): Promise<Session | undefined> {
    const token = url.searchParams.get('token') ?? '';
    if (token) {
      const legacy = this.sessions.get(token);
      if (legacy) return legacy;
      const agent = this.deps.tokens.verify(token);
      if (agent) return { user: agent.principal, apiToken: token };
    }
    return this.auth(req, projectId);
  }
  private requestScope(pathname: string, url: URL): { projectId?: string; taskId?: string } {
    const projectId = pathname.match(/^\/api\/projects\/([^/]+)/)?.[1]
      ?? pathname.match(/^\/api\/defaults\/([^/]+)/)?.[1]
      ?? pathname.match(/^\/api\/settings\/(?:quick\/)?project\/([^/]+)/)?.[1]
      ?? url.searchParams.get('projectId') ?? undefined;
    const taskId = pathname.match(/^\/api\/tasks\/([^/]+)/)?.[1] ?? url.searchParams.get('taskId') ?? undefined;
    const taskProject = taskId ? this.deps.store.getTask(taskId)?.projectId : undefined;
    return { projectId: projectId ?? taskProject, ...(taskId ? { taskId } : {}) };
  }
  private async sendWebResponse(res: http.ServerResponse, response: Response) {
    const body = Buffer.from(await response.arrayBuffer());
    const headers: Record<string, string | string[]> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    const getSetCookie = (response.headers as any).getSetCookie?.bind(response.headers);
    if (getSetCookie) headers['set-cookie'] = getSetCookie();
    res.writeHead(response.status, headers);
    res.end(body);
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

/** Tear down a check-in PTY and everything running inside it. The interactive
 *  shell node-pty spawned is a session leader (pid == session id), so killing
 *  the whole session reaps its children — foreground and background jobs alike.
 *  `pkill -s` is the thorough path; the process-group kill and `term.kill()` are
 *  fallbacks for platforms without pkill or if the session id trick misses. */
function killPtySession(term: { pid?: number; kill?: () => void }): void {
  const pid = term?.pid;
  if (typeof pid === 'number') {
    try { spawn('pkill', ['-KILL', '-s', String(pid)], { stdio: 'ignore' }).on('error', () => {}); } catch { /* no pkill */ }
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group already gone */ }
  }
  try { term.kill?.(); } catch { /* already dead */ }
}

/** Expand ~ / $HOME in repo paths so a configured repo resolves to a real dir. */
function normalizeConfig(config: ProjectConfig = {}): ProjectConfig {
  if (Array.isArray(config.repos)) {
    return { ...config, repos: config.repos.filter(Boolean).map(expandPath) };
  }
  return config;
}

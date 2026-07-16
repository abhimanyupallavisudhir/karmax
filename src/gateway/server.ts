import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket as WebSocketClient, WebSocketServer } from 'ws';
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
import { Provider, ProjectConfig, PrincipalRef } from '../domain/types.js';
import { confirmLayersOf } from '../domain/confirm.js';
import { ReviewActionRunner } from './review-actions.js';
import { claudeModels, codexModels, mergeModels, type ModelCatalog } from '../agent/models.js';
import type { IdentityService } from '../auth/identity.js';
import type { AuthorizationService } from '../platform/authorization.js';
import { TOOL_CAPABILITY, CAPABILITY_GROUPS, allows } from '../platform/capabilities.js';
import { PLATFORM_API_CATALOG } from '../platform/catalog.js';
import { RESOLVE_AGENT_ENABLED } from '../config/features.js';
import { WorldRegistry } from '../world/registry.js';
import { worldHandleForView } from '../world/resolve.js';
import type { ObjectStore } from '../store/objects.js';
import { newId } from '../util/id.js';
import { DurableEventFanout } from './fanout.js';
import { configuredPreviewOrigin, hashPreviewToken, newPreviewToken, previewCookieHeader,
  previewCookieValue, previewLeaseOrigin, previewLeaseUrl, previewTokenMatches } from './previews.js';
import { GITHUB_APP_PUBLIC_URL_KEY } from '../integrations/github-app.js';

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
  worlds: WorldRegistry;
  githubApp?: import('../integrations/github-app.js').GitHubAppService;
  providerConnections?: import('../world/connections.js').WorldProviderConnectionService;
  handoffs?: import('../world/handoff.js').WorldHandoffService;
  runners?: import('../world/runners.js').RunnerPoolService;
  objects?: ObjectStore;
  cellId?: string;
  hosted?: boolean;
}

/** Coarse HTTP operation → capability binding. KarmaxApi performs the same check
 * again for task operations; this layer covers the direct administrative routes. */
function capabilityForRequest(method: string, p: string, url?: URL): string | undefined {
  const read = method === 'GET';
  if (p === '/api/meta' || p === '/api/session' || p.startsWith('/api/health/')) return undefined;
  if (p === '/api/platform') return 'workflow:read';
  if (p === '/api/logout') return undefined;
  if (p === '/api/dashboard') return 'diagnostic:read';
  if (p.startsWith('/api/diagnostics')) return 'diagnostic:read';
  if (p === '/api/metrics') return 'diagnostic:read';
  if (p.startsWith('/api/processes')) return read ? 'process:read' : 'process:kill';
  if (p.startsWith('/api/users')) return read ? 'user:read' : 'user:write';
  if (p === '/api/invitations/accept') return undefined;
  if (p.startsWith('/api/inbox')) return read ? 'inbox:read' : 'inbox:write';
  if (p === '/api/organizations') return read ? 'organization:read' : 'organization:create';
  if (/^\/api\/organizations\/[^/]+\/projects/.test(p)) return read ? 'project:read' : 'project:create';
  if (/^\/api\/organizations\/[^/]+\/runner-pools/.test(p)) return read ? 'organization:read' : 'organization:edit';
  if (/^\/api\/organizations\/[^/]+\/world-providers/.test(p)) return read ? 'organization:read' : 'organization:edit';
  if (/^\/api\/organizations\/[^/]+\/usage/.test(p)) return 'payment:read';
  if (/^\/api\/organizations\/[^/]+\/repositories/.test(p)) return read ? 'repository:read' : 'repository:write';
  if (/^\/api\/organizations\/[^/]+\/github\/(?:app|app-manifest|authorize|install-url|refresh)/.test(p)) return read ? 'repository:read' : 'repository:write';
  if (/^\/api\/organizations\/[^/]+\/git-connections/.test(p)) return read ? 'repository:read' : 'repository:write';
  if (/^\/api\/organizations\/[^/]+\/teams/.test(p)) return read ? 'team:read' : 'team:write';
  if (/^\/api\/organizations\/[^/]+\/(members|invitations)/.test(p)) return read ? 'organization:member:read' : 'organization:member:write';
  if (/^\/api\/organizations\/[^/]+/.test(p)) return read ? 'organization:read' : 'organization:edit';
  if (/^\/api\/tasks\/[^/]+\/(responsibility|subscribers)/.test(p)) return p.endsWith('/subscribers') ? 'task:subscribe' : 'task:assign';
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
  if (/^\/api\/projects\/[^/]+\/execution-policy$/.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (/^\/api\/projects\/[^/]+\/(defaults|settings|quick-settings)/.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (/^\/api\/projects\/[^/]+\/members/.test(p)) return read ? 'project:read' : 'project:edit';
  if (/^\/api\/projects\/[^/]+\/(?:repositories|repository-sources)/.test(p)) return read ? 'repository:read' : 'repository:write';
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
  if (/\/review-action/.test(p) || /\/artifact$/.test(p) || /\/preview\//.test(p)) return 'task:review:execute';
  if (/\/artifacts(?:\/promote)?$/.test(p) || /^\/api\/artifacts\//.test(p)) return read ? 'task:read' : 'task:review:execute';
  if (/\/preview-leases$/.test(p) || /^\/api\/preview-leases\//.test(p)) return read ? 'task:read' : 'task:review:execute';
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

function principalFromBody(value: unknown): PrincipalRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('principal is required');
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'user' && typeof candidate.userId === 'string' && candidate.userId) return { kind: 'user', userId: candidate.userId };
  if (candidate.kind === 'team' && typeof candidate.teamId === 'string' && candidate.teamId) return { kind: 'team', teamId: candidate.teamId };
  if (candidate.kind === 'task-agent' && typeof candidate.taskId === 'string' && typeof candidate.role === 'string' && candidate.taskId && candidate.role)
    return { kind: 'task-agent', taskId: candidate.taskId, role: candidate.role };
  throw new Error('invalid principal reference');
}

function isWorldHandle(value: unknown): value is Record<string, unknown> & { kind: string; id: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.kind === 'string' && candidate.kind.length > 0
    && typeof candidate.id === 'string'
    && typeof candidate.root === 'string'
    && typeof candidate.branch === 'string'
    && typeof candidate.base === 'string';
}

function worldHandleIsRemote(handle: { kind: string; provider?: unknown }): boolean {
  const provider = typeof handle.provider === 'string' ? handle.provider : handle.kind;
  return !['worktree', 'container', 'memory'].includes(provider);
}

function isTaskView(value: Record<string, unknown>): boolean {
  return typeof value.taskId === 'string'
    && typeof value.workflow === 'string'
    && typeof value.stage === 'string'
    && typeof value.status === 'string'
    && Array.isArray(value.actions)
    && !!value.state
    && typeof value.state === 'object';
}

/**
 * Build the public wire projection of gateway data. Provider handles are
 * capabilities: even though they contain no API key, exposing sandbox ids,
 * repository locations, or recovery metadata creates an unnecessary second
 * interface to the execution plane. Clients get only availability + provider;
 * every operation remains an authenticated gateway request scoped to a task.
 */
export function toPublicPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPublicPayload);
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  if (isWorldHandle(value)) return { kind: value.kind };
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value;

  const input = value as Record<string, unknown>;
  const taskView = isTaskView(input);
  const state = input.state && typeof input.state === 'object' && !Array.isArray(input.state)
    ? input.state as Record<string, unknown>
    : undefined;
  const handle = isWorldHandle(input.world)
    ? input.world
    : isWorldHandle(state?.recoveryWorld) ? state.recoveryWorld : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    if (key === 'recoveryWorld' && isWorldHandle(item)) continue;
    if (taskView && key === 'world') continue;
    if (taskView && key === 'worldPath' && handle && worldHandleIsRemote(handle)) continue;
    out[key] = toPublicPayload(item);
  }
  if (taskView) {
    out.worldAvailable = Boolean(handle || input.worldPath);
    if (handle) out.worldProvider = handle.provider ?? handle.kind;
  }
  return out;
}

/** Conventional gateway port. If it's taken we walk upward (findFreePortFrom),
 *  so the UI URL stays stable across restarts. Override with KARMAX_PORT. */
export const DEFAULT_GATEWAY_PORT = 4505;

const USER_CAPS = ['*'];
const PREVIEW_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const MAX_PREVIEW_REQUEST_BYTES = 16 * 1024 * 1024;
const PREVIEW_REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'content-type', 'if-match', 'if-modified-since',
  'if-none-match', 'if-unmodified-since', 'range', 'user-agent',
]);
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
  userId?: string;
  email?: string;
}

export class Gateway {
  private sessions = new Map<string, Session>();
  private server?: http.Server;
  private safeMode = process.env.KARMAX_SAFE_MODE === '1';
  /** Runs review "run" actions (dev servers, scripts) in the task's world. */
  private reviewActions: ReviewActionRunner;
  private attachments = new AttachmentStore();
  private modelCatalog?: { at: number; value: ModelCatalog };
  private identityTokens = new Map<string, { apiToken: string; fingerprint: string }>();
  private fanout: DurableEventFanout;

  constructor(private deps: GatewayDeps) {
    this.reviewActions = new ReviewActionRunner(deps.worlds, deps.store, deps.runners);
    this.fanout = new DurableEventFanout(deps.store, deps.bus);
  }

  private newSession(user = 'me'): { sid: string; session: Session } {
    // Passwordless/password-only local mode predates Better Auth, but still uses
    // the same tenant invariants as hosted mode. Materialize its stable local
    // principal as owner of the migrated personal organization.
    this.deps.store.claimPersonalOrganization(user, user === 'me' ? undefined : user);
    for (const project of this.deps.store.listProjects().filter((candidate) => candidate.organizationId === 'org_personal')) {
      if (!this.deps.store.userIsProjectMember(project.id, user))
        this.deps.store.setProjectMembership(project.id, { kind: 'user', userId: user }, 'owner');
    }
    const sid = `s_${crypto.randomBytes(18).toString('hex')}`;
    const apiToken = this.deps.tokens.mintPrincipal(`user:${user}`, USER_CAPS).token;
    const session: Session = { user, apiToken };
    this.sessions.set(sid, session);
    return { sid, session };
  }

  async listen(preferredPort = DEFAULT_GATEWAY_PORT): Promise<{ url: string; internalUrl: string; port: number; close: () => Promise<void> }> {
    const port = await findFreePortFrom(preferredPort);
    const bindHost = process.env.KARMAX_HOST?.trim() || '127.0.0.1';
    const server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.fail(res, e)));
    this.server = server;

    // Two WebSocket endpoints, routed by path on upgrade:
    //  /ws          — the live event stream (SPEC §3.3 transport).
    //  /ws/terminal — a PTY against the task's world (cheap check-in, SPEC §5.5).
    const wssEvents = new WebSocketServer({ noServer: true });
    const wssTerm = new WebSocketServer({ noServer: true });
    const wssAction = new WebSocketServer({ noServer: true });
    const wssPreview = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url ?? '/', 'http://localhost');
      const isolatedPreview = Boolean(configuredPreviewOrigin());
      const onPreviewOrigin = isolatedPreview && this.requestIsPreviewOrigin(req);
      if (onPreviewOrigin && pathname.startsWith('/preview/'))
        wssPreview.handleUpgrade(req, socket, head, (ws) => wssPreview.emit('connection', ws, req));
      else if (onPreviewOrigin) socket.destroy();
      else if (pathname === '/ws') wssEvents.handleUpgrade(req, socket, head, (ws) => wssEvents.emit('connection', ws, req));
      else if (pathname === '/ws/terminal') wssTerm.handleUpgrade(req, socket, head, (ws) => wssTerm.emit('connection', ws, req));
      else if (pathname === '/ws/review-action') wssAction.handleUpgrade(req, socket, head, (ws) => wssAction.emit('connection', ws, req));
      else if ((!isolatedPreview && pathname.startsWith('/preview/')) ||
        (!isolatedPreview && /^\/api\/tasks\/[^/]+\/preview\/\d+/.test(pathname)))
        wssPreview.handleUpgrade(req, socket, head, (ws) => wssPreview.emit('connection', ws, req));
      else socket.destroy();
    });
    wssEvents.on('connection', async (ws, req) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const auth = await this.socketAuth(req, url);
      if (!auth) { ws.close(4401, 'unauthorized'); return; }
      const scoped = this.deps.tokens.verify(auth.apiToken);
      const off = this.fanout.on((ev) => {
        const projectId = this.deps.store.getTask(ev.taskId)?.projectId;
        if (scoped?.projectId && projectId !== scoped.projectId) return;
        if (!this.deps.tokens.check(auth.apiToken, 'task:event:read', projectId ? { projectId, taskId: ev.taskId } : undefined).ok) {
          const humanCaps = auth.userId && projectId ? this.deps.authorization?.capabilities(`user:${auth.userId}`, projectId) : [];
          if (!allows(humanCaps ?? [], 'task:event:read')) return;
        }
        try { ws.send(JSON.stringify(toPublicPayload(ev))); } catch { /* ignore */ }
      });
      ws.on('close', off);
      ws.on('error', off);
    });
    wssTerm.on('connection', (ws, req) => {
      ws.on('error', () => {});
      void this.terminal(ws, req).catch(() => { try { ws.close(); } catch {} });
    });
    wssAction.on('connection', (ws, req) => this.reviewActionStream(ws, req));
    wssPreview.on('connection', (ws, req) => {
      ws.on('error', () => {});
      void this.previewWebSocket(ws, req).catch(() => { try { ws.close(1011, 'preview unavailable'); } catch {} });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once('error', onError);
      server.listen(port, bindHost, () => {
        server.off('error', onError);
        // Keep an operational listener after the startup race; errors are exposed
        // by endpoint-specific handling instead of becoming uncaught events.
        server.on('error', () => {});
        resolve();
      });
    });
    const internalUrl = `http://127.0.0.1:${port}`;
    const directHost = bindHost === '0.0.0.0' || bindHost === '::' ? '127.0.0.1' : bindHost;
    const publicUrl = process.env.KARMAX_PUBLIC_URL?.trim().replace(/\/$/, '') || `http://${directHost}:${port}`;
    return {
      url: publicUrl,
      internalUrl,
      port,
      close: () =>
        new Promise<void>((resolve) => {
          this.reviewActions.stopAll();
          this.fanout.close();
          // `WebSocketServer.close()` does not terminate existing upgraded
          // sockets, and `http.Server.close()` waits for them forever. A stale
          // browser/test connection therefore used to wedge shutdown and leave
          // the Temporal worker/runtime installed. Close clients explicitly,
          // then force any remaining HTTP keep-alive sockets to drain.
          for (const wss of [wssEvents, wssTerm, wssAction, wssPreview]) {
            for (const ws of wss.clients) ws.terminate();
          }
          wssEvents.close();
          wssTerm.close();
          wssAction.close();
          wssPreview.close();
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    };
  }

  /** PTY check-in (SPEC §5.5): an ephemeral provider-owned terminal in the task world. */
  private async terminal(ws: import('ws').WebSocket, req: http.IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const taskId = url.searchParams.get('taskId') ?? '';
    const task = this.deps.store.getTask(taskId);
    const auth = await this.socketAuth(req, url, task?.projectId);
    if (!auth) { ws.close(4401, 'unauthorized'); return; }
    if (!this.deps.tokens.check(auth.apiToken, 'task:edit', { projectId: task?.projectId, taskId }).ok) {
      ws.close(4403, 'forbidden'); return;
    }
    const projectRecord = task ? this.deps.store.getProject(task.projectId) : undefined;
    const project = projectRecord ? this.deps.store.effectiveProjectConfig(projectRecord) : undefined;
    const handle = worldHandleForView(task?.lastView, taskId, project);
    if (!handle) {
      ws.send(JSON.stringify({ type: 'data', data: 'No world for this task yet.\r\n' }));
      ws.close();
      return;
    }
    if (!task || !projectRecord?.organizationId) { ws.close(4404, 'task project unavailable'); return; }
    let term: import('../world/types.js').WorldPty;
    let worldLeaseId: string | undefined;
    const executionId = newId('execution');
    try {
      if (this.deps.worlds.get(handle.kind).capabilities?.remote && projectRecord && this.deps.runners) {
        const lease = await this.deps.runners.acquire({ project: projectRecord, taskId, worldId: handle.id, provider: handle.kind });
        worldLeaseId = lease.leaseId;
      }
      this.deps.store.createExecution({ id: executionId, organizationId: projectRecord.organizationId,
        projectId: projectRecord.id, taskId, worldId: handle.id, generation: handle.generation ?? 1,
        kind: 'terminal', label: 'Interactive terminal', command: '$SHELL', server: false,
        openUrls: [], runnerLeaseId: worldLeaseId });
      const world = await this.deps.worlds.open(handle);
      term = await world.openPty({ cols: 80, rows: 24 });
      this.deps.store.setExecutionRunning(executionId);
      this.deps.store.appendExecutionFrame(executionId, 'Terminal opened.\n', 'system');
    } catch (error) {
      if (this.deps.store.execution(executionId)) {
        this.deps.store.appendExecutionFrame(executionId, `${String((error as Error)?.message ?? error)}\n`, 'system');
        this.deps.store.finishExecution(executionId, null, 'failed');
      }
      if (worldLeaseId) this.deps.runners?.release(worldLeaseId, handle.kind);
      ws.send(JSON.stringify({ type: 'data', data: `Terminal unavailable: ${String((error as Error)?.message ?? error)}\r\n` }));
      ws.close();
      return;
    }
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
          kill: () => { try { void term.close(); } catch { /* already gone */ } },
        })
      : () => {};
    let finalized = false;
    let clientClosed = false;
    const heartbeat = setInterval(() => this.deps.store.heartbeatExecution(executionId), 30_000);
    heartbeat.unref();
    const finish = (code: number | null, cancelled = false) => {
      if (finalized) return;
      finalized = true;
      clearInterval(heartbeat);
      untrack();
      this.deps.store.finishExecution(executionId, code, cancelled ? 'cancelled' : undefined);
      if (worldLeaseId) this.deps.runners?.release(worldLeaseId, handle.kind);
    };
    term.onData((d: string) => {
      this.deps.store.appendExecutionFrame(executionId, d);
      try { ws.send(JSON.stringify({ type: 'data', data: d })); } catch {}
    });
    term.onExit((code) => { finish(code, clientClosed); try { ws.close(); } catch {} });
    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'input') term.write(msg.data);
      else if (msg.type === 'resize') term.resize(msg.cols || 80, msg.rows || 24);
    });
    // The provider owns complete teardown (including descendants in a local PTY
    // session, or the remote PTY lease in a cloud sandbox).
    ws.on('close', () => {
      clientClosed = true;
      finish(null, true);
      void term.close();
    });
  }

  /** Stream a running review action's output to the UI. `procId` names a process
   *  the client already started via POST /review-action. We replay the buffered
   *  output first, then push the live tail until it exits or the socket closes. */
  private async reviewActionStream(ws: import('ws').WebSocket, req: http.IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const procId = url.searchParams.get('procId') ?? '';
    const rec = this.reviewActions.status(procId);
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
    const previewOrigin = configuredPreviewOrigin();
    const onPreviewOrigin = Boolean(previewOrigin && this.requestIsPreviewOrigin(req));
    // Repository applications are untrusted. In hosted mode they get an origin
    // that exposes only opaque preview leases, never Karmax API/static routes or
    // the reviewer's authenticated application cookies.
    if (onPreviewOrigin && !p.startsWith('/preview/')) return this.json(res, 404, { error: 'not found' });
    if (previewOrigin && !onPreviewOrigin && p.startsWith('/preview/')) {
      const leaseId = p.match(/^\/preview\/([^/]+)/)?.[1];
      if (!leaseId) return this.json(res, 404, { error: 'not found' });
      res.writeHead(307, { location: `${previewLeaseOrigin(decodeURIComponent(leaseId))}${p}${url.search}`, 'referrer-policy': 'no-referrer' });
      return void res.end();
    }
    if (p.startsWith('/preview/')) return this.serveLeasedPreview(req, res, url);
    // Caddy's on-demand TLS policy asks only for the exact opaque hostname of a
    // live preview lease. This replaces manual wildcard certificates while
    // preventing arbitrary public certificate issuance through the catch-all.
    if (p === '/api/tls/preview-allow' && req.method === 'GET') {
      const domain = (url.searchParams.get('domain') ?? '').trim().toLowerCase();
      res.writeHead(this.deps.store.previewHostnameAllowed(domain) ? 204 : 403,
        { 'cache-control': 'no-store', 'content-length': '0' });
      return void res.end();
    }
    if (p.startsWith('/scim/v2/')) return this.scim(req, res, url);
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
        if (current) return this.json(res, 200, { authRequired: true, authenticated: true, user: current.user,
          sso: this.deps.identity.oidcProviderId ? { providerId: this.deps.identity.oidcProviderId } : null });
        return this.json(res, 200, {
          authRequired: true,
          authenticated: false,
          setupRequired: !this.deps.identity.hasUsers(),
          signupAvailable: this.deps.identity.hasUsers(),
          sso: this.deps.identity.oidcProviderId ? { providerId: this.deps.identity.oidcProviderId } : null,
        });
      }
      const authRequired = !!this.deps.password;
      if (!authRequired) {
        const { sid } = this.newSession();
        return this.json(res, 200, { authRequired: false, token: sid, user: 'me' });
      }
      return this.json(res, 200, { authRequired: true });
    }
    if (p.startsWith('/api/auth/') && this.deps.identity) {
      const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
      const origin = process.env.KARMAX_PUBLIC_URL || `${forwardedProto || 'http'}://${req.headers.host || 'localhost'}`;
      const body = method === 'GET' || method === 'HEAD' ? undefined : await this.rawBody(req, 2 * 1024 * 1024);
      const response = await this.deps.identity.auth.handler(new Request(new URL(`${p}${url.search}`, origin), {
        method, headers: requestHeaders(req.headers), ...(body ? { body } : {}),
      }));
      return this.sendWebResponse(res, response);
    }
    if (p === '/api/sso/start' && method === 'POST' && this.deps.identity) {
      try {
        const b = await this.body(req);
        return this.sendWebResponse(res, await this.deps.identity.beginSso(String(b.callbackURL ?? '/'), requestHeaders(req.headers)));
      } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    if (p === '/api/github/webhook' && method === 'POST' && this.deps.githubApp) {
      try {
        const raw = await this.rawBody(req, 2 * 1024 * 1024);
        const result = await this.deps.githubApp.handleWebhook(
          String(req.headers['x-github-event'] ?? ''), String(req.headers['x-github-delivery'] ?? ''), raw,
          typeof req.headers['x-hub-signature-256'] === 'string' ? req.headers['x-hub-signature-256'] : undefined,
        );
        return this.json(res, 200, result);
      } catch (error) {
        return this.json(res, 401, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const githubManifestCallback = p.match(/^\/api\/github\/manifest\/callback(?:\/([^/]+))?$/);
    if (githubManifestCallback && method === 'GET' && this.deps.githubApp && this.deps.identity) {
      const code = url.searchParams.get('code') ?? '';
      // Query-form state remains accepted for setup links created by the prior
      // release; new manifests use the validator-safe path form.
      const state = githubManifestCallback[1] ? decodeURIComponent(githubManifestCallback[1]) : url.searchParams.get('state') ?? '';
      const identity = await this.deps.identity.session(requestHeaders(req.headers));
      if (!identity || !code || !state) return this.githubCallbackPage(res, 400, 'The GitHub App setup callback is incomplete.');
      const pending = this.deps.store.consumeGithubInstallState(state, identity.user.id);
      if (!pending) return this.githubCallbackPage(res, 400, 'This GitHub App setup link is invalid, expired, or belongs to another user.');
      try {
        await this.deps.githubApp.convertManifest(code);
        const installState = this.deps.store.createGithubInstallState(pending.organizationId, identity.user.id);
        res.writeHead(303, { location: this.deps.githubApp.installationUrl(installState) });
        return void res.end();
      } catch (error) {
        return this.githubCallbackPage(res, 502, `GitHub App setup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (p === '/api/github/oauth/callback' && method === 'GET' && this.deps.githubApp && this.deps.identity) {
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const identity = await this.deps.identity.session(requestHeaders(req.headers));
      if (!identity || !code || !state) return this.githubCallbackPage(res, 400, 'The GitHub authorization callback is incomplete.');
      const pending = this.deps.store.consumeGithubInstallState(state, identity.user.id);
      if (!pending) return this.githubCallbackPage(res, 400, 'This GitHub authorization link is invalid, expired, or belongs to another user.');
      try {
        await this.deps.githubApp.authorizeUser(identity.user.id, code, this.githubPublicUrl(req));
        res.writeHead(303, { location: `/organization?github=ready&organizationId=${encodeURIComponent(pending.organizationId)}` });
        return void res.end();
      } catch (error) {
        return this.githubCallbackPage(res, 502, `GitHub authorization failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (p === '/api/github/callback' && method === 'GET' && this.deps.githubApp && this.deps.identity) {
      const installationId = url.searchParams.get('installation_id') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const identity = await this.deps.identity.session(requestHeaders(req.headers));
      if (!identity || !installationId || !state) return this.githubCallbackPage(res, 400, 'The GitHub installation callback is incomplete.');
      const pending = this.deps.store.consumeGithubInstallState(state, identity.user.id);
      if (!pending) return this.githubCallbackPage(res, 400, 'This GitHub installation link is invalid, expired, or belongs to another user.');
      try {
        await this.deps.githubApp.connectInstallation(pending.organizationId, installationId);
        const status = this.deps.githubApp.status(identity.user.id);
        if (status.oauthConfigured && !status.userAuthorized) {
          const oauthState = this.deps.store.createGithubInstallState(pending.organizationId, identity.user.id);
          const publicUrl = this.githubPublicUrl(req);
          res.writeHead(303, { location: this.deps.githubApp.userAuthorizationUrl(oauthState, publicUrl) });
          return void res.end();
        }
        res.writeHead(303, { location: `/organization?github=connected&organizationId=${encodeURIComponent(pending.organizationId)}` });
        return void res.end();
      } catch (error) {
        return this.githubCallbackPage(res, 502, `GitHub could not be connected: ${error instanceof Error ? error.message : String(error)}`);
      }
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
        this.deps.store.claimPersonalOrganization(user.id, user.name);
        for (const project of this.deps.store.listProjects().filter((candidate) => candidate.organizationId === 'org_personal')) {
          this.deps.store.setProjectMembership(project.id, { kind: 'user', userId: user.id }, 'owner');
        }
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
        cellId: this.deps.cellId ?? 'local',
        hosted: this.deps.hosted ?? false,
        worldProviders: this.deps.worlds.catalog(),
        sso: this.deps.identity?.oidcProviderId ? { providerId: this.deps.identity.oidcProviderId } : null,
      });
    }
    if (p === '/api/health/live' && method === 'GET') return this.json(res, 200, { ok: true, ts: Date.now() });
    if (p === '/api/health/ready' && method === 'GET') {
      try {
        this.deps.store.db.prepare('SELECT 1').get();
        await withTimeout(this.deps.client.workflowService.getSystemInfo({}), 2_000);
        return this.json(res, 200, { ok: true, database: 'ready', temporal: 'ready', ts: Date.now() });
      } catch {
        return this.json(res, 503, { ok: false, ts: Date.now() });
      }
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
    const session = await this.auth(req, requestedScope.projectId, requestedScope.organizationId);
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
      const organizationCollectionAllowed = !checked.ok && p === '/api/organizations' && !!session.userId && (
        method === 'POST' || this.deps.store.listOrganizations(session.userId).some((organization) =>
          allows(this.deps.authorization?.capabilities(`user:${session.userId}`, undefined, organization.id) ?? [], required))
      );
      if (!checked.ok && !collectionAllowed && !organizationCollectionAllowed) return this.json(res, 403, { error: checked.reason ?? `missing capability ${required}` });
      if (checked.ok) authRecord = checked.record;
      const principal = checked.record?.principal ?? (session.userId ? `user:${session.userId}` : session.user);
      this.deps.authorization?.audit(principal, `http.${method.toLowerCase()}.${required}`,
        scope.projectId ? `project:${scope.projectId}` : scope.organizationId ? `organization:${scope.organizationId}` : 'global', { path: p });
    }

    try {
      if (p === '/api/logout' && method === 'POST') {
        const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
        if (bearer) this.sessions.delete(bearer);
        if (this.deps.identity) return this.sendWebResponse(res, await this.deps.identity.signOut(requestHeaders(req.headers)));
        return this.json(res, 200, { ok: true });
      }
      if (p === '/api/platform' && method === 'GET') return this.json(res, 200, PLATFORM_API_CATALOG);

      // Organization is the hosted tenant boundary. Collection discovery is
      // filtered by membership; every nested request was minted an
      // organization-scoped token above, so identifiers cannot cross tenants.
      if (p === '/api/organizations' && method === 'GET') {
        const canAuditAll = Boolean(authRecord && allows(authRecord.caps, 'authorization:read'));
        return this.json(res, 200, canAuditAll ? store.listOrganizations() : store.listOrganizations(session.userId));
      }
      if (p === '/api/organizations' && method === 'POST') {
        if (!session.userId) return this.json(res, 400, { error: 'a human account is required' });
        const b = await this.body(req);
        const organization = store.createOrganization({ name: String(b.name ?? 'My organization'),
          slug: b.slug ? String(b.slug) : undefined, kind: b.kind === 'personal' ? 'personal' : 'team', ownerUserId: session.userId });
        this.deps.authorization?.bootstrapOrganizationOwner(`user:${session.userId}`, session.userId, organization.id);
        return this.json(res, 200, organization);
      }
      if (p === '/api/invitations/accept' && method === 'POST') {
        if (!session.userId || !session.email) return this.json(res, 400, { error: 'a verified account is required' });
        const b = await this.body(req);
        const membership = store.acceptOrganizationInvitation(String(b.token ?? ''), session.userId, session.email);
        this.deps.authorization?.grant(`user:${session.userId}`, {
          principalId: `user:${session.userId}`, scopeKey: `organization:${membership.organizationId}`,
          profileId: 'developer', capabilities: ['organization:read', 'organization:member:read', 'team:read', 'repository:read', 'inbox:*'],
        });
        return this.json(res, 200, membership);
      }

      const organizationMatch = p.match(/^\/api\/organizations\/([^/]+)$/);
      if (organizationMatch && method === 'GET') return this.json(res, 200, store.getOrganization(organizationMatch[1]!) ?? null);
      const organizationExecution = p.match(/^\/api\/organizations\/([^/]+)\/execution-policy$/);
      if (organizationExecution) {
        const organizationId = organizationExecution[1]!;
        if (method === 'GET') return this.json(res, 200, store.getOrganizationExecutionPolicy(organizationId));
        if (method === 'PUT') {
          const b = await this.body(req);
          const policy = b.policy && typeof b.policy === 'object' ? b.policy : {};
          try {
            if (policy.worldProvider && !['worktree', 'container', 'memory'].includes(String(policy.worldProvider))
              && !this.deps.providerConnections?.available(organizationId, String(policy.worldProvider)))
              throw new Error(`${policy.worldProvider} is not connected and verified`);
            if (policy.runnerPoolId) {
              const pool = store.getRunnerPool(String(policy.runnerPoolId));
              if (!pool || pool.organizationId !== organizationId) throw new Error('runner pool does not belong to this organization');
              if (policy.worldProvider && pool.provider !== policy.worldProvider) throw new Error('runner pool provider must match the default provider');
            }
            return this.json(res, 200, store.setOrganizationExecutionPolicy(organizationId, policy));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
      }
      const organizationExport = p.match(/^\/api\/organizations\/([^/]+)\/export$/);
      if (organizationExport && method === 'GET') {
        const value = store.exportOrganization(organizationExport[1]!);
        res.setHeader('Content-Disposition', `attachment; filename="karmax-${organizationExport[1]!}-export.json"`);
        return this.json(res, 200, value);
      }
      if (organizationMatch && method === 'DELETE') {
        const organizationId = organizationMatch[1]!;
        const organization = store.getOrganization(organizationId);
        if (!organization) return this.json(res, 404, { error: 'organization not found' });
        if (organization.kind === 'personal' || organization.id === 'org_personal')
          return this.json(res, 400, { error: 'the installation personal organization cannot be deleted' });
        const b = await this.body(req);
        if (String(b.confirmSlug ?? '') !== organization.slug)
          return this.json(res, 400, { error: `type the organization slug (${organization.slug}) to confirm deletion` });

        // External resources go first. These operations are idempotent, so an
        // outage never commits a deceptively successful partial deletion.
        const resources = store.organizationResources(organizationId);
        const projects = store.listProjects().filter((project) => project.organizationId === organizationId);
        for (const project of projects) await this.removeProjectExternalResources(project.id, 'organization deleted');
        await this.deps.githubApp?.disconnectOrganization(organizationId);
        for (const connection of this.deps.providerConnections?.list(organizationId) ?? [])
          this.deps.providerConnections?.delete(organizationId, connection.provider);
        store.deleteOrganization(organizationId);
        for (const attachmentId of resources.attachmentIds)
          if (!store.attachmentIsScoped(attachmentId)) this.attachments.delete(attachmentId);
        return this.json(res, 200, { deleted: true, organizationId });
      }
      const identityPolicy = p.match(/^\/api\/organizations\/([^/]+)\/identity-policy$/);
      if (identityPolicy) {
        if (method === 'GET') return this.json(res, 200, store.getOrganizationIdentityPolicy(identityPolicy[1]!));
        if (method === 'PUT') {
          const b = await this.body(req);
          return this.json(res, 200, store.setOrganizationIdentityPolicy({ organizationId: identityPolicy[1]!,
            oidcProviderId: b.oidcProviderId ? String(b.oidcProviderId) : undefined,
            verifiedDomains: Array.isArray(b.verifiedDomains) ? b.verifiedDomains.map(String) : [], enforceSso: Boolean(b.enforceSso) }));
        }
      }
      const scimToken = p.match(/^\/api\/organizations\/([^/]+)\/scim-token$/);
      if (scimToken && method === 'POST') return this.json(res, 200, store.rotateScimToken(scimToken[1]!));
      const organizationMembers = p.match(/^\/api\/organizations\/([^/]+)\/members$/);
      if (organizationMembers) {
        const organizationId = organizationMembers[1]!;
        if (method === 'GET') {
          const users = new Map((this.deps.identity?.listUsers() ?? []).map((user) => [user.id, user]));
          return this.json(res, 200, store.listOrganizationMemberships(organizationId).map((membership) => {
            const user = users.get(membership.userId);
            return { ...membership, ...(user ? { user: { id: user.id, name: user.name, email: user.email } } : {}) };
          }));
        }
        if (method === 'POST') {
          const b = await this.body(req);
          const role = ['owner', 'admin'].includes(String(b.role)) ? String(b.role) as 'owner' | 'admin' : 'member';
          const membership = store.setOrganizationMembership(organizationId, String(b.userId), role);
          this.deps.authorization?.grant(`user:${session.userId}`, {
            principalId: `user:${membership.userId}`, scopeKey: `organization:${organizationId}`,
            profileId: role === 'owner' || role === 'admin' ? 'administrator' : 'developer',
            ...(role === 'member' ? { capabilities: ['organization:read', 'organization:member:read', 'team:read', 'repository:read', 'inbox:*'] } : {}),
          });
          return this.json(res, 200, membership);
        }
      }
      const organizationMember = p.match(/^\/api\/organizations\/([^/]+)\/members\/([^/]+)$/);
      if (organizationMember && method === 'DELETE') {
        store.deprovisionOrganizationUser(organizationMember[1]!, organizationMember[2]!);
        this.deps.authorization?.revoke(`user:${session.userId}`, `user:${organizationMember[2]!}`, `organization:${organizationMember[1]!}`);
        return this.json(res, 200, { ok: true });
      }
      const invitations = p.match(/^\/api\/organizations\/([^/]+)\/invitations$/);
      if (invitations) {
        const organizationId = invitations[1]!;
        if (method === 'GET') return this.json(res, 200, store.listOrganizationInvitations(organizationId));
        if (method === 'POST') {
          const b = await this.body(req);
          return this.json(res, 200, store.createOrganizationInvitation({ organizationId, email: String(b.email ?? ''),
            role: ['owner', 'admin'].includes(String(b.role)) ? b.role : 'member', invitedBy: `user:${session.userId}` }));
        }
      }
      const organizationTeams = p.match(/^\/api\/organizations\/([^/]+)\/teams$/);
      if (organizationTeams) {
        const organizationId = organizationTeams[1]!;
        if (method === 'GET') return this.json(res, 200, store.listTeams(organizationId, url.searchParams.get('projectId') ?? undefined));
        if (method === 'POST') {
          const b = await this.body(req);
          return this.json(res, 200, store.createTeam({ organizationId, name: String(b.name ?? ''),
            projectId: b.projectId ? String(b.projectId) : undefined, slug: b.slug ? String(b.slug) : undefined }));
        }
      }
      const organizationTeam = p.match(/^\/api\/organizations\/([^/]+)\/teams\/([^/]+)$/);
      if (organizationTeam) {
        const team = store.getTeam(organizationTeam[2]!);
        if (!team || team.organizationId !== organizationTeam[1]) return this.json(res, 404, { error: 'team not found' });
        try {
          if (method === 'PATCH') {
            const b = await this.body(req);
            return this.json(res, 200, store.updateTeam(team.id, { name: String(b.name ?? '') }));
          }
          if (method === 'DELETE') {
            store.deleteTeam(team.id);
            return this.json(res, 200, { ok: true });
          }
        } catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const teamMembers = p.match(/^\/api\/organizations\/([^/]+)\/teams\/([^/]+)\/members$/);
      if (teamMembers) {
        if (store.getTeam(teamMembers[2]!)?.organizationId !== teamMembers[1]) return this.json(res, 404, { error: 'team not found' });
        if (method === 'GET') {
          const users = new Map((this.deps.identity?.listUsers() ?? []).map((user) => [user.id, user]));
          return this.json(res, 200, store.listTeamMemberships(teamMembers[2]!).map((membership) => {
            const user = users.get(membership.userId);
            return { ...membership, ...(user ? { user: { id: user.id, name: user.name, email: user.email } } : {}) };
          }));
        }
        if (method === 'POST') {
          const b = await this.body(req);
          return this.json(res, 200, store.setTeamMembership(teamMembers[2]!, String(b.userId)));
        }
      }
      const teamMember = p.match(/^\/api\/organizations\/([^/]+)\/teams\/([^/]+)\/members\/([^/]+)$/);
      if (teamMember && method === 'DELETE') {
        if (store.getTeam(teamMember[2]!)?.organizationId !== teamMember[1]) return this.json(res, 404, { error: 'team not found' });
        store.removeTeamMembership(teamMember[2]!, teamMember[3]!);
        return this.json(res, 200, { ok: true });
      }
      const gitConnections = p.match(/^\/api\/organizations\/([^/]+)\/git-connections$/);
      if (gitConnections) {
        const organizationId = gitConnections[1]!;
        if (method === 'GET') return this.json(res, 200, store.listGitConnections(organizationId));
        if (method === 'POST') {
          const b = await this.body(req);
          if (!this.deps.githubApp) return this.json(res, 503, { error: 'GitHub App is not configured' });
          return this.json(res, 200, await this.deps.githubApp.connectInstallation(organizationId, String(b.installationId ?? '')));
        }
      }
      const githubAppSetup = p.match(/^\/api\/organizations\/([^/]+)\/github\/app$/);
      if (githubAppSetup) {
        if (!this.deps.githubApp) return this.json(res, 503, { error: 'GitHub integration is unavailable' });
        if (method === 'GET') return this.json(res, 200, this.deps.githubApp.status(session.userId));
        if (method === 'PUT') {
          if (!this.deps.tokens.check(token, 'user:write').ok)
            return this.json(res, 403, { error: 'Only a Karmax installation administrator can configure the shared GitHub App' });
          const b = await this.body(req);
          try {
            return this.json(res, 200, this.deps.githubApp.configure({ appId: b.appId, appSlug: String(b.appSlug ?? ''),
              privateKey: String(b.privateKey ?? '').replace(/\\n/g, '\n'), webhookSecret: b.webhookSecret ? String(b.webhookSecret) : undefined,
              clientId: b.clientId ? String(b.clientId) : undefined, clientSecret: b.clientSecret ? String(b.clientSecret) : undefined }));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
      }
      const githubManifest = p.match(/^\/api\/organizations\/([^/]+)\/github\/app-manifest$/);
      if (githubManifest && method === 'POST') {
        if (!session.userId) return this.json(res, 400, { error: 'a human account is required' });
        if (!this.deps.githubApp) return this.json(res, 503, { error: 'GitHub integration is unavailable' });
        if (!this.deps.tokens.check(token, 'user:write').ok)
          return this.json(res, 403, { error: 'Only a Karmax installation administrator can create the shared GitHub App' });
        if (this.deps.githubApp.configured()) return this.json(res, 409, { error: 'a GitHub App is already configured' });
        const b = await this.body(req);
        const state = store.createGithubInstallState(githubManifest[1]!, session.userId);
        try {
          const publicUrl = this.githubPublicUrl(req, b.publicUrl);
          return this.json(res, 200, this.deps.githubApp.manifest(publicUrl, state));
        }
        catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const githubAuthorize = p.match(/^\/api\/organizations\/([^/]+)\/github\/authorize$/);
      if (githubAuthorize && method === 'POST') {
        if (!session.userId) return this.json(res, 400, { error: 'a human account is required' });
        if (!this.deps.githubApp) return this.json(res, 503, { error: 'GitHub integration is unavailable' });
        const state = store.createGithubInstallState(githubAuthorize[1]!, session.userId);
        try { return this.json(res, 200, { url: this.deps.githubApp.userAuthorizationUrl(state, this.githubPublicUrl(req)) }); }
        catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const githubInstallUrl = p.match(/^\/api\/organizations\/([^/]+)\/github\/install-url$/);
      if (githubInstallUrl && method === 'POST') {
        if (!session.userId) return this.json(res, 400, { error: 'a human account is required' });
        if (!this.deps.githubApp?.configured()) return this.json(res, 503, { error: 'Set up the GitHub App first' });
        const state = store.createGithubInstallState(githubInstallUrl[1]!, session.userId);
        return this.json(res, 200, { url: this.deps.githubApp.installationUrl(state) });
      }
      const githubRefresh = p.match(/^\/api\/organizations\/([^/]+)\/github\/refresh$/);
      if (githubRefresh && method === 'POST') {
        if (!this.deps.githubApp?.configured()) return this.json(res, 503, { error: 'Set up and install the GitHub App first' });
        try {
          const repositories: import('../domain/types.js').Repository[] = [];
          for (const connection of store.listGitConnections(githubRefresh[1]!))
            repositories.push(...await this.deps.githubApp.reconcile(connection));
          return this.json(res, 200, { repositories, count: repositories.length });
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const organizationRepositories = p.match(/^\/api\/organizations\/([^/]+)\/repositories$/);
      if (organizationRepositories) {
        const organizationId = organizationRepositories[1]!;
        if (method === 'GET') return this.json(res, 200, store.listRepositories(organizationId));
        if (method === 'POST') {
          if (this.deps.hosted) return this.json(res, 400, { error: 'Hosted repositories must be imported through the GitHub App' });
          const b = await this.body(req);
          return this.json(res, 200, store.upsertRepository({ organizationId, provider: 'github',
            providerId: b.providerId ? String(b.providerId) : undefined, owner: String(b.owner ?? ''), name: String(b.name ?? ''),
            sshUrl: String(b.sshUrl ?? ''), defaultBranch: String(b.defaultBranch ?? 'main'), private: b.private !== false,
            gitConnectionId: b.gitConnectionId ? String(b.gitConnectionId) : undefined }));
        }
      }
      const createOrganizationRepository = p.match(/^\/api\/organizations\/([^/]+)\/repositories\/create$/);
      if (createOrganizationRepository && method === 'POST') {
        if (!session.userId) return this.json(res, 400, { error: 'a human account is required' });
        if (!this.deps.githubApp?.configured()) return this.json(res, 503, { error: 'Set up and install the GitHub App first' });
        const b = await this.body(req);
        const connection = store.getGitConnection(String(b.gitConnectionId ?? ''));
        if (!connection || connection.organizationId !== createOrganizationRepository[1])
          return this.json(res, 404, { error: 'GitHub connection not found in this organization' });
        try {
          return this.json(res, 200, await this.deps.githubApp.createRepository(connection.id, session.userId,
            { name: String(b.name ?? ''), description: b.description ? String(b.description) : undefined, private: b.private !== false }));
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const organizationProjects = p.match(/^\/api\/organizations\/([^/]+)\/projects$/);
      if (organizationProjects) {
        const organizationId = organizationProjects[1]!;
        if (method === 'GET') return this.json(res, 200, store.listProjects().filter((project) => project.organizationId === organizationId));
        if (method === 'POST') {
          const b = await this.body(req);
          const project = store.createProject(String(b.name ?? 'New project'), normalizeConfig(b.config), organizationId);
          if (session.userId) store.setProjectMembership(project.id, { kind: 'user', userId: session.userId }, 'owner');
          return this.json(res, 200, project);
        }
      }
      const runnerPools = p.match(/^\/api\/organizations\/([^/]+)\/runner-pools$/);
      if (runnerPools) {
        const organizationId = runnerPools[1]!;
        if (method === 'GET') return this.json(res, 200, store.listRunnerPools(organizationId));
        if (method === 'POST') {
          const b = await this.body(req);
          return this.json(res, 200, store.createRunnerPool({ organizationId, name: String(b.name ?? 'Runner pool'),
            provider: String(b.provider ?? 'e2b'), region: b.region ? String(b.region) : undefined,
            mode: b.mode === 'customer' ? 'customer' : 'managed', enabled: b.enabled !== false,
            capacity: { activeWorlds: Math.max(1, Number(b.capacity?.activeWorlds ?? 20)),
              cpu: Math.max(1, Number(b.capacity?.cpu ?? 40)), memoryMb: Math.max(128, Number(b.capacity?.memoryMb ?? 81920)),
              gpu: Math.max(0, Number(b.capacity?.gpu ?? 0)) } }));
        }
      }
      const runnerPool = p.match(/^\/api\/organizations\/([^/]+)\/runner-pools\/([^/]+)$/);
      if (runnerPool) {
        const current = store.getRunnerPool(runnerPool[2]!);
        if (!current || current.organizationId !== runnerPool[1]) return this.json(res, 404, { error: 'runner pool not found' });
        if (method === 'PATCH') {
          const b = await this.body(req);
          try {
            return this.json(res, 200, store.createRunnerPool({ ...current,
              name: b.name == null ? current.name : String(b.name),
              region: b.region === null ? undefined : b.region == null ? current.region : String(b.region),
              enabled: b.enabled == null ? current.enabled : Boolean(b.enabled),
              capacity: b.capacity && typeof b.capacity === 'object' ? {
                activeWorlds: Math.max(1, Number(b.capacity.activeWorlds ?? current.capacity.activeWorlds)),
                cpu: Math.max(1, Number(b.capacity.cpu ?? current.capacity.cpu)),
                memoryMb: Math.max(128, Number(b.capacity.memoryMb ?? current.capacity.memoryMb)),
                gpu: Math.max(0, Number(b.capacity.gpu ?? current.capacity.gpu)),
              } : current.capacity }));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
        if (method === 'DELETE') {
          try { return this.json(res, 200, { deleted: Boolean(store.deleteRunnerPool(current.id)) }); }
          catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
        }
      }
      const worldProviders = p.match(/^\/api\/organizations\/([^/]+)\/world-providers$/);
      if (worldProviders && method === 'GET') {
        return this.json(res, 200, this.deps.providerConnections?.list(worldProviders[1]!) ?? []);
      }
      const worldProvider = p.match(/^\/api\/organizations\/([^/]+)\/world-providers\/([^/]+)$/);
      if (worldProvider) {
        const organizationId = worldProvider[1]!;
        const provider = worldProvider[2]!;
        if (!this.deps.providerConnections) return this.json(res, 503, { error: 'provider connections are unavailable' });
        if (method === 'PUT') {
          const b = await this.body(req);
          try {
            return this.json(res, 200, this.deps.providerConnections.save({ organizationId, provider,
              apiKey: b.apiKey ? String(b.apiKey) : undefined, name: b.name ? String(b.name) : undefined,
              config: b.config && typeof b.config === 'object' ? b.config as any : {}, enabled: b.enabled !== false }));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
        if (method === 'DELETE') {
          const active = store.organizationResources(organizationId).worlds
            .filter((handle) => (handle.provider ?? handle.kind) === provider);
          if (active.length) return this.json(res, 409, { error: `${active.length} task world(s) still use ${provider}; finish or delete them first` });
          return this.json(res, 200, { deleted: Boolean(this.deps.providerConnections.delete(organizationId, provider)) });
        }
      }
      const testWorldProvider = p.match(/^\/api\/organizations\/([^/]+)\/world-providers\/([^/]+)\/test$/);
      if (testWorldProvider && method === 'POST') {
        if (!this.deps.providerConnections) return this.json(res, 503, { error: 'provider connections are unavailable' });
        try { return this.json(res, 200, await this.deps.providerConnections.test(testWorldProvider[1]!, testWorldProvider[2]!)); }
        catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const usage = p.match(/^\/api\/organizations\/([^/]+)\/usage$/);
      if (usage && method === 'GET') return this.json(res, 200, store.usageSummary(usage[1]!,
        Number(url.searchParams.get('from') ?? 0), Number(url.searchParams.get('to') ?? Date.now())));

      if (p === '/api/inbox' && method === 'GET') {
        if (!session.userId || !requestedScope.organizationId) return this.json(res, 400, { error: 'organizationId is required' });
        const items = store.listInbox(session.userId, requestedScope.organizationId,
          { unreadOnly: url.searchParams.get('unread') === '1', limit: Number(url.searchParams.get('limit') ?? 200) });
        return this.json(res, 200, items.map((item) => {
          const task = store.getTask(item.taskId);
          return { ...item, task: task ? { id: task.id, num: task.num, title: task.title, projectId: task.projectId } : undefined };
        }));
      }
      const inboxItem = p.match(/^\/api\/inbox\/([^/]+)$/);
      if (inboxItem && method === 'PATCH') {
        if (!session.userId) return this.json(res, 400, { error: 'a human account is required' });
        const b = await this.body(req);
        return this.json(res, 200, store.markInbox(session.userId, inboxItem[1]!, b.unread !== false) ?? null);
      }
      if (p === '/api/inbox/preferences') {
        if (!session.userId || !requestedScope.organizationId) return this.json(res, 400, { error: 'organizationId is required' });
        if (method === 'GET') return this.json(res, 200, store.getDeliveryPreferences(session.userId, requestedScope.organizationId));
        if (method === 'PUT') {
          const b = await this.body(req);
          return this.json(res, 200, store.setDeliveryPreferences({ userId: session.userId, organizationId: requestedScope.organizationId,
            browser: b.browser !== false, email: Boolean(b.email), slack: Boolean(b.slack), routine: b.routine !== false }));
        }
      }

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
          controlPlane: store.operationalSnapshot(),
          providers: this.deps.worlds.catalog(),
          ts: Date.now(),
        });
      }
      if (p === '/api/metrics' && method === 'GET') {
        const value = prometheusMetrics(store.operationalSnapshot());
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8',
          'content-length': String(Buffer.byteLength(value)), 'cache-control': 'no-store' });
        return void res.end(value);
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
        if (this.deps.hosted)
          return this.json(res, 400, { error: 'hosted projects must be created inside an organization' });
        const b = await this.body(req);
        return this.json(res, 200, store.createProject(b.name ?? 'New project', normalizeConfig(b.config, true)));
      }
      const projMatch = p.match(/^\/api\/projects\/([^/]+)$/);
      if (projMatch) {
        const id = projMatch[1]!;
        if (method === 'GET') return this.json(res, 200, store.getProject(id) ?? null);
        if (method === 'PATCH') {
          const b = await this.body(req);
          try {
            const config = normalizeConfig(b.config);
            const project = store.getProject(id);
            if (config.worldProvider && !['worktree', 'container', 'memory'].includes(config.worldProvider) && project?.organizationId &&
                !this.deps.providerConnections?.available(project.organizationId, config.worldProvider)) {
              throw new Error(`${config.worldProvider} is not connected. Connect and verify it in Organization settings first.`);
            }
            if (config.runnerPoolId) {
              const pool = store.getRunnerPool(config.runnerPoolId);
              if (!pool || pool.organizationId !== project?.organizationId) throw new Error('runner pool does not belong to this project organization');
              if (config.worldProvider && pool.provider !== config.worldProvider) throw new Error('runner pool provider must match the execution provider');
            }
            return this.json(res, 200, store.updateProjectConfig(id, config));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
        if (method === 'DELETE') {
          if (!store.getProject(id)) return this.json(res, 404, { error: 'project not found' });
          const resources = await this.removeProjectExternalResources(id, 'project deleted');
          store.deleteProject(id);
          for (const attachmentId of resources.attachmentIds)
            if (!store.attachmentIsScoped(attachmentId)) this.attachments.delete(attachmentId);
          return this.json(res, 200, { deleted: true, projectId: id });
        }
      }
      const projectExecution = p.match(/^\/api\/projects\/([^/]+)\/execution-policy$/);
      if (projectExecution) {
        const project = store.getProject(projectExecution[1]!);
        if (!project) return this.json(res, 404, { error: 'no project' });
        if (method === 'GET') return this.json(res, 200, {
          override: pickExecutionConfig(project.config),
          organization: store.getOrganizationExecutionPolicy(project.organizationId!),
          effective: pickExecutionConfig(store.effectiveProjectConfig(project)),
        });
        if (method === 'PUT') {
          const b = await this.body(req);
          const override = b.override && typeof b.override === 'object' ? b.override : {};
          try {
            const candidate = { ...project, config: applyExecutionOverride(project.config, override) };
            const effective = store.effectiveProjectConfig(candidate);
            if (effective.worldProvider && !['worktree', 'container', 'memory'].includes(effective.worldProvider)
              && !this.deps.providerConnections?.available(project.organizationId!, effective.worldProvider))
              throw new Error(`${effective.worldProvider} is not connected and verified in Organization settings`);
            if (effective.runnerPoolId) {
              const pool = store.getRunnerPool(effective.runnerPoolId);
              if (!pool || pool.organizationId !== project.organizationId) throw new Error('runner pool does not belong to this organization');
              if (pool.provider !== effective.worldProvider) throw new Error('runner pool provider must match the execution provider');
            }
            const saved = store.setProjectExecutionPolicy(project.id, override);
            return this.json(res, 200, { override: pickExecutionConfig(saved.config), organization: store.getOrganizationExecutionPolicy(project.organizationId!), effective: pickExecutionConfig(effective) });
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
      }
      const projectMembers = p.match(/^\/api\/projects\/([^/]+)\/members$/);
      if (projectMembers) {
        const projectId = projectMembers[1]!;
        if (method === 'GET') return this.json(res, 200, store.listProjectMemberships(projectId));
        if (method === 'POST') {
          const b = await this.body(req);
          const principal = principalFromBody(b.principal);
          const role = ['owner', 'admin', 'reviewer'].includes(String(b.role)) ? String(b.role) : 'member';
          const membership = store.setProjectMembership(projectId, principal, role);
          if (principal.kind === 'user') {
            const profileId = role === 'owner' || role === 'admin' ? 'maintainer' : 'developer';
            this.deps.authorization?.grant(`user:${session.userId}`, { principalId: `user:${principal.userId}`,
              scopeKey: `project:${projectId}`, profileId,
              ...(role === 'reviewer' ? { capabilities: ['project:read', 'task:read', 'task:event:read', 'task:signal', 'task:review:execute', 'inbox:*'] } : {}) });
          }
          return this.json(res, 200, membership);
        }
      }
      const projectMember = p.match(/^\/api\/projects\/([^/]+)\/members\/(user|team)\/([^/]+)$/);
      if (projectMember && method === 'DELETE') {
        const principal = projectMember[2] === 'user'
          ? { kind: 'user' as const, userId: projectMember[3]! }
          : { kind: 'team' as const, teamId: projectMember[3]! };
        store.removeProjectMembership(projectMember[1]!, principal);
        if (principal.kind === 'user') this.deps.authorization?.revoke(`user:${session.userId}`,
          `user:${principal.userId}`, `project:${projectMember[1]!}`);
        return this.json(res, 200, { ok: true });
      }
      const projectRepositories = p.match(/^\/api\/projects\/([^/]+)\/repositories$/);
      if (projectRepositories) {
        const projectId = projectRepositories[1]!;
        if (method === 'GET') return this.json(res, 200, store.listProjectRepositories(projectId));
        if (method === 'POST') {
          const b = await this.body(req);
          return this.json(res, 200, store.attachProjectRepository({ projectId, repositoryId: String(b.repositoryId),
            baseBranch: b.baseBranch ? String(b.baseBranch) : undefined,
            targetBranch: b.targetBranch ? String(b.targetBranch) : undefined,
            order: Number.isFinite(Number(b.order)) ? Number(b.order) : undefined }));
        }
      }
      const projectRepositorySources = p.match(/^\/api\/projects\/([^/]+)\/repository-sources$/);
      if (projectRepositorySources) {
        const project = store.getProject(projectRepositorySources[1]!);
        if (!project) return this.json(res, 404, { error: 'project not found' });
        if (method === 'GET') return this.json(res, 200, { repos: project.config.repos ?? [] });
        if (method === 'PUT') {
          if (this.deps.hosted) return this.json(res, 400, { error: 'hosted projects use attached GitHub repositories' });
          const b = await this.body(req);
          try { return this.json(res, 200, store.setProjectRepositorySources(project.id,
            Array.isArray(b.repos) ? b.repos.map(String) : [])); }
          catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
      }
      const projectRepository = p.match(/^\/api\/projects\/([^/]+)\/repositories\/([^/]+)$/);
      if (projectRepository && method === 'DELETE') {
        store.detachProjectRepository(projectRepository[1]!, projectRepository[2]!);
        return this.json(res, 200, { ok: true });
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
      const responsibilityMatch = p.match(/^\/api\/tasks\/([^/]+)\/responsibility$/);
      if (responsibilityMatch) {
        if (method === 'GET') {
          const task = store.getTask(responsibilityMatch[1]!);
          return this.json(res, 200, task ? { createdBy: task.createdBy, assignee: task.assignee,
            delegate: task.delegate, confirmationPolicy: task.confirmationPolicy, subscribers: task.subscribers } : null);
        }
        if (method === 'PATCH') {
          const b = await this.body(req);
          return this.json(res, 200, store.setTaskResponsibility(responsibilityMatch[1]!, {
            assignee: b.assignee === null ? null : b.assignee === undefined ? undefined : principalFromBody(b.assignee),
            delegate: b.delegate === null ? null : b.delegate === undefined ? undefined : principalFromBody(b.delegate),
            confirmationPolicy: b.confirmationPolicy === null ? null : b.confirmationPolicy,
          }));
        }
      }
      const subscribersMatch = p.match(/^\/api\/tasks\/([^/]+)\/subscribers$/);
      if (subscribersMatch) {
        if (method === 'GET') return this.json(res, 200, store.subscribersFor(subscribersMatch[1]!));
        if (method === 'POST' || method === 'DELETE') {
          const b = await this.body(req);
          const principal = principalFromBody(b.principal);
          if (method === 'POST') store.subscribeTask(subscribersMatch[1]!, principal);
          else store.unsubscribeTask(subscribersMatch[1]!, principal);
          return this.json(res, 200, { subscribers: store.subscribersFor(subscribersMatch[1]!) });
        }
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
        const message = await api.signalTask(token, signalMatch[1]!, b.signal, b.text, b.role, b.images);
        return this.json(res, 200, { ok: true, ...(message ? { message, role: b.role ?? 'do' } : {}) });
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
      const executionsMatch = p.match(/^\/api\/tasks\/([^/]+)\/executions$/);
      if (executionsMatch && method === 'GET') {
        return this.json(res, 200, store.listExecutions(executionsMatch[1]!));
      }
      const checkoutMatch = p.match(/^\/api\/tasks\/([^/]+)\/checkout$/);
      if (checkoutMatch && method === 'GET') {
        if (!this.deps.handoffs) return this.json(res, 503, { error: 'local checkout handoff is unavailable' });
        try { return this.json(res, 200, this.deps.handoffs.checkout(checkoutMatch[1]!)); }
        catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const refreshFromGithub = p.match(/^\/api\/tasks\/([^/]+)\/refresh-from-github$/);
      if (refreshFromGithub && method === 'POST') {
        if (!this.deps.handoffs) return this.json(res, 503, { error: 'local checkout handoff is unavailable' });
        const taskId = refreshFromGithub[1]!;
        const view = (await api.getTaskView(token, taskId, { live: true }).catch(() => undefined)) ?? store.getTask(taskId)?.lastView;
        if (!view) return this.json(res, 404, { error: 'task view is unavailable' });
        try { return this.json(res, 200, await this.deps.handoffs.refresh(taskId, view)); }
        catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
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
        const task = store.getTask(taskId);
        const handle = worldHandleForView(view, taskId, task ? store.effectiveProjectConfig(task.projectId) : undefined);
        if (action.kind === 'open') {
          const target = String(action.target ?? '');
          if (/^https?:\/\//i.test(target)) return this.json(res, 200, { kind: 'open', url: target, external: true });
          if (!target) return this.json(res, 400, { error: 'open action has no target' });
          const url2 = `/api/tasks/${encodeURIComponent(taskId)}/artifact?path=${encodeURIComponent(target)}`;
          return this.json(res, 200, { kind: 'open', url: url2, external: false });
        }
        // kind: 'run'
        if (!action.command) return this.json(res, 400, { error: 'run action has no command' });
        if (!handle) return this.json(res, 400, { error: 'no world for this task yet' });
        const rec = await this.reviewActions.start({
          taskId,
          world: handle,
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
      const artifactList = p.match(/^\/api\/tasks\/([^/]+)\/artifacts$/);
      if (artifactList && method === 'GET') return this.json(res, 200, store.listPromotedArtifacts(artifactList[1]!));
      const artifactPromote = p.match(/^\/api\/tasks\/([^/]+)\/artifacts\/promote$/);
      if (artifactPromote && method === 'POST') {
        if (!this.deps.objects) return this.json(res, 503, { error: 'promoted artifact storage is not configured' });
        const taskId = artifactPromote[1]!;
        const task = store.getTask(taskId);
        const project = task ? store.getProject(task.projectId) : undefined;
        const b = await this.body(req);
        const relPath = String(b.path ?? '');
        if (!task || !project?.organizationId || !relPath) return this.json(res, 400, { error: 'task and artifact path are required' });
        const handle = worldHandleForView(task.lastView, taskId, store.effectiveProjectConfig(project));
        if (!handle) return this.json(res, 404, { error: 'no world for this task' });
        const world = await this.deps.worlds.open(handle);
        const data = await world.readFileBuffer(relPath);
        if (data.length > 100 * 1024 * 1024) return this.json(res, 413, { error: 'artifact exceeds 100 MiB' });
        const id = newId('artifact');
        const name = String(b.name ?? path.basename(relPath)).slice(0, 240) || 'artifact';
        const mediaType = String(b.mediaType ?? ARTIFACT_MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream');
        const objectKey = `artifacts/${project.organizationId}/${project.id}/${taskId}/${id}`;
        await this.deps.objects.put(objectKey, data, mediaType);
        const ttlMs = b.ttlMs == null ? undefined : Math.max(60_000, Math.min(Number(b.ttlMs), 365 * 24 * 60 * 60 * 1000));
        const artifact = store.savePromotedArtifact({ id, organizationId: project.organizationId, projectId: project.id,
          taskId, objectKey, sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.length,
          mediaType, name, createdAt: Date.now(), ...(ttlMs ? { expiresAt: Date.now() + ttlMs } : {}) });
        return this.json(res, 200, artifact);
      }
      const promotedArtifact = p.match(/^\/api\/artifacts\/([^/]+)$/);
      if (promotedArtifact) {
        const artifact = store.getPromotedArtifact(promotedArtifact[1]!);
        if (!artifact || (artifact.expiresAt != null && artifact.expiresAt <= Date.now())) return this.json(res, 404, { error: 'artifact not found' });
        if (method === 'GET') {
          if (!this.deps.objects) return this.json(res, 503, { error: 'artifact storage is unavailable' });
          const data = await this.deps.objects.get(artifact.objectKey);
          if (crypto.createHash('sha256').update(data).digest('hex') !== artifact.sha256)
            return this.json(res, 502, { error: 'artifact integrity check failed' });
          res.writeHead(200, { 'content-type': artifact.mediaType, 'content-length': String(data.length),
            'content-disposition': `inline; filename="${artifact.name.replace(/["\\\r\n]/g, '_')}"`,
            'cache-control': 'private, no-store' });
          return void res.end(data);
        }
        if (method === 'DELETE') {
          store.deletePromotedArtifact(artifact.id);
          await this.deps.objects?.delete(artifact.objectKey);
          return this.json(res, 200, { ok: true });
        }
      }
      const previewMatch = p.match(/^\/api\/tasks\/([^/]+)\/preview\/(\d+)(\/.*)?$/);
      if (previewMatch && PREVIEW_METHODS.has(method)) {
        const taskId = previewMatch[1]!;
        const port = Number(previewMatch[2]);
        const task = store.getTask(taskId);
        const project = task ? store.getProject(task.projectId) : undefined;
        const handle = worldHandleForView(task?.lastView, taskId, project ? store.effectiveProjectConfig(project) : undefined);
        if (!task || !project?.organizationId || !handle) return this.json(res, 404, { error: 'task world not found' });
        if (!Number.isInteger(port) || port < 1 || port > 65_535) return this.json(res, 400, { error: 'invalid preview port' });
        const isolatedOrigin = configuredPreviewOrigin();
        if (isolatedOrigin) {
          const rawToken = newPreviewToken();
          let runnerLeaseId: string | undefined;
          if (this.deps.worlds.get(handle.kind).capabilities?.remote && this.deps.runners)
            runnerLeaseId = (await this.deps.runners.acquire({ project, taskId, worldId: handle.id, provider: handle.kind })).leaseId;
          let lease: import('../domain/types.js').PreviewLease;
          try {
            lease = store.createPreviewLease({ id: newId('preview'), organizationId: project.organizationId,
              projectId: project.id, taskId, worldId: handle.id, generation: handle.generation ?? 1, port,
              public: false, tokenHash: hashPreviewToken(rawToken), runnerLeaseId, provider: handle.kind,
              createdBy: authRecord?.principal ?? session.user, createdAt: Date.now(),
              expiresAt: Date.now() + previewAccessTtlMs() });
          } catch (error) {
            if (runnerLeaseId) this.deps.runners?.release(runnerLeaseId, handle.kind);
            throw error;
          }
          res.writeHead(307, { location: previewLeaseUrl(lease.id,
            `${previewMatch[3] ?? '/'}${url.search}`, rawToken), 'referrer-policy': 'no-referrer' });
          return void res.end();
        }
        return this.servePreview(req, res, taskId, port,
          `${previewMatch[3] ?? '/'}${url.search}`, `/api/tasks/${encodeURIComponent(taskId)}/preview/${port}`);
      }
      const previewLeases = p.match(/^\/api\/tasks\/([^/]+)\/preview-leases$/);
      if (previewLeases && method === 'GET') return this.json(res, 200, store.listPreviewLeases(previewLeases[1]!));
      if (previewLeases && method === 'POST') {
        const taskId = previewLeases[1]!;
        const task = store.getTask(taskId);
        const project = task ? store.getProject(task.projectId) : undefined;
        const handle = worldHandleForView(task?.lastView, taskId, project ? store.effectiveProjectConfig(project) : undefined);
        const b = await this.body(req);
        const port = Number(b.port);
        if (!task || !project?.organizationId || !handle) return this.json(res, 404, { error: 'task world not found' });
        if (!Number.isInteger(port) || port < 1 || port > 65_535) return this.json(res, 400, { error: 'invalid preview port' });
        if (!reviewPorts(task.lastView).has(port)) return this.json(res, 400, { error: 'port was not declared by a review action' });
        const ttlMs = Math.max(60_000, Math.min(Number(b.ttlMs ?? 60 * 60_000), 24 * 60 * 60_000));
        const isPublic = b.public === true;
        // Isolated previews cannot use the main-app session cookie by design,
        // so private and public leases both get a scoped bearer. Locally, a
        // private lease keeps the convenient authenticated-session behavior.
        const tokenRequired = isPublic || Boolean(configuredPreviewOrigin());
        const rawToken = tokenRequired ? newPreviewToken() : undefined;
        let runnerLeaseId: string | undefined;
        if (this.deps.worlds.get(handle.kind).capabilities?.remote && this.deps.runners)
          runnerLeaseId = (await this.deps.runners.acquire({ project, taskId, worldId: handle.id, provider: handle.kind })).leaseId;
        let lease: import('../domain/types.js').PreviewLease;
        try {
          lease = store.createPreviewLease({ id: newId('preview'), organizationId: project.organizationId,
            projectId: project.id, taskId, worldId: handle.id, generation: handle.generation ?? 1, port,
            public: isPublic, ...(rawToken ? { tokenHash: hashPreviewToken(rawToken) } : {}),
            runnerLeaseId, provider: handle.kind, createdBy: authRecord?.principal ?? session.user,
            createdAt: Date.now(), expiresAt: Date.now() + ttlMs });
        } catch (error) {
          if (runnerLeaseId) this.deps.runners?.release(runnerLeaseId, handle.kind);
          throw error;
        }
        return this.json(res, 200, { ...lease, tokenHash: undefined,
          url: previewLeaseUrl(lease.id, '/', rawToken) });
      }
      const previewLease = p.match(/^\/api\/preview-leases\/([^/]+)$/);
      if (previewLease && method === 'DELETE') {
        const lease = store.revokePreviewLease(previewLease[1]!);
        if (!lease) return this.json(res, 404, { error: 'preview lease not found' });
        if (lease.runnerLeaseId) this.deps.runners?.release(lease.runnerLeaseId, lease.provider);
        return this.json(res, 200, { ok: true });
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
        const { agentAccountHandles } = await import('../platform/credential-sources.js');
        return this.json(res, 200, {
          handles: agentAccountHandles(this.deps.broker?.listHandles() ?? []),
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
        const organizationId = url.searchParams.get('organizationId') ?? project?.organizationId;
        const globalVals = globalSettingsFor(gs, wf, organizationId ?? undefined);
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
        const globalQuickVals = quickGlobalSettingsFor(gs, wf, organizationId ?? undefined);
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
      const organizationSettings = p.match(/^\/api\/organizations\/([^/]+)\/settings\/([^/]+)$/);
      if (organizationSettings) {
        const [_, organizationId, wf] = organizationSettings;
        if (method === 'GET') return this.json(res, 200, globalSettingsFor((s, w) => store.getSettings(s, w), wf!, organizationId));
        if (method === 'PUT') {
          const b = await this.body(req);
          store.setSettings(`organization:${organizationId}`, wf!, b.values ?? {});
          return this.json(res, 200, { ok: true });
        }
      }
      const organizationQuickSettings = p.match(/^\/api\/organizations\/([^/]+)\/quick-settings\/([^/]+)$/);
      if (organizationQuickSettings) {
        const [_, organizationId, wf] = organizationQuickSettings;
        if (method === 'GET') return this.json(res, 200, quickGlobalSettingsFor((s, w) => store.getSettings(s, w), wf!, organizationId));
        if (method === 'PUT') {
          const b = await this.body(req);
          store.setSettings(`quick:organization:${organizationId}`, wf!, b.values ?? {});
          return this.json(res, 200, { ok: true });
        }
      }
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
    const homes = (provider: 'claude' | 'codex') => {
      const values = creds.filter((c) => c.provider === provider && c.kind !== 'key').map((c) => c.configHome);
      // No subscription login: let the provider process use the ambient API key.
      if (!values.length && creds.some((c) => c.provider === provider && c.kind === 'key')) values.push(undefined);
      return [...new Set(values)];
    };
    const settled = async (provider: 'claude' | 'codex') => {
      const fn = provider === 'claude' ? claudeModels : codexModels;
      const results = await Promise.all(homes(provider).map((home) => fn(home).catch(() => [])));
      return mergeModels(results);
    };
    const [claude, codex] = await Promise.all([settled('claude'), settled('codex')]);
    // Discovery is best-effort (offline/old CLI/expired login). Keep the existing
    // safe presets so forms never degrade to an empty, non-actionable picker.
    const value: ModelCatalog = {
      claude: claude.length ? claude : [
        { id: 'claude-sonnet-5' }, { id: 'claude-opus-4-8' }, { id: 'claude-haiku-4-5' }, { id: 'claude-fable-5' },
      ],
      codex: codex.length ? codex : [{ id: 'gpt-5.5' }, { id: 'gpt-5.4-mini' }],
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

  /** Serve an artifact through its world provider. The browser never receives a
   * host/sandbox path and remote worlds need no public filesystem endpoint. */
  private async serveArtifact(res: http.ServerResponse, taskId: string, relPath: string) {
    const task = this.deps.store.getTask(taskId);
    const handle = worldHandleForView(task?.lastView, taskId, task ? this.deps.store.effectiveProjectConfig(task.projectId) : undefined);
    if (!handle) return this.json(res, 404, { error: 'no world for this task' });
    if (!relPath) return this.json(res, 400, { error: 'missing path' });
    try {
      const world = await this.deps.worlds.open(handle);
      const data = await world.readFileBuffer(relPath);
      res.writeHead(200, {
        'content-type': ARTIFACT_MIME[path.extname(relPath).toLowerCase()] ?? 'application/octet-stream',
        'content-length': String(data.length),
      });
      res.end(data);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      this.json(res, /escape|relative/i.test(message) ? 400 : 404, { error: /escape|relative/i.test(message) ? message : 'artifact not found' });
    }
  }

  /** Reverse proxy for services inside a remote world. Provider traffic tokens
   * stay server-side. Request credentials are deliberately not forwarded: the
   * repository application receives only a small HTTP header allowlist. */
  private async servePreview(req: http.IncomingMessage, res: http.ServerResponse, taskId: string,
    port: number, requestPath: string, proxyBase: string) {
    const task = this.deps.store.getTask(taskId);
    const handle = worldHandleForView(task?.lastView, taskId, task ? this.deps.store.effectiveProjectConfig(task.projectId) : undefined);
    if (!handle) return this.json(res, 404, { error: 'no world for this task' });
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return this.json(res, 400, { error: 'invalid preview port' });
    const method = req.method ?? 'GET';
    if (!PREVIEW_METHODS.has(method)) {
      res.writeHead(405, { allow: [...PREVIEW_METHODS].join(', ') });
      return void res.end();
    }
    try {
      const body = method === 'GET' || method === 'HEAD' ? undefined : await this.rawBody(req, MAX_PREVIEW_REQUEST_BYTES);
      const world = await this.deps.worlds.open(handle);
      if (!world.fetchPort) return this.json(res, 400, { error: 'this world provider does not expose remote previews' });
      const forwarded: Record<string, string> = {};
      for (const name of PREVIEW_REQUEST_HEADERS) {
        const value = req.headers[name];
        if (typeof value === 'string') forwarded[name] = value;
        else if (Array.isArray(value)) forwarded[name] = value.join(', ');
      }
      const response = await world.fetchPort(port, requestPath, { method, headers: forwarded, body });
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'cache-control', 'etag', 'last-modified', 'location',
        'content-range', 'accept-ranges', 'vary']) {
        if (response.headers[name]) headers[name] = response.headers[name]!;
      }
      if (headers.location) headers.location = previewLocation(taskId, port, headers.location, proxyBase) ?? '';
      if (!headers.location) delete headers.location;
      headers['content-length'] = String(response.body.length);
      headers['referrer-policy'] = 'no-referrer';
      headers['x-content-type-options'] = 'nosniff';
      res.writeHead(response.status, headers);
      res.end(method === 'HEAD' ? undefined : response.body);
    } catch (error) {
      const tooLarge = error instanceof AttachmentError && /too large/i.test(error.message);
      this.json(res, tooLarge ? 413 : 502,
        { error: tooLarge ? error.message : `preview unavailable: ${String((error as Error)?.message ?? error)}` });
    }
  }

  private async serveLeasedPreview(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const match = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
    const lease = match ? this.deps.store.previewLease(match[1]!) : undefined;
    if (!lease || lease.revokedAt || lease.expiresAt <= Date.now()) return this.json(res, 404, { error: 'preview not found or expired' });
    if (configuredPreviewOrigin() && String(req.headers.host ?? '').toLowerCase() !== new URL(previewLeaseOrigin(lease.id)).host.toLowerCase())
      return this.json(res, 404, { error: 'preview not found or expired' });
    const current = this.deps.store.currentWorld(lease.worldId);
    if (!current || (current.generation ?? 1) !== lease.generation) return this.json(res, 410, { error: 'preview world generation is no longer current' });
    if (lease.tokenHash) {
      const queryToken = url.searchParams.get('token') ?? '';
      const cookieToken = previewCookieValue(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined, lease.id);
      const supplied = queryToken || cookieToken;
      if (!previewTokenMatches(lease.tokenHash, supplied))
        return this.json(res, 401, { error: 'invalid preview token' });
      // Exchange the URL bearer for an HttpOnly, lease-path-scoped cookie. This
      // makes relative CSS/JS and HMR sockets work without leaking the token via
      // Referer, browser history, or application JavaScript.
      if (queryToken && (req.method === 'GET' || req.method === 'HEAD')) {
        const query = new URLSearchParams(url.searchParams);
        query.delete('token');
        res.writeHead(303, { location: `${url.pathname}${query.size ? `?${query}` : ''}`,
          'set-cookie': previewCookieHeader(lease.id, queryToken, lease.expiresAt),
          'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return void res.end();
      }
      if (queryToken) res.setHeader('set-cookie', previewCookieHeader(lease.id, queryToken, lease.expiresAt));
    } else {
      const session = await this.auth(req, lease.projectId, lease.organizationId);
      if (!session || !this.deps.tokens.check(session.apiToken, 'task:read', { projectId: lease.projectId, taskId: lease.taskId }).ok)
        return this.json(res, 401, { error: 'unauthorized' });
    }
    const requestPath = `${match?.[2] ?? '/'}${url.searchParams.has('token')
      ? (() => { const q = new URLSearchParams(url.searchParams); q.delete('token'); return q.size ? `?${q}` : ''; })()
      : url.search}`;
    return this.servePreview(req, res, lease.taskId, lease.port, requestPath,
      `/preview/${encodeURIComponent(lease.id)}`);
  }

  /** Authenticated bidirectional proxy for HMR/live-reload sockets in a task
   * preview. The browser sees only Karmax; provider URLs and access tokens stay
   * on this side of the trust boundary. */
  private async previewWebSocket(browser: import('ws').WebSocket, req: http.IncomingMessage): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let taskId: string;
    let port: number;
    let requestPath: string;
    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/preview\/(\d+)(\/.*)?$/);
    if (taskMatch) {
      if (configuredPreviewOrigin()) { browser.close(4403, 'use isolated preview origin'); return; }
      taskId = decodeURIComponent(taskMatch[1]!);
      port = Number(taskMatch[2]);
      const task = this.deps.store.getTask(taskId);
      const auth = await this.socketAuth(req, url, task?.projectId);
      if (!task || !auth || !this.deps.tokens.check(auth.apiToken, 'task:review:execute', { projectId: task.projectId, taskId }).ok) {
        browser.close(4403, 'forbidden'); return;
      }
      const query = new URLSearchParams(url.searchParams); query.delete('token');
      requestPath = `${taskMatch[3] ?? '/'}${query.size ? `?${query}` : ''}`;
    } else {
      const leaseMatch = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
      const lease = leaseMatch ? this.deps.store.previewLease(leaseMatch[1]!) : undefined;
      if (!lease || lease.revokedAt || lease.expiresAt <= Date.now()) { browser.close(4404, 'preview expired'); return; }
      if (configuredPreviewOrigin() && String(req.headers.host ?? '').toLowerCase() !== new URL(previewLeaseOrigin(lease.id)).host.toLowerCase()) {
        browser.close(4404, 'preview expired'); return;
      }
      const current = this.deps.store.currentWorld(lease.worldId);
      if (!current || (current.generation ?? 1) !== lease.generation) { browser.close(4410, 'world changed'); return; }
      if (lease.tokenHash) {
        const queryToken = url.searchParams.get('token') ?? '';
        const cookieToken = previewCookieValue(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined, lease.id);
        if (!previewTokenMatches(lease.tokenHash, queryToken || cookieToken)) {
          browser.close(4401, 'invalid token'); return;
        }
      } else {
        const auth = await this.auth(req, lease.projectId, lease.organizationId);
        if (!auth || !this.deps.tokens.check(auth.apiToken, 'task:read', { projectId: lease.projectId, taskId: lease.taskId }).ok) {
          browser.close(4401, 'unauthorized'); return;
        }
      }
      taskId = lease.taskId;
      port = lease.port;
      const query = new URLSearchParams(url.searchParams); query.delete('token');
      requestPath = `${leaseMatch?.[2] ?? '/'}${query.size ? `?${query}` : ''}`;
    }
    const task = this.deps.store.getTask(taskId);
    const handle = worldHandleForView(task?.lastView, taskId, task ? this.deps.store.effectiveProjectConfig(task.projectId) : undefined);
    if (!handle) { browser.close(4404, 'world unavailable'); return; }
    const world = await this.deps.worlds.open(handle);
    if (!world.previewSocketTarget) { browser.close(4400, 'provider has no WebSocket previews'); return; }
    const target = await world.previewSocketTarget(port, requestPath);
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    const upstream = new WebSocketClient(target.url, protocols, { headers: target.headers });
    const pending: Array<{ data: import('ws').RawData; binary: boolean }> = [];
    browser.on('message', (data, binary) => {
      if (upstream.readyState === WebSocketClient.OPEN) upstream.send(data, { binary });
      else if (upstream.readyState === WebSocketClient.CONNECTING && pending.length < 100) pending.push({ data, binary });
    });
    browser.on('close', (code, reason) => {
      if (upstream.readyState === WebSocketClient.CONNECTING) upstream.terminate();
      else if (upstream.readyState === WebSocketClient.OPEN) upstream.close(code || 1000, reason.toString());
    });
    browser.on('error', () => upstream.terminate());
    upstream.on('open', () => {
      for (const message of pending.splice(0)) upstream.send(message.data, { binary: message.binary });
    });
    upstream.on('message', (data, binary) => { if (browser.readyState === browser.OPEN) browser.send(data, { binary }); });
    upstream.on('close', (code, reason) => { if (browser.readyState === browser.OPEN) browser.close(code || 1000, reason.toString()); });
    upstream.on('error', () => { if (browser.readyState === browser.OPEN) browser.close(1011, 'preview upstream failed'); });
  }

  /** SCIM 2.0 provisioning boundary. A tenant-scoped bearer token is stored only
   * as a hash; deprovisioning removes every org/team/project grant and revokes
   * browser + platform sessions without deleting an identity used by another org. */
  private async scim(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const match = url.pathname.match(/^\/scim\/v2\/([^/]+)\/(Users|Groups)(?:\/([^/]+))?$/);
    if (!match || !this.deps.identity) return this.scimJson(res, 404, { detail: 'resource not found' });
    const organizationId = decodeURIComponent(match[1]!);
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!this.deps.store.verifyScimToken(organizationId, token)) return this.scimJson(res, 401, { detail: 'invalid bearer token' });
    const resource = match[2]!;
    const id = match[3] ? decodeURIComponent(match[3]) : undefined;
    const method = req.method ?? 'GET';
    try {
      const body = method === 'GET' || method === 'DELETE' ? {} : await this.body(req);
      if (resource === 'Users') {
        if (method === 'GET' && id) {
          const user = this.deps.identity.listUsers().find((candidate) => candidate.id === id);
          if (!user || !this.deps.store.organizationMembership(organizationId, id)) return this.scimJson(res, 404, { detail: 'user not found' });
          return this.scimJson(res, 200, scimUser(user));
        }
        if (method === 'GET') {
          const filter = url.searchParams.get('filter')?.match(/^userName\s+eq\s+"([^"]+)"$/i)?.[1]?.toLowerCase();
          const members = new Set(this.deps.store.listOrganizationMemberships(organizationId).map((member) => member.userId));
          const users = this.deps.identity.listUsers().filter((user) => members.has(user.id) && (!filter || user.email.toLowerCase() === filter));
          return this.scimJson(res, 200, scimList(users.map((user) => scimUser(user))));
        }
        if (method === 'POST') {
          const email = String(body.userName ?? body.emails?.find((entry: any) => entry.primary)?.value ?? '').trim().toLowerCase();
          if (!email) return this.scimJson(res, 400, { detail: 'userName is required' });
          let user = this.deps.identity.listUsers().find((candidate) => candidate.email.toLowerCase() === email);
          if (!user) user = await this.deps.identity.createUser({ name: String(body.displayName ?? body.name?.formatted ?? email.split('@')[0]),
            email, password: crypto.randomBytes(24).toString('base64url') });
          this.deps.store.setOrganizationMembership(organizationId, user.id, 'member');
          this.deps.authorization?.grant('system:scim', { principalId: `user:${user.id}`,
            scopeKey: `organization:${organizationId}`, profileId: 'developer',
            capabilities: ['organization:read', 'organization:member:read', 'team:read', 'repository:read', 'inbox:*'] });
          return this.scimJson(res, 201, scimUser(user));
        }
        if ((method === 'PATCH' || method === 'PUT') && id) {
          const activeOperation = body.Operations?.find((operation: any) => String(operation.path ?? '').toLowerCase() === 'active');
          const active = activeOperation ? activeOperation.value !== false : body.active !== false;
          if (!active) {
            this.deps.store.deprovisionOrganizationUser(organizationId, id);
            this.deps.identity.revokeUserSessions(id);
          } else if (!this.deps.store.organizationMembership(organizationId, id)) this.deps.store.setOrganizationMembership(organizationId, id, 'member');
          const user = this.deps.identity.listUsers().find((candidate) => candidate.id === id);
          return this.scimJson(res, 200, user ? scimUser(user, active) : { id, active });
        }
        if (method === 'DELETE' && id) {
          this.deps.store.deprovisionOrganizationUser(organizationId, id);
          this.deps.identity.revokeUserSessions(id);
          res.writeHead(204); return void res.end();
        }
      }
      if (resource === 'Groups') {
        if (method === 'GET' && id) {
          const team = this.deps.store.getTeam(id);
          if (!team || team.organizationId !== organizationId) return this.scimJson(res, 404, { detail: 'group not found' });
          return this.scimJson(res, 200, scimGroup(team, this.deps.store.listTeamMemberships(team.id)));
        }
        if (method === 'GET') return this.scimJson(res, 200, scimList(this.deps.store.listTeams(organizationId)
          .map((team) => scimGroup(team, this.deps.store.listTeamMemberships(team.id)))));
        if (method === 'POST') {
          const team = this.deps.store.createTeam({ organizationId, name: String(body.displayName ?? 'Team') });
          for (const member of body.members ?? []) if (this.deps.store.organizationMembership(organizationId, String(member.value)))
            this.deps.store.setTeamMembership(team.id, String(member.value));
          return this.scimJson(res, 201, scimGroup(team, this.deps.store.listTeamMemberships(team.id)));
        }
        if ((method === 'PUT' || method === 'PATCH') && id) {
          const team = this.deps.store.getTeam(id);
          if (!team || team.organizationId !== organizationId) return this.scimJson(res, 404, { detail: 'group not found' });
          const members = body.members ?? body.Operations?.find((operation: any) => String(operation.path ?? '').toLowerCase() === 'members')?.value;
          if (Array.isArray(members)) {
            this.deps.store.db.prepare('DELETE FROM team_memberships WHERE teamId=?').run(team.id);
            for (const member of members) if (this.deps.store.organizationMembership(organizationId, String(member.value)))
              this.deps.store.setTeamMembership(team.id, String(member.value));
          }
          return this.scimJson(res, 200, scimGroup(team, this.deps.store.listTeamMemberships(team.id)));
        }
      }
      return this.scimJson(res, 405, { detail: 'method not supported' });
    } catch (error) {
      return this.scimJson(res, /owner/i.test(String((error as Error)?.message)) ? 409 : 400,
        { detail: error instanceof Error ? error.message : String(error) });
    }
  }

  private scimJson(res: http.ServerResponse, status: number, body: unknown) {
    const value = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/scim+json', 'content-length': String(Buffer.byteLength(value)) });
    res.end(value);
  }

  // ── helpers ──
  private async removeProjectExternalResources(projectId: string, reason: string) {
    const project = this.deps.store.getProject(projectId);
    if (!project) throw new Error('project not found');
    const resources = this.deps.store.projectResources(projectId);
    for (const task of this.deps.store.listTasks(projectId)) {
      try { await this.deps.client.workflow.getHandle(task.id).terminate(reason); }
      catch (error) { if (!isWorkflowGone(error)) throw error; }
    }
    // Finalize billing before metadata disappears. Queued leases produce zero
    // usage; active leases keep the elapsed provider cost in the org ledger.
    for (const lease of resources.leases) {
      if (this.deps.runners) this.deps.runners.release(lease.id, lease.provider);
      else this.deps.store.releaseWorldLease(lease.id);
    }
    for (const handle of resources.worlds) {
      try {
        // Do not use registry recovery here: deletion must never restore a cold
        // checkpoint merely to destroy the newly restored generation.
        const world = await this.deps.worlds.get(handle.kind).open(handle as import('../world/types.js').WorldHandle);
        await world.destroy();
      } catch (error) { if (!isWorldGone(error)) throw error; }
    }
    if (resources.objectKeys.length && !this.deps.objects)
      throw new Error('object store is unavailable; project resources were not fully deleted');
    for (const key of resources.objectKeys) await this.deps.objects!.delete(key);
    return resources;
  }

  private requestIsPreviewOrigin(req: http.IncomingMessage): boolean {
    const origin = configuredPreviewOrigin();
    if (!origin) return false;
    try {
      const requested = new URL(`http://${String(req.headers.host ?? '').trim()}`);
      const base = new URL(origin);
      return (requested.hostname === base.hostname || requested.hostname.endsWith(`.${base.hostname}`))
        && requested.port === base.port;
    } catch { return false; }
  }

  private publicUrl(req: http.IncomingMessage, browserUrl?: unknown): string {
    // Behind a reverse proxy, the browser is the one component that always
    // knows the URL the human actually opened. An authenticated setup request
    // may supply that origin instead of relying on frequently-misconfigured
    // forwarded headers.
    if (typeof browserUrl === 'string' && browserUrl.trim()) {
      const parsed = new URL(browserUrl.trim());
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        throw new Error('The browser URL for GitHub setup must be an http(s) URL');
      return parsed.origin;
    }
    const configured = process.env.KARMAX_PUBLIC_URL?.trim();
    if (configured) return new URL(configured).origin;
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() || 'http';
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0]?.trim();
    return new URL(`${proto}://${host}`).origin;
  }

  /** GitHub must see exactly the same origin throughout manifest, install, and
   * OAuth callbacks. Persist the admin's browser origin during setup so a stale
   * reverse-proxy/environment value cannot reappear midway through the flow. */
  private githubPublicUrl(req: http.IncomingMessage, browserUrl?: unknown): string {
    if (browserUrl != null) {
      const value = this.publicUrl(req, browserUrl);
      this.deps.store.kvSet(GITHUB_APP_PUBLIC_URL_KEY, value);
      return value;
    }
    return this.deps.store.kvGet(GITHUB_APP_PUBLIC_URL_KEY) ?? this.publicUrl(req);
  }

  private async auth(req: http.IncomingMessage, projectId?: string, organizationId?: string): Promise<Session | undefined> {
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
    const resolvedOrganizationId = organizationId ?? (projectId ? this.deps.store.getProject(projectId)?.organizationId : undefined);
    if (resolvedOrganizationId) {
      const policy = this.deps.store.getOrganizationIdentityPolicy(resolvedOrganizationId);
      if (policy.enforceSso && (!policy.oidcProviderId
        || !this.deps.identity.providersForUser(identity.user.id).includes(policy.oidcProviderId))) return undefined;
      if (policy.enforceSso && policy.verifiedDomains.length && this.deps.store.organizationMembership(resolvedOrganizationId, identity.user.id)) {
        const domain = identity.user.email.split('@')[1]?.toLowerCase();
        if (!domain || !policy.verifiedDomains.includes(domain)) return undefined;
      }
    }
    const caps = this.deps.authorization?.capabilities(principal, projectId, resolvedOrganizationId) ?? [];
    const fingerprint = JSON.stringify(caps.slice().sort());
    const cacheKey = `${identity.session.id}:${resolvedOrganizationId ?? 'global'}:${projectId ?? '*'}`;
    let cached = this.identityTokens.get(cacheKey);
    if (!cached || cached.fingerprint !== fingerprint || !this.deps.tokens.verify(cached.apiToken)) {
      if (cached) this.deps.tokens.revoke(cached.apiToken);
      cached = { apiToken: this.deps.tokens.mintPrincipal(principal, caps, projectId, 10 * 60 * 1000, resolvedOrganizationId).token, fingerprint };
      this.identityTokens.set(cacheKey, cached);
    }
    return { user: identity.user.name, userId: identity.user.id, email: identity.user.email, apiToken: cached.apiToken };
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
  private requestScope(pathname: string, url: URL): { projectId?: string; taskId?: string; organizationId?: string } {
    const projectId = pathname.match(/^\/api\/projects\/([^/]+)/)?.[1]
      ?? pathname.match(/^\/api\/defaults\/([^/]+)/)?.[1]
      ?? pathname.match(/^\/api\/settings\/(?:quick\/)?project\/([^/]+)/)?.[1]
      ?? url.searchParams.get('projectId') ?? undefined;
    const artifact = pathname.match(/^\/api\/artifacts\/([^/]+)/)?.[1];
    const artifactRecord = artifact ? this.deps.store.getPromotedArtifact(artifact) : undefined;
    const previewId = pathname.match(/^\/api\/preview-leases\/([^/]+)/)?.[1];
    const previewRecord = previewId ? this.deps.store.previewLease(previewId) : undefined;
    const taskId = pathname.match(/^\/api\/tasks\/([^/]+)/)?.[1] ?? artifactRecord?.taskId ?? previewRecord?.taskId
      ?? url.searchParams.get('taskId') ?? undefined;
    const taskProject = taskId ? this.deps.store.getTask(taskId)?.projectId : undefined;
    const resolvedProjectId = projectId ?? taskProject;
    const organizationId = pathname.match(/^\/api\/organizations\/([^/]+)/)?.[1]
      ?? url.searchParams.get('organizationId')
      ?? (resolvedProjectId ? this.deps.store.getProject(resolvedProjectId)?.organizationId : undefined);
    return { projectId: resolvedProjectId, organizationId, ...(taskId ? { taskId } : {}) };
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
    const body = JSON.stringify(toPublicPayload(obj ?? null));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
      'x-karmax-cell': this.deps.cellId ?? 'local' });
    res.end(body);
  }
  private githubCallbackPage(res: http.ServerResponse, status: number, message: string) {
    const body = `<!doctype html><meta charset="utf-8"><title>Karmax · GitHub</title><main style="font:16px system-ui;max-width:42rem;margin:12vh auto;padding:2rem"><h1>GitHub connection</h1><p>${escapeHtml(message)}</p><p><a href="/organization">Return to Karmax</a></p></main>`;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(body)),
      'x-karmax-cell': this.deps.cellId ?? 'local' });
    res.end(body);
  }
  private async body(req: http.IncomingMessage): Promise<any> {
    const value = await this.rawBody(req, 2 * 1024 * 1024);
    if (!value.length) return {};
    try {
      return JSON.parse(value.toString('utf8'));
    } catch {
      return {};
    }
  }
  /** Read a request body into a Buffer, aborting if it exceeds `maxBytes`. */
  private async rawBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    let exceeded = false;
    for await (const c of req) {
      total += (c as Buffer).length;
      if (total > maxBytes) {
        exceeded = true;
        continue;
      }
      if (!exceeded) chunks.push(c as Buffer);
    }
    if (exceeded) throw new AttachmentError(`upload too large (> ${maxBytes} bytes)`);
    return Buffer.concat(chunks);
  }
  private fail(res: http.ServerResponse, e: unknown) {
    try {
      this.json(res, e instanceof AttachmentError && /too large/i.test(e.message) ? 413 : 500,
        { error: String((e as Error)?.message ?? e) });
    } catch {
      /* ignore */
    }
  }
}

/** Keep a service's loopback redirect inside the authenticated preview proxy.
 * External HTTP(S) redirects remain explicit; non-web schemes are discarded. */
export function previewLocation(taskId: string, port: number, value: string,
  proxyBase = `/api/tasks/${encodeURIComponent(taskId)}/preview/${port}`): string | undefined {
  try {
    const target = new URL(value, `http://localhost:${port}`);
    if (!['http:', 'https:'].includes(target.protocol)) return undefined;
    if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(target.hostname)) {
      return `${proxyBase}${target.pathname}${target.search}${target.hash}`;
    }
    return target.toString();
  } catch {
    return undefined;
  }
}

function previewAccessTtlMs(): number {
  const value = Number(process.env.KARMAX_REVIEW_PREVIEW_TTL_MS);
  return Number.isFinite(value) && value >= 60_000 ? Math.min(value, 24 * 60 * 60_000) : 8 * 60 * 60_000;
}

function reviewPorts(view: import('../domain/types.js').TaskView | undefined): Set<number> {
  const ports = new Set<number>();
  for (const action of view?.reviewInfo?.actions ?? []) {
    for (const value of action.openUrls ?? []) {
      try {
        const url = new URL(value);
        if (!['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(url.hostname)) continue;
        const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
        if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port);
      } catch { /* non-URL review text is not a preview declaration */ }
    }
  }
  return ports;
}

const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
function scimUser(user: { id: string; email: string; name: string }, active = true) {
  return { schemas: [SCIM_USER_SCHEMA], id: user.id, userName: user.email, displayName: user.name,
    name: { formatted: user.name }, emails: [{ value: user.email, primary: true }], active };
}
function scimGroup(team: { id: string; name: string }, members: Array<{ userId: string }>) {
  return { schemas: [SCIM_GROUP_SCHEMA], id: team.id, displayName: team.name,
    members: members.map((member) => ({ value: member.userId })) };
}
function scimList(Resources: unknown[]) {
  return { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: Resources.length,
    startIndex: 1, itemsPerPage: Resources.length, Resources };
}

function prometheusMetrics(snapshot: Record<string, unknown>): string {
  const lines = ['# HELP karmax_info Karmax control-plane information.', '# TYPE karmax_info gauge', 'karmax_info 1'];
  const scalar = (name: string, help: string, value: unknown) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${Number(value ?? 0)}`);
  };
  scalar('karmax_organizations', 'Organizations in this cell.', snapshot.organizations);
  scalar('karmax_projects', 'Projects in this cell.', snapshot.projects);
  scalar('karmax_event_cursor', 'Latest durable gateway event sequence.', snapshot.eventCursor);
  scalar('karmax_database_bytes', 'SQLite control-plane database bytes.', snapshot.databaseBytes);
  const grouped = (metric: string, help: string, values: unknown) => {
    lines.push(`# HELP ${metric} ${help}`, `# TYPE ${metric} gauge`);
    for (const [state, count] of Object.entries((values ?? {}) as Record<string, unknown>))
      lines.push(`${metric}{state="${state.replace(/["\\]/g, '_')}"} ${Number(count)}`);
  };
  grouped('karmax_tasks', 'Tasks by durable status.', snapshot.tasks);
  grouped('karmax_worlds', 'World generations by lifecycle state.', snapshot.worlds);
  grouped('karmax_runner_leases', 'Runner leases by state.', snapshot.runnerLeases);
  grouped('karmax_executions', 'Interactive executions by state.', snapshot.executions);
  grouped('karmax_deliveries', 'Notification outbox rows by state.', snapshot.deliveries);
  return `${lines.join('\n')}\n`;
}

function isWorkflowGone(error: unknown): boolean {
  const value = error as { name?: string; message?: string };
  return value?.name === 'WorkflowNotFoundError' || /workflow.*(?:not found|already (?:closed|completed|terminated))/i.test(value?.message ?? '');
}

function isWorldGone(error: unknown): boolean {
  const value = error as { message?: string };
  return /(?:not found|does not exist|already (?:destroyed|removed)|no such sandbox|no world)/i.test(value?.message ?? '');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** Expand ~ / $HOME in repo paths so a configured repo resolves to a real dir. */
function normalizeConfig(config: ProjectConfig = {}, defaultHostedProvider = false): ProjectConfig {
  if (process.env.KARMAX_DEPLOYMENT === 'hosted') {
    const worldProvider = config.worldProvider ?? (defaultHostedProvider
      ? process.env.KARMAX_CLOUD_WORLD_PROVIDER ?? 'e2b'
      : undefined);
    if (worldProvider && ['worktree', 'container', 'memory'].includes(worldProvider))
      throw new Error('hosted projects require a remote world provider');
    if (worldProvider) config = { ...config, worldProvider };
  }
  if (Array.isArray(config.repos)) {
    return { ...config, repos: config.repos.filter(Boolean).map(expandPath) };
  }
  return config;
}

const EXECUTION_CONFIG_KEYS = ['worldProvider', 'runnerPoolId', 'resources', 'network', 'monthlyBudgetMicros', 'hibernateAfterMs'] as const;

function pickExecutionConfig(config: ProjectConfig): Partial<ProjectConfig> {
  return Object.fromEntries(EXECUTION_CONFIG_KEYS.filter((key) => config[key] !== undefined).map((key) => [key, config[key]])) as Partial<ProjectConfig>;
}

function applyExecutionOverride(config: ProjectConfig, override: Record<string, unknown>): ProjectConfig {
  const next: Record<string, unknown> = { ...config };
  for (const key of EXECUTION_CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(override, key)) continue;
    if (override[key] == null) delete next[key];
    else next[key] = override[key];
  }
  return next as ProjectConfig;
}

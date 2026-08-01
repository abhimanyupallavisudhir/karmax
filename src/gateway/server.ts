import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket as WebSocketClient, WebSocketServer } from 'ws';
import type { Client } from '@temporalio/client';
import { KarmaxApi, CapabilityError } from '../platform/api.js';
import type { TaskView } from '../domain/types.js';
import { BRAND_FILES, brandIconOf, isBrandIcon } from '../domain/brand.js';
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
import { sameRepository } from '../world/repository-identity.js';
import { accountCoordinatorId } from '../coordinators/names.js';
import { findFreePortFrom } from '../util/ports.js';
import { expandPath } from '../util/expand.js';
import { withTimeout } from '../util/timeout.js';
import { AgentSpec, AuthorizationSelection, Provider, Project, ProjectConfig, PrincipalRef, ProjectPrincipalRef, ResourceAttachment, ResourceRevision, ResourceTarget, normalizeUrgency } from '../domain/types.js';
import { confirmLayersOf } from '../domain/confirm.js';
import { ReviewActionRunner } from './review-actions.js';
import { acpModels, claudeModels, codexModels, opencodeModels, mergeModels, type ModelCatalog } from '../agent/models.js';
import type { IdentityService } from '../auth/identity.js';
import type { AuthorizationService } from '../platform/authorization.js';
import { TOOL_CAPABILITY, CAPABILITY_GROUPS, allows } from '../platform/capabilities.js';
import { PLATFORM_API_CATALOG } from '../platform/catalog.js';
import { RESOLVE_AGENT_ENABLED } from '../config/features.js';
import { hostLocal } from '../config/deployment.js';
import { credentialAliases, isAgentProvider, isLoginProvider } from '../agent/provider-registry.js';
import { WorldRegistry } from '../world/registry.js';
import { worldHandleForView } from '../world/resolve.js';
import type { ObjectStore } from '../store/objects.js';
import type { AccessMode, AccessStatus, VaultFieldName } from '../autonomy/vault-items.js';
import { defaultCdpUrl } from '../autonomy/cdp-endpoint.js';
import { newId } from '../util/id.js';
import { DurableEventFanout } from './fanout.js';
import { configuredPreviewOrigin, hashPreviewToken, newPreviewToken, previewCookieHeader,
  previewCookieValue, previewLeaseOrigin, previewLeaseUrl, previewTokenMatches } from './previews.js';
import type { RemoteAccessController } from '../remote/access.js';
import { GITHUB_APP_PUBLIC_URL_KEY } from '../integrations/github-app.js';
import { scanProjectResources } from '../world/resource-scan.js';
import { credentialResource, resourceDriverCatalog, snapshotResource } from '../domain/resource-drivers.js';
import { managedRepoPath } from '../world/worktree.js';
import { paths } from '../config/paths.js';
import { ensureProjectWikiRepository, setProjectWikiRemote } from '../wiki/repository.js';
import { worldRepos, worldWorkingRelativePath } from '../world/types.js';
import { enumerateCredentials } from '../platform/credentials.js';
import { gatherCredentialSources } from '../platform/credential-sources.js';
import { ITEM_FIELDS, VaultItems } from '../autonomy/vault-items.js';
import type { CredentialAccessRequest } from '../autonomy/vault-items.js';
import { PermissionRequests } from '../platform/permission-requests.js';

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
  email?: import('../autonomy/email.js').EmailService;
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
  workflows?: import('../packages/manager.js').WorkflowManager;
  handoffs?: import('../world/handoff.js').WorldHandoffService;
  runners?: import('../world/runners.js').RunnerPoolService;
  worldAccess?: import('../world/access.js').WorldAccessService;
  objects?: ObjectStore;
  resources?: import('../world/resources.js').ProjectResourceService;
  cellId?: string;
  hosted?: boolean;
  /** Whether the browser and the host are the same machine (see `hostLocal`).
   *  Defaults to detecting it from how the gateway is served. */
  hostLocal?: boolean;
  /** Inbox delivery channels with a registered adapter. The console disables the
   *  rest rather than offering a switch that silently cannot deliver. */
  deliveryChannels?: string[];
  remoteAccess?: RemoteAccessController;
}

/** Coarse HTTP operation → capability binding. KarmaxApi performs the same check
 * again for task operations; this layer covers the direct administrative routes.
 * Returns the required capability, `'none'` for routes that intentionally need
 * no capability, or undefined for a route this catalog does not know — callers
 * apply the conservative fallback, and tests assert the catalog stays complete. */
export function routeCapability(method: string, p: string, url?: URL): string | undefined {
  const read = method === 'GET';
  if (p === '/api/meta' || p === '/api/session' || p.startsWith('/api/health/')) return 'none';
  if (p === '/api/platform') return 'workflow:read';
  if (p === '/api/resource-drivers') return 'workflow:read';
  if (p.startsWith('/api/resource-uploads/')) return 'project:settings:write';
  if (p === '/api/logout') return 'none';
  // The dashboard is the current organization's overview (scoped in the handler);
  // any member with organization:read may see it. Host/diagnostic panels are
  // fetched separately and gated by diagnostic:read on their own routes.
  if (p === '/api/dashboard') return 'organization:read';
  if (p === '/api/remote-access') return read ? 'settings:read' : 'settings:write';
  if (p.startsWith('/api/diagnostics')) return 'diagnostic:read';
  if (p === '/api/metrics') return 'diagnostic:read';
  if (p.startsWith('/api/processes')) return read ? 'process:read' : 'process:kill';
  if (p.startsWith('/api/users')) return read ? 'user:read' : 'user:write';
  if (p === '/api/invitations/accept') return 'none';
  if (p.startsWith('/api/inbox')) return read ? 'inbox:read' : 'inbox:write';
  if (p === '/api/organizations') return read ? 'organization:read' : 'organization:create';
  if (/^\/api\/organizations\/[^/]+\/projects/.test(p)) return read ? 'project:read' : 'project:create';
  if (/^\/api\/organizations\/[^/]+\/runner-pools/.test(p)) return read ? 'organization:read' : 'organization:edit';
  if (/^\/api\/organizations\/[^/]+\/world-providers/.test(p)) return read ? 'organization:read' : 'organization:edit';
  if (/^\/api\/organizations\/[^/]+\/usage/.test(p)) return 'payment:read';
  if (/^\/api\/organizations\/[^/]+\/payments(?:\/|$)/.test(p)) return read ? 'payment:read' : 'payment:write';
  if (/^\/api\/organizations\/[^/]+\/settings\/payments$/.test(p)) return read ? 'payment:read' : 'payment:write';
  if (/^\/api\/organizations\/[^/]+\/repositories/.test(p)) return read ? 'repository:read' : 'repository:write';
  if (/^\/api\/organizations\/[^/]+\/github\/(?:app|app-manifest|authorize|install-url|refresh)/.test(p)) return read ? 'repository:read' : 'repository:write';
  if (/^\/api\/organizations\/[^/]+\/git-connections/.test(p)) return read ? 'repository:read' : 'repository:write';
  if (/^\/api\/organizations\/[^/]+\/teams/.test(p)) return read ? 'team:read' : 'team:write';
  if (/^\/api\/organizations\/[^/]+\/(members|invitations)/.test(p)) return read ? 'organization:member:read' : 'organization:member:write';
  // A full-tenant export dumps every project, the whole tasks table (prompts and
  // results included), memberships, settings and executions. `organization:read`
  // is inside PROJECT_GRANT_CEILING and the developer profile, so gating on it
  // let a deliberately project-ceilinged agent read every sibling project. This
  // is an administrative operation, not a read.
  if (/^\/api\/organizations\/[^/]+\/export$/.test(p)) return 'organization:edit';
  if (/^\/api\/organizations\/[^/]+\/(?:accounts|git-profiles|credentials)(?:\/|$)/.test(p))
    return read ? 'credential:read' : 'credential:write';
  if (/^\/api\/organizations\/[^/]+\/workflows(?:\/|$)/.test(p))
    return read ? 'workflow:read' : (p.includes('/install') ? 'workflow:install' : 'workflow:edit');
  // The wiki is the skills store: reads need the scope's read capability, edits
  // reuse skill:write (agents and developers can both grow it).
  if (/^\/api\/organizations\/[^/]+\/wiki(?:\/|$)/.test(p)) return read ? 'organization:read' : 'skill:write';
  // The agent mailbox is a credential surface, org-scoped by its path (the
  // token/session check enforces the tenant boundary from requestScope).
  if (/^\/api\/organizations\/[^/]+\/agent-mail(?:\/|$)/.test(p)) return read ? 'credential:read' : 'credential:write';
  if (/^\/api\/projects\/[^/]+\/wiki(?:\/|$)/.test(p)) return read ? 'project:read' : 'skill:write';
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
  // Vault items (PLAN-passwords.md): admin CRUD is credential:write; agent
  // write-back is the narrower vault:store; use/reveal/fill/request attempts
  // need only credential:read — the per-item grant + policy check happens in
  // the handler against the caller's own capability set.
  if (p === '/api/vault/store' || p === '/api/vault/passkey/save') return 'vault:store';
  if (/^\/api\/vault\/requests\/[^/]+\/resolve$/.test(p)) return 'credential:write';
  if (p === '/api/vault/import/bitwarden') return 'credential:write';
  if (p.startsWith('/api/vault/items')) return read ? 'credential:read' : 'credential:write';
  // Connectors: describe is read; connect/sync/config/write-back are admin.
  if (p.startsWith('/api/vault/connectors')) return read ? 'credential:read' : 'credential:write';
  if (p.startsWith('/api/vault')) return 'credential:read';
  // The agent-mail inbound webhook authenticates with its own shared secret
  // (like the GitHub webhook), so it needs no capability.
  if (p === '/api/agent-mail/ingest') return 'none';
  if (p === '/api/payments/stripe/callback' || p === '/api/payments/stripe/webhook') return 'none';
  if (p.startsWith('/api/cards') || p.startsWith('/api/payments')) return read ? 'payment:read' : 'payment:write';
  if (p === '/api/safe-mode') return read ? 'settings:read' : 'safe-mode:write';
  // Installation-wide outbound email is operator configuration (settings:write),
  // like the mailbox provider. The connected secret never leaves the vault.
  if (p === '/api/email' || p.startsWith('/api/email/')) return read ? 'settings:read' : 'settings:write';
  if (/^\/api\/settings\/(?:quick\/)?project\//.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (p.startsWith('/api/settings')) return read ? 'settings:read' : 'settings:write';
  if (p.startsWith('/api/defaults/')) return 'task:read';
  if (p.startsWith('/api/profiles')) return read ? 'profile:read' : 'profile:write';
  if (p === '/api/models' || p === '/api/schema' || p === '/api/events/catalog' || p === '/api/contributions') return 'workflow:read';
  if (p === '/api/search/fields') return 'task:read';
  if (p === '/api/attachments') return 'task:create';
  // Reading one back is a read of the task content it belongs to. The exact match
  // above does not cover `/api/attachments/:id`, which therefore fell through to the
  // conservative fallback — an implicit binding for a route that serves task bytes.
  if (p.startsWith('/api/attachments/')) return 'task:read';
  if (p.startsWith('/api/workflows')) return read ? 'workflow:read' : (p.includes('/install') ? 'workflow:install' : 'workflow:edit');
  // `/api/agent-queue*` is a queue surface too, but it does NOT start with
  // `/api/queue`, so it used to fall through to the conservative fallback:
  // `settings:write` at the gateway against `queue:write` in the service layer,
  // which 403'd a maintainer who legitimately holds `queue:*`.
  if (p.startsWith('/api/agent-queue')) return read ? 'queue:read' : 'queue:write';
  if (p.startsWith('/api/queue')) return read ? 'queue:read' : 'queue:write';
  if (p === '/api/projects') return read ? 'project:read' : 'project:create';
  if (/^\/api\/projects\/[^/]+$/.test(p)) return read ? 'project:read' : method === 'DELETE' ? 'project:delete' : 'project:edit';
  if (/^\/api\/projects\/[^/]+\/reorder$/.test(p)) return 'project:edit';
  if (/^\/api\/projects\/[^/]+\/execution-policy$/.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (/^\/api\/projects\/[^/]+\/(defaults|settings|quick-settings)/.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (/^\/api\/projects\/[^/]+\/members/.test(p)) return read ? 'project:read' : 'project:edit';
  if (/^\/api\/projects\/[^/]+\/(?:repositories|repository-sources)/.test(p)) return read ? 'repository:read' : 'repository:write';
  if (/^\/api\/projects\/[^/]+\/resources/.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (/^\/api\/projects\/[^/]+\/(?:secrets|services|environment)(?:\/|$)/.test(p))
    return read ? 'project:settings:read' : 'project:settings:write';
  if (/^\/api\/tasks\/[^/]+\/resources/.test(p)) return read ? 'task:read' : 'task:review:execute';
  if (/^\/api\/projects\/[^/]+\/tasks/.test(p)) return read ? 'task:read' : 'task:create';
  if (/^\/api\/projects\/[^/]+\/search$/.test(p)) return 'task:read';
  if (/^\/api\/projects\/[^/]+\/(tags|views)$/.test(p)) return read ? 'task:read' : 'task:edit';
  if (/^\/api\/(tags|views)\//.test(p)) return read ? 'task:read' : 'task:edit';
  if (/^\/api\/projects\/[^/]+\/workflow-pins$/.test(p)) return read ? 'workflow:read' : 'workflow:edit';
  if (/^\/api\/projects\/[^/]+\/propose-workflow-edit$/.test(p)) return 'workflow:edit';
  if (/\/events$/.test(p) || p === '/api/activity') return 'task:event:read';
  if (/\/(sessions|agents|conversation)$/.test(p)) return 'task:conversation:read';
  if (/\/fork-agent$/.test(p)) return 'task:conversation:fork';
  if (p === '/api/agent/git/publish') return 'task:git:publish';
  if (p === '/api/agent/git/import' || p === '/api/agent/git/refresh-upstream') return 'task:git:import';
  if (p === '/api/agent/escalate' || p === '/api/agent/escalation-targets'
    || p === '/api/agent/permission-requests') return 'task:escalate';
  if (p === '/api/permission-requests' || /^\/api\/permission-requests\/[^/]+\/resolve$/.test(p)) return 'task:read';
  if (p === '/api/agent/collaboration/request') return 'task:conversation:message';
  if (/\/file$/.test(p)) return 'task:conversation:read';
  if (/\/review-action/.test(p) || /\/artifact$/.test(p) || /\/preview\//.test(p) || /\/desktop$/.test(p)) return 'task:review:execute';
  if (/\/artifacts(?:\/promote)?$/.test(p) || /^\/api\/artifacts\//.test(p)) return read ? 'task:read' : 'task:review:execute';
  if (/\/preview-leases$/.test(p) || /^\/api\/preview-leases\//.test(p)) return read ? 'task:read' : 'task:review:execute';
  if (/\/signal$/.test(p)) return 'task:signal';
  if (/\/escalate$/.test(p)) return 'task:escalate';
  if (p.startsWith('/api/tasks/')) return read ? 'task:read' : method === 'DELETE' ? 'task:delete' : 'task:edit';
  if (p === '/api/skills') return 'skill:write';
  return undefined;
}

// Constant-time string comparison for secrets, so a caller can't recover a
// secret byte-by-byte from response timing. Length is compared first (its
// leakage is negligible for high-entropy secrets).
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function capabilityForRequest(method: string, p: string, url?: URL): string | undefined {
  const explicit = routeCapability(method, p, url);
  if (explicit) return explicit === 'none' ? undefined : explicit;
  // Uncataloged routes fail toward broad-read / admin-write rather than open.
  return method === 'GET' ? 'project:read' : 'settings:write';
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

function projectPrincipalFromBody(value: unknown, organizationId: string): ProjectPrincipalRef {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (candidate.kind === 'organization' && candidate.organizationId === organizationId)
      return { kind: 'organization', organizationId };
  }
  return principalFromBody(value);
}

function authorizationSelectionFromBody(value: unknown): AuthorizationSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.level !== 'string' || typeof candidate.scope !== 'string') return undefined;
  return {
    level: candidate.level,
    scope: candidate.scope as AuthorizationSelection['scope'],
    ...(Array.isArray(candidate.projectIds) ? { projectIds: candidate.projectIds.map(String) } : {}),
  };
}

function legacyAuthorizationSelection(profileId: unknown): AuthorizationSelection {
  const level = String(profileId ?? 'developer');
  if (level === 'god') return { level: 'god', scope: 'global' };
  if (level === 'administrator' || level === 'operator') return { level: 'administrator', scope: 'organization' };
  return { level: ['viewer', 'developer', 'maintainer'].includes(level) ? level : 'developer', scope: 'organization' };
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

// SPA path for an organization's settings page (/<org>/settings). Falls back to
// the pre-organization /settings alias, which the client still resolves, when the
// org (or its slug) is unknown.
function organizationSettingsPath(store: Store, organizationId: string): string {
  const slug = store.getOrganization(organizationId)?.slug;
  return slug ? `/${slug}/settings` : '/settings';
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
    if (handle) {
      out.worldProvider = handle.provider ?? handle.kind;
      const handleMeta = handle.meta && typeof handle.meta === 'object'
        ? handle.meta as Record<string, unknown>
        : undefined;
      if (handleMeta?.environmentFlavor === 'desktop') out.worldDesktop = true;
    }
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
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  '.png': 'image/png',
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
  private terminalTickets = new Map<string, { taskId: string; session: Session; expiresAt: number }>();
  private server?: http.Server;
  private safeMode = process.env.KARMAX_SAFE_MODE === '1';
  /** Host-machine affordances (`pass` import, host filesystem paths, a local
   *  checkout to `cd` into) are only offered to the machine karmax runs on. */
  private get hostLocal(): boolean { return this.deps.hostLocal ?? hostLocal(); }
  /** Runs review "run" actions (dev servers, scripts) in the task's world. */
  private reviewActions: ReviewActionRunner;
  private attachments = new AttachmentStore();
  private modelCatalog = new Map<string, { at: number; value: ModelCatalog }>();
  private identityTokens = new Map<string, { apiToken: string; fingerprint: string }>();
  private fanout: DurableEventFanout;
  /** Remotes verified during this gateway process. Persisted links are retried
   * once after every restart so interrupted first pushes self-heal. */
  private wikiRemotesReady = new Set<string>();
  private wikiRemotesProvisioning = new Set<string>();
  private wikiRemoteRetryAfter = new Map<string, number>();
  /** Holds CDP sessions across a passkey enroll/login click (PLAN-passwords §8). */
  private passkeys?: import('../autonomy/passkey.js').PasskeyManager;

  constructor(private deps: GatewayDeps) {
    this.reviewActions = new ReviewActionRunner(deps.worlds, deps.store, deps.runners, deps.worldAccess, deps.resources);
    this.fanout = new DurableEventFanout(deps.store, deps.bus);
  }

  private pendingCredentialRequests(taskId: string): CredentialAccessRequest[] {
    const task = this.deps.store.getTask(taskId);
    const organizationId = task && this.deps.store.getProject(task.projectId)?.organizationId;
    if (!organizationId) return [];
    return new VaultItems(this.deps.store, this.deps.broker, undefined, organizationId)
      .requests({ taskId, status: 'pending' });
  }

  private pendingPermissionRequests(taskId: string) {
    const task = this.deps.store.getTask(taskId);
    const organizationId = task && this.deps.store.getProject(task.projectId)?.organizationId;
    if (!organizationId) return [];
    return new PermissionRequests(this.deps.store, organizationId)
      .requests({ taskId, status: 'pending' });
  }

  private withApprovalRequests(view: TaskView | undefined, taskId: string): TaskView | undefined {
    if (!view) return view;
    const count = this.pendingCredentialRequests(taskId).length + this.pendingPermissionRequests(taskId).length;
    return { ...view, ...(count ? { approvalRequests: count } : { approvalRequests: undefined }) };
  }

  private credentialRequestView(request: CredentialAccessRequest, organizationId: string): CredentialAccessRequest {
    const task = this.deps.store.getTask(request.taskId);
    const project = task && this.deps.store.getProject(task.projectId);
    if (!task || project?.organizationId !== organizationId) return request;
    return { ...request, task: { id: task.id, ...(task.num != null ? { num: task.num } : {}),
      title: task.title, projectId: task.projectId } };
  }

  private emitTaskEvent(event: { taskId: string; type: string; ts: number; payload: Record<string, unknown> }): void {
    const seq = this.deps.store.appendEvent(event);
    this.deps.bus.emit({ ...event, seq });
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

    // Initialize local canonical repos before binding so task starts cannot race
    // that invariant. Remote provisioning is scheduled best-effort by
    // ensureProjectWiki and deliberately does not gate the control plane.
    for (const project of this.deps.store.listProjects()) await this.ensureProjectWiki(project);
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
    const ticket = url.searchParams.get('ticket') ?? '';
    const ticketRecord = ticket ? this.terminalTickets.get(ticket) : undefined;
    if (ticketRecord) this.terminalTickets.delete(ticket); // one connection only
    const auth = ticketRecord && ticketRecord.taskId === taskId && ticketRecord.expiresAt > Date.now()
      ? ticketRecord.session
      : await this.socketAuth(req, url, task?.projectId);
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
      const opened = await this.deps.worlds.open(handle);
      const world = this.deps.resources ? await this.deps.resources.prepare(opened) : opened;
      // Check-in targets a BRANCH, not just the world: a multi-PR task holds
      // several checkouts side by side and the user must be able to open a
      // terminal in any of them (SPEC §11.1). This is the whole cost of that on
      // every backend — the branches are directories in the one world, so a cwd
      // is all it takes, and the remote case needs no second sandbox. An unknown
      // name falls back to the world's default rather than escaping the boundary.
      const wanted = url.searchParams.get('checkout');
      const checkout = wanted
        ? worldRepos(world.handle as import('../world/types.js').WorldHandle).find((r) => r.name === wanted)
        : undefined;
      term = await world.openPty({ cols: 80, rows: 24, ...(checkout ? { cwd: checkout.root } : {}) });
      this.deps.store.setExecutionRunning(executionId);
      this.deps.store.appendExecutionFrame(executionId, 'Terminal opened.\n', 'system');
    } catch (error) {
      if (this.deps.store.execution(executionId)) {
        this.deps.store.appendExecutionFrame(executionId, `${String((error as Error)?.message ?? error)}\n`, 'system');
        this.deps.store.finishExecution(executionId, null, 'failed');
      }
      if (worldLeaseId && this.deps.worldAccess) await this.deps.worldAccess.releaseLeaseAndParkIfIdle(handle, worldLeaseId);
      else if (worldLeaseId) this.deps.runners?.release(worldLeaseId, handle.kind);
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
      if (worldLeaseId && this.deps.worldAccess) void this.deps.worldAccess.releaseLeaseAndParkIfIdle(handle, worldLeaseId);
      else if (worldLeaseId) this.deps.runners?.release(worldLeaseId, handle.kind);
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
    if (p.startsWith('/brand/')) return this.brand(p, res);
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
          sso: this.deps.identity.oidcProviderId ? { providerId: this.deps.identity.oidcProviderId } : null,
          google: this.deps.identity.googleEnabled });
        return this.json(res, 200, {
          authRequired: true,
          authenticated: false,
          setupRequired: !this.deps.identity.hasUsers(),
          signupAvailable: this.deps.identity.hasUsers(),
          sso: this.deps.identity.oidcProviderId ? { providerId: this.deps.identity.oidcProviderId } : null,
          google: this.deps.identity.googleEnabled,
        });
      }
      // Legacy sessions are single-user by construction; minting one on a
      // hosted multi-tenant cell would hand out owner access to a stranger.
      if (this.deps.hosted) return this.json(res, 503, { error: 'hosted mode requires the identity service' });
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
    // Stripe signs this exact raw byte sequence. It cannot pass through the
    // session gate or JSON parsing before signature verification.
    if (p === '/api/payments/stripe/webhook' && method === 'POST') {
      try {
        const provider = this.deps.paymentRegistry?.get('stripe');
        const { StripeIssuingProvider } = await import('../autonomy/payments.js');
        if (!(provider instanceof StripeIssuingProvider))
          return this.json(res, 503, { error: 'Stripe Issuing is unavailable' });
        const raw = await this.rawBody(req, 2 * 1024 * 1024);
        const result = provider.handleWebhook(raw,
          typeof req.headers['stripe-signature'] === 'string' ? req.headers['stripe-signature'] : undefined);
        const body = JSON.stringify(result.body);
        res.writeHead(result.status, {
          'content-type': 'application/json; charset=utf-8',
          ...(result.stripeVersion ? { 'stripe-version': result.stripeVersion } : {}),
          'x-karmax-cell': this.deps.cellId ?? 'local',
        });
        return void res.end(body);
      } catch (error) {
        return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (p === '/api/payments/stripe/callback' && method === 'GET') {
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const oauthError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
      if (oauthError) return this.paymentCallbackPage(res, 400, `Stripe connection was not completed: ${oauthError}`);
      if (!code || !state) return this.paymentCallbackPage(res, 400, 'The Stripe callback is incomplete.');
      try {
        const provider = this.deps.paymentRegistry?.get('stripe');
        const { StripeIssuingProvider } = await import('../autonomy/payments.js');
        if (!(provider instanceof StripeIssuingProvider)) throw new Error('Stripe Issuing is unavailable');
        const connection = await provider.completeOAuth(state, code);
        const destination = `${organizationSettingsPath(this.deps.store, connection.organizationId)}?payments=stripe-connected&organizationId=${encodeURIComponent(connection.organizationId)}`;
        res.writeHead(303, { location: destination });
        return void res.end();
      } catch (error) {
        return this.paymentCallbackPage(res, 502,
          `Stripe could not be connected: ${error instanceof Error ? error.message : String(error)}`);
      }
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
        // GitHub's PR lifecycle enters karmax as ordinary task events, so the
        // timeline and `event` triggers see it like any other happening (SPEC §5.4).
        // The service already resolved each event to a task of the installing
        // organization, so dispatch is unconditional here.
        const { events, ...body } = result;
        for (const event of events ?? [])
          this.emitTaskEvent({ taskId: event.taskId, type: event.type, ts: Date.now(), payload: event.payload });
        return this.json(res, 200, { ...body, ...(events?.length ? { dispatched: events.length } : {}) });
      } catch (error) {
        // Only a genuine signature failure is a 401. Answering 401 for ANY
        // exception made GitHub redeliver — but `handleWebhook` has already
        // inserted the delivery dedupe row by then, so the redelivery
        // short-circuits as a duplicate and the reconcile is lost forever. A 5xx
        // is the honest answer for a processing fault and is equally retried.
        const message = error instanceof Error ? error.message : String(error);
        return this.json(res, /webhook signature/i.test(message) ? 401 : 500, { error: message });
      }
    }
    // Agent mailbox inbound webhook (PLAN-passwords.md §8): authenticated by a
    // configured shared secret, not a karmax session — so it sits with the other
    // unauthenticated endpoints, before the session gate.
    if (p === '/api/agent-mail/ingest' && method === 'POST') {
      const mailMod = await import('../autonomy/agent-mail.js');
      // Auth: the minted secret (in the copy-pasted webhook URL or a Bearer
      // header) — forwarding services can rarely set custom headers, so the
      // query form is the primary one. Legacy env secret stays accepted.
      const minted = mailMod.ingestSecret(this.deps.store);
      const presented = url.searchParams.get('secret')
        ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
      const legacy = process.env.KARMAX_AGENT_MAIL_SECRET;
      // Constant-time compare so the secret can't be recovered byte-by-byte via
      // response timing (matches the Stripe webhook check).
      const secretOk = !!presented && (timingSafeEqualStr(presented, minted) || (!!legacy && timingSafeEqualStr(presented, legacy)));
      if (!secretOk)
        return this.json(res, 401, { error: 'agent-mail ingest requires the webhook secret (the ?secret= in the URL krmax shows the operator)' });
      // Providers POST different shapes/encodings; parse by content-type and
      // normalize (karmax JSON, Postmark, CloudMailin, Mailgun, SendGrid, raw
      // MIME from the Cloudflare Email Worker).
      const rawBody = await this.rawBody(req, 8 * 1024 * 1024);
      const contentType = String(req.headers['content-type'] ?? '');
      let fields: Record<string, any> = {};
      try {
        if (contentType.includes('multipart/form-data')) fields = mailMod.parseMultipart(rawBody.toString('utf8'), contentType);
        else if (contentType.includes('application/x-www-form-urlencoded')) fields = mailMod.parseUrlEncoded(rawBody.toString('utf8'));
        else fields = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return this.json(res, 400, { error: 'unparseable body (expected JSON, form-urlencoded, or multipart/form-data)' });
      }
      const msg = mailMod.normalizeInbound(fields);
      if (!msg.to || !msg.from) return this.json(res, 400, { error: 'could not find a recipient/sender in the payload' });
      // Routed by recipient to the owning organization; unknown recipients are
      // dropped (never leaked into any tenant's inbox). Never echo the message.
      const { delivered } = new mailMod.AgentMail(this.deps.store)
        .ingest({ to: mailMod.cleanAddress(msg.to), from: mailMod.cleanAddress(msg.from), subject: msg.subject ? String(msg.subject) : undefined, text: String(msg.text ?? '') });
      return this.json(res, 200, { delivered });
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
        for (const project of this.deps.store.listProjects().filter((candidate) => candidate.organizationId === pending.organizationId))
          await this.ensureProjectWiki(project, identity.user.id);
        res.writeHead(303, { location: `${organizationSettingsPath(this.deps.store, pending.organizationId)}?github=ready&organizationId=${encodeURIComponent(pending.organizationId)}` });
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
        for (const project of this.deps.store.listProjects().filter((candidate) => candidate.organizationId === pending.organizationId))
          await this.ensureProjectWiki(project, identity.user.id);
        res.writeHead(303, { location: `${organizationSettingsPath(this.deps.store, pending.organizationId)}?github=connected&organizationId=${encodeURIComponent(pending.organizationId)}` });
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
      if (this.deps.hosted) return this.json(res, 503, { error: 'hosted mode requires the identity service' });
      // Constant-time, like the Stripe webhook and the agent-mail ingest secret:
      // this compares a shared secret on an unauthenticated route.
      if (this.deps.password && timingSafeEqualStr(String(b.password ?? ''), this.deps.password)) {
        const { sid } = this.newSession();
        return this.json(res, 200, { token: sid, user: 'me' });
      }
      return this.json(res, 401, { error: 'invalid password' });
    }
    if (p === '/api/setup' && method === 'POST' && this.deps.identity) {
      if (this.deps.identity.hasUsers()) return this.json(res, 409, { error: 'krmax has already been set up' });
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
      // explicit trust root. Later self-signups each land in their own personal
      // workspace organization (provisioned below) — a usable app immediately,
      // and they can still be invited into other organizations.
      if (!this.deps.identity.hasUsers()) return this.json(res, 409, { error: 'set up the first administrator before signing up' });
      const b = await this.body(req);
      try {
        const response = await this.deps.identity.signUp(
          { name: String(b.name ?? ''), email: String(b.email ?? ''), password: String(b.password ?? '') },
          requestHeaders(req.headers),
        );
        if (!response.ok) {
          // Better Auth reports the real reason as `.message` (e.g. "User already
          // exists"). Surface it verbatim instead of the client's generic
          // fallback, so a duplicate email or weak password reads clearly.
          const detail = (await response.clone().json().catch(() => ({}))) as any;
          return this.json(res, response.status === 422 ? 409 : (response.status || 400),
            { error: detail?.message ?? 'could not create account' });
        }
        // A fresh identity gets its own personal-workspace organization so it
        // lands in a usable app immediately — no "no access yet" waiting room.
        const created = (await response.clone().json().catch(() => ({}))) as any;
        const userId = created?.user?.id ? String(created.user.id) : undefined;
        if (userId) this.provisionPersonalWorkspace(userId, String(created?.user?.name ?? b.name ?? ''));
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
        hostLocal: this.hostLocal,
        worldProviders: this.deps.worlds.catalog(),
        // Which inbox delivery channels actually have an adapter wired. The console
        // used to render Email/Slack switches unconditionally and toast "saved" for
        // them, but `src/main.ts` only registers those adapters when
        // KARMAX_EMAIL_DELIVERY_URL / KARMAX_SLACK_DELIVERY_URL are set — so a user
        // could enable Email, be told it saved, and then simply never be notified
        // again (the failure was logged server-side only). Report the truth and let
        // the UI disable what cannot work.
        deliveryChannels: this.deps.deliveryChannels ?? ['browser'],
        sso: this.deps.identity?.oidcProviderId ? { providerId: this.deps.identity.oidcProviderId } : null,
        google: this.deps.identity?.googleEnabled ?? false,
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
    const auditScope = requestedScope.projectId ? `project:${requestedScope.projectId}`
      : requestedScope.organizationId ? `organization:${requestedScope.organizationId}` : 'global';
    const session = await this.auth(req, requestedScope.projectId, requestedScope.organizationId);
    if (!session) {
      // Denials are audited too: cross-tenant probing must be visible to an
      // administrator, not only successful requests.
      this.deps.authorization?.audit('anonymous', 'http.denied.unauthenticated', auditScope, { path: p, method });
      return this.json(res, 401, { error: 'unauthorized' });
    }
    const token = session.apiToken;
    const { api, store } = this.deps;
    let authRecord = this.deps.tokens.verify(token);
    const organizationResource = p.match(/^\/api\/organizations\/([^/]+)\/(accounts|git-profiles|credentials|workflows)(\/.*)?$/);
    // The legacy un-namespaced aliases (`/api/accounts`, `/api/git-profiles`,
    // `/api/credentials`) carry no organization, and `requestScope` derives none
    // for them — so this used to fall straight through to `org_personal` and
    // read/write ANOTHER tenant's credential handles and config-home logins with
    // the tenant guard inert. The bearer's own organization is the correct
    // default (the payments block at `/api/cards` already does exactly this).
    const resourceOrganizationId = organizationResource?.[1] ?? requestedScope.organizationId
      ?? authRecord?.organizationId ?? 'org_personal';
    const resourcePath = organizationResource
      ? `/api/${organizationResource[2]}${organizationResource[3] ?? ''}`
      : p;

    const required = capabilityForRequest(method, p, url);
    if (required) {
      const scope = requestedScope;
      const checked = this.deps.tokens.check(token, required, scope);
      // The project collection has no single scope. A project-only human may
      // enter it when at least one project grant permits discovery; the response
      // below is filtered project-by-project. No other unscoped route gets this
      // exception.
      const collectionAllowed = !checked.ok && p === '/api/projects' && method === 'GET' && !!session.userId && (
        // A member of any organization may enter (even before any project exists)
        // — the response is filtered project-by-project, so an empty org just
        // yields an empty list and the app lands on that org's dashboard rather
        // than the "no access" waiting room.
        this.deps.store.listOrganizations(session.userId).length > 0 ||
        this.deps.store.listProjects().some((project) => allows(this.deps.authorization?.capabilities(`user:${session.userId}`, project.id) ?? [], required)));
      const organizationCollectionAllowed = !checked.ok && p === '/api/organizations' && !!session.userId && (
        method === 'POST' || this.deps.store.listOrganizations(session.userId).some((organization) =>
          allows(this.deps.authorization?.capabilities(`user:${session.userId}`, undefined, organization.id) ?? [], required))
      );
      const principal = checked.record?.principal ?? (session.userId ? `user:${session.userId}` : session.user);
      if (!checked.ok && !collectionAllowed && !organizationCollectionAllowed) {
        this.deps.authorization?.audit(principal, `http.denied.${required}`, auditScope,
          { path: p, method, reason: checked.reason ?? `missing capability ${required}` });
        return this.json(res, 403, { error: checked.reason ?? `missing capability ${required}` });
      }
      if (checked.ok) authRecord = checked.record;
      this.deps.authorization?.audit(principal, `http.${method.toLowerCase()}.${required}`, auditScope, { path: p });
    }

    try {
      if (p === '/api/logout' && method === 'POST') {
        const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
        if (bearer) this.sessions.delete(bearer);
        if (this.deps.identity) return this.sendWebResponse(res, await this.deps.identity.signOut(requestHeaders(req.headers)));
        return this.json(res, 200, { ok: true });
      }
      if (p === '/api/platform' && method === 'GET') return this.json(res, 200, PLATFORM_API_CATALOG);
      if (p === '/api/resource-drivers' && method === 'GET') return this.json(res, 200, resourceDriverCatalog());
      // Remote access drives `tailscale`/`pkexec` ON THE HOST. That is a
      // host-machine affordance, so it follows `hostLocal` (the console hides it
      // on the same predicate), not `hosted` — a self-host served on a public URL
      // is `hosted:false, hostLocal:false` and must not offer it.
      if (p === '/api/remote-access' && method === 'GET') {
        if (!this.hostLocal || !this.deps.remoteAccess) return this.json(res, 503, { error: 'remote access is unavailable' });
        return this.json(res, 200, await this.deps.remoteAccess.setupStatus());
      }
      if (p === '/api/remote-access' && method === 'POST') {
        if (!this.hostLocal || !this.deps.remoteAccess) return this.json(res, 503, { error: 'remote access is unavailable' });
        const b = await this.body(req);
        if (b.action === 'setup') return this.json(res, 202, this.deps.remoteAccess.beginSetup());
        if (b.action === 'enable') return this.json(res, 200, await this.deps.remoteAccess.enable());
        if (b.action === 'disable') return this.json(res, 200, await this.deps.remoteAccess.disable());
        return this.json(res, 400, { error: 'action must be setup, enable, or disable' });
      }

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
        let organization;
        try {
          organization = store.createOrganization({ name: String(b.name ?? 'My organization'),
            slug: b.slug ? String(b.slug) : undefined, kind: b.kind === 'personal' ? 'personal' : 'team', ownerUserId: session.userId });
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        this.deps.authorization?.bootstrapOrganizationOwner(`user:${session.userId}`, session.userId, organization.id);
        return this.json(res, 200, organization);
      }
      if (p === '/api/invitations/accept' && method === 'POST') {
        if (!session.userId || !session.email) return this.json(res, 400, { error: 'a verified account is required' });
        const b = await this.body(req);
        try {
          const membership = store.acceptOrganizationInvitation(String(b.token ?? ''), session.userId, session.email);
          this.deps.authorization?.replacePrincipalAuthorization('system:invitation', `user:${session.userId}`,
            membership.organizationId, membership.authorization ?? legacyAuthorizationSelection(membership.profileId), ['*']);
          return this.json(res, 200, membership);
        } catch (e) {
          // Expired / already-used / wrong-email are user-facing, not 500s.
          return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
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
        res.setHeader('Content-Disposition', `attachment; filename="krmax-${organizationExport[1]!}-export.json"`);
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
        for (const connection of store.listPaymentConnections(organizationId)) {
          const provider = this.deps.paymentRegistry?.get(connection.provider) as any;
          if (provider && typeof provider.disconnect === 'function') await provider.disconnect(organizationId);
        }
        await this.deps.githubApp?.disconnectOrganization(organizationId);
        for (const connection of this.deps.providerConnections?.list(organizationId) ?? [])
          this.deps.providerConnections?.delete(organizationId, connection.provider);
        this.deps.resources?.deleteOrganizationKey(organizationId);
        const { GitProfiles } = await import('../autonomy/git-profiles.js');
        const gitProfiles = new GitProfiles(store, this.deps.broker, undefined, organizationId);
        for (const profile of gitProfiles.list()) gitProfiles.delete(profile.name);
        const { agentAccountHandles } = await import('../platform/credential-sources.js');
        for (const handle of agentAccountHandles(this.deps.broker?.listHandles() ?? [], organizationId))
          this.deps.broker?.deleteHandle(handle);
        this.deps.configHomes?.removeOrganization(organizationId);
        await this.deps.workflows?.removeOrganization(organizationId);
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
            const authorization = this.deps.authorization?.selectionForPrincipal(`user:${membership.userId}`, organizationId)
              ?? (membership.role === 'owner' ? { level: 'administrator', scope: 'organization' } : undefined);
            return { ...membership, authorization, profileId: authorization?.level ?? 'viewer',
              protectedOwner: membership.role === 'owner', ...(user ? { user: { id: user.id, name: user.name, email: user.email } } : {}) };
          }));
        }
        if (method === 'POST') {
          const b = await this.body(req);
          const authorization = authorizationSelectionFromBody(b.authorization) ?? legacyAuthorizationSelection(b.profileId);
          this.deps.authorization?.assertCanGrantSelection(authRecord?.principal ?? `user:${session.userId}`,
            organizationId, authorization, authRecord?.kind === 'human' ? undefined : authRecord?.caps);
          const existing = store.organizationMembership(organizationId, String(b.userId));
          const membership = store.setOrganizationMembership(organizationId, String(b.userId), existing?.role === 'owner' ? 'owner' : 'member');
          this.deps.authorization?.replacePrincipalAuthorization(authRecord?.principal ?? `user:${session.userId}`,
            `user:${membership.userId}`, organizationId, authorization,
            authRecord?.kind === 'human' ? undefined : authRecord?.caps);
          return this.json(res, 200, { ...membership, authorization });
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
          const authorization = authorizationSelectionFromBody(b.authorization) ?? legacyAuthorizationSelection(b.profileId);
          this.deps.authorization?.assertCanGrantSelection(authRecord?.principal ?? `user:${session.userId}`,
            organizationId, authorization, authRecord?.kind === 'human' ? undefined : authRecord?.caps);
          const result = store.createOrganizationInvitation({ organizationId, email: String(b.email ?? ''),
            role: 'member', authorization, invitedBy: `user:${session.userId}` });
          // Auto-deliver the invite when outbound email is configured; the copyable
          // link is still returned as a fallback (and for email-less installs).
          let emailed = false;
          if (this.deps.email?.configured() && result.invitation.email) {
            const link = `${this.publicUrl(req)}/invite?token=${encodeURIComponent(result.token)}`;
            const organization = store.getOrganization(organizationId);
            const orgName = organization?.name ?? 'a krmax organization';
            const { emailHtml } = await import('../auth/identity.js');
            try {
              await this.deps.email.send({
                to: result.invitation.email,
                subject: `You've been invited to ${orgName} on krmax`,
                text: `You've been invited to join ${orgName} on krmax.\n\nAccept the invitation:\n\n${link}\n\nThis is a one-time link. If you weren't expecting this, you can ignore it.`,
                html: emailHtml(`You've been invited to ${orgName}`,
                  `You've been invited to join ${orgName} on krmax. Accept the invitation to get started.`,
                  'Accept invitation', link, `This is a one-time link. If you weren't expecting this, you can ignore it.`),
              });
              emailed = true;
            } catch (e) { console.error('[invite] email send failed:', e instanceof Error ? e.message : e); }
          }
          return this.json(res, 200, { ...result, emailed });
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
          const connected = await this.deps.githubApp.connectInstallation(organizationId, String(b.installationId ?? ''));
          for (const project of store.listProjects().filter((candidate) => candidate.organizationId === organizationId))
            await this.ensureProjectWiki(project, session.userId);
          return this.json(res, 200, connected);
        }
      }
      const githubAppSetup = p.match(/^\/api\/organizations\/([^/]+)\/github\/app$/);
      if (githubAppSetup) {
        if (!this.deps.githubApp) return this.json(res, 503, { error: 'GitHub integration is unavailable' });
        if (method === 'GET') return this.json(res, 200, this.deps.githubApp.status(session.userId));
        if (method === 'PUT') {
          if (!this.deps.tokens.check(token, 'user:write').ok)
            return this.json(res, 403, { error: 'Only a Krmax installation administrator can configure the shared GitHub App' });
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
          return this.json(res, 403, { error: 'Only a Krmax installation administrator can create the shared GitHub App' });
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
          for (const project of store.listProjects().filter((candidate) => candidate.organizationId === githubRefresh[1]))
            await this.ensureProjectWiki(project, session.userId);
          return this.json(res, 200, { repositories, count: repositories.length });
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const organizationRepositories = p.match(/^\/api\/organizations\/([^/]+)\/repositories$/);
      if (organizationRepositories) {
        const organizationId = organizationRepositories[1]!;
        if (method === 'GET') return this.json(res, 200,
          store.listRepositories(organizationId).filter((repository) => !store.repositoryIsProjectWiki(repository.id)));
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
          let project;
          try {
            project = store.createProject(String(b.name ?? 'New project'), normalizeConfig(b.config), organizationId);
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
          if (session.userId) store.setProjectMembership(project.id, { kind: 'user', userId: session.userId }, 'owner');
          await this.ensureProjectWiki(project, session.userId);
          await this.spawnProjectPrepTask(token, project.id);
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
      if (usage && method === 'GET') {
        const now = Date.now();
        const date = new Date(now);
        const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
        const from = Number(url.searchParams.get('from') ?? monthStart);
        const to = Number(url.searchParams.get('to') ?? now);
        const sync = store.listWorldProviderConnections(usage[1]!).map((connection) => {
          try { return { provider: connection.provider,
            ...JSON.parse(store.kvGet(`usage-sync:${usage[1]}:${connection.provider}`) ?? '{"status":"pending"}') }; }
          catch { return { provider: connection.provider, status: 'pending' }; }
        });
        return this.json(res, 200, { ...store.usageSummary(usage[1]!, from, to), from, to, sync });
      }

      if (p === '/api/inbox' && method === 'GET') {
        if (!session.userId || !requestedScope.organizationId) return this.json(res, 400, { error: 'organizationId is required' });
        const items = store.listInbox(session.userId, requestedScope.organizationId,
          { unreadOnly: url.searchParams.get('unread') === '1', limit: Number(url.searchParams.get('limit') ?? 200) });
        const headers = store.taskHeaders(items.map((item) => item.taskId));
        return this.json(res, 200, items.map((item) => ({ ...item, task: headers.get(item.taskId) })));
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
        // The panel needs only counts. `agentQueueView` is bound to `queue:read`
        // (it is a queue surface), so a principal holding `diagnostic:read`
        // alone still gets host stats rather than a blanket 403.
        const queue = await api.agentQueueView(token).catch(() => ({
          capacity: Number(store.getSettings('global', 'agent-queue')?.capacity) || 3,
          queue: [] as unknown[], current: [] as unknown[],
        }));
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
        if (authRecord?.projectIds?.length) return this.json(res, 200,
          projects.filter((x) => authRecord!.projectIds!.includes(x.id)));
        // An organization-scoped token discovers its own tenant's projects only.
        if (authRecord?.organizationId) return this.json(res, 200,
          projects.filter((x) => (x.organizationId ?? 'org_personal') === authRecord!.organizationId));
        if (session.userId && this.deps.authorization) {
          const principal = `user:${session.userId}`;
          return this.json(res, 200, projects.filter((x) => allows(this.deps.authorization!.capabilities(principal, x.id), 'project:read')));
        }
        // Identity-backed deployments never legitimately reach here: a session
        // that cannot be attributed to a user or a scoped token sees nothing.
        // The bare return is single-user legacy mode (no identity service).
        if (this.deps.identity) return this.json(res, 200, []);
        return this.json(res, 200, projects);
      }
      if (p === '/api/projects' && method === 'POST') {
        if (this.deps.hosted)
          return this.json(res, 400, { error: 'hosted projects must be created inside an organization' });
        const b = await this.body(req);
        let project;
        try {
          project = store.createProject(b.name ?? 'New project', normalizeConfig(b.config, true));
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        await this.ensureProjectWiki(project, session.userId);
        await this.spawnProjectPrepTask(token, project.id);
        return this.json(res, 200, project);
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
      // Sidebar order. The drop tells us which project the dragged one now sits
      // above (`before`); omitting it means "last". Sending the neighbour rather
      // than an absolute index keeps a drag correct against a list that changed
      // under the user, and the store re-densifies the organization's positions.
      const projReorder = p.match(/^\/api\/projects\/([^/]+)\/reorder$/);
      if (projReorder && method === 'POST') {
        const b = await this.body(req);
        try {
          return this.json(res, 200, store.reorderProject(projReorder[1]!, b.before ?? undefined));
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
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
      // Product-facing secret view over typed resource attachments. Values are
      // write-only; .env example files provide lazy suggestions.
      const projectSecrets = p.match(/^\/api\/projects\/([^/]+)\/secrets(?:\/([^/]+))?$/);
      if (projectSecrets && ['GET', 'POST', 'DELETE'].includes(method)) {
        const project = store.getProject(projectSecrets[1]!);
        if (!project?.organizationId) return this.json(res, 404, { error: 'project not found' });
        if (!this.deps.broker || !this.deps.resources)
          return this.json(res, 503, { error: 'project resources are unavailable' });
        const resources = store.listResourceAttachments(project.id, true)
          .filter((resource) => resource.driver === 'secret@1');
        const encodedName = projectSecrets[2] ? decodeURIComponent(projectSecrets[2]) : undefined;
        if (method === 'GET' && !encodedName) {
          const names = await discoverEnvironmentNames(project, store, this.deps.githubApp);
          const existing = new Set(resources.map((resource) => resource.target.kind === 'environment'
            ? resource.target.name : resource.name));
          return this.json(res, 200, { secrets: resources.map((resource) => ({
            ...redactResource(resource),
            file: resource.target.kind === 'path' ? resource.target.path : undefined,
            variable: resource.target.kind === 'environment' ? resource.target.name : undefined,
          })), suggestions: [...names].filter((name) => !existing.has(name)).sort() });
        }
        if (method === 'POST' && !encodedName) {
          const body = await this.body(req);
          const entries: Array<{ name: string; value: string; file?: string }> =
            typeof body.env === 'string' ? parseEnvironmentValues(body.env)
            : body.name ? [{ name: String(body.name), value: body.value == null ? '' : String(body.value),
              file: body.file ? String(body.file) : undefined }] : [];
          if (!entries.length) return this.json(res, 400, { error: 'name/value or pasted env required' });
          const saved: ResourceAttachment[] = [];
          try {
            for (const entry of entries) {
              const existing = resources.find((resource) =>
                resource.name === entry.name || (resource.target.kind === 'environment' && resource.target.name === entry.name));
              if (existing) {
                const handle = existing.credentialHandles[0] ?? `resource:${existing.id}:credential`;
                if (entry.value) this.deps.broker.registerHandle(handle, entry.value);
                saved.push(store.updateResourceAttachment(existing.id, {
                  target: entry.file ? { kind: 'path', path: entry.file } : { kind: 'environment', name: entry.name },
                  credentialHandles: [handle], enabled: true,
                }));
              } else {
                if (!entry.value) continue;
                const id = newId('resource'), handle = `resource:${id}:credential`;
                this.deps.broker.registerHandle(handle, entry.value);
                saved.push(store.createResourceAttachment({ id, organizationId: project.organizationId,
                  projectId: project.id, name: entry.name, driver: 'secret@1',
                  target: entry.file ? { kind: 'path', path: entry.file } : { kind: 'environment', name: entry.name },
                  access: 'read', isolation: 'fork', source: { discovered: typeof body.env === 'string' },
                  credentialHandles: [handle], publish: 'discard' }));
              }
            }
            return this.json(res, 200, { imported: saved.map(redactResource), secrets: saved.map(redactResource) });
          } catch (error) {
            return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (method === 'DELETE' && encodedName) {
          const resource = resources.find((candidate) => candidate.id === encodedName || candidate.name === encodedName
            || (candidate.target.kind === 'environment' && candidate.target.name === encodedName));
          if (!resource) return this.json(res, 404, { error: 'secret not found' });
          await this.deps.resources.deleteAttachment(resource.id);
          return this.json(res, 200, { deleted: true });
        }
      }

      // Environment recipe, repo-derived proposal, and immutable provider build.
      const projectEnvironment = p.match(/^\/api\/projects\/([^/]+)\/environment(?:\/(proposal|build))?$/);
      if (projectEnvironment && ['GET', 'PUT', 'POST'].includes(method)) {
        const project = store.getProject(projectEnvironment[1]!);
        if (!project?.organizationId) return this.json(res, 404, { error: 'project not found' });
        const { ProjectEnvironment, proposeEnvironment } = await import('../store/project-environment.js');
        const environments = new ProjectEnvironment(store);
        const sub = projectEnvironment[2];
        try {
          if (method === 'GET' && !sub) {
            const spec = environments.spec(project.id);
            return this.json(res, 200, { spec: spec ?? null,
              digest: spec ? environments.digest(spec) : null, builds: environments.builds(project.id) });
          }
          if (method === 'PUT' && !sub) {
            const body = await this.body(req);
            const list = (value: unknown) => Array.isArray(value) ? value.map(String)
              : typeof value === 'string' ? value.split('\n') : [];
            const spec = environments.setSpec(project.id, { image: body.image ? String(body.image) : undefined,
              setup: list(body.setup), boot: list(body.boot), includeDocker: Boolean(body.includeDocker) });
            return this.json(res, 200, { spec, digest: environments.digest(spec) });
          }
          if (method === 'GET' && sub === 'proposal') {
            const dirs = projectRepositoryDirectories(project);
            const { ProjectServices } = await import('../store/project-services.js');
            return this.json(res, 200, proposeEnvironment(dirs, {
              hasPerWorldServices: new ProjectServices(store).list(project.id)
                .some((service) => service.kind === 'per-world'),
            }));
          }
          if (method === 'POST' && sub === 'build') {
            const spec = environments.spec(project.id);
            if (!spec) return this.json(res, 400, { error: 'accept or configure an environment proposal first' });
            const body = await this.body(req);
            const provider = String(body.provider ?? store.effectiveProjectConfig(project).worldProvider ?? 'worktree');
            const digest = environments.digest(spec);
            const connection = ['e2b', 'daytona'].includes(provider)
              ? this.deps.providerConnections?.resolve(project.organizationId, provider) : undefined;
            environments.recordBuild(project.id, { provider, digest, status: 'building' });
            const { buildEnvironment } = await import('../world/environment-build.js');
            void buildEnvironment({ provider, projectId: project.id, digest, spec,
              ...(connection ? { connection: { apiKey: connection.apiKey,
                apiUrl: (connection.config as any)?.apiUrl, target: (connection.config as any)?.target,
                template: (connection.config as any)?.template } } : {}) })
              .then((result) => environments.recordBuild(project.id,
                { provider, digest, ref: result.ref, status: 'ready' }))
              .catch((error) => environments.recordBuild(project.id,
                { provider, digest, status: 'failed', error: String(error instanceof Error ? error.message : error).slice(0, 800) }));
            return this.json(res, 202, { building: { provider, digest } });
          }
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      // Service recipes. Per-world services consume Task 253 resources as
      // optional read-only seeds; they never introduce a parallel object store.
      const projectServices = p.match(/^\/api\/projects\/([^/]+)\/services(?:\/(compose-import))?$/);
      if (projectServices && ['GET', 'POST', 'DELETE'].includes(method)) {
        const project = store.getProject(projectServices[1]!);
        if (!project) return this.json(res, 404, { error: 'project not found' });
        const { ProjectServices, composeServiceProposals } = await import('../store/project-services.js');
        const services = new ProjectServices(store);
        try {
          if (method === 'GET' && projectServices[2] === 'compose-import') {
            const { readDevcontainer } = await import('../store/project-environment.js');
            const proposals = [];
            for (const dir of projectRepositoryDirectories(project)) {
              const devcontainer = readDevcontainer(dir);
              const candidates = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml',
                ...(devcontainer?.composeFiles ?? []),
                '.devcontainer/docker-compose.yml', '.devcontainer/docker-compose.yaml'];
              for (const candidate of candidates) {
                const filename = path.join(dir, candidate);
                if (!fs.existsSync(filename)) continue;
                proposals.push(...composeServiceProposals(fs.readFileSync(filename, 'utf8')));
                break;
              }
            }
            const existing = new Set(services.list(project.id).map((service) => service.name));
            return this.json(res, 200, { proposals: proposals.filter((service) => !existing.has(service.name)) });
          }
          if (method === 'GET') return this.json(res, 200, { services: services.list(project.id) });
          if (method === 'POST' && !projectServices[2]) {
            const body = await this.body(req);
            if (body.seedResourceId) {
              const resource = store.getResourceAttachment(String(body.seedResourceId));
              if (!resource || resource.projectId !== project.id || resource.target.kind !== 'path')
                return this.json(res, 400, { error: 'seed resource must be a path resource in this project' });
            }
            if (body.connectionResourceId) {
              const resource = store.getResourceAttachment(String(body.connectionResourceId));
              if (!resource || resource.projectId !== project.id || !credentialResource(resource))
                return this.json(res, 400, { error: 'connection resource must be a secret/service attachment in this project' });
            }
            return this.json(res, 200, { service: services.save(project.id, body as any) });
          }
          if (method === 'DELETE') {
            const name = url.searchParams.get('name');
            if (!name) return this.json(res, 400, { error: 'name required' });
            services.delete(project.id, name);
            return this.json(res, 200, { deleted: true });
          }
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      const projectResources = p.match(/^\/api\/projects\/([^/]+)\/resources$/);
      if (projectResources) {
        const project = store.getProject(projectResources[1]!);
        if (!project?.organizationId) return this.json(res, 404, { error: 'project not found' });
        if (!this.deps.resources) return this.json(res, 503, { error: 'project resources are unavailable' });
        if (method === 'GET') return this.json(res, 200, store.listResourceAttachments(project.id, true).map((resource) => ({
          ...redactResource(resource),
          revision: resource.currentRevisionId ? redactResourceRevision(store.getResourceRevision(resource.currentRevisionId)) : undefined,
        })));
        if (method === 'POST') {
          const b = await this.body(req, 600 * 1024 * 1024);
          const id = newId('resource');
          const driver = String(b.driver ?? 'volume@1');
          const secret = typeof b.secret === 'string' ? b.secret : undefined;
          const credentialHandles: string[] = [];
          if (credentialResource(driver)) {
            if (!secret) return this.json(res, 400, { error: 'secret value is required for this resource driver' });
            if (!this.deps.broker) return this.json(res, 503, { error: 'credential broker is unavailable' });
            const handle = `resource:${id}:credential`;
            this.deps.broker.registerHandle(handle, secret);
            credentialHandles.push(handle);
          }
          try {
            const resource = store.createResourceAttachment({ id, organizationId: project.organizationId,
              projectId: project.id, name: String(b.name ?? 'Resource'), driver,
              target: normalizeResourceTarget(b.target, driver, String(b.name ?? 'resource')),
              access: b.access === 'write' ? 'write' : 'read', isolation: b.isolation === 'shared' ? 'shared' : 'fork',
              source: b.source && typeof b.source === 'object' ? b.source : {}, credentialHandles,
              publish: b.publish === 'review' ? 'review' : 'discard' });
            let revision;
            if (isSnapshotResourceDriver(driver)) {
              if (typeof b.sourcePath === 'string') {
                // A host filesystem path only means something when the browser and
                // the host are the same machine. Gating on `hosted` alone let a
                // remote caller on a public self-host import `/etc` or `~/.ssh`
                // and download it back as a resource revision.
                if (!this.hostLocal) throw new Error('resource imports must upload bytes; a browser-local path is not available unless Krmax runs on your machine');
                revision = await this.deps.resources.importDirectory(resource.id, expandPath(b.sourcePath));
              } else if (Array.isArray(b.files)) {
                revision = await this.deps.resources.importFiles(resource.id, decodeResourceFiles(b.files));
              }
            }
            store.appendAudit({ principalId: session.userId ? `user:${session.userId}` : 'system:legacy-user',
              action: 'resource:create', scopeKey: `project:${project.id}`, detail: { resourceId: resource.id, driver } });
            return this.json(res, 200, { ...redactResource(store.getResourceAttachment(resource.id)!),
              revision: redactResourceRevision(revision) });
          } catch (error) {
            for (const handle of credentialHandles) this.deps.broker?.deleteHandle(handle);
            store.deleteResourceAttachment(id);
            return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      const copyGlobsMigration = p.match(/^\/api\/projects\/([^/]+)\/resources\/import-copyglobs$/);
      if (copyGlobsMigration && method === 'POST') {
        const project = store.getProject(copyGlobsMigration[1]!);
        if (!project?.organizationId) return this.json(res, 404, { error: 'project not found' });
        // `hostLocal`, not `hosted` — the same gate as the scan/import routes above,
        // and for the same reason: this walks the HOST filesystem
        // (ProjectResourceService.migrateCopyGlobs readdir/reads the project's repo
        // roots) and turns what it finds into resources that materialize into the
        // task world, where the caller can read them from a terminal. `hosted` and
        // `hostLocal` are orthogonal, so a self-host on a public URL
        // (`hosted:false, hostLocal:false`) was serving this to remote callers.
        // The console already hides it on `hostLocal()`; this was the missing half.
        if (!this.hostLocal) return this.json(res, 400,
          { error: 'copyGlobs migration requires access to the project’s local or managed checkout' });
        if (!this.deps.resources) return this.json(res, 503, { error: 'project resources are unavailable' });
        try {
          return this.json(res, 200, await this.deps.resources.migrateCopyGlobs(project));
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const projectResource = p.match(/^\/api\/projects\/([^/]+)\/resources\/(?!scan$)([^/]+)$/);
      if (projectResource) {
        const resource = store.getResourceAttachment(projectResource[2]!);
        if (!resource || resource.projectId !== projectResource[1]) return this.json(res, 404, { error: 'resource not found' });
        if (method === 'GET') return this.json(res, 200, { ...redactResource(resource),
          revisions: store.listResourceRevisions(resource.id).map(redactResourceRevision) });
        if (method === 'PATCH') {
          const b = await this.body(req);
          try {
            let secretUpdate: { handle: string; value: string } | undefined;
            if (typeof b.secret === 'string') {
              if (!this.deps.broker) throw new Error('credential broker is unavailable');
              const handle = resource.credentialHandles[0] ?? `resource:${resource.id}:credential`;
              b.credentialHandles = [handle];
              secretUpdate = { handle, value: b.secret };
            }
            const next = store.updateResourceAttachment(resource.id, {
              ...(b.name !== undefined ? { name: String(b.name) } : {}),
              ...(b.target !== undefined ? { target: normalizeResourceTarget(b.target, resource.driver, resource.name) } : {}),
              ...(b.access !== undefined ? { access: b.access } : {}), ...(b.isolation !== undefined ? { isolation: b.isolation } : {}),
              ...(b.publish !== undefined ? { publish: b.publish } : {}), ...(b.enabled !== undefined ? { enabled: Boolean(b.enabled) } : {}),
              ...(b.source && typeof b.source === 'object' ? { source: b.source } : {}),
              ...(b.credentialHandles ? { credentialHandles: b.credentialHandles } : {}),
            });
            if (secretUpdate) this.deps.broker!.registerHandle(secretUpdate.handle, secretUpdate.value);
            return this.json(res, 200, redactResource(next));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
        if (method === 'DELETE') {
          await this.deps.resources?.deleteAttachment(resource.id);
          if (!this.deps.resources) {
            for (const handle of resource.credentialHandles) this.deps.broker?.deleteHandle(handle);
            store.deleteResourceAttachment(resource.id);
          }
          return this.json(res, 200, { deleted: true, resourceId: resource.id });
        }
      }
      const projectResourceScan = p.match(/^\/api\/projects\/([^/]+)\/resources\/scan$/);
      if (projectResourceScan && method === 'GET') {
        const project = store.getProject(projectResourceScan[1]!);
        if (!project) return this.json(res, 404, { error: 'project not found' });
        // `hosted` and `hostLocal` are orthogonal: a self-host served on a public
        // URL is `hosted:false, hostLocal:false`. This route reads the HOST
        // filesystem, and the console hides it on `hostLocal()` — gate the server
        // on the same predicate, or a remote user still gets the host's file tree.
        if (!this.hostLocal) return this.json(res, 200, { proposals: [], unavailable: project.config.repos ?? [],
          note: 'Krmax is not running on your machine, so it cannot see this workstation’s ignored files. Choose files or use the uploader.' });
        return this.json(res, 200, await scanProjectResources(project));
      }
      const resourceUploadCreate = p.match(/^\/api\/projects\/([^/]+)\/resources\/([^/]+)\/uploads$/);
      if (resourceUploadCreate && method === 'POST') {
        const resource = store.getResourceAttachment(resourceUploadCreate[2]!);
        if (!resource || resource.projectId !== resourceUploadCreate[1]) return this.json(res, 404, { error: 'resource not found' });
        if (!isSnapshotResourceDriver(resource.driver) || !this.deps.objects) return this.json(res, 400, { error: 'resumable uploads require a snapshot resource and object store' });
        const id = newId('resource-upload');
        const upload: ResourceUploadSession = { id, organizationId: resource.organizationId, projectId: resource.projectId,
          attachmentId: resource.id, files: {}, bytes: 0, createdAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60_000 };
        store.kvSet(resourceUploadKey(id), JSON.stringify(upload));
        return this.json(res, 200, { id, partBytes: RESOURCE_UPLOAD_PART_BYTES, expiresAt: upload.expiresAt });
      }
      const resourceUpload = p.match(/^\/api\/resource-uploads\/([^/]+)$/);
      if (resourceUpload) {
        const upload = resourceUploadSession(store, resourceUpload[1]!);
        if (!upload || upload.projectId !== url.searchParams.get('projectId')) return this.json(res, 404, { error: 'resource upload not found' });
        if (!this.deps.objects || !this.deps.resources) return this.json(res, 503, { error: 'resource upload services unavailable' });
        if (upload.expiresAt < Date.now()) return this.json(res, 410, { error: 'resource upload expired' });
        if (method === 'PUT') {
          const relative = String(url.searchParams.get('path') ?? '');
          const part = Number(url.searchParams.get('part'));
          if (!safeUploadPath(relative) || !Number.isInteger(part) || part < 0) return this.json(res, 400, { error: 'invalid upload path or part' });
          const data = await this.rawBody(req, RESOURCE_UPLOAD_PART_BYTES);
          if (!data.length) return this.json(res, 400, { error: 'empty upload part' });
          const record = upload.files[relative] ?? { parts: [], bytes: 0 };
          if (part !== record.parts.length) return this.json(res, 409, { error: `expected part ${record.parts.length}` });
          const objectKey = resourceUploadObjectKey(upload, relative, part);
          await this.deps.objects.put(objectKey, data);
          record.parts.push({ objectKey, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
          record.bytes += data.length; upload.bytes += data.length; upload.files[relative] = record;
          store.kvSet(resourceUploadKey(upload.id), JSON.stringify(upload));
          return this.json(res, 200, { path: relative, part, bytes: data.length, totalBytes: upload.bytes });
        }
        if (method === 'POST') {
          try {
            if (!Object.keys(upload.files).length) throw new Error('upload has no files');
            const revision = await this.deps.resources.importFiles(upload.attachmentId,
              Object.entries(upload.files).map(([relative, record]) => ({ path: relative, bytes: record.bytes,
                data: uploadedFileChunks(this.deps.objects!, record.parts) })));
            await Promise.allSettled(Object.values(upload.files).flatMap((record) => record.parts)
              .map((part) => this.deps.objects!.delete(part.objectKey)));
            store.kvDelete(resourceUploadKey(upload.id));
            return this.json(res, 200, redactResourceRevision(revision));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
        if (method === 'DELETE') {
          for (const record of Object.values(upload.files)) for (const part of record.parts) await this.deps.objects.delete(part.objectKey);
          store.kvDelete(resourceUploadKey(upload.id));
          return this.json(res, 200, { deleted: true });
        }
      }
      const resourceImport = p.match(/^\/api\/projects\/([^/]+)\/resources\/([^/]+)\/import$/);
      if (resourceImport && method === 'POST') {
        const resource = store.getResourceAttachment(resourceImport[2]!);
        if (!resource || resource.projectId !== resourceImport[1]) return this.json(res, 404, { error: 'resource not found' });
        if (!this.deps.resources) return this.json(res, 503, { error: 'project resources are unavailable' });
        const b = await this.body(req, 600 * 1024 * 1024);
        try {
          const revision = typeof b.sourcePath === 'string'
            // Same host-filesystem gate as the create path above: `hostLocal`,
            // not `hosted`.
            ? !this.hostLocal ? (() => { throw new Error('imports require uploaded files unless Krmax runs on your machine'); })()
              : await this.deps.resources.importDirectory(resource.id, expandPath(b.sourcePath))
            : await this.deps.resources.importFiles(resource.id, decodeResourceFiles(b.files));
          return this.json(res, 200, redactResourceRevision(revision));
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const taskResources = p.match(/^\/api\/tasks\/([^/]+)\/resources$/);
      if (taskResources && method === 'GET') {
        const task = store.getTask(taskResources[1]!);
        if (!task || !this.deps.resources) return this.json(res, task ? 503 : 404, { error: task ? 'project resources are unavailable' : 'task not found' });
        const summaries = [];
        for (const resource of store.listResourceAttachments(task.projectId)) {
          if (resource.access !== 'write' || resource.target.kind !== 'path') continue;
          try { summaries.push({ resource: redactResource(resource), summary: await this.deps.resources.summarize(task.id, resource.id) }); }
          catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            summaries.push(message.includes('no active lease')
              ? { resource: redactResource(resource), discarded: true }
              : { resource: redactResource(resource), error: message });
          }
        }
        return this.json(res, 200, summaries);
      }
      const taskResourcePromote = p.match(/^\/api\/tasks\/([^/]+)\/resources\/([^/]+)\/promote$/);
      if (taskResourcePromote && method === 'POST') {
        if (!this.deps.resources) return this.json(res, 503, { error: 'project resources are unavailable' });
        try {
          const promoted = await this.deps.resources.promote(taskResourcePromote[1]!, taskResourcePromote[2]!);
          return this.json(res, 200, { ...promoted, attachment: redactResource(promoted.attachment),
            revision: redactResourceRevision(promoted.revision) });
        }
        catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const taskResourceDiscard = p.match(/^\/api\/tasks\/([^/]+)\/resources\/([^/]+)\/discard$/);
      if (taskResourceDiscard && method === 'POST') {
        if (!this.deps.resources) return this.json(res, 503, { error: 'project resources are unavailable' });
        try {
          await this.deps.resources.discard(taskResourceDiscard[1]!, taskResourceDiscard[2]!);
          return this.json(res, 200, { discarded: true });
        } catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const projectMembers = p.match(/^\/api\/projects\/([^/]+)\/members$/);
      if (projectMembers) {
        const projectId = projectMembers[1]!;
        if (method === 'GET') return this.json(res, 200, store.listProjectMemberships(projectId).map((membership) => {
          if (membership.principal.kind !== 'user') return { ...membership,
            profileId: this.deps.authorization?.profile(membership.role, projectId)?.id
              ?? (membership.role === 'owner' || membership.role === 'admin' ? 'maintainer' : 'developer') };
          const grant = this.deps.authorization?.grants(`user:${membership.principal.userId}`).find((candidate) => candidate.scopeKey === `project:${projectId}`);
          return { ...membership, profileId: grant?.profileId ?? (membership.role === 'owner' || membership.role === 'admin' ? 'maintainer' : 'developer'), protectedOwner: membership.role === 'owner' };
        }));
        if (method === 'POST') {
          const b = await this.body(req);
          const project = store.getProject(projectId);
          if (!project?.organizationId) return this.json(res, 404, { error: 'project organization not found' });
          const principal = projectPrincipalFromBody(b.principal, project.organizationId);
          const profileId = String(b.profileId ?? 'developer');
          if (!['viewer', 'developer', 'maintainer'].includes(profileId))
            return this.json(res, 400, { error: 'project access must be Viewer, Developer, or Project maintainer' });
          this.deps.authorization?.assertCanGrantSelection(authRecord?.principal ?? `user:${session.userId}`,
            project.organizationId, { level: profileId, scope: 'projects', projectIds: [projectId] },
            authRecord?.kind === 'human' ? undefined : authRecord?.caps);
          const previous = store.listProjectMemberships(projectId).find((member) => JSON.stringify(member.principal) === JSON.stringify(principal));
          const membership = store.setProjectMembership(projectId, principal, previous?.role === 'owner' ? 'owner'
            : principal.kind === 'user' ? 'member' : profileId);
          if (principal.kind === 'user') {
            this.deps.authorization?.grant(`user:${session.userId}`, { principalId: `user:${principal.userId}`,
              scopeKey: `project:${projectId}`, profileId });
          }
          return this.json(res, 200, membership);
        }
      }
      const projectMember = p.match(/^\/api\/projects\/([^/]+)\/members\/(user|team|organization)\/([^/]+)$/);
      if (projectMember && method === 'DELETE') {
        const principal = projectMember[2] === 'user'
          ? { kind: 'user' as const, userId: projectMember[3]! }
          : projectMember[2] === 'team' ? { kind: 'team' as const, teamId: projectMember[3]! }
          : { kind: 'organization' as const, organizationId: projectMember[3]! };
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
          const attached = store.attachProjectRepository({ projectId, repositoryId: String(b.repositoryId),
            baseBranch: b.baseBranch ? String(b.baseBranch) : undefined,
            targetBranch: b.targetBranch ? String(b.targetBranch) : undefined,
            order: Number.isFinite(Number(b.order)) ? Number(b.order) : undefined });
          const project = store.getProject(projectId);
          if (project) await this.ensureProjectWiki(project, session.userId);
          return this.json(res, 200, attached);
        }
      }
      const projectRepositorySources = p.match(/^\/api\/projects\/([^/]+)\/repository-sources$/);
      if (projectRepositorySources) {
        const project = store.getProject(projectRepositorySources[1]!);
        if (!project) return this.json(res, 404, { error: 'project not found' });
        if (method === 'GET') return this.json(res, 200, { repos: project.config.repos ?? [] });
        if (method === 'PUT') {
          const b = await this.body(req);
          try {
            const repos = Array.isArray(b.repos) ? b.repos.map(String) : [];
            if (this.deps.hosted) {
              const known = store.listRepositories(project.organizationId!).map((repository) => repository.sshUrl);
              const unknown = repos.filter((repo: string) => !known.some((candidate) => sameRepository(candidate, repo)));
              if (unknown.length) throw new Error('Hosted projects must select repositories available through the organization GitHub connection');
            }
            const saved = store.setProjectRepositorySources(project.id, repos);
            await this.ensureProjectWiki(saved, session.userId);
            return this.json(res, 200, saved); }
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
          const all = await api.listTaskSummaries(token, projectId);
          // Archived tasks are hidden from the default list (SPEC §11 housekeeping).
          const includeArchived = url.searchParams.get('includeArchived') === '1';
          const filtered = includeArchived ? all : all.filter((t) => !t.params?.archived);
          // Optional pagination (?limit=&offset=); returns the page + total count.
          const limit = Number(url.searchParams.get('limit') ?? '0');
          const offset = Number(url.searchParams.get('offset') ?? '0');
          const page = limit > 0 ? filtered.slice(offset, offset + limit) : filtered;
          // The list only needs each task's chip/queue fields (stage/status/state/
          // waitingFor/mergeQueue/…), never its conversation. Dropping the heavy view
          // fields — `messages`, `transcripts`, `reviewInfo` — shrinks this response by
          // ~80% (they were the bulk of a multi-MB payload for a few hundred tasks).
          // It matters because loadTasks() refetches the whole list on navigation AND
          // on every WS-debounced refresh, so the fat body was paid over and over. The
          // full view is still served per task by /api/tasks/:id when a task is opened.
          const trimListView = (v: TaskView | undefined) => {
            if (!v) return v;
            const { messages: _m, transcripts: _t, reviewInfo: _r, ...rest } = v;
            return rest;
          };
          // listTasks already returns the durable lastView snapshot written by
          // publishView. Never call getTaskView once per row here: enriching 300+
          // rows computed attempt/stage metadata independently and turned one list
          // request into thousands of synchronous SQLite reads. Drawer-only fields
          // (including stageTransitions) are resolved by the single-task endpoint.
          const listed = page.map((t) => ({
            ...t,
            lastView: trimListView(this.withApprovalRequests(t.lastView, t.id)),
          }));
          if (limit > 0) return this.json(res, 200, { tasks: listed, total: filtered.length, offset });
          return this.json(res, 200, listed);
        }
        if (method === 'POST') {
          const b = await this.body(req);
          const project = store.getProject(projectId);
          if (project) await this.ensureProjectWiki(project, session.userId);
          const task = await api.createTask(token, { projectId, ...b });
          return this.json(res, 200, task);
        }
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
          return this.json(res, 200, await api.createTag(token, { projectId, name: b.name, parentId: b.parentId, color: b.color, kind: b.kind, description: b.description }));
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
            return this.badRequest(res, e);
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
          return this.badRequest(res, e);
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
        const projected = this.withApprovalRequests(view, viewMatch[1]!)!;
        return this.json(res, 200, rec?.num != null ? { ...projected, num: rec.num } : projected);
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
        const group = api.attemptGroup(token, attemptsMatch[1]!);
        return this.json(res, 200, group ? {
          ...group,
          attempts: group.attempts.map((attempt) => ({
            ...attempt,
            lastView: this.withApprovalRequests(attempt.lastView, attempt.id),
          })),
        } : null);
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
        const queued = store.getTask(queueMatch[1]!);
        const project = queued ? store.getProject(queued.projectId) : undefined;
        if (project) await this.ensureProjectWiki(project, session.userId);
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
          try {
            // Use the same full-form replacement path as armed tasks. Besides
            // preserving platform metadata, it keeps the shared confirmer snapshot
            // in sync when a reset removes the sparse task-level override.
            const updated = await api.updateArmedParams(token, id, b.params ?? {}, {
              replace: b.replace === true,
              keepArmed: false,
            });
            return this.json(res, 200, updated);
          } catch (e) {
            return this.json(res, 409, { error: e instanceof Error ? e.message : String(e) });
          }
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
      const workflowMatch = p.match(/^\/api\/tasks\/([^/]+)\/workflow$/);
      if (workflowMatch && method === 'PATCH') {
        const b = await this.body(req);
        try {
          return this.json(res, 200, await api.changeWorkflow(token, workflowMatch[1]!, String(b.workflow ?? '')));
        } catch (e) {
          return this.json(res, 409, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      const taskAuthMatch = p.match(/^\/api\/tasks\/([^/]+)\/authorization$/);
      if (taskAuthMatch && method === 'PATCH') {
        const b = await this.body(req);
        try {
          return this.json(res, 200, await api.setTaskAuthorization(token, taskAuthMatch[1]!,
            authorizationSelectionFromBody(b.authorization) ?? String(b.profileId ?? ''),
            Array.isArray(b.credentialGrants) ? b.credentialGrants.map(String) : undefined,
            b.credentialPolicies && typeof b.credentialPolicies === 'object' && !Array.isArray(b.credentialPolicies)
              ? b.credentialPolicies as any : undefined));
        } catch (e) {
          // Frozen in-flight (cancelled / past the point of no return / finished),
          // or a stale draft edit — the workflow validator's reason is authoritative.
          return this.json(res, 409, { error: e instanceof Error ? e.message : String(e) });
        }
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
      const escalateMatch = p.match(/^\/api\/tasks\/([^/]+)\/escalate$/);
      if (escalateMatch && method === 'POST') {
        const b = await this.body(req);
        try {
          return this.json(res, 200, await api.escalateToHuman(token, {
            taskId: escalateMatch[1]!,
            audience: Array.isArray(b.audience) ? b.audience.map(String) : [],
            message: String(b.message ?? ''),
          }));
        } catch (e) {
          return this.json(res, 409, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      const stageMatch = p.match(/^\/api\/tasks\/([^/]+)\/stage$/);
      if (stageMatch && method === 'POST') {
        const b = await this.body(req);
        try {
          return this.json(res, 200, await api.moveTaskStage(token, stageMatch[1]!, String(b.target ?? '')));
        } catch (e) {
          return this.json(res, 409, { error: e instanceof Error ? e.message : String(e) });
        }
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
      const terminalTicketMatch = p.match(/^\/api\/tasks\/([^/]+)\/terminal-ticket$/);
      if (terminalTicketMatch && method === 'POST') {
        const taskId = terminalTicketMatch[1]!;
        if (!store.getTask(taskId)) return this.json(res, 404, { error: 'task not found' });
        const ticket = crypto.randomBytes(24).toString('base64url');
        const expiresAt = Date.now() + 5 * 60_000;
        for (const [candidate, record] of this.terminalTickets) if (record.expiresAt <= Date.now()) this.terminalTickets.delete(candidate);
        this.terminalTickets.set(ticket, { taskId, session, expiresAt });
        // A path into this install's checkout only means something to the machine it lives on.
        const attachArgv = this.hostLocal ? [process.execPath, fileURLToPath(new URL('../../bin/karmax.js', import.meta.url))] : ['karmax'];
        return this.json(res, 200, { taskId, ticket, expiresAt, gatewayUrl: this.publicUrl(req), attachArgv });
      }
      const checkoutMatch = p.match(/^\/api\/tasks\/([^/]+)\/checkout$/);
      if (checkoutMatch && method === 'GET') {
        // Deliberately NOT gated on `hostLocal`: this is the *Git* handoff — a
        // `git clone` script into a relative workspace dir, built from the
        // project's own repository URLs. It exposes no host path, and it is
        // precisely what `materialize-local` tells a non-host-local user to use
        // instead. Gating it would remove the only checkout a remote user has.
        if (!this.deps.handoffs) return this.json(res, 503, { error: 'local checkout handoff is unavailable' });
        try { return this.json(res, 200, this.deps.handoffs.checkout(checkoutMatch[1]!)); }
        catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const materializeMatch = p.match(/^\/api\/tasks\/([^/]+)\/materialize-local$/);
      if (materializeMatch && method === 'POST') {
        if (!this.deps.handoffs) return this.json(res, 503, { error: 'local checkout handoff is unavailable' });
        if (!this.hostLocal) return this.json(res, 409, { error: 'use the Git checkout handoff when Krmax is not running on your machine' });
        const taskId = materializeMatch[1]!;
        const view = (await api.getTaskView(token, taskId, { live: true }).catch(() => undefined)) ?? store.getTask(taskId)?.lastView;
        if (!view) return this.json(res, 404, { error: 'task view is unavailable' });
        try { return this.json(res, 200, await this.deps.handoffs.materialize(taskId, view)); }
        catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (p === '/api/agent/git/publish' && method === 'POST') {
        try { return this.json(res, 200, await api.publishTaskBranch(token)); }
        catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (p === '/api/agent/git/import' && method === 'POST') {
        const b = await this.body(req);
        try { return this.json(res, 200, await api.importTaskBranch(token, String(b.sourceTaskId ?? ''))); }
        catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (p === '/api/agent/git/refresh-upstream' && method === 'POST') {
        const b = await this.body(req);
        try { return this.json(res, 200, await api.refreshUpstream(token, b.branch ? String(b.branch) : undefined)); }
        catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (p === '/api/agent/escalate' && method === 'POST') {
        const b = await this.body(req);
        try {
          return this.json(res, 200, await api.escalateToHuman(token, {
            audience: Array.isArray(b.audience) ? b.audience.map(String) : [],
            message: String(b.message ?? ''),
            ...(b.urgency ? { urgency: normalizeUrgency(b.urgency) } : {}),
          }));
        } catch (error) {
          return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p === '/api/agent/permission-requests' && method === 'POST') {
        const b = await this.body(req);
        try {
          return this.json(res, 200, await api.requestPermission(token, {
            capabilities: Array.isArray(b.capabilities) ? b.capabilities.map(String) : [],
            audience: Array.isArray(b.audience) ? b.audience.map(String) : [],
            reason: String(b.reason ?? ''),
            ...(b.urgency ? { urgency: normalizeUrgency(b.urgency) } : {}),
          }));
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p === '/api/agent/escalation-targets' && method === 'GET') {
        try { return this.json(res, 200, api.humanEscalationTargets(token)); }
        catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (p === '/api/permission-requests' && method === 'GET') {
        const organizationId = String(url.searchParams.get('organizationId') ?? '');
        const taskId = String(url.searchParams.get('taskId') ?? '');
        if (!organizationId || !taskId)
          return this.json(res, 400, { error: 'organizationId and taskId are required' });
        try {
          return this.json(res, 200, api.listPermissionRequests(token, {
            organizationId,
            taskId,
            status: (url.searchParams.get('status') as any) ?? undefined,
          }));
        } catch (error) {
          return this.json(res, error instanceof CapabilityError ? 403 : 400,
            { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const permissionResolution = p.match(/^\/api\/permission-requests\/([^/]+)\/resolve$/);
      if (permissionResolution && method === 'POST') {
        const organizationId = String(url.searchParams.get('organizationId') ?? '');
        const b = await this.body(req);
        const action = String(b.action ?? '');
        if (!organizationId) return this.json(res, 400, { error: 'organizationId is required' });
        if (action !== 'approve' && action !== 'deny')
          return this.json(res, 400, { error: 'action must be approve | deny' });
        try {
          return this.json(res, 200, await api.resolvePermissionRequest(token, {
            organizationId,
            requestId: permissionResolution[1]!,
            action,
          }));
        } catch (error) {
          return this.json(res, error instanceof CapabilityError ? 403 : 400,
            { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p === '/api/agent/collaboration/request' && method === 'POST') {
        const b = await this.body(req);
        try {
          return this.json(res, 202, await api.requestAgentAction(token, {
            taskId: String(b.taskId ?? ''),
            role: b.role ? String(b.role) : undefined,
            action: String(b.action ?? '') as 'publish_branch',
            message: b.message ? String(b.message) : undefined,
          }));
        } catch (error) {
          return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const desktopMatch = p.match(/^\/api\/tasks\/([^/]+)\/desktop$/);
      if (desktopMatch && method === 'GET') {
        const taskId = desktopMatch[1]!;
        const task = store.getTask(taskId);
        const handle = worldHandleForView(task?.lastView, taskId, task ? store.effectiveProjectConfig(task.projectId) : undefined);
        if (!handle) return this.json(res, 404, { error: 'no world for this task' });
        let access: Awaited<ReturnType<NonNullable<GatewayDeps['worldAccess']>['open']>> | undefined;
        try {
          access = this.deps.worldAccess
            ? await this.deps.worldAccess.open(taskId, handle, { dedicated: true })
            : undefined;
          const world = access?.world ?? await this.deps.worlds.open(handle);
          if (!world.desktopSession) throw new Error('this world has no desktop experience');
          const desktop = await world.desktopSession();
          const expiresAt = Date.now() + 5 * 60_000;
          if (access?.runnerLeaseId && task) {
            const project = store.getProject(task.projectId)!;
            store.createPreviewLease({ id: newId('desktop'), organizationId: project.organizationId!,
              projectId: project.id, taskId, worldId: access.handle.id, generation: access.handle.generation ?? 1,
              port: 6080, public: false, runnerLeaseId: access.runnerLeaseId, provider: access.handle.kind,
              createdBy: authRecord?.principal ?? session.user, createdAt: Date.now(), expiresAt });
          }
          return this.json(res, 200, { ...desktop, expiresAt });
        } catch (error) {
          await access?.release();
          return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }
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
        if (action.kind === 'payment') {
          const request = action.requestId ? store.getPaymentSpendRequest(action.requestId) : undefined;
          const organizationId = task ? store.getProject(task.projectId)?.organizationId : undefined;
          if (!request || request.taskId !== taskId || request.organizationId !== organizationId)
            return this.json(res, 404, { error: 'spend request not found for this task' });
          const paymentPermission = this.deps.tokens.check(token, 'payment:write',
            { organizationId, projectId: task?.projectId, taskId });
          if (!paymentPermission.ok)
            return this.json(res, 403, { error: paymentPermission.reason ?? 'missing capability payment:write' });
          if (!this.deps.paymentRegistry && !this.deps.payments)
            return this.json(res, 503, { error: 'payments are unavailable' });
          const { BudgetService } = await import('../autonomy/payments.js');
          const budget = new BudgetService(store, this.deps.paymentRegistry ?? this.deps.payments!);
          const principal = authRecord?.principal ?? (session.userId ? `user:${session.userId}` : session.user);
          const result = action.operation === 'deny'
            ? budget.deny(request.id, principal)
            : await budget.approve(request.id, principal);
          let resumed = false;
          if (result.status === 'granted') {
            resumed = await api.signalTask(token, taskId, 'followUp',
              `Payment request ${request.id} is approved and ready. Continue the purchase using the same request.`)
              .then(() => true, () => false);
          }
          return this.json(res, 200, { kind: 'payment', result, resumed });
        }
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
        let access: Awaited<ReturnType<NonNullable<GatewayDeps['worldAccess']>['open']>> | undefined;
        try {
          access = this.deps.worldAccess ? await this.deps.worldAccess.open(taskId, handle) : undefined;
          const world = access?.world ?? await this.deps.worlds.open(handle);
          const data = await world.readFileBuffer(worldWorkingRelativePath(handle, relPath));
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
        } finally { await access?.release(); }
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
        const handle = store.currentWorld(lease.worldId) as import('../world/types.js').WorldHandle | undefined;
        if (handle && this.deps.worldAccess) await this.deps.worldAccess.releaseLeaseAndParkIfIdle(handle, lease.runnerLeaseId);
        else if (lease.runnerLeaseId) this.deps.runners?.release(lease.runnerLeaseId, lease.provider);
        return this.json(res, 200, { ok: true });
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
        const rawLimit = Number(url.searchParams.get('limit') ?? '0');
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 1_000) : undefined;
        return this.json(res, 200, await api.taskEvents(token, eventsMatch[1]!, since, limit));
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
        // Include the exact effective agent selection captured at queue time (and
        // kept current after an accepted in-flight retune). Besides powering the
        // CLI fork command, the expanded task form uses this to prefill a newly
        // selected fork with the source agent's provider/model/effort.
        const agents = (await api.getTaskView(token, id).catch(() => undefined))?.agents;
        const out: Record<string, { id: string; home?: string; provider?: string; model?: string; effort?: AgentSpec['effort'] }> = {};
        for (const role of ['do', 'merge', ...(RESOLVE_AGENT_ENABLED ? ['resolve'] : []), 'confirm']) {
          const sessionTaskId = role === 'confirm' ? (t?.intentId ?? id) : id;
          const s = store.kvGet(`session:${sessionTaskId}:${role}`);
          if (!s) continue;
          let home: string | undefined;
          let provider: string | undefined;
          let model: string | undefined;
          let effort: AgentSpec['effort'];
          const meta = store.kvGet(`sessionmeta:${sessionTaskId}:${role}`);
          if (meta) {
            try {
              const m = JSON.parse(meta);
              home = m.home || undefined;
              provider = m.provider || undefined;
              model = m.model || undefined;
              effort = m.effort || undefined;
            } catch { /* ignore */ }
          }
          const spec = agents?.[role];
          out[role] = {
            id: s,
            ...(home ? { home } : {}),
            ...(spec?.provider || provider ? { provider: spec?.provider ?? provider } : {}),
            ...(spec?.model || model ? { model: spec?.model ?? model } : {}),
            ...(spec?.effort || effort ? { effort: spec?.effort ?? effort } : {}),
          };
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
      // Wiki — org/project skills, memories, and general prompts. One route
      // family per scope; KarmaxApi enforces read/write capabilities and path
      // safety, so the wiki works identically for humans (UI) and agents
      // (read_wiki/search_wiki/platform_request, including from cloud worlds).
      const wikiMatch = p.match(/^\/api\/(organizations|projects)\/([^/]+)\/wiki(?:\/(page|search|suggest|refs|history))?$/);
      if (wikiMatch) {
        const scope = wikiMatch[1] === 'projects' ? ('project' as const) : ('organization' as const);
        const id = wikiMatch[2]!;
        const sub = wikiMatch[3];
        const selector = {
          ...(url.searchParams.get('taskId') ? { taskId: String(url.searchParams.get('taskId')) } : {}),
          ...(url.searchParams.get('branch') ? { branch: String(url.searchParams.get('branch')) } : {}),
        };
        try {
          if (!sub && method === 'GET') return this.json(res, 200, await api.readWikiResolved(token, scope, id, url.searchParams.get('path') ?? '', selector));
          if (sub === 'page') {
            if (method === 'GET') {
              const read = await api.readWikiResolved(token, scope, id, String(url.searchParams.get('path') ?? ''), selector);
              return 'page' in read ? this.json(res, 200, read.page) : this.json(res, 404, { error: 'wiki page not found' });
            }
            if (method === 'PUT') {
              const b = await this.body(req);
              return this.json(res, 200, await api.saveWikiPageResolved(token, scope, id, {
                path: String(b.path ?? ''), content: String(b.content ?? ''), kind: b.kind === 'memory' ? 'memory' : 'skill',
                create: b.create === true, prevPath: b.prevPath ? String(b.prevPath) : undefined,
              }, selector));
            }
            // `recursive=1` is the caller's explicit confirmation that removing a
            // section (and every entry under it) is intended; without it the wiki
            // layer refuses a section delete.
            if (method === 'DELETE') return this.json(res, 200, await api.deleteWikiPageResolved(token, scope, id,
              String(url.searchParams.get('path') ?? ''),
              { ...selector, recursive: ['1', 'true'].includes(String(url.searchParams.get('recursive') ?? '')) }));
          }
          if (sub === 'search' && method === 'GET') return this.json(res, 200, await api.searchWikiResolved(token, scope, id, String(url.searchParams.get('q') ?? ''), selector));
          if (sub === 'suggest' && method === 'GET') return this.json(res, 200, await api.suggestWikiResolved(token, scope, id, String(url.searchParams.get('q') ?? ''), selector));
          if (sub === 'refs' && method === 'GET' && scope === 'project') return this.json(res, 200, api.wikiViews(token, id));
          if (sub === 'history' && method === 'GET' && scope === 'organization')
            return this.json(res, 200, api.organizationWikiHistory(token, id, url.searchParams.get('path') ?? undefined));
        } catch (error) {
          if (error instanceof CapabilityError) throw error;
          const conflict = /already exists/.test(String((error as Error)?.message));
          return this.json(res, conflict ? 409 : 400, { error: error instanceof Error ? error.message : String(error) });
        }
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
      if (resourcePath === '/api/workflows' && method === 'GET')
        return this.json(res, 200, api.listWorkflows(token, resourceOrganizationId));
      if (resourcePath === '/api/workflows/install' && method === 'POST') {
        const b = await this.body(req);
        if (!b.url) return this.json(res, 400, { error: 'url required' });
        try {
          return this.json(res, 200, await api.installWorkflow(token, {
            url: String(b.url),
            ref: b.ref ? String(b.ref) : undefined,
            name: b.name ? String(b.name) : undefined,
          }, resourceOrganizationId));
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
        const withRole = (pr: any) => {
          const {
            modelProvider: _legacyModelProvider,
            allowedAccounts: _legacyAllowedAccounts,
            auth: _legacyAuth,
            capabilities: _legacyCapabilities,
            ...visibleProfile
          } = pr;
          if (visibleProfile.inherited) {
            const {
              modelProvider: _legacyInheritedProvider,
              allowedAccounts: _legacyInheritedAllowedAccounts,
              auth: _legacyInheritedAuth,
              capabilities: _legacyInheritedCapabilities,
              ...visibleInherited
            } = visibleProfile.inherited;
            visibleProfile.inherited = visibleInherited;
          }
          return { ...visibleProfile, roleWorkflows: roleDef(pr.role)?.workflows ?? [] };
        };
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
        return this.json(res, 200, await this.availableModels(
          url.searchParams.get('refresh') === '1',
          requestedScope.organizationId ?? 'org_personal',
        ));
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
        const {
          projectId: _pid,
          scope: _s,
          inherited: _i,
          modelProvider: _legacyModelProvider,
          allowedAccounts: _legacyAllowedAccounts,
          auth: _legacyAuth,
          // The role's workflow owns the capability ceiling (roleCeiling); a submitted
          // one must neither narrow nor escalate what the role's turns are minted with.
          capabilities: _legacyCapabilities,
          ...rest
        } = b;
        store.upsertProfile({ provider: 'claude', ...rest, id });
        return this.json(res, 200, store.getProfile(id) ?? null);
      }
      // reset a project profile override back to the global default
      const profDelMatch = p.match(/^\/api\/profiles\/(.+)$/);
      if (profDelMatch && method === 'DELETE') {
        store.deleteProfile(decodeURIComponent(profDelMatch[1]!));
        return this.json(res, 200, { ok: true });
      }

      // Payment rails (SPEC §7.6), resolved in the caller's organization. Local
      // needs no connection; incomplete external rails are reported honestly.
      const stripePlatform = p.match(/^\/api\/organizations\/([^/]+)\/payments\/stripe\/platform$/);
      if (stripePlatform) {
        const provider = this.deps.paymentRegistry?.get('stripe') as any;
        if (!provider || typeof provider.platformStatus !== 'function')
          return this.json(res, 503, { error: 'Stripe Issuing is unavailable' });
        const publicUrl = this.publicUrl(req);
        if (method === 'GET') return this.json(res, 200, {
          ...provider.platformStatus(),
          canManage: this.deps.tokens.check(token, 'user:write').ok,
          callbackUrl: `${publicUrl}/api/payments/stripe/callback`,
          webhookUrl: `${publicUrl}/api/payments/stripe/webhook`,
        });
        if (method === 'PUT') {
          if (!this.deps.tokens.check(token, 'user:write').ok)
            return this.json(res, 403, { error: 'Only a Krmax installation administrator can configure the shared Stripe Connect application' });
          const b = await this.body(req);
          try {
            return this.json(res, 200, {
              ...provider.configurePlatform({
                clientId: String(b.clientId ?? ''),
                secretKey: b.secretKey ? String(b.secretKey) : undefined,
                webhookSecret: b.webhookSecret ? String(b.webhookSecret) : undefined,
              }),
              canManage: true,
              callbackUrl: `${publicUrl}/api/payments/stripe/callback`,
              webhookUrl: `${publicUrl}/api/payments/stripe/webhook`,
            });
          } catch (error) {
            return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      const organizationPayments = p.match(/^\/api\/organizations\/([^/]+)\/payments\/(providers|connect)$/);
      if ((p === '/api/payments/providers' || organizationPayments?.[2] === 'providers') && method === 'GET') {
        const organizationId = authRecord?.organizationId ?? requestedScope.organizationId ?? 'org_personal';
        const context = { organizationId };
        const list = this.deps.paymentRegistry?.list(context)
          ?? (this.deps.payments ? [this.deps.payments.describe(context)] : []);
        const active = this.deps.paymentRegistry?.active(organizationId).name ?? this.deps.payments?.name ?? null;
        return this.json(res, 200, { providers: list, active });
      }
      if ((p === '/api/payments/connect' || organizationPayments?.[2] === 'connect') && method === 'POST') {
        const b = await this.body(req);
        const prov = this.deps.paymentRegistry?.get(b.provider) ?? this.deps.payments;
        if (!prov) return this.json(res, 400, { error: 'no payment provider configured' });
        const organizationId = authRecord?.organizationId ?? requestedScope.organizationId ?? 'org_personal';
        const result = await prov.connect({
          organizationId,
          userId: session.userId,
          redirectUri: `${this.publicUrl(req)}/api/payments/stripe/callback`,
        });
        if (result.status === 'connected') {
          const current = store.getSettings(`organization:${organizationId}`, 'payments') ?? {};
          store.setSettings(`organization:${organizationId}`, 'payments', { ...current, provider: prov.name });
        }
        return this.json(res, result.status === 'unavailable' ? 400 : 200, result);
      }
      const paymentDisconnect = p.match(/^\/api\/organizations\/([^/]+)\/payments\/connections\/([^/]+)$/);
      if (paymentDisconnect && method === 'DELETE') {
        const organizationId = paymentDisconnect[1]!;
        const provider = this.deps.paymentRegistry?.get(paymentDisconnect[2]!);
        if (!provider) return this.json(res, 404, { error: 'payment provider not found' });
        const stripe = provider as any;
        if (typeof stripe.disconnect !== 'function') return this.json(res, 400, { error: 'this provider has no connection to remove' });
        await stripe.disconnect(organizationId);
        const current = store.getSettings(`organization:${organizationId}`, 'payments') ?? {};
        store.setSettings(`organization:${organizationId}`, 'payments', { ...current, provider: 'mock' });
        return this.json(res, 200, { ok: true });
      }
      const paymentBalance = p.match(/^\/api\/organizations\/([^/]+)\/payments\/balance$/);
      if (paymentBalance && method === 'GET') {
        const providerName = url.searchParams.get('provider')
          ?? (store.getSettings(`organization:${paymentBalance[1]}`, 'payments') as any)?.provider
          ?? 'mock';
        const provider = this.deps.paymentRegistry?.get(providerName) ?? this.deps.payments;
        if (!provider) return this.json(res, 400, { error: 'no payment provider configured' });
        return this.json(res, 200, await provider.balance(paymentBalance[1]!));
      }
      const paymentCardholders = p.match(/^\/api\/organizations\/([^/]+)\/payments\/cardholders$/);
      if (paymentCardholders && method === 'GET') {
        const provider = this.deps.paymentRegistry?.get(url.searchParams.get('provider') ?? 'stripe');
        if (!provider) return this.json(res, 400, { error: 'payment provider not found' });
        // Only issuing rails mint cards against a compliance record.
        if (!provider.listCardholders) return this.json(res, 200, []);
        return this.json(res, 200, await provider.listCardholders(paymentCardholders[1]!));
      }
      if (paymentCardholders && method === 'POST') {
        const b = await this.body(req);
        const provider = this.deps.paymentRegistry?.get(String(b.provider ?? 'stripe'));
        if (!provider) return this.json(res, 400, { error: 'payment provider not found' });
        if (!provider.createCardholder)
          return this.json(res, 400, { error: `the ${provider.name} rail does not use cardholders` });
        try {
          return this.json(res, 200, await provider.createCardholder(paymentCardholders[1]!, {
            type: b.type === 'company' ? 'company' : 'individual',
            name: String(b.name ?? ''),
            email: b.email ? String(b.email) : undefined,
            phone: b.phone ? String(b.phone) : undefined,
            address: {
              line1: String(b.address?.line1 ?? ''),
              line2: b.address?.line2 ? String(b.address.line2) : undefined,
              city: String(b.address?.city ?? ''),
              state: b.address?.state ? String(b.address.state) : undefined,
              postalCode: String(b.address?.postalCode ?? ''),
              country: String(b.address?.country ?? ''),
            },
            firstName: b.firstName ? String(b.firstName) : undefined,
            lastName: b.lastName ? String(b.lastName) : undefined,
            dob: b.dob ? { day: Number(b.dob.day), month: Number(b.dob.month), year: Number(b.dob.year) } : undefined,
          }));
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const paymentRequests = p.match(/^\/api\/organizations\/([^/]+)\/payments\/requests$/);
      if (paymentRequests && method === 'GET')
        return this.json(res, 200, store.listPaymentSpendRequests({ organizationId: paymentRequests[1]! }));
      const paymentTransactions = p.match(/^\/api\/organizations\/([^/]+)\/payments\/transactions$/);
      if (paymentTransactions && method === 'GET')
        return this.json(res, 200, store.listPaymentTransactions(paymentTransactions[1]!));
      const paymentResolve = p.match(/^\/api\/organizations\/([^/]+)\/payments\/requests\/([^/]+)\/(approve|deny)$/);
      if (paymentResolve && method === 'POST') {
        const request = store.getPaymentSpendRequest(paymentResolve[2]!);
        if (!request || request.organizationId !== paymentResolve[1])
          return this.json(res, 404, { error: 'spend request not found in this organization' });
        const { BudgetService } = await import('../autonomy/payments.js');
        if (!this.deps.paymentRegistry && !this.deps.payments)
          return this.json(res, 503, { error: 'payments are unavailable' });
        const budget = new BudgetService(store, this.deps.paymentRegistry ?? this.deps.payments!);
        const principal = authRecord?.principal ?? (session.userId ? `user:${session.userId}` : session.user);
        const result = paymentResolve[3] === 'approve'
          ? await budget.approve(request.id, principal)
          : budget.deny(request.id, principal);
        let resumed = false;
        if (result.status === 'granted') {
          resumed = await api.signalTask(token, request.taskId, 'followUp',
            `Payment request ${request.id} is approved and ready. Continue the purchase using the same request.`)
            .then(() => true, () => false);
        }
        return this.json(res, 200, { ...result, resumed });
      }

      // ── vault items + credential access requests (PLAN-passwords.md §§4–7) ──
      if (p.startsWith('/api/vault')) {
        // Bind to the caller's own organization (tenant boundary). The token org
        // is authoritative and cannot be spoofed — auth() validated it against
        // membership; the query-param org only ever narrows within it.
        const organizationId = authRecord?.organizationId ?? requestedScope.organizationId ?? 'org_personal';
        const vault = new VaultItems(store, this.deps.broker, undefined, organizationId);
        const caps = authRecord?.caps ?? [];
        // A human session's token is task-unscoped; per-task passes/extensions
        // only ever apply to real task-agent bearers.
        const callerTaskId = authRecord?.taskId && authRecord.taskId !== '*' ? authRecord.taskId : undefined;
        const principal = authRecord?.principal ?? (session.userId ? `user:${session.userId}` : session.user);
        const defaultField = (type: string): any =>
          ({ login: 'password', 'api-key': 'secret', 'ssh-key': 'privateKey', env: 'env', note: 'note' })[type];
        const findItem = (b: any) => (b.itemId ? vault.get(String(b.itemId)) : b.domain ? vault.findByDomain(String(b.domain))[0] : undefined);

        if (p === '/api/vault/import/bitwarden' && method === 'POST') {
          try {
            // The browser sends a one-time plaintext JSON export. Keep it in
            // request memory only: the importer writes each supported secret
            // straight through VaultItems into the encrypted broker.
            const b = await this.body(req, 51 * 1024 * 1024);
            const source = b && typeof b === 'object' && Object.prototype.hasOwnProperty.call(b, 'export') ? b.export : b;
            const requestedPolicy = b?.policy && typeof b.policy === 'object' ? b.policy : undefined;
            const policy = requestedPolicy ? {
              use: requestedPolicy.use === 'ask' ? 'ask' as const : 'auto' as const,
              reveal: requestedPolicy.reveal === 'auto' || requestedPolicy.reveal === 'never'
                ? requestedPolicy.reveal as 'auto' | 'never'
                : 'ask' as const,
            } : undefined;
            const { importBitwardenExport } = await import('../autonomy/bitwarden-import.js');
            const result = importBitwardenExport(vault, source, policy);
            store.appendAudit({
              principalId: principal,
              action: 'vault.imported',
              scopeKey: organizationId,
              detail: {
                source: 'bitwarden',
                count: result.count,
                created: result.created,
                updated: result.updated,
                skipped: result.skipped.length,
              },
            });
            return this.json(res, 200, result);
          } catch (e) {
            const status = e instanceof AttachmentError && /too large/i.test(e.message) ? 413 : 400;
            return this.json(res, status, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (p === '/api/vault/items' && method === 'GET') return this.json(res, 200, vault.list());
        if (p === '/api/vault/items' && method === 'POST') {
          const b = await this.body(req);
          const saved = vault.save({
            id: b.id ? String(b.id) : undefined,
            type: b.type,
            label: String(b.label ?? ''),
            domains: Array.isArray(b.domains) ? b.domains.map(String) : typeof b.domains === 'string' ? b.domains.split(/[,\s]+/).filter(Boolean) : undefined,
            username: b.username ? String(b.username) : undefined,
            tags: Array.isArray(b.tags) ? b.tags.map(String) : typeof b.tags === 'string' ? b.tags.split(/[,\s]+/).filter(Boolean) : undefined,
            envVar: b.envVar ? String(b.envVar) : undefined,
            policy: b.policy,
            secrets: b.secrets,
            provenance: { source: 'manual' },
          });
          // A human rotating a secret propagates to its imported source or
          // agent-created write-back targets (field-level, notes preserved)
          // when the corresponding connector's write-back is on.
          let propagated;
          if (b.id && b.secrets && Object.keys(b.secrets).length) {
            try {
              const { defaultConnectors } = await import('../autonomy/connectors.js');
              propagated = await defaultConnectors(store, vault, this.deps.broker, organizationId,
                { hostLocal: this.hostLocal, hosted: this.deps.hosted })
                .propagate(saved.id, Object.keys(b.secrets) as any);
            } catch (e) {
              propagated = { error: `vault updated, but pushing to the source store failed: ${e instanceof Error ? e.message : String(e)}` } as any;
            }
          }
          return this.json(res, 200, { ...saved, ...(propagated ? { propagated } : {}) });
        }
        const viDel = p.match(/^\/api\/vault\/items\/([^/]+)$/);
        if (viDel && method === 'DELETE') {
          vault.delete(viDel[1]!);
          return this.json(res, 200, { deleted: true });
        }
        // Agent write-back (§7 store_credential). Two distinct powers:
        //  • CREATE (and fully update items this same task created) — the
        //    narrow vault:store, as before.
        //  • ROTATE the SECRETS of any item the task's grant covers for use —
        //    when an agent changes a password on the site, the stored value is
        //    stale for everyone until it's updated, so rotation rides the same
        //    authorization as using the credential. Metadata/policy/label edits
        //    on someone else's item remain a human/credential:write action:
        //    the rotation path ignores everything except `secrets`.
        if (p === '/api/vault/store' && method === 'POST') {
          const b = await this.body(req);
          if (!callerTaskId && !allows(caps, 'credential:write')) return this.json(res, 400, { error: 'a task-agent token is required' });
          const prior = b.id ? vault.get(String(b.id)) : undefined;
          if (b.id && !prior) return this.json(res, 404, { error: `no vault item ${b.id}` });
          const ownItem = !prior || !callerTaskId || prior.provenance.taskId === callerTaskId || allows(caps, 'credential:write');
          let saved;
          if (ownItem) {
            saved = vault.save({
              id: prior?.id,
              type: b.type,
              label: String(b.label ?? ''),
              domains: Array.isArray(b.domains) ? b.domains.map(String) : undefined,
              username: b.username ? String(b.username) : undefined,
              tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined,
              envVar: b.envVar ? String(b.envVar) : undefined,
              policy: b.policy,
              secrets: b.secrets,
              provenance: { source: callerTaskId ? `task:${callerTaskId}` : 'manual', taskId: callerTaskId },
            });
          } else {
            // Rotation of a foreign item: allowed iff the task's grant covers it.
            //
            // INTENDED: this is gated on the *use* grant, deliberately NOT on the
            // item's `reveal` policy — so a use-only task may rotate an item whose
            // policy is `reveal: 'never'`, and thereby know the value it just set.
            // That looks like a hole but the alternative is worse: an agent that
            // changes a password on a live site and then cannot write it back
            // leaves the vault holding a stale value and locks everyone out. Note
            // the "leaked" secret is one the agent chose, not one it learned, and
            // it is only a working credential if the agent really did change the
            // site — otherwise it has merely desynced the vault, which the audit
            // record below makes visible. Availability wins here; don't "fix" it
            // by gating on reveal.
            if (!vault.covered(caps, callerTaskId, prior!))
              return this.json(res, 403, { error: 'this task was not granted this credential — request_credential first, or create your own item' });
            const secretFields = Object.keys(b.secrets ?? {});
            if (!secretFields.length)
              return this.json(res, 403, { error: 'only the secrets of a granted item can be updated (metadata and policy stay with its owner)' });
            saved = vault.save({ id: prior!.id, type: prior!.type, secrets: b.secrets });
            store.appendAudit({ principalId: `task:${callerTaskId}`, action: 'vault.rotated',
              detail: { itemId: prior!.id, label: prior!.label, fields: secretFields } });
          }
          // Best-effort propagation of rotated fields back to imported sources
          // and agent-created write-back targets (§9 updateSecret) — the vault
          // is already correct either way.
          let propagated;
          if (prior && b.secrets) {
            try {
              const { defaultConnectors } = await import('../autonomy/connectors.js');
              propagated = await defaultConnectors(store, vault, this.deps.broker, organizationId,
                { hostLocal: this.hostLocal, hosted: this.deps.hosted })
                .propagate(saved.id, Object.keys(b.secrets) as any);
            } catch (e) {
              propagated = { error: `vault updated, but pushing to the source store failed: ${e instanceof Error ? e.message : String(e)}` } as any;
            }
          }
          // A newly registered account follows the operator's connector
          // write-back policy automatically. Requiring the task to call the
          // administrative connector endpoint would make the advertised
          // `vault:store` capability insufficient for its only purpose.
          let writeBack: Array<{ connector: string; externalId?: string; error?: string }> = [];
          if (!prior) {
            const { defaultConnectors } = await import('../autonomy/connectors.js');
            writeBack = await defaultConnectors(store, vault, this.deps.broker, organizationId,
              { hostLocal: this.hostLocal, hosted: this.deps.hosted }).writeBackCreated(saved.id);
            for (const result of writeBack) {
              store.appendAudit({ principalId: callerTaskId ? `task:${callerTaskId}` : principal,
                action: result.error ? 'vault.write_back.failed' : 'vault.write_back',
                detail: { itemId: saved.id, ...result } });
            }
          }
          return this.json(res, 200, { id: saved.id, label: saved.label, type: saved.type, fields: saved.fields,
            ...(propagated ? { propagated } : {}), ...(writeBack?.length ? { writeBack } : {}) });
        }
        // Plaintext reveal (§5C) — per-item grant + reveal policy, audited.
        if (p === '/api/vault/resolve' && method === 'POST') {
          const b = await this.body(req);
          const item = findItem(b);
          if (!item) return this.json(res, 200, { status: 'not_in_vault', reason: 'no matching vault item — use request_credential to ask for it' });
          const decision = vault.access(caps, callerTaskId, item, 'reveal', { consume: true });
          if (decision.status !== 'granted')
            return this.json(res, 200, this.autoRaiseCredential(vault, decision, { caps, taskId: callerTaskId, projectId: authRecord?.projectId, item, field: b.field, mode: 'reveal', why: b.why }));
          const field = (b.field as any) ?? defaultField(item.type);
          if (!ITEM_FIELDS[item.type].includes(field)) return this.json(res, 400, { error: `item type ${item.type} has no field ${field}` });
          const value = field === 'totp'
            ? vault.totp(item, { taskId: callerTaskId, principal })
            : vault.resolveField(item, field, { taskId: callerTaskId, principal, mode: 'reveal' });
          return this.json(res, 200, { status: 'granted', itemId: item.id, field, ...(item.username ? { username: item.username } : {}), value });
        }
        // Zero-exposure browser fill (§5B) — the secret goes gateway → CDP,
        // never through the agent. `username` fills metadata; `totp` fills the
        // current code computed broker-side from the stored seed.
        if (p === '/api/vault/fill' && method === 'POST') {
          const b = await this.body(req);
          const item = findItem(b);
          if (!item) return this.json(res, 200, { status: 'not_in_vault', reason: 'no matching vault item — use request_credential to ask for it' });
          const decision = vault.access(caps, callerTaskId, item, 'use', { consume: true });
          if (decision.status !== 'granted')
            return this.json(res, 200, this.autoRaiseCredential(vault, decision, { caps, taskId: callerTaskId, projectId: authRecord?.projectId, item, field: b.field, mode: 'use', why: b.why }));
          const field = String(b.field ?? 'password');
          if (field === 'username' && !item.username) return this.json(res, 400, { error: `item "${item.label}" has no ${field}` });
          if (field !== 'username' && !item.fields.includes(field as any)) return this.json(res, 400, { error: `item "${item.label}" has no ${field}` });
          const resolveText = () => field === 'username'
            ? item.username!
            : field === 'totp'
              ? vault.totp(item, { taskId: callerTaskId, principal })
              : vault.resolveField(item, field as any, { taskId: callerTaskId, principal, mode: 'use' });
          try {
            const origin = await this.fillCredential(callerTaskId, {
              selector: String(b.selector ?? ''), cdpUrl: b.cdpUrl, expectDomains: item.domains, resolveText,
            });
            return this.json(res, 200, { status: 'granted', itemId: item.id, filled: true, origin });
          } catch (e) {
            return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (p === '/api/vault/requests' && method === 'GET') {
          return this.json(res, 200, vault.requests({
            taskId: url.searchParams.get('taskId') ?? undefined,
            status: (url.searchParams.get('status') as any) ?? undefined,
          }).map((request) => this.credentialRequestView(request, organizationId)));
        }
        // The pull model (§7): an agent escalates for an item it lacks.
        if (p === '/api/vault/requests' && method === 'POST') {
          const b = await this.body(req);
          if (!callerTaskId) return this.json(res, 400, { error: 'a task-agent token is required to request credential access' });
          const priorPending = new Set(vault.requests({ taskId: callerTaskId, status: 'pending' }).map((request) => request.id));
          const decision = vault.request({
            taskId: callerTaskId,
            projectId: authRecord?.projectId,
            caps,
            itemId: b.itemId ? String(b.itemId) : undefined,
            domain: b.domain ? String(b.domain) : undefined,
            field: b.field,
            mode: b.mode,
            kind: b.kind === 'reset' ? 'reset' : undefined,
            why: b.why ? String(b.why) : undefined,
          });
          if (decision.requestId && !priorPending.has(decision.requestId)) {
            const task = store.getTask(callerTaskId);
            const taskOrganization = task && store.getProject(task.projectId)?.organizationId;
            if (task && taskOrganization === organizationId) this.emitTaskEvent({
              taskId: task.id,
              type: 'credential.approval-requested',
              ts: Date.now(),
              payload: {
                requestId: decision.requestId,
                status: 'approval-needed',
                mode: b.mode === 'reveal' ? 'reveal' : 'use',
                kind: b.kind === 'reset' ? 'reset' : 'access',
                ...(decision.itemId ? { itemId: decision.itemId } : {}),
                ...(b.domain ? { domain: String(b.domain) } : {}),
                ...(b.why ? { why: String(b.why) } : {}),
                ...(b.urgency ? { urgency: normalizeUrgency(b.urgency) } : {}),
              },
            });
          }
          return this.json(res, 200, decision);
        }
        const vres = p.match(/^\/api\/vault\/requests\/([^/]+)\/resolve$/);
        if (vres && method === 'POST') {
          const b = await this.body(req);
          const action = String(b.action ?? '');
          if (!['once', 'task', 'always', 'deny'].includes(action)) return this.json(res, 400, { error: 'action must be once | task | always | deny' });
          try {
            const resolved = vault.resolve(vres[1]!, { action: action as any, by: principal, itemId: b.itemId ? String(b.itemId) : undefined });
            const item = resolved.itemId ? vault.get(resolved.itemId) : undefined;
            const label = item?.label ?? resolved.domain ?? 'credential';
            const message = action === 'deny'
              ? `[Krmax credential decision]\n\nAccess to "${label}" was denied. Do not request it again; continue without it or explain why the task cannot proceed.`
              : `[Krmax credential decision]\n\nAccess to "${label}" was approved (${action}). Retry the blocked ${resolved.mode} operation now; the grant is already active.`;
            const resume = await api.resumeAfterCredentialDecision(resolved.taskId, message);
            const task = store.getTask(resolved.taskId);
            if (task && store.getProject(task.projectId)?.organizationId === organizationId) {
              this.emitTaskEvent({
                taskId: resolved.taskId,
                type: 'credential.approval-resolved',
                ts: Date.now(),
                payload: { requestId: resolved.id, itemId: resolved.itemId, action, resumed: resume.resumed },
              });
            }
            return this.json(res, 200, { ...this.credentialRequestView(resolved, organizationId), resume });
          } catch (e) {
            return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        }

        // ── external store connectors (§9) ──
        if (p.startsWith('/api/vault/connectors')) {
          if (!this.deps.broker) return this.json(res, 400, { error: 'no credential broker configured' });
          const { defaultConnectors } = await import('../autonomy/connectors.js');
          const connectors = defaultConnectors(store, vault, this.deps.broker, organizationId,
            { hostLocal: this.hostLocal, hosted: this.deps.hosted });
          if (p === '/api/vault/connectors' && method === 'GET') return this.json(res, 200, await connectors.describe());
          const connName = p.match(/^\/api\/vault\/connectors\/([^/]+)(?:\/([^/]+))?$/);
          if (connName && !connectors.get(connName[1]!)) return this.json(res, 404, { error: `no connector "${connName[1]}"` });
          if (connName && method === 'POST') {
            const b = await this.body(req);
            const action = connName[2];
            try {
              if (action === 'connect') { connectors.connect(connName[1]!, String(b.secret ?? '')); return this.json(res, 200, { connected: true }); }
              if (action === 'config') return this.json(res, 200, connectors.setConfig(connName[1]!, { writeBack: !!b.writeBack }));
              if (action === 'list') return this.json(res, 200, await connectors.get(connName[1]!)!.list());
              if (action === 'sync') return this.json(res, 200, await connectors.sync(connName[1]!, Array.isArray(b.externalIds) ? b.externalIds.map(String) : [],
                { policy: b.policy, writeBack: typeof b.writeBack === 'boolean' ? b.writeBack : undefined }));
              if (action === 'write-back') return this.json(res, 200, (await connectors.writeBack(connName[1]!, String(b.itemId ?? ''))) ?? { skipped: 'write-back disabled for this connector' });
            } catch (e) {
              return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
            }
            return this.json(res, 404, { error: 'unknown connector action' });
          }
        }

        // ── agent-enrolled passkeys (§8) ──
        if (p.startsWith('/api/vault/passkey')) {
          if (!this.passkeys) {
            const { PasskeyManager } = await import('../autonomy/passkey.js');
            this.passkeys = new PasskeyManager();
          }
          const b = method === 'POST' ? await this.body(req) : {};
          const item = b.itemId ? vault.get(String(b.itemId)) : b.domain ? vault.findByDomain(String(b.domain))[0] : undefined;
          try {
            if (p === '/api/vault/passkey/enroll' && method === 'POST') {
              const domains = Array.isArray(b.domains) ? b.domains.map(String) : b.domain ? [String(b.domain)] : undefined;
              const started = await this.passkeys.begin(String(b.cdpUrl ?? defaultCdpUrl()), { expectDomains: domains, mode: 'enroll' });
              return this.json(res, 200, { ...started, next: 'trigger the site\'s "create a passkey" button in the browser, then POST /api/vault/passkey/save with this authenticatorId' });
            }
            if (p === '/api/vault/passkey/save' && method === 'POST') {
              const creds = await this.passkeys.harvest(String(b.authenticatorId ?? ''));
              if (!creds.length) return this.json(res, 400, { error: 'no passkey was created on the page — trigger the site\'s enroll button first' });
              const saved = vault.save({
                type: 'passkey',
                label: String(b.label ?? (item?.label ? `${item.label} (passkey)` : 'passkey')),
                domains: Array.isArray(b.domains) ? b.domains.map(String) : creds[0]!.rpId ? [creds[0]!.rpId] : undefined,
                username: b.username ? String(b.username) : undefined,
                secrets: { passkey: JSON.stringify(creds) },
                provenance: { source: callerTaskId ? `task:${callerTaskId}` : 'manual', taskId: callerTaskId },
              });
              return this.json(res, 200, { itemId: saved.id, label: saved.label, count: creds.length });
            }
            if (p === '/api/vault/passkey/login' && method === 'POST') {
              if (!item) return this.json(res, 200, { status: 'not_in_vault', reason: 'no passkey item — enroll one first' });
              const decision = vault.access(caps, callerTaskId, item, 'use', { consume: true });
              if (decision.status !== 'granted') return this.json(res, 200, { ...decision, itemId: item.id });
              const creds = JSON.parse(vault.resolveField(item, 'passkey', { taskId: callerTaskId, principal, mode: 'use' })) as any[];
              const domains = item.domains;
              const started = await this.passkeys.begin(String(b.cdpUrl ?? defaultCdpUrl()), { expectDomains: domains, mode: 'login', credential: creds[0] });
              return this.json(res, 200, { status: 'granted', ...started, next: 'trigger "sign in with a passkey" in the browser, then POST /api/vault/passkey/release with this authenticatorId' });
            }
            if (p === '/api/vault/passkey/release' && method === 'POST') {
              this.passkeys.release(String(b.authenticatorId ?? ''));
              return this.json(res, 200, { released: true });
            }
          } catch (e) {
            return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        }
      }

      // ── agent mailbox (§8): ORGANIZATION-scoped — each org connects its own
      // email backend (like world providers / payment cards). The org in the
      // path is enforced by requestScope + the token check, so one tenant can
      // neither configure nor read another's mail. (The inbound webhook is a
      // separate unauthenticated shared-secret route before the session gate.)
      const orgMail = p.match(/^\/api\/organizations\/([^/]+)\/agent-mail(?:\/(providers|connect))?$/);
      if (orgMail) {
        const organizationId = orgMail[1]!;
        const sub = orgMail[2];
        const { AgentMail } = await import('../autonomy/agent-mail.js');
        if (!sub && method === 'GET') {
          const config = this.mailboxConfig(organizationId);
          const mail = new AgentMail(
            store,
            this.mailboxDomain(organizationId),
            this.mailboxFixedLocal(organizationId),
            config.agentmailAddress,
          );
          return this.json(res, 200, { organizationId, address: mail.address(organizationId), configured: mail.configured(),
            provider: config.provider, domain: this.mailboxDomain(organizationId),
            messages: mail.recent(organizationId, { since: url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined, match: url.searchParams.get('match') ?? undefined, limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined }) });
        }
        if (sub === 'providers' && method === 'GET') {
          const { defaultMailboxRegistry } = await import('../autonomy/mailbox.js');
          const { ingestSecret, cloudflareWorkerScript } = await import('../autonomy/agent-mail.js');
          const config = this.mailboxConfig(organizationId);
          // The push webhook URL (secret included) + Cloudflare worker are still
          // returned for the operator who wants them; the UI hides them for now.
          const base = process.env.KARMAX_GATEWAY_URL || `http://${req.headers.host ?? '127.0.0.1'}`;
          const webhookUrl = `${base}/api/agent-mail/ingest?secret=${ingestSecret(this.deps.store)}`;
          return this.json(res, 200, { providers: defaultMailboxRegistry().list(config), active: config.provider, webhookUrl, cloudflareWorker: cloudflareWorkerScript(webhookUrl) });
        }
        if (sub === 'connect' && method === 'POST') {
          const { defaultMailboxRegistry } = await import('../autonomy/mailbox.js');
          const b = await this.body(req);
          const provider = defaultMailboxRegistry().get(String(b.provider ?? ''));
          if (!provider) return this.json(res, 400, { error: `unknown mailbox provider "${b.provider}"` });
          const result = provider.connect({
            domain: b.domain ? String(b.domain) : undefined,
            apiKey: b.apiKey ? String(b.apiKey) : undefined,
            address: b.address ? String(b.address) : undefined,
            imapHost: b.imapHost ? String(b.imapHost) : undefined,
            imapPort: b.imapPort ? Number(b.imapPort) : undefined,
            imapUser: b.imapUser ? String(b.imapUser) : undefined,
            imapSecure: b.imapSecure === undefined ? undefined : b.imapSecure !== false,
          });
          if (result.status === 'connected' && result.config) {
            // The provider secret (AgentMail key / IMAP password) → the vault under
            // an org-scoped handle the poller resolves; never echoed or stored raw.
            const apiKeyHandle = this.mailboxSecretHandle(organizationId, String(b.provider));
            if (b.apiKey && this.deps.broker) this.deps.broker.registerHandle(apiKeyHandle, String(b.apiKey));
            // REPLACE (not merge) so switching providers can't leave a stale field.
            const config = { ...result.config, ...(b.apiKey ? { apiKeyHandle } : {}) };
            this.setMailboxConfig(organizationId, config);
            if (config.provider === 'agentmail') {
              new AgentMail(store, config.agentmailDomain, undefined, config.agentmailAddress).address(organizationId);
            }
          }
          return this.json(res, result.status === 'unavailable' ? 400 : 200, result);
        }
      }

      // ── outbound email (installation-wide) — the operator connects ONE sender
      // (settings:write) and every organization's user mail (confirmation, reset,
      // invites) flows through it. The secret lives in the vault, never echoed.
      if (p === '/api/email' && method === 'GET') {
        const { describeOutboundProviders } = await import('../autonomy/email.js');
        const config = this.outboundEmailConfig();
        return this.json(res, 200, {
          provider: config.provider, from: config.from,
          configured: this.deps.email?.configured() ?? false,
          canManage: this.deps.tokens.check(token, 'settings:write').ok,
          providers: describeOutboundProviders(config),
        });
      }
      if (p === '/api/email/connect' && method === 'POST') {
        const { connectOutboundEmail } = await import('../autonomy/email.js');
        const b = await this.body(req);
        const result = connectOutboundEmail({
          provider: b.provider ? String(b.provider) : undefined,
          from: b.from ? String(b.from) : undefined,
          host: b.host ? String(b.host) : undefined,
          port: b.port ? Number(b.port) : undefined,
          secure: b.secure === undefined ? undefined : b.secure !== false,
          user: b.user ? String(b.user) : undefined,
          secret: b.secret ? String(b.secret) : undefined,
        });
        if (result.status === 'connected' && result.config) {
          const handle = 'email:outbound:auth';
          if (b.secret && this.deps.broker) this.deps.broker.registerHandle(handle, String(b.secret));
          // REPLACE, not merge, so switching providers can't leave a stale field.
          this.setOutboundEmailConfig({ ...result.config, secretHandle: handle });
        }
        return this.json(res, result.status === 'unavailable' ? 400 : 200, result);
      }
      if (p === '/api/email/test' && method === 'POST') {
        if (!this.deps.email?.configured()) return this.json(res, 400, { error: 'connect an email provider first' });
        const b = await this.body(req);
        const to = String(b.to ?? session.email ?? '').trim();
        if (!to) return this.json(res, 400, { error: 'no recipient — pass { to } or sign in with an email' });
        try {
          await this.deps.email.send({ to, subject: 'krmax test email',
            text: 'This is a test email from karmax. Outbound email is working.' });
          return this.json(res, 200, { ok: true, to });
        } catch (e) { return this.json(res, 502, { error: e instanceof Error ? e.message : String(e) }); }
      }

      // cards (payment resources; SPEC §7.6) — organization-scoped so a tenant
      // never spends from another's card. A project card narrows within its org.
      if (p === '/api/cards' && method === 'GET') {
        const pid = url.searchParams.get('projectId') ?? undefined;
        const cardOrg = authRecord?.organizationId ?? requestedScope.organizationId;
        if (pid && cardOrg && store.getProject(pid)?.organizationId !== cardOrg)
          return this.json(res, 404, { error: 'project not found in this organization' });
        const { cardRemaining } = await import('../autonomy/payments.js');
        // `available` is not what is left on the card — on an issuing rail it is
        // the organization's whole balance. Report the ceiling and what has been
        // counted against it, so the surface cannot claim more than the cap.
        return this.json(res, 200, store.listCards(pid, cardOrg).map((card) => {
          const spent = store.cardPaymentSpent(card.id);
          // An unregistered rail (a card left behind by a provider this
          // deployment no longer loads) still has a cap worth reporting.
          let enforces = true;
          try { enforces = this.deps.paymentRegistry?.forCard(card).enforcesCardCap !== false; } catch {}
          return { ...card, spent, remaining: cardRemaining(card, spent, enforces) };
        }));
      }
      if (p === '/api/cards' && method === 'POST') {
        if (!this.deps.paymentRegistry && !this.deps.payments)
          return this.json(res, 400, { error: 'no payment provider configured' });
        const b = await this.body(req);
        // A non-project card belongs to the caller's own organization (the old
        // installation-wide "global" card is gone in the multi-tenant model).
        const cardOrg = authRecord?.organizationId ?? requestedScope.organizationId
          ?? (b.projectId ? store.getProject(String(b.projectId))?.organizationId : undefined) ?? 'org_personal';
        if (b.scope === 'project' && (!b.projectId || store.getProject(String(b.projectId))?.organizationId !== cardOrg))
          return this.json(res, 400, { error: 'project does not belong to this organization' });
        const provider = b.provider
          ? this.deps.paymentRegistry?.get(String(b.provider))
          : this.deps.paymentRegistry?.active(cardOrg) ?? this.deps.payments;
        if (!provider) return this.json(res, 400, { error: 'payment provider not found' });
        try {
          const card = await provider.provisionCard({
            scope: b.scope === 'project' ? 'project' : 'organization',
            scopeId: b.scope === 'project' ? b.projectId : cardOrg,
            label: b.label ?? 'Card',
            cap: Number(b.cap ?? 0),
            merchantLock: Array.isArray(b.merchantLock) ? b.merchantLock : undefined,
            organizationId: cardOrg,
            currency: b.currency ? String(b.currency) : 'usd',
            cardholderId: b.cardholderId ? String(b.cardholderId) : undefined,
            // Only the vault-card rail consumes these; the secret half goes
            // straight into the vault and is never echoed back in the response.
            details: b.details ? {
              number: String(b.details.number ?? ''),
              cvc: String(b.details.cvc ?? ''),
              expMonth: Number(b.details.expMonth),
              expYear: Number(b.details.expYear),
              billing: b.details.billing,
            } : undefined,
          });
          return this.json(res, 200, card);
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const fundMatch = p.match(/^\/api\/cards\/([^/]+)\/fund$/);
      if (fundMatch && method === 'POST') {
        if (!this.deps.paymentRegistry && !this.deps.payments)
          return this.json(res, 400, { error: 'no payment provider configured' });
        const cardOrg = authRecord?.organizationId ?? requestedScope.organizationId ?? 'org_personal';
        const card = store.getCard(fundMatch[1]!);
        const belongs = card?.scope === 'organization'
          ? card.scopeId === cardOrg
          : card?.scope === 'project'
            ? Boolean(card.scopeId && store.getProject(card.scopeId)?.organizationId === cardOrg)
            : card?.scope === 'global' && cardOrg === 'org_personal';
        if (!belongs)
          return this.json(res, 404, { error: 'card not found in this organization' });
        const provider = this.deps.paymentRegistry?.forCard(card) ?? this.deps.payments;
        if (!provider) return this.json(res, 400, { error: 'payment provider not found' });
        const b = await this.body(req);
        try {
          await provider.fund(fundMatch[1]!, Number(b.amount ?? 0));
          return this.json(res, 200, store.getCard(fundMatch[1]!) ?? null);
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const cardMatch = p.match(/^\/api\/cards\/([^/]+)$/);
      if (cardMatch && method === 'DELETE') {
        const cardOrg = authRecord?.organizationId ?? requestedScope.organizationId ?? 'org_personal';
        const card = store.getCard(cardMatch[1]!) as import('../autonomy/payments.js').Card | undefined;
        const belongs = card?.scope === 'organization'
          ? card.scopeId === cardOrg
          : card?.scope === 'project'
            ? Boolean(card.scopeId && store.getProject(card.scopeId)?.organizationId === cardOrg)
            : card?.scope === 'global' && cardOrg === 'org_personal';
        if (!card || !belongs) return this.json(res, 404, { error: 'card not found in this organization' });
        const provider = this.deps.paymentRegistry?.forCard(card) ?? this.deps.payments;
        if (!provider) return this.json(res, 400, { error: 'payment provider not found' });
        await provider.revoke(card.id);
        return this.json(res, 200, store.getCard(card.id));
      }

      // accounts: API-key handles (broker; secrets write-only) + config-home
      // logins (SPEC §7.3 — switchable per-account subscriptions).
      if (resourcePath === '/api/accounts' && method === 'GET') {
        const { agentAccountHandles } = await import('../platform/credential-sources.js');
        return this.json(res, 200, {
          handles: agentAccountHandles(this.deps.broker?.listHandles() ?? [], resourceOrganizationId),
          // never expose the home's absolute path to the browser
          logins: (this.deps.configHomes?.list(resourceOrganizationId) ?? []).map((a) => ({
            provider: a.provider,
            account: a.account,
            loggedIn: a.loggedIn,
            key: resourceOrganizationId === 'org_personal'
              ? `login:${a.provider}:${a.account}`
              : `login:${resourceOrganizationId}:${a.provider}:${a.account}`,
          })),
        });
      }
      if (resourcePath === '/api/accounts' && method === 'POST') {
        const b = await this.body(req);
        if (!this.deps.broker) return this.json(res, 400, { error: 'no credential broker configured' });
        if (!b.provider || !b.account || !b.apiKey) return this.json(res, 400, { error: 'provider, account, apiKey required' });
        const provider = String(b.provider);
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(provider)) {
          return this.json(res, 400, { error: 'model provider must be a simple id (letters, numbers, dot, underscore, hyphen)' });
        }
        const account = String(b.account);
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(account)) {
          return this.json(res, 400, { error: 'account must be a simple id (letters, numbers, dot, underscore, hyphen)' });
        }
        const handle = resourceOrganizationId === 'org_personal'
          ? `${provider}:${account}`
          : `${provider}:${resourceOrganizationId}:${account}`;
        this.deps.broker.registerHandle(handle, String(b.apiKey));
        await this.refreshLoginPool();
        return this.json(res, 200, { handle }); // never echoes the secret
      }
      // connect an account login: mint a config home + launch the provider's own
      // OAuth, return the device URL for the user to complete (we never type creds).
      if (resourcePath === '/api/accounts/connect' && method === 'POST') {
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
        const result = await this.deps.login.connect(provider, String(b.account), { modelProvider, authMethod }, resourceOrganizationId);
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
      const loginMatch = resourcePath.match(/^\/api\/accounts\/logins\/([^/]+)\/(.+)$/);
      if (loginMatch && (method === 'DELETE' || method === 'PATCH')) {
        if (!this.deps.configHomes) return this.json(res, 400, { error: 'no config homes configured' });
        const rawProvider = loginMatch[1];
        if (!isLoginProvider(rawProvider)) return this.json(res, 400, { error: `unsupported login provider: ${rawProvider}` });
        const provider = rawProvider;
        const account = decodeURIComponent(loginMatch[2]!);
        if (method === 'DELETE') {
          this.deps.configHomes.remove(provider, account, resourceOrganizationId);
        } else {
          const b = await this.body(req);
          if (!b.account) return this.json(res, 400, { error: 'new account name required' });
          this.deps.configHomes.rename(provider, account, String(b.account), resourceOrganizationId);
        }
        await this.refreshLoginPool();
        return this.json(res, 200, { ok: true });
      }

      // Git profiles (PLAN-git-config.md §3): named git identity + credentials for
      // the repos karmax works on. The registry is public; secrets are write-only
      // into the vault (never echoed) and resolved JIT by the broker at use time.
      if (resourcePath === '/api/git-profiles' && method === 'GET') {
        const { GitProfiles } = await import('../autonomy/git-profiles.js');
        const gp = new GitProfiles(store, this.deps.broker, undefined, resourceOrganizationId);
        return this.json(res, 200, { profiles: gp.list(), defaultProfile: gp.defaultProfile() ?? null });
      }
      if (resourcePath === '/api/git-profiles' && method === 'POST') {
        const b = await this.body(req);
        if (!this.deps.broker) return this.json(res, 400, { error: 'no credential broker configured' });
        if (!b.name || !b.userName || !b.userEmail) return this.json(res, 400, { error: 'name, userName, userEmail required' });
        const { GitProfiles } = await import('../autonomy/git-profiles.js');
        const gp = new GitProfiles(store, this.deps.broker, undefined, resourceOrganizationId);
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
      const gitProfileMatch = resourcePath.match(/^\/api\/git-profiles\/([^/]+)$/);
      if (gitProfileMatch && method === 'DELETE') {
        const { GitProfiles } = await import('../autonomy/git-profiles.js');
        new GitProfiles(store, this.deps.broker, undefined, resourceOrganizationId)
          .delete(decodeURIComponent(gitProfileMatch[1]!));
        return this.json(res, 200, { ok: true });
      }
      // The doctor check (PLAN-git-config.md §7): which tier a project's remote
      // ops resolve to (profile / host fallback) and whether it can reach the
      // repos' remotes non-interactively. Read-only.
      if (resourcePath === '/api/git-profiles/preflight' && method === 'GET') {
        const projectId = url.searchParams.get('projectId') ?? undefined;
        const project = projectId ? store.getProject(projectId) : undefined;
        const { GitProfiles } = await import('../autonomy/git-profiles.js');
        const organizationId = project?.organizationId ?? resourceOrganizationId;
        if (project && organizationId !== resourceOrganizationId)
          return this.json(res, 400, { error: 'project does not belong to this organization' });
        return this.json(res, 200, await new GitProfiles(store, this.deps.broker, undefined, organizationId).preflight(project?.config));
      }
      if (resourcePath === '/api/git-profiles/default' && method === 'POST') {
        const b = await this.body(req);
        const { GitProfiles } = await import('../autonomy/git-profiles.js');
        new GitProfiles(store, this.deps.broker, undefined, resourceOrganizationId)
          .setDefault(b.name ? String(b.name) : undefined);
        return this.json(res, 200, { ok: true });
      }

      // Manual availability override for an agent login (SPEC §6.2): force a login
      // on/off or edit its reset time (e.g. after upgrading a plan) without waiting
      // for the old refresh. Signals the account coordinator directly.
      if (resourcePath === '/api/accounts/availability' && method === 'POST') {
        if (!this.deps.client) return this.json(res, 400, { error: 'no temporal client' });
        const b = await this.body(req);
        if (!b.accountId || !b.status) return this.json(res, 400, { error: 'accountId and status required' });
        if (!this.organizationCredentialKeys(resourceOrganizationId).includes(String(b.accountId)))
          return this.json(res, 404, { error: 'credential not found in this organization' });
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
      if (resourcePath === '/api/accounts/concurrency' && method === 'POST') {
        const b = await this.body(req);
        if (!b.accountId) return this.json(res, 400, { error: 'accountId required' });
        if (!this.organizationCredentialKeys(resourceOrganizationId).includes(String(b.accountId)))
          return this.json(res, 404, { error: 'credential not found in this organization' });
        const { concurrencyKey } = await import('../platform/credential-sources.js');
        const { UNLIMITED_CONCURRENCY } = await import('../coordinators/names.js');
        const n = b.max == null || b.max === '' ? UNLIMITED_CONCURRENCY : Math.floor(Number(b.max));
        if (!Number.isFinite(n) || n < 1) return this.json(res, 400, { error: 'max must be a positive integer, or empty for unlimited' });
        store.kvSet(concurrencyKey(String(b.accountId)), String(n));
        await this.refreshLoginPool();
        return this.json(res, 200, { ok: true, maxConcurrent: n });
      }

      // Proactive quota (#6): real usage % + reset for each pollable subscription.
      // GET returns the cached snapshots; recheck re-probes on demand (the button).
      // API-key/setup-token creds aren't pollable → they show reactive status.
      if (resourcePath === '/api/accounts/usage' && method === 'GET') {
        const { enumerateCredentials } = await import('../platform/credentials.js');
        const { gatherCredentialSources } = await import('../platform/credential-sources.js');
        const { isUsagePollable, isUsageStale } = await import('../agent/usage.js');
        const creds = enumerateCredentials(gatherCredentialSources({
          configHomes: this.deps.configHomes,
          broker: this.deps.broker,
          organizationId: resourceOrganizationId,
        }));
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
          // Explain absence on a login that CAN'T be polled (setup-token, no full
          // native credential) so the dashboard shows a reason, not a blank.
          else if (!canPoll && c.kind !== 'key') usage[c.key] = { ok: false, reason: 'setup-token' };
        }
        return this.json(res, 200, { usage, pollable });
      }
      if (resourcePath === '/api/accounts/usage/recheck' && method === 'POST') {
        const b = await this.body(req);
        const only = b.accountId ? String(b.accountId) : undefined;
        const usage = await this.refreshUsage(only, resourceOrganizationId);
        return this.json(res, 200, { usage });
      }

      // Credential policy (SPEC §7/§9): list every credential + its effective
      // enablement per scope (global→project→task), and set a scope's ordering /
      // enable-disable overrides.
      if (resourcePath === '/api/credentials' && method === 'GET') {
        const { enumerateCredentials, resolveCredentials } = await import('../platform/credentials.js');
        const { gatherCredentialSources, parsePolicy, credPolicyKey } = await import('../platform/credential-sources.js');
        const projectId = url.searchParams.get('projectId') ?? undefined;
        const taskId = url.searchParams.get('taskId') ?? undefined;
        const scopedProjectId = projectId ?? (taskId ? store.getTask(taskId)?.projectId : undefined);
        const scopedOrganizationId = scopedProjectId
          ? store.getProject(scopedProjectId)?.organizationId ?? resourceOrganizationId
          : resourceOrganizationId;
        if (scopedOrganizationId !== resourceOrganizationId)
          return this.json(res, 400, { error: 'credential scope does not belong to this organization' });
        const creds = enumerateCredentials(gatherCredentialSources({
          configHomes: this.deps.configHomes,
          broker: this.deps.broker,
          organizationId: scopedOrganizationId,
        }));
        const g = parsePolicy(store.kvGet(credPolicyKey.organization(scopedOrganizationId)))
          ?? (scopedOrganizationId === 'org_personal' ? parsePolicy(store.kvGet(credPolicyKey.global())) : undefined);
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
      if (resourcePath === '/api/credentials/policy' && method === 'POST') {
        const b = await this.body(req);
        const { credPolicyKey } = await import('../platform/credential-sources.js');
        let key: string;
        if (b.scope === 'task') {
          const task = b.taskId ? store.getTask(String(b.taskId)) : undefined;
          const project = task ? store.getProject(task.projectId) : undefined;
          if (!task || project?.organizationId !== resourceOrganizationId)
            return this.json(res, 400, { error: 'credential scope does not belong to this organization' });
          key = credPolicyKey.task(task.id);
        } else if (b.scope === 'project') {
          const project = b.projectId ? store.getProject(String(b.projectId)) : undefined;
          if (!project || project.organizationId !== resourceOrganizationId)
            return this.json(res, 400, { error: 'credential scope does not belong to this organization' });
          key = credPolicyKey.project(project.id);
        } else if (b.scope === 'global' || b.scope === 'organization') {
          key = credPolicyKey.organization(resourceOrganizationId);
        } else {
          return this.json(res, 400, { error: 'scope must be organization, global, project, or task' });
        }
        store.kvSet(key, JSON.stringify(b.policy ?? {}));
        return this.json(res, 200, { ok: true });
      }

      // workflow parameter schemas (SPEC §10.4) — drives task forms + settings forms
      if (p === '/api/schema' && method === 'GET') {
        // Built-in + installed workflows, so the New Task form offers both (§21d).
        return this.json(res, 200, api.workflowSchemas(requestedScope.organizationId ?? 'org_personal'));
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
        const globalVals = { ...globalSettingsFor(gs, wf, organizationId ?? undefined) };
        const projectVals = project ? { ...projectSettingsFor(gs, project, wf) } : {};
        // "Agent environment" (worldProvider) is stored in the execution policy, not
        // the settings rows — surface the real organization default + project override
        // so the Task Defaults form shows and inherits the true selection (§11).
        if (organizationId && globalVals.worldProvider === undefined) {
          const orgProvider = store.getOrganizationExecutionPolicy(organizationId).worldProvider;
          if (orgProvider !== undefined) globalVals.worldProvider = orgProvider;
        }
        if (project?.config.worldProvider !== undefined) projectVals.worldProvider = project.config.worldProvider;
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
        // Quick-task agent defaults (SPEC §10.4): an agent-only overlay for tasks
        // added from the quick box. Project Quick agents inherit through the
        // organization Quick agents into the regular project/organization agents.
        const globalQuickVals = quickGlobalSettingsFor(gs, wf, organizationId ?? undefined);
        const projectQuickVals = project ? quickProjectSettingsFor(gs, project.id, wf) : {};
        return this.json(res, 200, {
          task: { own: {}, inherited: enrich(resolveParams(m, { project: projectVals, global: globalVals }), {}) },
          project: { own: projectVals, inherited: enrich(resolveParams(m, { global: globalVals }), projectVals) },
          global: { own: globalVals, inherited: enrich(resolveParams(m, {}), { ...projectVals, ...globalVals }) },
          globalQuick: { own: globalQuickVals, inherited: enrich(resolveParams(m, { global: globalVals }), globalQuickVals) },
          projectQuick: {
            own: projectQuickVals,
            inherited: enrich(resolveParamsLayers(m, [globalQuickVals, projectVals, globalVals]), { ...projectVals, ...globalVals, ...globalQuickVals, ...projectQuickVals }),
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
          const values = b.values ?? {};
          store.setSettings(`organization:${organizationId}`, wf!, values);
          // The organization "Agent environment" default lives in the execution
          // policy (so runner-pool compatibility and effectiveProjectConfig agree);
          // mirror a non-empty selection there. Blank at organization scope means
          // "unchanged" — the top-level default is always a concrete provider.
          if (values.worldProvider)
            store.setOrganizationExecutionPolicy(organizationId!, { worldProvider: values.worldProvider as string });
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
          if (wf === 'appearance' && !isBrandIcon(b.values?.icon)) {
            return this.json(res, 400, { error: 'Unknown brand icon' });
          }
          store.setSettings('global', wf, b.values ?? {});
          if (wf === 'agent-queue') await api.setAgentCapacity(token, Number(b.values?.capacity));
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
          // "Agent environment" is canonically an execution-policy value; mirror it so
          // effectiveProjectConfig, runner-pool compatibility, and the Compute section
          // stay coherent (empty ⇒ clear the override and inherit the organization).
          if (Object.prototype.hasOwnProperty.call(values, 'worldProvider'))
            store.setProjectExecutionPolicy(projectId, { worldProvider: (values.worldProvider as string) || null });
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
        let events = store.allEventsSince(since, 300);
        if (authRecord?.projectId) events = events.filter((e) => store.getTask(e.taskId)?.projectId === authRecord?.projectId);
        return this.json(res, 200, events);
      }

      // dashboard
      if (p === '/api/dashboard' && method === 'GET') {
        const dashOrg = requestedScope.organizationId ?? authRecord?.organizationId;
        // Host-wide agent-account leasing is operator data; include it only for a
        // caller who holds diagnostic:read (global operator), never for an ordinary
        // organization member viewing their own overview.
        const caps = authRecord?.caps ?? (session.userId
          ? this.deps.authorization?.capabilities(`user:${session.userId}`, undefined, dashOrg) ?? []
          : []);
        return this.json(res, 200, await this.dashboard(dashOrg, allows(caps, 'diagnostic:read')));
      }

      // safe mode toggle
      // Installation-wide: safe mode reboots the whole cell. The console renders
      // every card for everyone, so the server has to say who may manage this —
      // the same server-derived `canManage` the Stripe Connect card takes.
      if (p === '/api/safe-mode' && method === 'GET') {
        return this.json(res, 200, { safeMode: this.safeMode,
          canManage: this.deps.tokens.check(token, 'safe-mode:write').ok });
      }
      if (p === '/api/safe-mode' && method === 'POST') {
        const b = await this.body(req);
        this.safeMode = !!b.enabled;
        return this.json(res, 200, { safeMode: this.safeMode });
      }

      return this.json(res, 404, { error: 'not found' });
    } catch (e) {
      // A status-bearing platform error (denied / not found / invalid input) is a
      // caller-facing answer, not a server fault: surface its own code rather
      // than letting `fail` flatten everything but CapabilityError to a 500.
      const declared = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : undefined;
      if (declared) return this.json(res, declared, { error: (e as Error).message });
      throw e;
    }
  }

  /**
   * Seed a brand-new project with its preparation task (SPEC §4.6). A new project's
   * tasks default to the `software-dev` workflow, so we seed that workflow's
   * `onActivate` prep task — "make this project karmax-ready" — as the first task on
   * the list. It's created as a **draft**: a project is usually created (name only)
   * before its repository is configured, and a repo-oriented task can't run without
   * one — so the prep task waits on the list for the user to queue once the repo is
   * set, rather than failing creation or running against an empty sandbox.
   * Best-effort: a failure here must never fail project creation.
   */
  private async spawnProjectPrepTask(token: string, projectId: string): Promise<void> {
    const prep = manifest('software-dev')?.onActivate?.spawnTask;
    if (!prep) return;
    try {
      await this.deps.api.createTask(token, {
        projectId,
        title: prep.title,
        prompt: prep.prompt,
        workflow: prep.workflow,
        draft: true,
      });
    } catch (error) {
      console.warn(`[karmax] could not spawn prep task for ${projectId}:`, error instanceof Error ? error.message : error);
    }
  }

  /** Initialize the local canonical wiki immediately. When GitHub is fully
   * connected and the creating human authorized, also create its private
   * companion remote; otherwise the local repo remains ready and this is
   * retried naturally when a project is next set up. */
  private async ensureProjectWiki(project: import('../domain/types.js').Project, userId?: string): Promise<void> {
    const root = ensureProjectWikiRepository(paths().content, project.id);
    if (!this.deps.store.projectWiki(project.id)) this.deps.store.setProjectWikiRepository(project.id);
    const current = this.deps.store.projectWiki(project.id)?.repository;
    if (current && this.wikiRemotesReady.has(project.id)) return;
    if (!this.deps.githubApp) return;
    if ((this.wikiRemoteRetryAfter.get(project.id) ?? 0) > Date.now()) return;
    const githubApp = this.deps.githubApp;
    // Already provisioned in a previous run: mint a short-lived installation
    // token and wire the remote without touching the operator's user OAuth
    // token. Re-running repository creation on every boot would re-hit the API
    // with a possibly-expired user authorization.
    if (current?.private && current.gitConnectionId) {
      if (this.wikiRemotesProvisioning.has(project.id)) return;
      this.wikiRemotesProvisioning.add(project.id);
      void (async () => {
        try {
          await setProjectWikiRemote(root, current.sshUrl, await githubApp.brokerCredentials(current));
          this.wikiRemotesReady.add(project.id);
          this.wikiRemoteRetryAfter.delete(project.id);
        } catch (error) {
          this.wikiRemoteRetryAfter.set(project.id, Date.now() + 5 * 60_000);
          console.warn(`[karmax] could not sync wiki remote for ${project.id}:`, error instanceof Error ? error.message : error);
        } finally {
          this.wikiRemotesProvisioning.delete(project.id);
        }
      })();
      return;
    }
    const organizationId = project.organizationId ?? 'org_personal';
    const candidates = [...new Set([
      ...(userId ? [userId] : []),
      ...this.deps.store.listOrganizationMemberships(organizationId)
        .sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner'))
        .map((membership) => membership.userId),
    ])];
    const actor = candidates.find((candidate) => this.deps.githubApp!.status(candidate).userAuthorized);
    if (!actor) return;
    const connections = this.deps.store.listGitConnections(organizationId);
    const attachedConnectionIds = [...new Set(this.deps.store.listProjectRepositories(project.id)
      .map((candidate) => candidate.repository.gitConnectionId).filter((id): id is string => Boolean(id)))];
    const connection = current?.gitConnectionId
      ? connections.find((candidate) => candidate.id === current.gitConnectionId)
      : attachedConnectionIds.length === 1
      ? connections.find((candidate) => candidate.id === attachedConnectionIds[0])
      : connections.length === 1 ? connections[0] : undefined;
    if (!connection) return;
    if (this.wikiRemotesProvisioning.has(project.id)) return;
    this.wikiRemotesProvisioning.add(project.id);
    void (async () => {
      try {
        const base = project.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'project';
        // Preserve the remote identity across project renames. The deterministic
        // name is only for the first provisioning attempt.
        const name = current?.name ?? `${base}-wiki-${project.id.slice(-8)}`;
        const repository = await githubApp.ensureRepository(connection.id, actor, {
          name, description: `Krmax project wiki for ${project.name}`,
          private: true, defaultBranch: 'main', autoInit: false,
        });
        // Link before the push so even a transient network failure keeps this
        // platform-owned repository out of the ordinary project repo picker.
        this.deps.store.setProjectWikiRepository(project.id, repository.id);
        await setProjectWikiRemote(root, repository.sshUrl, await githubApp.brokerCredentials(repository));
        this.wikiRemotesReady.add(project.id);
        this.wikiRemoteRetryAfter.delete(project.id);
      } catch (error) {
        // An offline SSH endpoint should produce one bounded warning, not a retry
        // storm every time an old browser tab reloads project metadata.
        this.wikiRemoteRetryAfter.set(project.id, Date.now() + 5 * 60_000);
        console.warn(`[karmax] could not create wiki remote for ${project.id}:`, error instanceof Error ? error.message : error);
      } finally {
        this.wikiRemotesProvisioning.delete(project.id);
      }
    })();
  }

  private async availableModels(refresh = false, organizationId = 'org_personal'): Promise<{ providers: ModelCatalog; refreshedAt: number }> {
    const cached = this.modelCatalog.get(organizationId);
    if (!refresh && cached && Date.now() - cached.at < 5 * 60_000) {
      return { providers: cached.value, refreshedAt: cached.at };
    }
    const { gatherCredentialSources } = await import('../platform/credential-sources.js');
    const { enumerateCredentials } = await import('../platform/credentials.js');
    const creds = enumerateCredentials(gatherCredentialSources({
      configHomes: this.deps.configHomes,
      broker: this.deps.broker,
      organizationId,
    }));
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
        { id: 'default' }, { id: 'opus[1m]' }, { id: 'claude-fable-5[1m]' }, { id: 'sonnet' }, { id: 'haiku' },
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
    const next = { at: Date.now(), value };
    this.modelCatalog.set(organizationId, next);
    return { providers: value, refreshedAt: next.at };
  }

  /** For each agent field, resolve the concrete provider/model the server would
   *  actually run (setting → seeded profile → code default), so the form can show
   *  it as the inherited default. */
  /** Re-register the connected-login pool with the account coordinator so lease
   *  rotation reflects the current set (called after connect/rename/delete). */
  private async refreshLoginPool(): Promise<void> {
    if (!this.deps.configHomes || !this.deps.client) return;
    const { concurrencyFor } = await import('../platform/credential-sources.js');
    const creds = this.deps.store.listOrganizations().flatMap((organization) =>
      enumerateCredentials(gatherCredentialSources({
        configHomes: this.deps.configHomes,
        broker: this.deps.broker,
        organizationId: organization.id,
      })),
    );
    const pool = creds.map((c) => {
      const maxConcurrent = concurrencyFor((k) => this.deps.store.kvGet(k), c.key);
      const credentialProvider = c.kind === 'key' ? c.provider : c.modelProvider;
      return {
        id: c.key,
        configHome: c.configHome ?? '',
        provider: c.provider,
        kind: c.kind,
        ...(c.apiKeyHandle ? { apiKeyHandle: c.apiKeyHandle } : {}),
        ...(credentialProvider ? { credentialProvider } : {}),
        ...(maxConcurrent != null ? { maxConcurrent } : {}),
      };
    });
    if (!pool.length) return;
    const { makeCoordinatorActivities } = await import('../activities/coordinator.js');
    await makeCoordinatorActivities({ client: this.deps.client, taskQueue: this.deps.taskQueue }).registerAccounts(pool).catch(() => undefined);
  }

  /** Probe usage for pollable subscription logins (all, or just `only`) and cache the
   *  snapshots in kv under `usage:<credKey>`. Drives the dashboard's real %; a probe
   *  asks the provider's native CLI for account quota without spending a model turn.
   *  Overlapping rechecks (auto-refresh + button, multiple tabs) share one in-flight
   *  probe per login rather than spawning duplicate CLIs. */
  private usageProbes = new Map<string, Promise<unknown>>();
  private async refreshUsage(only?: string, organizationId = 'org_personal'): Promise<Record<string, unknown>> {
    const { store } = this.deps;
    const { probeClaudeUsage, probeCodexUsage, isUsagePollable } = await import('../agent/usage.js');
    const creds = enumerateCredentials(gatherCredentialSources({
      configHomes: this.deps.configHomes,
      broker: this.deps.broker,
      organizationId,
    }))
      .filter((c) => isUsagePollable(c) && (!only || c.key === only));
    const out: Record<string, unknown> = {};
    await Promise.all(creds.map(async (c) => {
      let probe = this.usageProbes.get(c.key);
      if (!probe) {
        // Ambient uses the provider's default home; a managed login uses its own.
        const configHome = c.kind === 'ambient' ? undefined : c.configHome;
        probe = (c.provider === 'codex' ? probeCodexUsage({ configHome }) : probeClaudeUsage({ configHome }))
          .then((snap) => { store.kvSet(`usage:${c.key}`, JSON.stringify(snap)); return snap; })
          .finally(() => this.usageProbes.delete(c.key));
        this.usageProbes.set(c.key, probe);
      }
      out[c.key] = await probe;
    }));
    return out;
  }

  private organizationCredentialKeys(organizationId: string): string[] {
    return enumerateCredentials(gatherCredentialSources({
      configHomes: this.deps.configHomes,
      broker: this.deps.broker,
      organizationId,
    })).map((credential) => credential.key);
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

  private async dashboard(organizationId?: string, includeHost = true) {
    let accounts: unknown = { accounts: [], waiting: 0 };
    if (includeHost) {
      try {
        accounts = await withTimeout(this.deps.client.workflow.getHandle(accountCoordinatorId()).query('accounts'), 3000);
      } catch {
        /* coordinator not running or wedged — show empty rather than hang */
      }
    }
    // Scope to the caller's organization so a member sees their own overview, not
    // a host-wide count across every tenant.
    const projects = this.deps.store.listProjects()
      .filter((pr) => !organizationId || (pr.organizationId ?? 'org_personal') === organizationId);
    // Summaries only: the dashboard reads nothing but `lastView.stage`, while
    // `listTasks` hydrates every row's full `lastView` — transcripts included —
    // for every project in the organization at once (the store documents that
    // pattern as having cost >1 GiB RSS).
    const allTasks = projects.flatMap((pr) => this.deps.store.listTaskSummaries(pr.id));
    const byStage: Record<string, number> = {};
    for (const t of allTasks) {
      const stage = t.lastView?.stage ?? 'unknown';
      byStage[stage] = (byStage[stage] ?? 0) + 1;
    }
    return { accounts, projects: projects.length, tasks: allTasks.length, byStage };
  }

  /** Brand assets, resolved per request against the instance-wide icon setting.
   * Serving them from one stable path is what lets the favicon, the installed
   * app icon and the pre-auth login mark all follow the setting with no client
   * knowledge of it — and no build step over `web/`. */
  private async brand(p: string, res: http.ServerResponse) {
    const name = p.slice('/brand/'.length);
    // `/brand/<file>` follows the setting; `/brand/<variant>/<file>` addresses one
    // variant directly, which is how the settings picker previews the choices.
    if (!BRAND_FILES.includes(name as (typeof BRAND_FILES)[number])) return this.static(p, res);
    const icon = brandIconOf(this.deps.store.getSettings('global', 'appearance'));
    try {
      const data = await fs.promises.readFile(path.join(this.deps.staticDir, 'brand', icon, name));
      // Favicons are cached hard by default; revalidating keeps a switch instant.
      res.writeHead(200, { 'content-type': MIME[path.extname(name)]!, 'cache-control': 'no-cache' });
      res.end(data);
    } catch {
      // A variant need not ship every format (only the diamond has an SVG); the
      // browser falls through to the next <link rel="icon"> on a miss.
      res.writeHead(404).end('not found');
    }
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
   * host/sandbox path and remote worlds need no public filesystem endpoint.
   * `sourceFile` (conversation file links) defaults unknown extensions to an
   * inline text view instead of a download, for a useful source view. */
  private async serveArtifact(res: http.ServerResponse, taskId: string, relPath: string, sourceFile = false) {
    const task = this.deps.store.getTask(taskId);
    const handle = worldHandleForView(task?.lastView, taskId, task ? this.deps.store.effectiveProjectConfig(task.projectId) : undefined);
    if (!handle) return this.json(res, 404, { error: 'no world for this task' });
    if (!relPath) return this.json(res, 400, { error: 'missing path' });
    // Relative artifact paths are authored from the agent's default cwd, while
    // provider file APIs are rooted at the whole world boundary. Absolute
    // citations may name any checkout inside that boundary.
    const root = String(handle.root ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    const normalized = relPath.replace(/\\/g, '/');
    if (normalized.startsWith('/')) {
      if (normalized !== root && !normalized.startsWith(`${root}/`))
        return this.json(res, 400, { error: 'path escapes world' });
      relPath = normalized.slice(root.length + 1) || '.';
    } else {
      try { relPath = worldWorkingRelativePath(handle, relPath); }
      catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
    }
    let access: Awaited<ReturnType<NonNullable<GatewayDeps['worldAccess']>['open']>> | undefined;
    try {
      access = this.deps.worldAccess ? await this.deps.worldAccess.open(taskId, handle) : undefined;
      const world = access?.world ?? await this.deps.worlds.open(handle);
      // A symlink inside a host-visible world must not read outside it (the
      // provider's lexical traversal guard cannot see link targets). Remote
      // sandboxes confine reads at the provider boundary instead.
      const hostBase = path.resolve(handle.root ?? '');
      const hostPath = relPath === '.' ? hostBase : path.resolve(hostBase, relPath);
      if (fs.existsSync(hostPath)) {
        const real = await fs.promises.realpath(hostPath);
        const realBase = await fs.promises.realpath(hostBase).catch(() => hostBase);
        if (real !== realBase && !real.startsWith(realBase + path.sep)) return this.json(res, 400, { error: 'path escapes world' });
      }
      const data = await world.readFileBuffer(relPath);
      const inferredType = ARTIFACT_MIME[path.extname(relPath).toLowerCase()];
      const looksTextual = !data.subarray(0, 8192).includes(0);
      res.writeHead(200, {
        'content-type': inferredType ?? (sourceFile && looksTextual ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
        'content-length': String(data.length),
        'content-disposition': `inline; filename="${path.basename(relPath).replace(/["\\\r\n]/g, '_')}"`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(data);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      this.json(res, /escape|relative/i.test(message) ? 400 : 404, { error: /escape|relative/i.test(message) ? message : 'artifact not found' });
    } finally { await access?.release(); }
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
    let access: Awaited<ReturnType<NonNullable<GatewayDeps['worldAccess']>['open']>> | undefined;
    try {
      const body = method === 'GET' || method === 'HEAD' ? undefined : await this.rawBody(req, MAX_PREVIEW_REQUEST_BYTES);
      access = this.deps.worldAccess ? await this.deps.worldAccess.open(taskId, handle) : undefined;
      const world = access?.world ?? await this.deps.worlds.open(handle);
      if (!world.fetchPort) throw new Error('this world provider does not expose remote previews');
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
    } finally { await access?.release(); }
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
    const access = this.deps.worldAccess ? await this.deps.worldAccess.open(taskId, handle) : undefined;
    const world = access?.world ?? await this.deps.worlds.open(handle);
    if (!world.previewSocketTarget) { await access?.release(); browser.close(4400, 'provider has no WebSocket previews'); return; }
    let target: Awaited<ReturnType<NonNullable<typeof world.previewSocketTarget>>>;
    try { target = await world.previewSocketTarget(port, requestPath); }
    catch { await access?.release(); browser.close(1011, 'preview upstream unavailable'); return; }
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    const upstream = new WebSocketClient(target.url, protocols, { headers: target.headers });
    const pending: Array<{ data: import('ws').RawData; binary: boolean }> = [];
    browser.on('message', (data, binary) => {
      if (upstream.readyState === WebSocketClient.OPEN) upstream.send(data, { binary });
      else if (upstream.readyState === WebSocketClient.CONNECTING && pending.length < 100) pending.push({ data, binary });
    });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      void access?.release();
    };
    browser.on('close', (code, reason) => {
      release();
      if (upstream.readyState === WebSocketClient.CONNECTING) upstream.terminate();
      else if (upstream.readyState === WebSocketClient.OPEN) upstream.close(code || 1000, reason.toString());
    });
    browser.on('error', () => { release(); upstream.terminate(); });
    upstream.on('open', () => {
      for (const message of pending.splice(0)) upstream.send(message.data, { binary: message.binary });
    });
    upstream.on('message', (data, binary) => { if (browser.readyState === browser.OPEN) browser.send(data, { binary }); });
    upstream.on('close', (code, reason) => { release(); if (browser.readyState === browser.OPEN) browser.close(code || 1000, reason.toString()); });
    upstream.on('error', () => { release(); if (browser.readyState === browser.OPEN) browser.close(1011, 'preview upstream failed'); });
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
    for (const card of this.deps.store.listCards(projectId, project.organizationId)
      .filter((candidate) => candidate.scope === 'project' && candidate.scopeId === projectId
        && candidate.status !== 'canceled')) {
      const provider = this.deps.paymentRegistry?.forCard(card)
        ?? (card.provider === this.deps.payments?.name ? this.deps.payments : undefined);
      if (!provider) throw new Error(`payment provider "${card.provider}" is unavailable; cannot safely revoke ${card.label}`);
      await provider.revoke(card.id);
    }
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
    await this.deps.resources?.deleteProject(projectId);
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

  /**
   * A blocked fill/reveal attempt (§5B/§5C) auto-raises the access request (§7)
   * so it surfaces to the human immediately — the agent no longer has to make a
   * separate `request_credential` call after being told `needs_approval`. Only
   * `needs_approval` from a task-agent parks; `denied` is a hard no and never
   * parks, and human callers (no taskId) just get the status back. `park()`
   * dedupes, so repeated attempts collapse onto the one pending request.
   */
  private autoRaiseCredential(
    vault: VaultItems,
    decision: { status: AccessStatus; reason?: string },
    ctx: { caps: string[]; taskId?: string; projectId?: string; item: { id: string }; field?: unknown; mode: AccessMode; why?: unknown },
  ): Record<string, unknown> {
    const base: Record<string, unknown> = { ...decision, itemId: ctx.item.id };
    if (decision.status !== 'needs_approval' || !ctx.taskId) return base;
    const raised = vault.request({
      taskId: ctx.taskId, projectId: ctx.projectId, caps: ctx.caps,
      itemId: ctx.item.id, field: ctx.field as VaultFieldName | undefined, mode: ctx.mode,
      why: ctx.why != null ? String(ctx.why) : undefined,
    });
    return raised.requestId ? { ...base, requestId: raised.requestId } : base;
  }

  /**
   * Type a resolved secret into the agent's browser (§5B). For a LOCAL world the
   * gateway drives CDP directly (agent + gateway share the host). For a REMOTE
   * world the browser lives in the sandbox with no private path from the host,
   * so the fill runs INSIDE the world via `world.exec`, the secret handed over
   * stdin (never argv/env/a file the co-resident agent could read). Either way
   * the live page origin is re-verified against the item's domains before typing.
   */
  private async fillCredential(callerTaskId: string | undefined, args: {
    selector: string; cdpUrl?: unknown; expectDomains?: string[]; resolveText: () => string;
  }): Promise<string> {
    const cdpUrl = String(args.cdpUrl ?? defaultCdpUrl());
    const task = callerTaskId ? this.deps.store.getTask(callerTaskId) : undefined;
    const handle = task
      ? worldHandleForView(task.lastView, callerTaskId!, this.deps.store.effectiveProjectConfig(task.projectId))
      : undefined;
    const remote = !!handle && (worldHandleIsRemote(handle) || !!this.deps.worlds.get(handle.kind)?.capabilities?.remote);
    if (handle && remote) {
      let access: Awaited<ReturnType<NonNullable<GatewayDeps['worldAccess']>['open']>> | undefined;
      try {
        access = this.deps.worldAccess ? await this.deps.worldAccess.open(callerTaskId!, handle) : undefined;
        const world = access?.world ?? await this.deps.worlds.open(handle);
        const { fillInWorld } = await import('../autonomy/world-fill.js');
        return (await fillInWorld(world, { selector: args.selector, expectDomains: args.expectDomains, cdpUrl, resolveText: args.resolveText })).origin;
      } finally {
        await access?.release();
      }
    }
    const { fillViaCdp } = await import('../autonomy/fill.js');
    return (await fillViaCdp({ cdpUrl, selector: args.selector, resolveText: args.resolveText, expectDomains: args.expectDomains })).origin;
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
  /** Organization-scoped mailbox provider config (agent-mail §8). */
  /** Give a freshly self-registered user their own personal-workspace org (owner
   *  grant), so signup lands in a real workspace instead of the access-pending
   *  waiting room. Best-effort: a failure here never fails the signup itself. */
  private provisionPersonalWorkspace(userId: string, name: string): void {
    try {
      if (this.deps.store.listOrganizations(userId).length) return; // already has one
      const label = (name || '').trim();
      const organization = this.deps.store.createOrganization({
        name: label ? `${label}'s workspace` : 'Personal workspace', kind: 'personal', ownerUserId: userId });
      this.deps.authorization?.bootstrapOrganizationOwner(`user:${userId}`, userId, organization.id);
    } catch (e) {
      console.error('[signup] personal workspace provisioning failed:', e instanceof Error ? e.message : e);
    }
  }

  /** Installation-wide outbound email config (single row; operator-managed). */
  private outboundEmailConfig(): import('../autonomy/email.js').OutboundEmailConfig {
    try { return JSON.parse(this.deps.store.kvGet('email:outbound') ?? '{}'); } catch { return {}; }
  }
  private setOutboundEmailConfig(config: import('../autonomy/email.js').OutboundEmailConfig): void {
    this.deps.store.kvSet('email:outbound', JSON.stringify(config));
  }
  private mailboxConfig(organizationId: string): import('../autonomy/mailbox.js').MailboxConfig {
    try {
      return JSON.parse(this.deps.store.kvGet(`agent-mail:provider:${organizationId}`) ?? '{}');
    } catch {
      return {};
    }
  }
  private setMailboxConfig(organizationId: string, config: import('../autonomy/mailbox.js').MailboxConfig): void {
    this.deps.store.kvSet(`agent-mail:provider:${organizationId}`, JSON.stringify(config));
  }
  private mailboxDomain(organizationId: string): string | undefined {
    // The mint domain, resolved by the ACTIVE provider so a leftover field from a
    // previous provider can't win: imap/hosted-fixed use the address host,
    // agentmail its domain, hosted its domain, self-managed its domain.
    const c = this.mailboxConfig(organizationId);
    if (c.provider === 'imap') return c.fixedAddress?.split('@')[1] || undefined;
    if (c.provider === 'agentmail') return c.agentmailDomain || undefined;
    if (c.provider === 'hosted') return c.hostedDomain || undefined;
    if (c.provider === 'self-managed') return c.domain || process.env.KARMAX_AGENT_MAIL_DOMAIN || undefined;
    return c.domain || c.hostedDomain || c.agentmailDomain || c.fixedAddress?.split('@')[1] || process.env.KARMAX_AGENT_MAIL_DOMAIN || undefined;
  }
  /** The single-inbox base local part when addresses ride +tags on one mailbox
   *  (hosted fixed-address / IMAP); undefined for domain and AgentMail providers. */
  private mailboxFixedLocal(organizationId: string): string | undefined {
    return this.mailboxConfig(organizationId).fixedAddress?.split('@')[0] || undefined;
  }
  /** The org-scoped vault handle a provider's secret is stored under. */
  private mailboxSecretHandle(organizationId: string, provider: string): string {
    return `mailbox:${provider}:${organizationId}:auth`;
  }

  private requestScope(pathname: string, url: URL): { projectId?: string; taskId?: string; organizationId?: string } {
    // Routes whose only identifier is a bare record id still belong to exactly
    // one project. Resolving that project here is what arms the tenant guard in
    // `TokenAuthority.check` — without it a `task:edit` token from any project
    // of any organization could rename or delete another tenant's tag or saved
    // view, because the check had no project to compare its scope against.
    const tagId = pathname.match(/^\/api\/tags\/([^/]+)/)?.[1];
    const viewId = pathname.match(/^\/api\/views\/([^/]+)/)?.[1];
    const projectId = pathname.match(/^\/api\/projects\/([^/]+)/)?.[1]
      ?? pathname.match(/^\/api\/defaults\/([^/]+)/)?.[1]
      ?? pathname.match(/^\/api\/settings\/(?:quick\/)?project\/([^/]+)/)?.[1]
      ?? (tagId ? this.deps.store.getTag(tagId)?.projectId : undefined)
      ?? (viewId ? this.deps.store.getView(viewId)?.projectId : undefined)
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
    const body = `<!doctype html><meta charset="utf-8"><title>Krmax · GitHub</title><main style="font:16px system-ui;max-width:42rem;margin:12vh auto;padding:2rem"><h1>GitHub connection</h1><p>${escapeHtml(message)}</p><p><a href="/organization">Return to Krmax</a></p></main>`;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(body)),
      'x-karmax-cell': this.deps.cellId ?? 'local' });
    res.end(body);
  }
  private paymentCallbackPage(res: http.ServerResponse, status: number, message: string) {
    const body = `<!doctype html><meta charset="utf-8"><title>Krmax · Stripe</title><main style="font:16px system-ui;max-width:42rem;margin:12vh auto;padding:2rem"><h1>Stripe connection</h1><p>${escapeHtml(message)}</p><p><a href="/organization">Return to Krmax</a></p></main>`;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(body)), 'x-karmax-cell': this.deps.cellId ?? 'local' });
    res.end(body);
  }
  private async body(req: http.IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<any> {
    const value = await this.rawBody(req, maxBytes);
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
  /** Errors that name their own HTTP status (CapabilityError → 403,
   *  NotFoundError → 404, ValidationError → 400) carry it here, so every route
   *  answers alike instead of a handful wrapping locally and the rest 500ing. */
  /** Answer a handler-local failure as a 400 UNLESS the error names its own
   *  status. Several routes wrapped their body in `catch → 400`, which flattened
   *  a denial (403) and a bad identifier (404) into "your input was malformed". */
  private badRequest(res: http.ServerResponse, e: unknown) {
    const declared = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : undefined;
    return this.json(res, declared ?? 400, { error: e instanceof Error ? e.message : String(e) });
  }
  private fail(res: http.ServerResponse, e: unknown) {
    const declared = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : undefined;
    try {
      this.json(res, declared ?? (e instanceof AttachmentError && /too large/i.test(e.message) ? 413 : 500),
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
  const lines = ['# HELP karmax_info Krmax control-plane information.', '# TYPE karmax_info gauge', 'karmax_info 1'];
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

const EXECUTION_CONFIG_KEYS = ['worldProvider', 'runnerPoolId', 'resources', 'network', 'environment', 'monthlyBudgetMicros', 'hibernateAfterMs'] as const;

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

function projectRepositoryDirectories(project: Project): string[] {
  return (project.config.repos ?? []).map((source) => {
    const local = expandPath(source);
    if (fs.existsSync(local)) return local;
    const managed = managedRepoPath(source);
    return fs.existsSync(managed) ? managed : undefined;
  }).filter((value): value is string => Boolean(value));
}

async function discoverEnvironmentNames(project: Project, store: Store,
  githubApp?: import('../integrations/github-app.js').GitHubAppService): Promise<Set<string>> {
  const names = new Set<string>();
  const add = (text: string) => {
    for (const line of text.split('\n')) {
      const match = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (match) names.add(match[1]!);
    }
  };
  for (const dir of projectRepositoryDirectories(project)) for (const file of
    ['.env.example', '.env.sample', '.env.template']) {
    try { add(fs.readFileSync(path.join(dir, file), 'utf8')); } catch {}
  }
  if (githubApp) for (const linked of store.listProjectRepositories(project.id)) for (const file of
    ['.env.example', '.env.sample', '.env.template']) {
    const text = await githubApp.fileContents(linked.repository, file);
    if (text) add(text);
  }
  return names;
}

function parseEnvironmentValues(text: string): Array<{ name: string; value: string }> {
  const values: Array<{ name: string; value: string }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (value) values.push({ name: match[1]!, value });
  }
  return values;
}

function redactResource(resource: ResourceAttachment): Omit<ResourceAttachment, 'credentialHandles'> & { credentialConfigured: boolean } {
  const { credentialHandles, ...safe } = resource;
  return { ...safe, credentialConfigured: credentialHandles.length > 0 };
}

function redactResourceRevision(revision: ResourceRevision | undefined): Omit<ResourceRevision, 'sealedRef'> | undefined {
  if (!revision) return undefined;
  const { sealedRef: _sealedRef, ...safe } = revision;
  return safe;
}

function normalizeResourceTarget(value: unknown, driver: string, name: string): ResourceTarget {
  if (value && typeof value === 'object') {
    const target = value as Record<string, unknown>;
    if (target.kind === 'path') return { kind: 'path', path: String(target.path ?? '') };
    if (target.kind === 'environment' || target.kind === 'service') return { kind: target.kind, name: String(target.name ?? '') };
  }
  const variable = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^([^A-Z_])/, '_$1') || 'RESOURCE';
  return ['secret@1', 'service@1', 'database@1'].includes(driver)
    ? { kind: driver === 'service@1' || driver === 'database@1' ? 'service' : 'environment', name: variable }
    : { kind: 'path', path: `resources/${name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-') || 'data'}` };
}

function isSnapshotResourceDriver(driver: string): boolean { return snapshotResource(driver); }

function decodeResourceFiles(value: unknown): Array<{ path: string; data: Buffer }> {
  if (!Array.isArray(value)) throw new Error('files must be an array');
  let bytes = 0;
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`file ${index + 1} is invalid`);
    const file = entry as Record<string, unknown>;
    const relative = String(file.path ?? '');
    if (!relative) throw new Error(`file ${index + 1} has no path`);
    const data = Buffer.from(String(file.data ?? ''), file.encoding === 'utf8' ? 'utf8' : 'base64');
    bytes += data.length;
    if (bytes > 512 * 1024 * 1024) throw new Error('resource import exceeds 512 MiB JSON upload limit; use a local directory import or runner uploader');
    return { path: relative, data };
  });
}

const RESOURCE_UPLOAD_PART_BYTES = 8 * 1024 * 1024;
interface ResourceUploadPart { objectKey: string; bytes: number; sha256: string }
interface ResourceUploadSession {
  id: string; organizationId: string; projectId: string; attachmentId: string;
  files: Record<string, { parts: ResourceUploadPart[]; bytes: number }>;
  bytes: number; createdAt: number; expiresAt: number;
}
function resourceUploadKey(id: string): string { return `resource-upload:${id}`; }
function resourceUploadSession(store: Store, id: string): ResourceUploadSession | undefined {
  try { return JSON.parse(store.kvGet(resourceUploadKey(id)) ?? '') as ResourceUploadSession; } catch { return undefined; }
}
function safeUploadPath(value: string): boolean {
  return Boolean(value && value.length <= 1024 && !value.startsWith('/') && !value.includes('\\')
    && !value.split('/').includes('..') && !value.includes('\0'));
}
function resourceUploadObjectKey(upload: ResourceUploadSession, relative: string, part: number): string {
  const file = crypto.createHash('sha256').update(relative).digest('hex');
  return `resource-uploads/${upload.organizationId}/${upload.id}/${file}/${part}.bin`;
}
async function* uploadedFileChunks(objects: ObjectStore, parts: ResourceUploadPart[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    const data = await objects.get(part.objectKey);
    if (data.length !== part.bytes || crypto.createHash('sha256').update(data).digest('hex') !== part.sha256)
      throw new Error('resource upload part failed integrity verification');
    yield data;
  }
}

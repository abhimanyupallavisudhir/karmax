import { REPOSITORY_ROUTE } from '../world/resource-repository.js';
import { clientAddress, ClientRequestLimits } from './client-address.js';
import { keepAuthorized, socketLifetime } from './socket-lifetime.js';
import type { PasskeyCredential } from '../autonomy/passkey.js';
import { ExecutionOutput } from './execution-output.js';
import { TaskSecrets, handleRef, paymentCardDetails, recordSecretRefs, secretScope } from '../autonomy/task-secrets.js';
import { AsyncInterval } from '../util/async-interval.js';
import * as __asyncCollections from '../util/async-collections.js';
import { GatewayMetrics } from './metrics.js';
import { MIME, ARTIFACT_MIME } from '../store/artifact-mime.js';
import { assetExists, MATHJAX_SCRIPT_SOURCE, serveStaticAsset, staticAssetRevision, unpublishedAsset } from './static-assets.js';
import { SwrCache } from '../util/swr-cache.js';
import { MAX_REVIEW_ARTIFACT_BYTES, savedReviewArtifact } from '../store/review-artifacts.js';
import { readWorldFilePrefix } from '../world/file-prefix.js';
import { TimingDelivery } from '../timing/delivery.js';
import { timingEnabled, installationTiming, withTiming, toolFailed } from '../timing/index.js';
import { probeConnection } from '../mcp/connections/probe.js';
import { McpConnections, validateMcpSelection } from '../mcp/connections/store.js';
import { registrySearch } from '../mcp/connections/registry.js';
import { beginOAuth, finishOAuth, mcpClientMetadata, MCP_CLIENT_METADATA_PATH } from '../mcp/connections/oauth.js';
import { publicModelFetch, publicUrl } from '../mcp/connections/http.js';
import { sharingPolicy, currentShare, createShare, revokeShare, publicShare, publicConversationHtml } from './conversation-sharing.js';
import http from 'node:http';
import { ServiceConnections, ConnectionError } from '../integrations/service-connections.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocket as WebSocketClient, WebSocketServer } from 'ws';
import type { Client } from '@temporalio/client';
import { KarmaxApi, CapabilityError, ValidationError } from '../platform/api.js';
import type { EvalResult } from '../domain/search.js';
import type { ChildTaskSummary, KarmaxEvent, TaskView } from '../domain/types.js';
import { BRAND_FILES, brandIconOf, isBrandIcon, siteNameError, siteNameOf, BRAND } from '../domain/brand.js';
import { Store } from '../store/db.js';
import { ProjectTransfers, ProjectTransferError } from '../platform/project-transfer.js';
import { AttachmentStore, AttachmentError, MAX_FILE_BYTES, MAX_IMAGE_BYTES } from '../store/attachments.js';
import { ConversationImportError, MAX_CONVERSATION_IMPORT_BYTES, putConversationImport } from '../store/conversation-imports.js';
import { KarmaxBus } from '../contrib/bus.js';
import { TokenAuthority, type ScopedToken } from '../platform/tokens.js';
import { resolveAuthorizationSummary } from '../platform/authorization-summary.js';
import { participantAuthorization } from '../platform/agent-authority.js';
import { platformRequestPathError } from '../platform/platform-request.js';
import { ContributionRegistry } from '../contrib/registry.js';
import { Overlays } from '../store/overlays.js';
import { activationTaskPrompt, manifest } from '../contrib/manifests.js';
import { projectSettingsFor, globalSettingsFor, quickProjectSettingsFor, quickGlobalSettingsFor, quickScopeKey, settingsToProjectConfig, resolveParams, resolveParamsLayers, effectiveRepos } from '../platform/params.js';
import { defaultProvider } from '../agent/adapters.js';
import { findProviderSession } from '../agent/fork.js';
import { localCodexFiles } from '../agent/codex-history-files.js';
import { validCodexSessionId } from '../agent/codex-history.js';
import { conversionWarningsHeader, exportConversationWithPanagent, type PanagentWarning } from '../agent/panagent.js';
import { DEFAULT_MCP_CONNECTIONS, defaultModel, defaultEffort, organizationProfileId, projectProfileId, roleDefaultProfile } from '../agent/profiles.js';
import { repositoryBranchDefaults } from '../platform/branch-defaults.js';
import { sameRepository } from '../world/repository-identity.js';
import { QRY_AGENT_QUEUE, accountCoordinatorId, agentQueueId } from '../coordinators/names.js';
import { hostedMonthlyPriceCents } from '../domain/entitlements.js';
import { SIG as WORKFLOW_SIG } from '../workflows/names.js';
import { findFreePortFrom } from '../util/ports.js';
import { expandPath } from '../util/expand.js';
import { withTimeout } from '../util/timeout.js';
import { AgentAuthority, AgentSpec, AuthorizationSelection, Avatar, Provider, Project, ProjectConfig, PrincipalRef, ProjectPrincipalRef, ResourceAttachment, ResourceRevision, ResourceTarget, normalizeUrgency } from '../domain/types.js';
import { confirmLayersOf } from '../domain/confirm.js';
import { ReviewActionRunner } from './review-actions.js';
import { acpModels, claudeModelCatalog, claudeModels, codexModelCatalog, codexModels, opencodeModels, mergeModels,
  modelDiscoveryFailureReason, type ModelCatalog } from '../agent/models.js';
import type { IdentityService } from '../auth/identity.js';
import type { RepositoryFiles } from '../store/project-environment.js';
import { AuthorizationGrantError, ORGANIZATION_GRANT_CEILING, type AuthorizationService } from '../platform/authorization.js';
import { TOOL_CAPABILITY, CAPABILITY_GROUPS, OWN_TASK_CAPABILITIES, ORGANIZATION_WIKI_WRITE_DENIED, allows, type Capability } from '../platform/capabilities.js';
import { PLATFORM_API_CATALOG } from '../platform/catalog.js';
import { RESOLVE_AGENT_ENABLED } from '../config/features.js';
import { hostLocal } from '../config/deployment.js';
import { apiKeyEnv, credentialAliases, isAgentProvider, isLoginProvider } from '../agent/provider-registry.js';
import { WorldRegistry } from '../world/registry.js';
import { worldHandleForView } from '../world/resolve.js';
import { LocalObjectStore, type ObjectStore } from '../store/objects.js';
import { ConversationExportExpired, createCodexConversationExport, readCodexConversationExport } from '../store/conversation-exports.js';
import type { AccessMode, AccessStatus, VaultFieldName, VaultItem } from '../autonomy/vault-items.js';
import { localTaskBrowserUrl, WORLD_CDP_URL } from '../autonomy/task-browser.js';
import { newId } from '../util/id.js';
import { DurableEventFanout } from './fanout.js';
import { authorizationChanged, authorizationEpoch } from '../store/authorization-epoch.js';
import { configuredPreviewOrigin, hashPreviewToken, newPreviewToken, previewCookieHeader,
  previewCookieValue, previewLeaseOrigin, previewLeaseUrl, previewTokenMatches } from './previews.js';
import type { RemoteAccessController } from '../remote/access.js';
import { GITHUB_APP_PUBLIC_URL_KEY, type GithubProjectWebhookEvent,
  type GithubVaultPushEvent } from '../integrations/github-app.js';
import { scanProjectResources } from '../world/resource-scan.js';
import { credentialResource, resourceDriverCatalog, resourceSecretHandle, snapshotResource } from '../domain/resource-drivers.js';
import { managedRepoPath } from '../world/worktree.js';
import { paths } from '../config/paths.js';
import { ensureProjectWikiRepositoryAsync, setProjectWikiRemote } from '../wiki/repository.js';
import { worldRepos, worldWorkingRelativePath, type WorldHandle } from '../world/types.js';
import { enumerateCredentials, resolveCredentials, resolveExplanationCredentials } from '../platform/credentials.js';
import { credPolicyKey, gatherCredentialSources, parsePolicy, readPolicyLayers, remapCredentialPolicy } from '../platform/credential-sources.js';
import { ITEM_FIELDS, VaultItems, itemHandle, weakensProtection } from '../autonomy/vault-items.js';
import { INSTALLATION_SCOPE, organizationScope } from '../autonomy/vault-keys.js';
import type { CredentialAccessRequest } from '../autonomy/vault-items.js';
import { PermissionRequests } from '../platform/permission-requests.js';
import { AuthorizationRequests } from '../platform/authorization-requests.js';
import { inheritPersonalGithubProfile } from '../autonomy/git-profiles.js';
import { actorPrincipal, identityAuditDetail, requireHumanSubject,
  resolveCallerIdentity } from '../platform/identity.js';
import { DEFAULT_EXPLANATION_SETTINGS, explanationProvider, knownProviderEndpoint, normalizeExplanationSettings,
  requestExplanation, type ExplanationSettings } from '../agent/explanation.js';
import { avatarCallableBy, avatarEnabled } from '../platform/avatars.js';
import { AccountErasureService, ErasureError } from '../privacy/account-erasure.js';
import { hostedOnboardingKey, hostedOnboardingStatus, parseHostedOnboardingRecord,
  parseHostedOnboardingDisplay } from './hosted-onboarding.js';
import { CHECKOUT_DISCLOSURES, assertPaidLaunchReady, assertPolicyAcceptance,
  policyDocument, publicLaunchInfo } from '../launch/legal.js';

export interface GatewayDeps {
  /** Primary startup/recovery and worker liveness, independent of DB health. */
  runtimeReady?: () => boolean;
  /** The separate activity process's Store transaction timings, if any. */
  workerStoreMetrics?: () => import('../store/transaction-metrics.js').StoreMetricsSnapshot | undefined;
  serviceConnections?: ServiceConnections;
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
  managedStorage?: import('../world/managed-storage.js').ManagedStorageService;
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
  /** Releases chunked task checkpoints when their project is deleted. */
  checkpoints?: import('../world/checkpoint.js').WorldCheckpointService;
  subscriptions?: import('../billing/subscriptions.js').SubscriptionBillingService;
  paidLaunchSettings?: import('../launch/settings.js').PaidLaunchSettingsService;
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
  if (p === '/api/connections/config') return read ? 'credential:read' : 'settings:write';
  if (p.startsWith('/api/connections')) return p.endsWith('/execute') || p === '/api/connections/request' ? 'connection:use' : 'credential:read';
  if (/^\/api\/organizations\/[^/]+\/conversation-sharing$/.test(p)) return read ? 'organization:read' : 'organization:edit';
  if (/^\/api\/projects\/[^/]+\/conversation-sharing$/.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (/^\/api\/tasks\/[^/]+\/conversation-share$/.test(p)) return 'task:conversation:share';
  if (p === MCP_CLIENT_METADATA_PATH && read) return 'none';
  if (p === '/api/meta' || p === '/api/session' || p.startsWith('/api/health/')) return 'none';
  if (p === '/api/settings/access') return url?.searchParams.get('projectId') ? 'project:read' : 'organization:read';
  if (p === '/api/platform') return 'workflow:read';
  if (p === '/api/resource-drivers') return 'workflow:read';
  if (p.startsWith('/api/resource-uploads/')) return 'project:settings:write';
  if (p === '/api/logout') return 'none';
  if (p === '/api/remote-access') return read ? 'settings:read' : 'settings:write';
  if (p.startsWith('/api/diagnostics')) return 'diagnostic:read';
  if (p === '/api/metrics') return 'diagnostic:read';
  if (p.startsWith('/api/processes')) return read ? 'process:read' : 'process:kill';
  if (p === '/api/users/erasure-cases' || /^\/api\/users\/[^/]+\/erasure(?:\/export)?$/.test(p)) return 'user:write';
  if (p.startsWith('/api/users')) return read ? 'user:read' : 'user:write';
  if (p === '/api/user/export' || p === '/api/user/default-organization' || p === '/api/user/paid-subscriptions'
    || p === '/api/user/onboarding' || p === '/api/user/onboarding/reset' || p === '/api/user/account-deletion-request') return 'none';
  // A signed-in person always owns their own Git identity. It is not an
  // organization credential grant and must remain editable after they join a
  // project only as a Developer (or before they join any project at all).
  if (/^\/api\/user\/(?:git-profiles|github-accounts)(?:\/|$)/.test(p)) return 'none';
  if (p === '/api/invitations/accept') return 'none';
  if (p.startsWith('/api/inbox')) return read ? 'inbox:read' : 'inbox:write';
  if (p === '/api/organization-directory' && read) return 'none';
  if (p === '/api/organizations') return read ? 'organization:read' : 'organization:create';
  // The organization task list spans its projects; like global search, each
  // project is authorized in searchableProjects / searchOrganizationTasks.
  if (/^\/api\/organizations\/[^/]+\/search$/.test(p) && read) return 'none';
  if (/^\/api\/organizations\/[^/]+\/projects/.test(p)) return read ? 'project:read' : 'project:create';
  if (/^\/api\/organizations\/[^/]+\/runner-pools/.test(p)) return read ? 'organization:read' : 'organization:edit';
  if (/^\/api\/organizations\/[^/]+\/world-providers/.test(p)) return read ? 'organization:read' : 'organization:edit';
  if (/^\/api\/organizations\/[^/]+\/usage-policy/.test(p)) return read ? 'organization:read' : 'organization:edit';
  if (/^\/api\/organizations\/[^/]+\/usage/.test(p)) return 'payment:read';
  // Insights are every member's view of the organization's work; money inside
  // them is included only for callers who also hold payment:read (handler).
  if (/^\/api\/organizations\/[^/]+\/insights$/.test(p)) return 'organization:read';
  if (/^\/api\/organizations\/[^/]+\/entitlements$/.test(p)) return 'organization:read';
  if (/^\/api\/organizations\/[^/]+\/subscription\/status$/.test(p)) return 'organization:read';
  if (/^\/api\/organizations\/[^/]+\/subscription\/(?:gift|gift-storage)$/.test(p)) return 'subscription:gift';
  if (/^\/api\/organizations\/[^/]+\/subscription\/(?:checkout|portal|change|cancel|sync-seats|storage-packs|reconcile)$/.test(p))
    return 'payment:write';
  if (/^\/api\/organizations\/[^/]+\/payments\/stripe\/platform$/.test(p)) return read ? 'settings:read' : 'settings:write';
  if (/^\/api\/organizations\/[^/]+\/payments(?:\/|$)/.test(p)) return read ? 'payment:read' : 'payment:write';
  if (/^\/api\/tasks\/[^/]+\/payments$/.test(p)) return read ? 'task:read' : 'payment:write';
  if (/^\/api\/organizations\/[^/]+\/settings\/payments$/.test(p)) return read ? 'payment:read' : 'payment:write';
  if (/^\/api\/organizations\/[^/]+\/repositories/.test(p)) return read ? 'repository:read' : 'repository:write';
  if (/^\/api\/organizations\/[^/]+\/github\/app-manifest$/.test(p)) return 'settings:write';
  if (/^\/api\/organizations\/[^/]+\/github\/app$/.test(p)) return read ? 'repository:read' : 'settings:write';
  if (/^\/api\/organizations\/[^/]+\/github\/(?:authorize|install-url|connect-existing|refresh|identity)/.test(p)) return read ? 'repository:read' : 'repository:write';
  if (/^\/api\/organizations\/[^/]+\/git-connections/.test(p)) return read ? 'repository:read' : 'repository:write';
  if (/^\/api\/organizations\/[^/]+\/teams/.test(p)) return read ? 'team:read' : 'team:write';
  if (/^\/api\/organizations\/[^/]+\/(members|invitations)/.test(p)) return read ? 'organization:member:read' : 'organization:member:write';
  // A full-tenant export dumps every project, the whole tasks table (prompts and
  // results included), memberships, settings and executions. `organization:read`
  // is inside PROJECT_GRANT_CEILING and the developer profile, so gating on it
  // let a deliberately project-ceilinged agent read every sibling project. This
  // is an administrative operation, not a read.
  if (/^\/api\/organizations\/[^/]+\/export$/.test(p)) return 'organization:edit';
  // The storage contents name every project's data across the organization,
  // so even reading them is above the project-grant ceiling (like export).
  if (/^\/api\/organizations\/[^/]+\/storage-contents(?:\/|$)/.test(p)) return 'organization:edit';
  if (/^\/api\/organizations\/[^/]+\/(?:accounts|git-profiles|credentials)(?:\/|$)/.test(p))
    return read ? 'credential:read' : 'credential:write';
  if (/^\/api\/organizations\/[^/]+\/workflows(?:\/|$)/.test(p))
    return read ? 'workflow:read' : (p.includes('/install') ? 'workflow:install' : 'workflow:edit');
  // The wiki is the skills store: reads need the scope's read capability.
  // Project edits reuse skill:write (agents and developers can both grow it);
  // organization pages reach every task, so they need organization-wide authority.
  if (/^\/api\/organizations\/[^/]+\/wiki(?:\/|$)/.test(p)) return read ? 'organization:read' : 'organization:wiki:write';
  if (/^\/api\/organizations\/[^/]+\/avatar-settings$/.test(p)) return read ? 'organization:read' : 'organization:edit';
  // The agent mailbox is a credential surface, org-scoped by its path (the
  // token/session check enforces the tenant boundary from requestScope).
  if (/^\/api\/organizations\/[^/]+\/agent-mail(?:\/|$)/.test(p)) return read ? 'credential:read' : 'credential:write';
  if (/^\/api\/projects\/[^/]+\/wiki(?:\/|$)/.test(p)) return read ? 'project:read' : 'skill:write';
  if (/^\/api\/projects\/[^/]+\/avatar-settings$/.test(p)) return read ? 'project:read' : 'project:settings:write';
  if (/^\/api\/projects\/[^/]+\/avatars(?:\/[^/]+)?$/.test(p)) return read ? 'project:read' : 'task:create';
  if (/^\/api\/organizations\/[^/]+$/.test(p) && method === 'DELETE') return 'organization:delete';
  if (/^\/api\/organizations\/[^/]+/.test(p)) return read ? 'organization:read' : 'organization:edit';
  if (/^\/api\/tasks\/[^/]+\/(responsibility|subscribers)/.test(p)) return p.endsWith('/subscribers') ? 'task:subscribe' : 'task:assign';
  // Requesting an explanation spends the organization's model credit and
  // appends to the timeline, so it is a conversation write, not a read.
  if (/^\/api\/tasks\/[^/]+\/explanations$/.test(p)) return read ? 'task:conversation:read' : 'task:conversation:message';
  // Every caller may learn its own authority; the answer never widens it.
  if (p === '/api/authorization/me') return read ? 'none' : undefined;
  if (p === '/api/authorization/profiles' && read) return 'task:create';
  if (p === '/api/authorization/escalation-targets' || p === '/api/authorization-requests')
    return read ? 'task:read' : 'task:create';
  if (/^\/api\/authorization-requests\/[^/]+\/resolve$/.test(p)) return 'task:read';
  if (p.startsWith('/api/authorization') || p.startsWith('/api/audit')) return read ? 'authorization:read' : 'authorization:write';
  if (p.startsWith('/api/accounts') || p.startsWith('/api/git-profiles')) return read ? 'credential:read' : 'credential:write';
  if (p === '/api/credentials/policy') {
    if (url?.searchParams.get('taskId')) return 'task:edit';
    if (url?.searchParams.get('projectId')) return 'project:settings:write';
    return 'credential:write';
  }
  if (p.startsWith('/api/credentials')) return read ? 'credential:read' : 'credential:write';
  // Vault items (wiki plans/PLAN-passwords): admin CRUD is credential:write; agent
  // write-back is the narrower vault:store; use/reveal/fill/request attempts
  // need only credential:read — the per-item grant + policy check happens in
  // the handler against the caller's own capability set.
  if (p === '/api/vault/store' || p === '/api/vault/passkey/save' || p === '/api/vault/session/save') return 'vault:store';
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
  if (p === '/api/subscriptions/webhook' || p === '/api/subscriptions/paddle/webhook'
    || p === '/api/subscriptions/paddle/checkout-config') return 'none';
  if (p.startsWith('/api/cards') || p.startsWith('/api/payments')) return read ? 'payment:read' : 'payment:write';
  // Installation-wide outbound email is operator configuration (settings:write),
  // like the mailbox provider. The connected secret never leaves the vault.
  if (p === '/api/email' || p.startsWith('/api/email/')) return read ? 'settings:read' : 'settings:write';
  if (/^\/api\/settings\/(?:quick\/)?project\//.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (p.startsWith('/api/settings')) return read ? 'settings:read' : 'settings:write';
  if (p.startsWith('/api/defaults/')) return 'task:read';
  if (p === '/api/mcp' || p.startsWith('/api/mcp/')) {
    return read ? 'profile:read' : url?.searchParams.get('projectId') ? 'project:settings:write' : 'organization:edit';
  }
  if (p.startsWith('/api/profiles')) {
    const scoped = Boolean(url?.searchParams.get('projectId') || url?.searchParams.get('organizationId'));
    return scoped ? (read ? 'profile:read' : 'profile:write') : (read ? 'settings:read' : 'settings:write');
  }
  if (p === '/api/models' || p === '/api/schema' || p === '/api/events/catalog' || p === '/api/contributions') return 'workflow:read';
  if (p === '/api/search' && read) return 'none'; // each project is authorized in searchProjects
  if (p === '/api/search/fields') return 'task:read';
  if (p === '/api/attachments' || p === '/api/files') return 'task:create';
  if (p === '/api/conversation-imports') return 'task:create';
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
  if (/^\/api\/projects\/[^/]+\/transfer$/.test(p)) return 'project:read';
  if (/^\/api\/projects\/[^/]+\/folder$/.test(p)) return 'project:edit';
  if (/^\/api\/projects\/[^/]+\/reorder$/.test(p)) return 'project:edit';
  if (/^\/api\/projects\/[^/]+\/execution-policy$/.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (/^\/api\/projects\/[^/]+\/(defaults|settings|quick-settings)/.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (/^\/api\/projects\/[^/]+\/explanation-settings$/.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (/^\/api\/projects\/[^/]+\/members/.test(p)) return read ? 'project:read' : 'project:edit';
  if (/^\/api\/projects\/[^/]+\/(?:repositories|repository-sources|checkout)(?:\/|$)/.test(p))
    return read ? 'repository:read' : 'repository:write';
  if (/^\/api\/projects\/[^/]+\/github-merge-eligibility$/.test(p)) return 'project:read';
  if (/^\/api\/projects\/[^/]+\/resources/.test(p)) return read ? 'project:settings:read' : 'project:settings:write';
  if (/^\/api\/projects\/[^/]+\/(?:secrets|services|environment)(?:\/|$)/.test(p))
    return read ? 'project:settings:read' : 'project:settings:write';
  if (/^\/api\/tasks\/[^/]+\/resources/.test(p)) return read ? 'task:read' : 'task:review:execute';
  if (/^\/api\/tasks\/[^/]+\/resource-candidates/.test(p)) return read ? 'task:read' : 'task:review:execute';
  if (/^\/api\/projects\/[^/]+\/tasks/.test(p)) return read ? 'task:read' : 'task:create';
  if (/^\/api\/projects\/[^/]+\/search$/.test(p)) return 'task:read';
  if (/^\/api\/projects\/[^/]+\/(tags|views)$/.test(p)) return read ? 'task:read' : 'task:edit';
  if (/^\/api\/(tags|views)\//.test(p)) return read ? 'task:read' : 'task:edit';
  if (/^\/api\/projects\/[^/]+\/workflow-pins$/.test(p)) return read ? 'workflow:read' : 'workflow:edit';
  if (/^\/api\/projects\/[^/]+\/propose-workflow-edit$/.test(p)) return 'workflow:edit';
  if (/\/(events|timing)$/.test(p) || p === '/api/activity') return 'task:event:read';
  if (/\/(sessions|agents|conversation(?:\.jsonl)?)$/.test(p)) return 'task:conversation:read';
  if (/\/fork-agent$/.test(p)) return 'task:conversation:fork';
  if (p === '/api/agent/git/publish') return 'task:git:publish';
  if (p === '/api/agent/git/import' || p === '/api/agent/git/refresh-upstream') return 'task:git:import';
  if (p.startsWith('/api/agent/github/actions')) return read ? 'github:actions:read' : 'github:actions:write';
  if (p === '/api/agent/resource-candidates') return 'task:review:write';
  if (p === '/api/agent/escalate' || p === '/api/agent/escalation-targets'
    || p === '/api/agent/permission-requests') return 'task:escalate';
  if (p === '/api/permission-requests' || /^\/api\/permission-requests\/[^/]+\/resolve$/.test(p)) return 'task:read';
  if (p === '/api/agent/notify') return 'task:conversation:message';
  if (p === '/api/agent/collaboration/request'
    || /^\/api\/agent\/collaboration\/[^/]+\/cancel$/.test(p)) return 'task:conversation:message';
  if (/\/(?:file|open-command|file-checkout)$/.test(p)) return 'task:conversation:read';
  if (/\/review-action/.test(p) || /\/artifact$/.test(p) || /\/preview\//.test(p) || /\/desktop$/.test(p)) return 'task:review:execute';
  if (/\/artifacts(?:\/promote)?$/.test(p) || /^\/api\/artifacts\//.test(p)) return read ? 'task:read' : 'task:review:execute';
  if (/\/preview-leases$/.test(p) || /^\/api\/preview-leases\//.test(p)) return read ? 'task:read' : 'task:review:execute';
  if (/\/signal$/.test(p)) return 'task:signal';
  if (/^\/api\/tasks\/[^/]+\/messages$/.test(p)) return 'task:conversation:message';
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

type DownloadableProvider = 'claude' | 'codex';
/** Pending decisions per task: those that still notify, and all of them. */
type ApprovalCounts = Map<string, { notify: number; pending: number }>;
/** Opens the calling task's page on one of `domains`, origin-verified. */
type TaskPageOpener = (domains: string[]) => Promise<{ session: import('../autonomy/cdp.js').CdpSession; origin: string }>;

function downloadableProvider(value: unknown): DownloadableProvider | undefined {
  return value === 'claude' || value === 'codex' ? value : undefined;
}

/** Stable UUID for a generated native history. Keeping it stable means repeated
 * downloads produce the same install/fork command and overwrite the same local
 * session file instead of littering the CLI history on every click. */
function conversationExportSessionId(taskId: string, role: string, provider: DownloadableProvider): string {
  const hex = crypto.createHash('sha256').update(`karmax-conversation/${taskId}/${role}/${provider}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) % 4]!;
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function providerHomeFromSessionFile(provider: DownloadableProvider, filename: string): string | undefined {
  const marker = `${path.sep}${provider === 'codex' ? 'sessions' : 'projects'}${path.sep}`;
  const at = filename.indexOf(marker);
  return at > 0 ? filename.slice(0, at) : undefined;
}

/** Resolve stored session metadata without searching other config homes. A task
 * with legacy metadata that lacks its source home falls back to a generated
 * transcript export instead of sweeping the installation by opaque id. */
async function storedConversationSession(store: Store, taskId: string, intentId: string | undefined, role: string,
  providerHint?: unknown, metadataOnly = false): Promise<{ id?: string; provider?: DownloadableProvider; home?: string; source?: string }> {
  const sessionTaskId = role === 'confirm' ? (intentId ?? taskId) : taskId;
  const id = (await store.kvGet(`session:${sessionTaskId}:${role}`)) || undefined;
  let home: string | undefined;
  let metadataProvider: DownloadableProvider | undefined;
  try {
    const meta = JSON.parse((await store.kvGet(`sessionmeta:${sessionTaskId}:${role}`)) ?? '{}');
    home = meta.home ? String(meta.home) : undefined;
    metadataProvider = downloadableProvider(meta.provider);
  } catch { /* legacy metadata can be incomplete or malformed */ }
  const hinted = downloadableProvider(providerHint);
  if (!id) return { provider: hinted ?? metadataProvider, home };
  const candidates = [...new Set([hinted, metadataProvider, 'codex', 'claude'])]
    .filter((provider): provider is DownloadableProvider => provider === 'codex' || provider === 'claude');
  for (const provider of candidates) {
    // Discovery for the task page only needs availability. Full copy/lineage
    // validation belongs to the explicit export, which can read a large history.
    const source = metadataOnly && provider === 'codex'
      ? (home && validCodexSessionId(id) ? localCodexFiles(home).find(file => path.basename(file).endsWith(`${id}.jsonl`)) : undefined)
      : findProviderSession({ provider, session: id, srcHome: home });
    if (source) return { id, provider, home: home ?? providerHomeFromSessionFile(provider, source), source };
  }
  return { id, provider: hinted ?? metadataProvider, home };
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
  if (candidate.kind === 'avatar' && typeof candidate.avatarId === 'string' && candidate.avatarId)
    return { kind: 'avatar', avatarId: candidate.avatarId };
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

/** What a refused grant tells the client: which agent, so the console can ask
 * about exactly that one (`chooseAuthorizationGrant`). */
function grantRefusal(e: unknown): { code?: string; participant?: string; authorization?: AuthorizationSelection } {
  const error = e as { code?: unknown; participant?: unknown; authorization?: AuthorizationSelection } | undefined;
  return {
    ...(error?.code ? { code: String(error.code) } : {}),
    ...(typeof error?.participant === 'string' ? { participant: error.participant,
      ...(error.authorization ? { authorization: error.authorization } : {}) } : {}),
  };
}

/** `acceptAttenuation`: `true` for every agent, or the participant keys. */
function attenuationAcceptance(value: unknown): boolean | string[] | undefined {
  if (value === true) return true;
  return Array.isArray(value) ? value.map(String) : undefined;
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
async function organizationSettingsPath(store: Store, organizationId: string): Promise<string> {
  const slug = (await store.getOrganization(organizationId))?.slug;
  return slug ? `/${slug}/settings` : '/settings';
}

async function userProfilePath(store: Store, organizationId: string): Promise<string> {
  const slug = (await store.getOrganization(organizationId))?.slug;
  return slug ? `/${slug}/profile` : '/profile';
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
      // The wiki checkout's folder name (never its location), so citations of
      // wiki files link to the wiki view rather than to a file handoff.
      const wiki = worldRepos(handle as unknown as WorldHandle).find((repo) => repo.role === 'project-wiki');
      if (wiki?.root) out.worldWiki = wiki.root.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
    }
  }
  return out;
}

/** Conventional gateway port. If it's taken we walk upward (findFreePortFrom),
 *  so the UI URL stays stable across restarts. Override with KARMAX_PORT. */
export const DEFAULT_GATEWAY_PORT = 4505;
/** Online password guessing: this many failures per address or account lock sign-in for the window. */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
const GIT_PASS_AUTO_SYNC_BACKSTOP_MS = 15 * 60_000;
/** How long a live event socket reuses a task visibility decision (LT-15)
 * when nothing in this process has changed authorization: the bound for
 * revocations made by another replica. */
const SOCKET_DECISION_TTL_MS = 5_000;
/** A browser's event socket can die without a close (sleep, network change,
 * NAT expiry). Each side checks the other this often: the gateway with protocol
 * pings, the console with an application `ping` it can see answered. */
const EVENT_SOCKET_PING_MS = 30_000;
/** Past this much unsent data a socket gets only the latest streamed text. */
const LIVE_OUTPUT_BUFFER_BYTES = 64 * 1024;
/** A watching socket gets these only for the task it shows (RQ-16)… */
const WATCHED_TASK_EVENTS = new Set(['agent.output', 'timing']);
/** …and these only from its own project; lifecycle events still reach inbox and insights. */
const TASK_DETAIL_EVENTS = new Set([...WATCHED_TASK_EVENTS, 'agent.activity', 'conversation.message', 'conversation.explanation']);

const USER_CAPS = ['*'];
const PREVIEW_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const MAX_PREVIEW_REQUEST_BYTES = 16 * 1024 * 1024;
const MAX_TERMINAL_TICKETS_PER_SESSION = 8;
const PREVIEW_REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'content-type', 'if-match', 'if-modified-since',
  'if-none-match', 'if-unmodified-since', 'range', 'user-agent',
]);

/** See `Gateway.routeDecision`. `required` is absent for routes that need no capability. */
type RouteDecision =
  | { required?: undefined; allowed: true; scope: { projectId?: string; taskId?: string; organizationId?: string } }
  | { required: string; allowed: boolean; scope: { projectId?: string; taskId?: string; organizationId?: string };
    checked: Awaited<ReturnType<TokenAuthority['check']>> };

/** What a task agent would ask for with `request_permission` to get past a
 * refusal: the missing capability, or the project its scope lacks. People
 * have no task to extend, and other organizations cannot be requested. */
function permissionRequestFor(checked: { ok: boolean; missing?: string; reason?: string },
  record: ScopedToken | undefined, target?: { projectId?: string; organizationId?: string }): { capabilities: string[]; projectIds?: string[] } | undefined {
  if (checked.ok || !record || record.kind !== 'agent' || record.taskId === '*') return undefined;
  if (checked.missing) return checked.missing.includes('*') ? undefined : { capabilities: [checked.missing] };
  if (target?.projectId && record.projectIds?.length && !record.projectIds.includes(target.projectId)
    && target.organizationId && target.organizationId === record.organizationId)
    return { capabilities: [], projectIds: [target.projectId] };
  return undefined;
}

interface Session {
  user: string;
  apiToken: string;
  userId?: string;
  /** The browser (identity) session this one stands for, when it does. */
  identitySessionId?: string;
  email?: string;
  expiresAt?: number;
}

/** Enterprise SSO as the sign-in card shows it: configured, and whether its
 * provider is registered yet (audit R-11). While the IdP is unreachable the
 * button stays visible but disabled, so an organization that requires SSO sees
 * why nobody can sign in rather than no way in at all. */
function ssoSession(identity: { oidcProviderId?: string; ssoAvailable: boolean } | undefined) {
  return identity?.oidcProviderId
    ? { providerId: identity.oidcProviderId, ...(identity.ssoAvailable ? {} : { unavailable: true }) } : null;
}

export class Gateway {
  private sessions = new Map<string, Session>();
  private passwordlessSession?: Promise<{ sid: string; session: Session }>;
  private closing = false;
  private terminalStarts = new Set<Promise<void>>();
  private terminalStops = new Set<() => Promise<void>>();
  private requestGuards = new WeakMap<http.IncomingMessage, () => Promise<void>>();
  private terminalTickets = new Map<string, { taskId: string; session: Session; expiresAt: number }>();
  private personDecisions = new Map<string, { caps: Promise<Capability[] | undefined>; until: number }>();
  private requestLimits = new ClientRequestLimits();
  /** Failed sign-ins per client address and per account. Better Auth's own
   *  limiter only sees `auth.handler` traffic; `/api/login` calls the API
   *  directly, so without this a password could be guessed online. */
  private loginFailures = new Map<string, { count: number; until: number }>();
  private server?: http.Server;
  /** Host-machine affordances (`pass` import, host filesystem paths, a local
   *  checkout to `cd` into) are only offered to the machine karmax runs on. */
  private get hostLocal(): boolean { return this.deps.hostLocal ?? hostLocal(); }
  private get siteName(): Promise<string> { return (async () => { return siteNameOf((await this.deps.store.getSettings('global', 'appearance')));  })(); }
  /** Runs review "run" actions (dev servers, scripts) in the task's world. */
  private reviewActions!: ReviewActionRunner;
  private attachments = new AttachmentStore();
  /** Discovery spawns provider CLIs (seconds): pages read the last catalog while
   *  one background load per organization refreshes it. */
  private modelCatalog = new SwrCache<string, ModelCatalog>((organizationId) => this.discoverModels(organizationId), 5 * 60_000);
  private identityTokens = new Map<string, { apiToken: string; fingerprint: string; expiresAt: number; userId: string }>();
  private fanout!: DurableEventFanout;
  /** Remotes verified during this gateway process. Persisted links are retried
   * once after every restart so interrupted first pushes self-heal. */
  private wikiWork = new Set<Promise<void>>();
  /** Projects whose local wiki repository this gateway process has ensured. */
  private wikiLocalReady = new Set<string>();
  private wikiRemotesReady = new Set<string>();
  private wikiRemotesProvisioning = new Set<string>();
  private wikiRemoteRetryAfter = new Map<string, number>();
  /** Holds CDP sessions across a passkey enroll/login click (PLAN-passwords §8). */
  private passkeys?: import('../autonomy/passkey.js').PasskeyManager;
  private pendingPolicyAcceptances = new Map<string, { versions: Record<string, string>; expiresAt: number }>();
  private stopLoginPoolSync?: () => void;
  private gitPassAutoSyncTimer?: AsyncInterval;
  /** Preserve every observed push while keeping one Git/GPG operation per
   *  organization in flight. A push arriving mid-sync queues one more refresh. */
  private gitPassAutoSyncRuns = new Map<string, Promise<void>>();

  constructor(private deps: GatewayDeps) {
  }

  static async create(deps: GatewayDeps) {
    const instance = new Gateway(deps);
    await instance.initialize(deps);
    return instance;
  }

  private async initialize(deps: GatewayDeps) {

    if (deps.identity) {
      deps.tokens.connectIdentitySessions((sessionId, userId) => deps.identity!.sessionActive(sessionId, userId));
      deps.identity.connectSessionRevocation?.(async userId => {
        authorizationChanged(); // sessions live in the identity database, outside the Store's watch
        for (const [key, cached] of this.identityTokens) if (cached.userId === userId) {
          this.identityTokens.delete(key);
          await deps.tokens.revoke(cached.apiToken);
        }
      });
      deps.identity.connectOrganizationNames(async () => (await deps.store.organizationNameReservations()));
      deps.identity.connectAccountClosure?.(async id => Boolean(await deps.store.kvGet(`account-closed:${id}`)));
      deps.store.connectUserNames(async () => (await deps.identity!.listUsers()));
    }
    this.reviewActions = new ReviewActionRunner(deps.worlds, deps.store, deps.runners, deps.worldAccess, deps.resources,
      (taskId) => this.taskSecrets(taskId));
    this.fanout = (await DurableEventFanout.create(deps.store, deps.bus));
    // Device OAuth finishes in the provider CLI after `/accounts/connect` has
    // returned. Refreshing only in that request races the eventual auth.json and
    // leaves a visibly connected login absent from the runnable coordinator pool.
    this.stopLoginPoolSync = deps.login?.onStateChange(async (state) => {
      await this.refreshLoginPool();
      // A renewed sign-in withdraws its "sign in again" notice at once.
      const { notifyCredentialAttention } = await import('../agent/credential-health.js');
      await notifyCredentialAttention({ store: this.deps.store, configHomes: this.deps.configHomes }, Date.now(), [state.organizationId])
        .catch(() => undefined);
      if (!state.loggedIn) return;
      const credential = enumerateCredentials(gatherCredentialSources({
        configHomes: this.deps.configHomes,
        broker: this.deps.broker,
        organizationId: state.organizationId,
      })).find((candidate) => candidate.provider === state.provider && candidate.account === state.account);
      // A completed provider login is not enough to clear quarantine on its own:
      // prove the new credential can read live subscription usage, then let the
      // coordinator's compare-and-set transition only needs-attention → available.
      if (credential) await this.refreshUsage(credential.key, state.organizationId).catch(() => undefined);
    });
  }

  private timingListeners = new Set<(enabled: boolean) => void>();
  private operationalMetrics?: GatewayMetrics;
  private timingPoll?: AsyncInterval;
  private timingValue = false;
  private timingReadAt = -Infinity;
  private timingRead?: Promise<void>;
  private async cachedTimingEnabled(): Promise<boolean> {
    if (Date.now() - this.timingReadAt >= 1000) {
      this.timingRead ??= this.refreshTiming().finally(() => { this.timingRead = undefined; });
      await this.timingRead;
    }
    return this.timingValue;
  }
  private async refreshTiming(): Promise<void> {
    const enabled = await timingEnabled(this.deps.store);
    this.timingReadAt = Date.now();
    if (enabled === this.timingValue) return;
    this.timingValue = enabled;
    for (const listener of this.timingListeners) listener(enabled);
  }
  /** One poll per gateway, shared by all sockets; catches other gateway writes. */
  private async watchTiming(listener: (enabled: boolean) => void): Promise<() => void> {
    (await this.refreshTiming());
    this.timingListeners.add(listener);
    listener(this.timingValue);
    this.timingPoll ??= new AsyncInterval(() => this.refreshTiming(), 1000);
    return () => {
      this.timingListeners.delete(listener);
      if (!this.timingListeners.size) { void this.timingPoll?.stop(); this.timingPoll = undefined; }
    };
  }

  /** The live event stream (`/ws`): every durable event the caller may read. */
  private async eventStream(ws: import('ws').WebSocket, req: http.IncomingMessage): Promise<void> {
    const lifetime = socketLifetime(ws);

    const url = new URL(req.url ?? '/', 'http://localhost');
    const auth = await this.socketAuth(req, url);
    if (!auth) { ws.close(4401, 'unauthorized'); return; }
    if (ws.readyState !== WebSocketClient.OPEN) return;
    const scoped = (await this.deps.tokens.verify(auth.apiToken));
    const delivery = new TimingDelivery(async row => (await this.deps.store.appendEvent({ taskId: row.taskId,
      type: 'timing', ts: row.wallMs, payload: { ...row } })), async () => (await this.cachedTimingEnabled()),
      async (context, sink) => (await installationTiming(this.deps.store, context, sink)));
    const syncTiming = (enabled: boolean) => {
      try { ws.send(JSON.stringify({ type: 'timing.setting', enabled })); } catch { /* disconnected */ }
    };
    const offTiming = (await this.watchTiming(syncTiming));
    lifetime.add(offTiming);
    if (lifetime.closed) return;
    // What this tab shows (RQ-16). Until it says, it gets every readable event.
    let watch: { projectId: string | null; taskId: string | null } | undefined;
    let answered = true;
    ws.on('pong', () => { answered = true; });
    const pinger = setInterval(() => {
      try {
        if (!answered) { ws.terminate(); return; }
        answered = false;
        ws.ping();
      } catch { /* closing */ }
    }, EVENT_SOCKET_PING_MS);
    pinger.unref?.();
    lifetime.add(() => clearInterval(pinger));
    ws.on('message', async data => {
      if (data.toString().length > 1024) return;
      try {
        const message = JSON.parse(data.toString());
        if (message?.type === 'ping') {
          if (ws.readyState === WebSocketClient.OPEN) ws.send('{"type":"pong"}');
          return;
        }
        if (message?.type === 'watch') {
          const id = (value: unknown) => value == null ? null : typeof value === 'string' ? value : undefined;
          const projectId = id(message.projectId), taskId = id(message.taskId);
          if (projectId !== undefined && taskId !== undefined) watch = { projectId, taskId };
          return;
        }
        (await delivery.acknowledge(message));
      } catch { /* invalid observation */ }
    });
    const watched = (ev: KarmaxEvent, projectId?: string) => !watch || ev.taskId === watch.taskId
      || (projectId === watch.projectId ? !WATCHED_TASK_EVENTS.has(ev.type) : !TASK_DETAIL_EVENTS.has(ev.type));
    // Decide each task's visibility once and reuse it (LT-15): re-verifying the
    // token cost several store reads per event per socket, and a streaming agent
    // publishes several events a second. A decision lasts until this process
    // commits anything that can withdraw access (revocation, member removal,
    // project transfer), until a token-based socket's token expires, and at
    // most SOCKET_DECISION_TTL_MS, which bounds changes made by another replica.
    const decisions = new Map<string, { allowed: Promise<boolean>; until: number; epoch: number }>();
    const mayRead = (projectId: string | undefined, taskId: string): Promise<boolean> => {
      const key = `${projectId ?? ''}\0${taskId}`;
      const cached = decisions.get(key);
      if (cached && cached.until > Date.now() && cached.epoch === authorizationEpoch()) return cached.allowed;
      if (decisions.size >= 4096) decisions.clear();
      // Read before deciding: a change committed while the check runs moves it again.
      const epoch = authorizationEpoch();
      const allowed = (async () => {
        // A person's socket decides from their grants as they stand now: its
        // token keeps the capabilities it was minted with for ten minutes, so
        // a narrowed grant would otherwise wait for it to rotate (GW-13).
        if (auth.userId && this.deps.authorization)
          return !!projectId && allows((await this.deps.authorization.capabilitiesAsync(`user:${auth.userId}`, projectId)), 'task:event:read');
        return (await this.deps.tokens.check(auth.apiToken, 'task:event:read', projectId ? { projectId, taskId } : undefined)).ok;
      })();
      // A failed lookup is not a decision: the next event asks again.
      allowed.catch(() => { if (decisions.get(key)?.allowed === allowed) decisions.delete(key); });
      // A person's decision does not depend on the socket token, so it does not
      // expire with it; a token's does.
      decisions.set(key, { allowed, epoch, until: Math.min(Date.now() + SOCKET_DECISION_TTL_MS,
        auth.userId && this.deps.authorization ? Infinity : scoped?.expiresAt ?? Infinity) });
      return allowed;
    };
    // Streamed text supersedes itself, so a client that has fallen behind gets
    // only each agent's latest text once its buffer drains, never every window
    // (#396 review item 2). Everything else keeps its order and the hard bound.
    const heldOutput = new Map<string, { ev: KarmaxEvent & { seq?: number }; projectId?: string; siblingAttempt?: boolean }>();
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const releaseHeld = () => {
      drainTimer ??= setTimeout(() => {
        drainTimer = undefined;
        if (ws.readyState !== WebSocketClient.OPEN) return;
        if (ws.bufferedAmount > LIVE_OUTPUT_BUFFER_BYTES) { releaseHeld(); return; }
        const held = [...heldOutput.values()];
        heldOutput.clear();
        for (const { ev, projectId, siblingAttempt } of held) void deliver(ev, projectId, siblingAttempt);
      }, 100);
      drainTimer.unref?.();
    };
    lifetime.add(() => { if (drainTimer) clearTimeout(drainTimer); });
    const deliver = async (ev: KarmaxEvent & { seq?: number }, projectId?: string, siblingAttempt?: boolean) => {
      // Reconnect/backfill from durable state rather than allowing a slow
      // browser's send queue to grow without bound.
      if (ws.readyState !== WebSocketClient.OPEN) return;
      if (!watched(ev, projectId)) return;
      if (ev.type === 'agent.output' && (ev.payload as { source?: unknown }).source === 'assistant') {
        const key = `${ev.taskId}\0${String((ev.payload as { role?: unknown }).role ?? '')}`;
        heldOutput.delete(key);
        if (ws.bufferedAmount > LIVE_OUTPUT_BUFFER_BYTES) { heldOutput.set(key, { ev, projectId, siblingAttempt }); releaseHeld(); return; }
      }
      if (ws.bufferedAmount > 2 * 1024 * 1024) {
        ws.close(1013, 'Client fell behind; reconnect to refresh');
        return;
      }
      if (ev.type === 'timing' && !(await this.cachedTimingEnabled())) return;
      if (scoped?.projectId && projectId !== scoped.projectId) return;
      if (!(await mayRead(projectId, ev.taskId).catch(() => false))) return;
      try {
        const payload = ev.payload as Record<string, unknown>;
        const timingDeliveryId = (ev.type === 'agent.activity' && payload.kind === 'message' && payload.title
          || ev.type === 'agent.output' && payload.source === 'assistant' && payload.text)
          ? (await delivery.offer({ taskId: ev.taskId, turnId: typeof payload.turnId === 'string' ? payload.turnId : undefined,
            workflowRunId: typeof payload.workflowRunId === 'string' ? payload.workflowRunId : undefined,
            attempt: typeof payload.attempt === 'number' ? payload.attempt : undefined })) : undefined;
        if (ws.readyState !== WebSocketClient.OPEN) return;
        ws.send(JSON.stringify({ ...(toPublicPayload(ev) as Record<string, unknown>), projectId,
          ...(siblingAttempt ? { siblingAttempt } : {}), ...(timingDeliveryId ? { timingDeliveryId } : {}) }));
      } catch { /* ignore */ }
    };
    const off = this.fanout.on(deliver, () => ws.close(1013, 'Client fell behind; reconnect to refresh'));
    lifetime.add(off);
  }

  /** Whether a review-action process id was started for `taskId`. Ids are
   *  guessable, so the task in the route is the authority, not the id. */
  private async reviewActionBelongsTo(procId: string, taskId: string): Promise<boolean> {
    const live = this.reviewActions.get(procId);
    if (live) return live.taskId === taskId;
    const durable = (await this.deps.store.execution(procId));
    return !!durable && durable.taskId === taskId && durable.kind === 'review-action';
  }

  private githubWebhookSweep?: Promise<void>;
  private connectionTimer?: ReturnType<typeof setInterval>;
  private connectionSweep?: Promise<void>;
  private connections(): ServiceConnections | undefined {
    if (!this.deps.serviceConnections && this.deps.broker)
      this.deps.serviceConnections = new ServiceConnections(this.deps.store, this.deps.broker);
    return this.deps.serviceConnections;
  }
  private sweepConnections(): void {
    if (!this.githubWebhookSweep && this.deps.githubApp?.retryWebhooks) {
      this.githubWebhookSweep = this.deps.githubApp.retryWebhooks(async (result) => { await this.dispatchGithubWebhook(result); })
        .catch((error) => console.warn('[github] webhook retry failed', error))
        .finally(() => { this.githubWebhookSweep = undefined; });
    }
    if (this.connectionSweep || !this.connections()) return;
    this.connectionSweep = this.connections()!.reconcile(async (c) => {
      const task = (await this.deps.store.getTask(c.taskId!));
      if (!task || ['done', 'cancelled', 'failed'].includes(task.lastView?.status ?? '')) return true;
      const message = c.status === 'active'
        ? `${c.label} is connected. Use list_connections, search_connection_tools, and execute_connection_tool with connection ${c.id}. The account is authorized for this task; continue the requested work.`
        : `${c.label} connection is ${c.status}. Continue without it or explain the remaining connection step.`;
      const result = await this.deps.api.resumeAfterCredentialDecision(c.taskId!, message, c.role ?? 'do');
      if (result.resumed) (await this.emitTaskEvent({ taskId: c.taskId!, type: 'connection.resolved', ts: Date.now(),
        payload: { requestId: c.id, connectionId: c.id, status: c.status } }));
      return result.resumed;
    }).finally(() => { this.connectionSweep = undefined; });
  }

  /** Read each organization request ledger once per response, not once per row.
   * Task list projections must never hydrate every task's transcript again.
   * `notify` leaves out decisions dismissed from the inbox; `pending` keeps them,
   * because a dismissed decision still blocks its agent. */
  private async approvalCounts(organizationId: string): Promise<ApprovalCounts> {
    const counts: ApprovalCounts = new Map();
    const add = (taskId: string | undefined, dismissed = false) => {
      if (!taskId) return;
      const count = counts.get(taskId) ?? { notify: 0, pending: 0 };
      count.pending += 1;
      if (!dismissed) count.notify += 1;
      counts.set(taskId, count);
    };
    for (const request of (await new VaultItems(this.deps.store, this.deps.broker, undefined, organizationId)
      .requests({ status: 'pending' }))) add(request.taskId);
    for (const request of (await new PermissionRequests(this.deps.store, organizationId).requests({ status: 'pending' })))
      add(request.taskId, !!request.dismissed);
    for (const request of (await new AuthorizationRequests(this.deps.store, organizationId).requests({ status: 'pending' })))
      if (request.target.kind === 'task') add(request.target.taskId, !!request.dismissed);
    for (const connection of (await this.connections()?.all()) ?? [])
      if (['requested', 'connecting'].includes(connection.status)) add(connection.taskId);
    return counts;
  }

  private async withApprovalRequests(view: TaskView | undefined, taskId: string,
    counts?: ApprovalCounts): Promise<TaskView | undefined> {
    if (!view) return view;
    if (!counts) {
      const organizationId = (await this.deps.store.taskAttribution(taskId))?.organizationId;
      counts = organizationId ? (await this.approvalCounts(organizationId)) : new Map();
    }
    const count = counts.get(taskId);
    // Sub-task and fork panels flag a task's approval exactly as its list row does.
    const flag = <T extends ChildTaskSummary>(summary: T): T => {
      const approvalRequests = counts.get(summary.id)?.notify;
      return approvalRequests && summary.lastView ? { ...summary, lastView: { ...summary.lastView, approvalRequests } } : summary;
    };
    const subTaskSummaries = view.subTaskSummaries?.map(flag);
    const forkSummaries = view.forkSummaries?.map(flag);
    return { ...view, ...(subTaskSummaries ? { subTaskSummaries } : {}), ...(forkSummaries ? { forkSummaries } : {}),
      approvalRequests: count?.notify || undefined, pendingDecisions: count?.pending || undefined };
  }

  private async credentialRequestView(request: CredentialAccessRequest, organizationId: string): Promise<CredentialAccessRequest> {
    const task = (await this.deps.store.getTask(request.taskId));
    const project = task && (await this.deps.store.getProject(task.projectId));
    if (!task || project?.organizationId !== organizationId) return request;
    return { ...request, task: { id: task.id, ...(task.num != null ? { num: task.num } : {}),
      title: task.title, projectId: task.projectId } };
  }

  private async emitTaskEvent(event: { taskId: string; type: string; ts: number; payload: Record<string, unknown> }): Promise<number> {
    const seq = (await this.deps.store.appendEvent(event));
    this.deps.bus.emit({ ...event, seq });
    return seq;
  }

  private async explanationSettings(projectId?: string, organizationId?: string): Promise<{
    organizationId: string;
    organizationOwn: Partial<ExplanationSettings>;
    projectOwn: Partial<ExplanationSettings>;
    inherited: ExplanationSettings;
    effective: ExplanationSettings;
  }> {
    const project = projectId ? (await this.deps.store.getProject(projectId)) : undefined;
    const orgId = project?.organizationId ?? organizationId ?? 'org_personal';
    const organizationOwn = ((await this.deps.store.getSettings(`organization:${orgId}`, 'explanation'))
      ?? (orgId === 'org_personal' ? (await this.deps.store.getSettings('global', 'explanation')) : undefined)
      ?? {}) as Partial<ExplanationSettings>;
    const projectOwn = ((projectId ? (await this.deps.store.getSettings(projectId, 'explanation')) : undefined)
      ?? {}) as Partial<ExplanationSettings>;
    const inherited = normalizeExplanationSettings(organizationOwn, DEFAULT_EXPLANATION_SETTINGS);
    const effective = normalizeExplanationSettings(projectOwn, inherited);
    return { organizationId: orgId, organizationOwn, projectOwn, inherited, effective };
  }

  private explanationSettingsOwn(value: unknown, fallback: ExplanationSettings): Partial<ExplanationSettings> {
    const body = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const own: Partial<ExplanationSettings> = {};
    for (const key of ['endpoint', 'model', 'prompt'] as const) {
      if (typeof body[key] === 'string' && body[key].trim()) own[key] = body[key].trim();
    }
    // Validate the partial overlay in its inherited context before persisting it.
    try {
      const effective = normalizeExplanationSettings(own, fallback);
      // A hosted cell calls only public HTTPS endpoints (publicModelFetch): say so now, not on first use.
      if (this.deps.hosted && own.endpoint) publicUrl(effective.endpoint);
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : String(error));
    }
    return own;
  }

  private async explanationApiKey(provider: string, organizationId: string, projectId: string, taskId: string): Promise<string | undefined> {
    const aliases = credentialAliases(provider);
    const credentials = enumerateCredentials(gatherCredentialSources({
      configHomes: this.deps.configHomes,
      broker: this.deps.broker,
      organizationId,
    }));
    const ordered = resolveExplanationCredentials(credentials, (await readPolicyLayers(
      async (key) => (await this.deps.store.kvGet(key)), { organizationId, projectId, taskId },
    ))).filter((credential) => credential.kind === 'key');
    const credential = ordered.find((candidate) => aliases.includes(candidate.provider));
    if (!credential) return undefined;
    if (credential.apiKeyHandle) {
      if (!this.deps.broker) return undefined;
      return this.deps.broker.resolve(credential.apiKeyHandle, { taskId, caps: ['use-credential:*'] });
    }
    return process.env[apiKeyEnv(credential.provider)];
  }

  private async remapCredentialPolicies(organizationId: string, from: string, to?: string): Promise<void> {
    const keys = [credPolicyKey.organization(organizationId)];
    if (organizationId === 'org_personal') keys.push(credPolicyKey.global());
    for (const project of (await this.deps.store.listProjects()).filter((candidate) => candidate.organizationId === organizationId)) {
      keys.push(credPolicyKey.project(project.id));
      for (const task of (await this.deps.store.listTasks(project.id))) keys.push(credPolicyKey.task(task.id));
    }
    for (const key of keys) {
      const policy = parsePolicy((await this.deps.store.kvGet(key)));
      if (policy) (await this.deps.store.kvSet(key, JSON.stringify(remapCredentialPolicy(policy, from, to))));
    }
    // These caches/settings share the stable credential id. Carry them across a
    // rename and remove them on delete so a future key cannot inherit stale state.
    for (const prefix of ['concurrency:', 'usage:']) {
      const value = (await this.deps.store.kvGet(`${prefix}${from}`));
      if (value !== undefined && to) (await this.deps.store.kvSet(`${prefix}${to}`, value));
      (await this.deps.store.kvDelete(`${prefix}${from}`));
    }
  }

  private clientAddress(req: http.IncomingMessage): string {
    return clientAddress(req);
  }
  private loginBlocked(keys: string[]): boolean {
    const now = Date.now();
    for (const [key, record] of this.loginFailures) if (record.until <= now) this.loginFailures.delete(key);
    return keys.some((key) => (this.loginFailures.get(key)?.count ?? 0) >= LOGIN_MAX_FAILURES);
  }
  private noteLoginFailure(keys: string[]): void {
    const now = Date.now();
    for (const key of keys) {
      const record = this.loginFailures.get(key);
      if (record && record.until > now) record.count += 1;
      else this.loginFailures.set(key, { count: 1, until: now + LOGIN_FAILURE_WINDOW_MS });
    }
  }
  private clearLoginFailures(keys: string[]): void {
    for (const key of keys) this.loginFailures.delete(key);
  }

  private async newSession(user = 'me'): Promise<{ sid: string; session: Session }> {
    // Passwordless/password-only local mode predates Better Auth, but still uses
    // the same tenant invariants as hosted mode. Materialize its stable local
    // principal as owner of the migrated personal organization.
    (await this.deps.store.claimPersonalOrganization(user, user === 'me' ? undefined : user));
    for (const project of (await this.deps.store.listProjects()).filter((candidate) => candidate.organizationId === 'org_personal')) {
      if (!(await this.deps.store.userIsProjectMember(project.id, user)))
        (await this.deps.store.setProjectMembership(project.id, { kind: 'user', userId: user }, 'owner'));
    }
    const sid = `s_${crypto.randomBytes(18).toString('hex')}`;
    const apiToken = (await this.deps.tokens.mintPrincipal(`user:${user}`, USER_CAPS)).token;
    const session: Session = { user, userId: user, apiToken, expiresAt: Date.now() + 12 * 60 * 60_000 };
    for (const [key, value] of this.sessions) if ((value.expiresAt ?? Infinity) <= Date.now()) {
      this.sessions.delete(key);
      await this.deps.tokens.revoke(value.apiToken);
    }
    this.sessions.set(sid, session);
    while (this.sessions.size > 128) {
      const [key, value] = this.sessions.entries().next().value!;
      this.sessions.delete(key);
      await this.deps.tokens.revoke(value.apiToken);
    }
    return { sid, session };
  }

  private enqueueGitPassAutoSync(organizationId: string, work: () => Promise<void>): void {
    const prior = this.gitPassAutoSyncRuns.get(organizationId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(work).catch((error) => {
      console.warn(`[vault] Git-backed pass automatic sync failed for ${organizationId}: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (this.gitPassAutoSyncRuns.get(organizationId) === next) this.gitPassAutoSyncRuns.delete(organizationId);
    });
    this.gitPassAutoSyncRuns.set(organizationId, next);
  }

  private async enqueueGitPassPush(event: GithubVaultPushEvent): Promise<void> {
    if (!this.deps.broker || !this.deps.githubApp) return;
    const repository = (await this.deps.store.getRepository(event.repositoryId));
    if (!repository || repository.organizationId !== event.organizationId) return;
    this.enqueueGitPassAutoSync(event.organizationId, async () => {
      const { defaultConnectors } = await import('../autonomy/connectors.js');
      const vault = new VaultItems(this.deps.store, this.deps.broker, undefined, event.organizationId);
      await defaultConnectors(this.deps.store, vault, this.deps.broker, event.organizationId,
        { hostLocal: this.hostLocal, hosted: this.deps.hosted, githubApp: this.deps.githubApp })
        .autoSyncGitPush(repository, event.revision);
    });
  }

  private async enqueueGitPassBackstop(): Promise<void> {
    if (!this.deps.broker) return;
    for (const { id: organizationId } of (await this.deps.store.listOrganizations())) {
      this.enqueueGitPassAutoSync(organizationId, async () => {
        const { defaultConnectors } = await import('../autonomy/connectors.js');
        const vault = new VaultItems(this.deps.store, this.deps.broker, undefined, organizationId);
        const connectors = defaultConnectors(this.deps.store, vault, this.deps.broker, organizationId,
          { hostLocal: this.hostLocal, hosted: this.deps.hosted, githubApp: this.deps.githubApp });
        await connectors.retryWrites({dueOnly:true});
        await connectors.autoSync('pass-git', 'backstop');
      });
    }
  }

  private async dispatchGithubWebhook(result: import('../integrations/github-app.js').GithubWebhookResult): Promise<number> {
    for (const event of result.events ?? []) {
      await this.emitTaskEvent({ taskId: event.taskId, type: event.type, ts: Date.now(), payload: event.payload });
      const task = await this.deps.store.getTask(event.taskId);
      if (task && ['software-dev', 'goal'].includes(task.workflow)
        && Number(String(task.workflowVersion).split('.')[1] ?? 0) >= 20)
        await this.deps.client.workflow.getHandle(event.taskId).signal(WORKFLOW_SIG.providerChanged).catch(() => undefined);
    }
    const recoveries = await this.dispatchGithubRecoveryEvents(result.projectEvents ?? []);
    for (const event of result.vaultPushes ?? []) await this.enqueueGitPassPush(event);
    return recoveries;
  }

  /** Route both terminal GitHub runs and "no run was created" incidents through
   * the same post-merge recovery-task rail. The durable incident claim is what
   * makes webhook duplicates, monitor polls, and crash retries converge. */
  async dispatchGithubRecoveryEvents(events: GithubProjectWebhookEvent[]): Promise<number> {
    let recoveries = 0;
    for (const event of events) {
      // Preserve the historical run-id key exactly so an upgrade cannot turn a
      // GitHub redelivery for an already-recovered run into a second task.
      const incident = event.payload.incidentKey ?? String(event.payload.runId);
      const key = `github:workflow-recovery:${event.projectId}:${event.payload.repositoryId}:${incident}`;
      const incidentLine = `Recovery incident: ${key}`;
      const previous = (await this.deps.store.kvGet(key));
      if (previous?.startsWith('task_')) continue;
      // A process may have died after the claim but before task creation.
      // Reclaim an abandoned marker; fresh markers serialize concurrent
      // workflow_run/check_run deliveries and monitor sweeps.
      if (previous?.startsWith('pending:')) {
        const claimedAt = Number(previous.slice('pending:'.length));
        if (Number.isFinite(claimedAt) && Date.now() - claimedAt < 10 * 60_000) continue;
        // createTask persists before starting the workflow. If the process died
        // after that insert but before replacing `pending`, adopt the task by its
        // durable incident line instead of creating a second recovery on restart.
        const existing = (await this.deps.store.listTasks(event.projectId)).find((task) =>
          String(task.params?.prompt ?? '').includes(incidentLine));
        if (existing) { (await this.deps.store.kvSet(key, existing.id)); continue; }
        (await this.deps.store.kvDelete(key));
      }
      if (!(await this.deps.store.kvClaim(key, `pending:${Date.now()}`))) continue;
      try {
        const project = (await this.deps.store.getProject(event.projectId));
        if (!project) { (await this.deps.store.kvDelete(key)); continue; }
        const origin = event.payload.originatingTaskId
          ? `\nOriginating task: ${event.payload.originatingTaskId}` : '';
        const missing = event.payload.source === 'deployment_monitor';
        const evidence = event.payload.evidence
          ? `\n\nDurable monitor evidence:\n${JSON.stringify(event.payload.evidence, null, 2)}` : '';
        const token = (await this.deps.tokens.mintPrincipal('system:github-recovery', ['*'],
          event.projectId, 10 * 60_000, project.organizationId)).token;
        const task = await this.deps.api.createTask(token, {
          projectId: event.projectId,
          title: `Repair ${missing ? 'missing' : 'failed'} GitHub workflow: ${event.payload.workflow}`,
          prompt: [
            missing
              ? `A post-merge GitHub deployment workflow run was not created for ${event.payload.repository}.`
              : `A post-merge GitHub workflow failed for ${event.payload.repository}.`,
            `Workflow: ${event.payload.workflow}`,
            `Conclusion: ${event.payload.conclusion}`,
            `Exact revision: ${event.payload.headSha || 'not reported'}`,
            missing
              ? `Successful prerequisite run: ${event.payload.url || `GitHub Actions run ${event.payload.runId}`}${origin}`
              : `Run: ${event.payload.url || `GitHub Actions run ${event.payload.runId}`}${origin}`,
            incidentLine,
            evidence,
            '',
            'Inspect the complete GitHub evidence and classify it before changing code. For a missing run, check workflow schema/registration and triggers first; the evidence distinguishes direct API absence from webhook delay and records file/API permission failures. If a run exists, distinguish queued/waiting environment approval from a terminal failure. If it is a transient GitHub runner failure, rerun the exact revision once and verify it. If it is billing, permissions, protected-environment approval, secrets, or repository configuration, report the precise human action required and do not manufacture a code change. If it is a deterministic deployment or code defect, repair it through the normal reviewed pull-request workflow and verify recovery. The already-merged originating task is immutable and must remain complete.',
          ].join('\n'),
        });
        (await this.deps.store.kvSet(key, task.id));
        (await this.emitTaskEvent({ taskId: task.id, type: event.type, ts: Date.now(), payload: event.payload }));
        recoveries++;
      } catch (error) {
        // The API compensates ordinary start failures, but if it threw after the
        // durable task insert survived, retain/adopt that task just like the
        // restart path above instead of deleting the only idempotency record.
        const existing = (await this.deps.store.listTasks(event.projectId)).find((task) =>
          String(task.params?.prompt ?? '').includes(incidentLine));
        if (existing) { (await this.deps.store.kvSet(key, existing.id)); continue; }
        (await this.deps.store.kvDelete(key));
        throw error;
      }
    }
    return recoveries;
  }

  private async upgradePrincipal(req: http.IncomingMessage, url: URL): Promise<string | undefined> {
    if (url.pathname.startsWith('/preview/')) {
      const id = url.pathname.match(/^\/preview\/([^/]+)/)?.[1];
      const lease = id ? await this.deps.store.previewLease(id) : undefined;
      if (!lease || lease.revokedAt || lease.expiresAt <= Date.now()) return;
      if (configuredPreviewOrigin() && String(req.headers.host ?? '').toLowerCase() !== new URL(previewLeaseOrigin(lease.id)).host.toLowerCase()) return;
      const current = await this.deps.store.currentWorld(lease.worldId);
      if (!current || (current.generation ?? 1) !== lease.generation) return;
      if (lease.tokenHash) {
        if (!previewTokenMatches(lease.tokenHash, previewCookieValue(req.headers.cookie, lease.id))) return;
      } else {
        const auth = await this.auth(req, lease.projectId, lease.organizationId);
        if (!auth || !(await this.deps.tokens.check(auth.apiToken, 'task:read', { projectId: lease.projectId, taskId: lease.taskId })).ok) return;
      }
      return `preview:${lease.id}`;
    }
    if (!['/ws', '/ws/terminal', '/ws/review-action'].includes(url.pathname) || !this.sameOriginRequest(req)) return;
    const ticket = url.pathname === '/ws/terminal' ? this.terminalTickets.get(url.searchParams.get('ticket') ?? '') : undefined;
    // A live ticket admits its person while the session that asked for it is
    // signed in: signing out any other session revokes its cached token early.
    if (ticket && ticket.taskId === url.searchParams.get('taskId') && ticket.expiresAt > Date.now() && ticket.session.userId)
      return await this.sessionLive(ticket.session) ? `user:${ticket.session.userId}` : undefined;
    const auth = ticket && ticket.taskId === url.searchParams.get('taskId') && ticket.expiresAt > Date.now()
      ? ticket.session : await this.socketAuth(req, url);
    if (!auth) return;
    const record = await this.deps.tokens.verify(auth.apiToken);
    return record ? record.principal : undefined;
  }

  async listen(preferredPort = DEFAULT_GATEWAY_PORT): Promise<{ url: string; internalUrl: string; port: number; close: () => Promise<void> }> {
    const port = await findFreePortFrom(preferredPort);
    const bindHost = process.env.KARMAX_HOST?.trim() || '127.0.0.1';
    this.operationalMetrics = new GatewayMetrics();
    const server = http.createServer((req, res) => {
      const finish = this.operationalMetrics!.begin(req.url ?? '/');
      res.once('finish', () => finish(res.statusCode));
      res.once('close', () => finish(res.writableFinished ? res.statusCode : 499));
      void this.handle(req, res).catch((e) => this.fail(res, e));
    });
    this.server = server;

    // Two WebSocket endpoints, routed by path on upgrade:
    //  /ws          — the live event stream (SPEC §3.3 transport).
    //  /ws/terminal — a PTY against the task's world (cheap check-in, SPEC §5.5).
    const wssEvents = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    const wssTerm = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    const wssAction = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    const wssPreview = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    let pendingUpgrades = 0;
    const socketCounts = new Map<string, number>();
    server.on('upgrade', (req, socket, head) => {
      const total = wssEvents.clients.size + wssTerm.clients.size + wssAction.clients.size + wssPreview.clients.size;
      if (this.closing || this.deps.runtimeReady?.() === false || pendingUpgrades >= 64 || total + pendingUpgrades >= 1024) {
        socket.destroy(); return;
      }
      pendingUpgrades++;
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const principal = await withTimeout(this.upgradePrincipal(req, url), 5000);
        if (!principal || socket.destroyed || this.closing || (socketCounts.get(principal) ?? 0) >= 32) { socket.destroy(); return; }
        const onPreviewOrigin = Boolean(configuredPreviewOrigin() && this.requestIsPreviewOrigin(req));
        const wss = url.pathname.startsWith('/preview/') && (!configuredPreviewOrigin() || onPreviewOrigin) ? wssPreview
          : onPreviewOrigin ? undefined : url.pathname === '/ws' ? wssEvents
          : url.pathname === '/ws/terminal' ? wssTerm : url.pathname === '/ws/review-action' ? wssAction : undefined;
        if (!wss) { socket.destroy(); return; }
        socketCounts.set(principal, (socketCounts.get(principal) ?? 0) + 1);
        socket.once('close', () => {
          const count = (socketCounts.get(principal) ?? 1) - 1;
          if (count) socketCounts.set(principal, count); else socketCounts.delete(principal);
        });
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
      })().catch(() => socket.destroy()).finally(() => { pendingUpgrades--; });
    });
    wssEvents.on('connection', (ws, req) => {
      ws.on('error', () => {});
      void this.eventStream(ws, req).catch(() => { try { ws.close(); } catch {} });
    });
    wssTerm.on('connection', (ws, req) => {
      ws.on('error', () => {});
      const starting = this.terminal(ws, req).catch(() => { try { ws.close(); } catch {} });
      this.terminalStarts.add(starting);
      void starting.then(() => this.terminalStarts.delete(starting));
    });
    wssAction.on('connection', (ws, req) => {
      ws.on('error', () => {});
      void this.reviewActionStream(ws, req).catch(() => { try { ws.close(); } catch {} });
    });
    wssPreview.on('connection', (ws, req) => {
      ws.on('error', () => {});
      void this.previewWebSocket(ws, req).catch(() => { try { ws.close(1011, 'preview unavailable'); } catch {} });
    });

    // Wiki repair is best-effort; project/task mutations initialize their own
    // canonical wiki before use, so unrelated projects never delay binding.
    this.trackWikiWork((async () => {
      for (const project of await this.deps.store.listProjects()) {
        if (this.closing) break;
        await this.ensureProjectWiki(project).catch(error => console.warn('[wiki] startup repair failed:', error));
      }
    })().catch(error => console.warn('[wiki] startup scan failed:', error)));
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
    // Webhooks give GitHub-backed stores low latency; this durable-state scan is
    // the recovery rail for missed deliveries, restarts, and non-GitHub remotes.
    this.sweepConnections();
    this.connectionTimer = setInterval(() => this.sweepConnections(), 5000);
    this.connectionTimer.unref();
    (await this.enqueueGitPassBackstop());
    this.gitPassAutoSyncTimer = new AsyncInterval(() => this.enqueueGitPassBackstop(), GIT_PASS_AUTO_SYNC_BACKSTOP_MS);
    this.gitPassAutoSyncTimer.unref();
    return {
      url: publicUrl,
      internalUrl,
      port,
      close: async () => {
          this.closing = true;
          while (this.wikiWork.size) await Promise.allSettled([...this.wikiWork]);
          if (this.connectionTimer) clearInterval(this.connectionTimer);
          this.stopLoginPoolSync?.();
          this.stopLoginPoolSync = undefined;
          await this.gitPassAutoSyncTimer?.stop();
          await this.timingPoll?.stop();
          this.gitPassAutoSyncTimer = undefined;
          try { await this.reviewActions.stopAll(); } finally {
          this.fanout.close();
          this.operationalMetrics?.close();
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
          await Promise.all([
            new Promise<void>((resolve, reject) => {
              server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve());
              server.closeAllConnections();
            }),
            (async () => {
              await Promise.all([...this.terminalStarts]);
              await Promise.allSettled([...this.terminalStops].map(stop => stop()));
            })(),
          ]);
          }
        },
    };
  }

  /** PTY check-in (SPEC §5.5): an ephemeral provider-owned terminal in the task world. */
  /** Everything this task received, resolved by this process (SS-3): stored
   * and served output about the task is scrubbed of it. */
  private async taskSecrets(taskId: string): Promise<TaskSecrets> {
    return new TaskSecrets({ store: this.deps.store, broker: this.deps.broker,
      cardDetails: paymentCardDetails(this.deps.store, this.deps.paymentRegistry) }, (await secretScope(this.deps.store, taskId)));
  }

  private async terminal(ws: import('ws').WebSocket, req: http.IncomingMessage) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const taskId = url.searchParams.get('taskId') ?? '';
    const task = (await this.deps.store.getTask(taskId));
    const ticket = url.searchParams.get('ticket') ?? '';
    const ticketRecord = ticket ? this.terminalTickets.get(ticket) : undefined;
    if (ticketRecord) this.terminalTickets.delete(ticket); // one connection only
    const auth = ticketRecord && ticketRecord.taskId === taskId && ticketRecord.expiresAt > Date.now()
      ? ticketRecord.session
      : await this.socketAuth(req, url, task?.projectId);
    if (!auth) { ws.close(4401, 'unauthorized'); return; }
    // The same decision the open shell is re-checked with (keepAuthorized below).
    if (!(task && await this.sessionMay(auth, 'task:edit', task.projectId, taskId))) {
      ws.close(4403, 'forbidden'); return;
    }
    const projectRecord = task ? (await this.deps.store.getProject(task.projectId)) : undefined;
    const project = projectRecord ? (await this.deps.store.effectiveProjectConfig(projectRecord)) : undefined;
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
      (await this.deps.store.createExecution({ id: executionId, organizationId: projectRecord.organizationId,
        projectId: projectRecord.id, taskId, worldId: handle.id, generation: handle.generation ?? 1,
        kind: 'terminal', label: 'Interactive terminal', command: '$SHELL', server: false,
        openUrls: [], runnerLeaseId: worldLeaseId }));
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
      (await this.deps.store.setExecutionRunning(executionId));
      (await this.deps.store.appendExecutionFrame(executionId, 'Terminal opened.\n', 'system'));
    } catch (error) {
      if ((await this.deps.store.execution(executionId))) {
        (await this.deps.store.appendExecutionFrame(executionId, `${String((error as Error)?.message ?? error)}\n`, 'system'));
        (await this.deps.store.finishExecution(executionId, null, 'failed'));
      }
      if (worldLeaseId && this.deps.worldAccess) await this.deps.worldAccess.releaseLeaseAndParkIfIdle(handle, worldLeaseId);
      else if (worldLeaseId) (await this.deps.runners?.release(worldLeaseId, handle.kind));
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
          kill: async () => { try { void (await term.close()); } catch { /* already gone */ } },
        })
      : () => {};
    let finalizing: Promise<void> | undefined;
    let clientClosed = false;
    // Stored for reconnect and exported with the organization: scrubbed. The
    // live stream to the person at the shell is not.
    const output = new ExecutionOutput(data => this.deps.store.appendExecutionFrame(executionId, data), undefined,
      (await this.taskSecrets(taskId)));
    const heartbeat = new AsyncInterval(() => this.deps.store.heartbeatExecution(executionId), 30_000);
    heartbeat.unref();
    const finish = (code: number | null, cancelled = false): Promise<void> => {
      if (finalizing) return finalizing;
      finalizing = (async () => {
        await heartbeat.stop();
        untrack();
        let outputFailed = false;
        try { await output.close(); } catch { outputFailed = true; }
        try { await this.deps.store.finishExecution(executionId, code, outputFailed ? 'failed' : cancelled ? 'cancelled' : undefined); }
        finally {
          if (worldLeaseId && this.deps.worldAccess) await this.deps.worldAccess.releaseLeaseAndParkIfIdle(handle, worldLeaseId);
          else if (worldLeaseId) await this.deps.runners?.release(worldLeaseId, handle.kind);
        }
      })();
      void finalizing.then(() => this.terminalStops.delete(stopTerminal), () => this.terminalStops.delete(stopTerminal));
      return finalizing;
    };
    const failed = (error: unknown) => console.error('[terminal] execution failed:', error);
    let stopping: Promise<void> | undefined;
    const stopTerminal = (): Promise<void> => {
      clientClosed = true;
      return stopping ??= (async () => { try { await term.close(); } finally { await finish(null, true); } })();
    };
    this.terminalStops.add(stopTerminal);
    term.onData((data: string) => {
      output.append(data);
      try { ws.send(JSON.stringify({ type: 'data', data })); } catch {}
    });
    term.onExit(code => {
      void finish(code, clientClosed).catch(failed).finally(() => { try { ws.close(); } catch {} });
    });
    ws.on('message', raw => {
      // A socket that is closing (access withdrawn, say) no longer drives the shell.
      if (ws.readyState !== WebSocketClient.OPEN) return;
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try {
        if (msg.type === 'input') void Promise.resolve(term.write(msg.data)).catch(failed);
        else if (msg.type === 'resize') void Promise.resolve(term.resize(msg.cols || 80, msg.rows || 24)).catch(failed);
      } catch (error) { failed(error); }
    });
    // Close the provider stream first, then drain accepted output. Natural exit
    // and socket close share one finalization promise and one lease release.
    ws.on('close', () => { void stopTerminal().catch(failed); });
    // The shell lasts only as long as its principal may edit the task. A
    // `karmax attach` connects with a ticket and no cookie; its person is
    // decided from their current grants, not the ticket's 10-minute token.
    const lifetime = socketLifetime(ws);
    lifetime.add(() => stopTerminal());
    keepAuthorized(ws, lifetime, async () => {
      // The ticket's session when it authorised the connection, and only while
      // it is still signed in; otherwise the request's own.
      const current = auth === ticketRecord?.session
        ? (await this.sessionLive(auth) ? auth : undefined)
        : await this.socketAuth(req, url, task.projectId);
      return !!current && await this.sessionMay(current, 'task:edit', task.projectId, taskId);
    });
    if (this.closing || ws.readyState !== 1) await stopTerminal();
  }

  /** Stream a running review action's output to the UI. `procId` names a process
   *  the client already started via POST /review-action. We replay the buffered
   *  output first, then push the live tail until it exits or the socket closes. */
  private async reviewActionStream(ws: import('ws').WebSocket, req: http.IncomingMessage) {
    const lifetime = socketLifetime(ws);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const procId = url.searchParams.get('procId') ?? '';
    const rec = (await this.reviewActions.status(procId));
    if (!rec) {
      try { ws.send(JSON.stringify({ type: 'exit', code: -1, data: 'No such action process.\n' })); } catch {}
      ws.close();
      return;
    }
    const task = (await this.deps.store.getTask(rec.taskId));
    const auth = await this.socketAuth(req, url, task?.projectId);
    if (!auth) { ws.close(4401, 'unauthorized'); return; }
    if (!(await this.deps.tokens.check(auth.apiToken, 'task:review:execute', { projectId: task?.projectId, taskId: rec.taskId })).ok) {
      ws.close(4403, 'forbidden'); return;
    }
    const send = (obj: unknown) => { try { ws.send(JSON.stringify(obj)); } catch {} };
    if (rec.output) send({ type: 'data', data: rec.output });
    if (!rec.running) {
      send({ type: 'exit', code: rec.exitCode });
      ws.close();
      return;
    }
    const off = (await this.reviewActions.attach(procId, (chunk, done, code) => {
      if (chunk) send({ type: 'data', data: chunk });
      if (done) { send({ type: 'exit', code }); try { ws.close(); } catch {} }
    }));
    lifetime.add(off);
    keepAuthorized(ws, lifetime, async () => {
      const current = await this.socketAuth(req, url, task?.projectId);
      return !!current && await this.sessionMay(current, 'task:review:execute', task?.projectId, rec.taskId);
    });
  }

  // ─── request handling ────────────────────────────────────────────────────────
  private secureRequest(req: http.IncomingMessage): boolean {
    return this.deps.hosted === true || process.env.KARMAX_PUBLIC_URL?.startsWith('https://') === true
      || (req.socket as { encrypted?: boolean })?.encrypted === true;
  }

  private sessionCookie(req: http.IncomingMessage, sid: string): string {
    return `krmax_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sid ? 43200 : 0}${this.secureRequest(req) ? '; Secure' : ''}`;
  }

  private sameOriginRequest(req: http.IncomingMessage): boolean {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (!origin) return true; // Non-browser API clients do not send Origin.
    try {
      const expected = process.env.KARMAX_PUBLIC_URL?.trim()
        || `${(req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'}://${req.headers.host}`;
      return new URL(origin).origin === new URL(expected).origin;
    } catch { return false; }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const receivedAt = req.method === 'POST' && (await this.cachedTimingEnabled()) ? { monoMs: performance.now(), wallMs: Date.now() } : undefined;
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    // Resource repositories: restic in task worlds (and the worker), with
    // grants of their own, never a session; not the browser API's limits.
    if (p.startsWith(REPOSITORY_ROUTE) && this.deps.resources?.repositoryServer)
      return this.deps.resources.repositoryServer.handle(req, res, p.slice(REPOSITORY_ROUTE.length) + url.search);
    const sensitiveNavigation = /^\/api\/tasks\/[^/]+\/(desktop|preview\/)/.test(p);
    if (p.startsWith('/api/') && (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET') || sensitiveNavigation)
      && !this.sameOriginRequest(req)) return this.json(res, 403, { error: 'cross-origin request forbidden' });
    const previewOrigin = configuredPreviewOrigin();
    const onPreviewOrigin = Boolean(previewOrigin && this.requestIsPreviewOrigin(req));
    // Repository applications are untrusted. In hosted mode they get an origin
    // that exposes only opaque preview leases, never Karmax API/static routes or
    // the reviewer's authenticated application cookies.
    if (onPreviewOrigin && !p.startsWith('/preview/')) return this.json(res, 404, { error: 'not found' });
    if (p.startsWith('/api/') && p !== '/api/health/live' && this.deps.runtimeReady?.() === false)
      return this.json(res, 503, { ok: false, error: 'runtime is not ready', ts: Date.now() });
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
      res.writeHead((await this.deps.store.previewHostnameAllowed(domain)) ? 204 : 403,
        { 'cache-control': 'no-store', 'content-length': '0' });
      return void res.end();
    }
    if (this.deps.hosted && !p.startsWith('/api/health/') && !this.requestLimits.allow(this.clientAddress(req), p))
      return this.json(res, 429, { error: 'too many requests; try again later' });
    if (p.startsWith('/share/conversations/')) {
      const share = req.method === 'GET' ? (await publicShare(this.deps.store, p.slice('/share/conversations/'.length))) : undefined;
      const signedIn = !!(await this.deps.identity?.session(requestHeaders(req.headers)).catch(() => null));
      res.writeHead(share ? 200 : 404, { 'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow',
        'content-security-policy': `default-src 'none'; script-src 'self' ${MATHJAX_SCRIPT_SOURCE}; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` });
      return void res.end(publicConversationHtml(share, { siteName: await this.siteName, signedIn }));
    }
    if (p.startsWith('/scim/v2/')) return this.scim(req, res, url);
    if (p.startsWith('/brand/')) return this.brand(p, res, req);
    if (p === '/app.webmanifest' && req.method === 'GET') return (await this.webManifest(res));
    if (p.startsWith('/api/')) return (await this.api(req, res, url, receivedAt));
    if (p === '/ws') return; // handled by ws
    return (await this.static(p, res, req));
  }

  private async api(req: http.IncomingMessage, res: http.ServerResponse, url: URL, receivedAt?: { monoMs: number; wallMs: number }) {
    const p = url.pathname;
    const method = req.method ?? 'GET';

    // A public OAuth application identity, derived only from operator configuration.
    // Never reflect Host/Origin or tenant data into redirect URIs.
    if (p === MCP_CLIENT_METADATA_PATH && method === 'GET') {
      const metadata = mcpClientMetadata();
      return this.json(res, metadata ? 200 : 404, metadata ?? { error: 'A public HTTPS installation URL is required' });
    }
    // ── unauthenticated endpoints ──
    if (p === '/api/session' && method === 'GET') {
      if (this.deps.identity) {
        const current = await this.deps.identity.session(requestHeaders(req.headers));
        if (current) {
          (await this.consumeSignupPolicyAcceptance(req, current.user.id, current.user.email));
          if (((await this.deps.paidLaunchSettings?.publicLaunchInfo()) ?? publicLaunchInfo()).paidLaunch && !(await this.deps.store.policyAcceptances(current.user.id))
            .some((acceptance) => acceptance.context === 'signup')) {
            return this.json(res, 200, { authRequired: true, authenticated: false, policyAcceptanceRequired: true,
              user: current.user, sso: ssoSession(this.deps.identity),
              google: this.deps.identity.googleEnabled, github: this.deps.identity.githubEnabled });
          }
          const onboardingKey = `git:onboarding:${current.user.id}`;
          // Better Auth creates social-login users inside its callback route,
          // bypassing /api/signup. Complete the same karmax-side provisioning on
          // their first authenticated session. The helper is idempotent.
          if ((await this.provisionPersonalWorkspace(current.user.id, current.user.name))) {
            (await this.deps.store.kvSet(onboardingKey, 'pending'));
          }
          const gitOnboarding = (await this.deps.store.kvGet(onboardingKey)) === 'pending';
          if (gitOnboarding) (await this.deps.store.kvSet(onboardingKey, 'seen'));
          return this.json(res, 200, { authRequired: true, authenticated: true, user: current.user, gitOnboarding,
          emailDelivery: (await this.deps.identity.canSendEmail?.()) ?? false,
          sso: ssoSession(this.deps.identity),
          google: this.deps.identity.googleEnabled,
          github: this.deps.identity.githubEnabled });
        }
        return this.json(res, 200, {
          authRequired: true,
          authenticated: false,
          setupRequired: !(await this.deps.identity.hasUsers()),
          signupAvailable: (await this.deps.identity.hasUsers()),
          // Whether "Forgot password?" can deliver anything.
          emailDelivery: (await this.deps.identity.canSendEmail?.()) ?? false,
          sso: ssoSession(this.deps.identity),
          google: this.deps.identity.googleEnabled,
          github: this.deps.identity.githubEnabled,
        });
      }
      // Legacy sessions are single-user by construction; minting one on a
      // hosted multi-tenant cell would hand out owner access to a stranger.
      if (this.deps.hosted) return this.json(res, 503, { error: 'hosted mode requires the identity service' });
      const authRequired = !!this.deps.password;
      if (!authRequired) {
        if (this.passwordlessSession) {
          const previous = await this.passwordlessSession;
          if (!this.sessions.has(previous.sid) || (previous.session.expiresAt ?? 0) <= Date.now()) this.passwordlessSession = undefined;
        }
        const { sid } = await (this.passwordlessSession ??= this.newSession().catch(error => {
          this.passwordlessSession = undefined; throw error;
        }));
        res.setHeader('set-cookie', this.sessionCookie(req, sid));
        return this.json(res, 200, { authRequired: false, token: sid, user: 'me' });
      }
      return this.json(res, 200, { authRequired: true });
    }
    if (p === '/api/launch' && method === 'GET')
      return this.json(res, 200, (await this.deps.paidLaunchSettings?.publicLaunchInfo((await this.siteName)))
        ?? publicLaunchInfo(process.env, undefined, (await this.siteName)));
    const legalMatch = p.match(/^\/api\/legal\/([^/]+)$/);
    if (legalMatch && method === 'GET') {
      const document = (await this.deps.paidLaunchSettings?.policyDocument(legalMatch[1]!, (await this.siteName)))
        ?? policyDocument(legalMatch[1]!, process.env, undefined, (await this.siteName));
      return document ? this.json(res, 200, document) : this.json(res, 404, { error: 'policy not found' });
    }
    if (p === '/api/legal/preaccept' && method === 'POST') {
      try {
        const body = await this.body(req);
        const versions = assertPolicyAcceptance('signup', body.accepted, body.versions);
        const token = crypto.randomBytes(32).toString('base64url');
        const hash = crypto.createHash('sha256').update(token).digest('hex');
        const now = Date.now();
        for (const [key, pending] of this.pendingPolicyAcceptances) {
          if (pending.expiresAt < now) this.pendingPolicyAcceptances.delete(key);
        }
        if (this.pendingPolicyAcceptances.size >= 10_000)
          return this.json(res, 429, { error: 'too many pending signup attempts; try again shortly' });
        this.pendingPolicyAcceptances.set(hash, { versions, expiresAt: now + 15 * 60_000 });
        res.setHeader('set-cookie', `krmax_policy_acceptance=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=900${this.secureRequest(req) ? '; Secure' : ''}`);
        return this.json(res, 200, { ok: true, versions });
      } catch (error) {
        return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (p === '/api/legal/complete-signup' && method === 'POST' && this.deps.identity) {
      const current = await this.deps.identity.session(requestHeaders(req.headers));
      if (!current) return this.json(res, 401, { error: 'sign in before completing policy acceptance' });
      try {
        const body = await this.body(req);
        const versions = assertPolicyAcceptance('signup', body.accepted, body.versions);
        (await this.deps.store.recordPolicyAcceptance({ userId: current.user.id, email: current.user.email,
          context: 'signup', versions }));
        return this.json(res, 200, { ok: true, versions });
      } catch (error) {
        return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (p.startsWith('/api/auth/') && this.deps.identity) {
      // Public account creation goes through /api/signup, where the immutable
      // policy-version evidence is validated and recorded. Better Auth's direct
      // sign-up route would otherwise be an undocumented acceptance bypass.
      if (p === '/api/auth/sign-up/email') return this.json(res, 404, { error: 'use /api/signup to create an account' });
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
        const result = (await provider.handleWebhook(raw,
          typeof req.headers['stripe-signature'] === 'string' ? req.headers['stripe-signature'] : undefined));
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
    // SaaS subscription billing has its own secret, provider, and ledger. Keep
    // this pre-auth raw-body route separate from the Stripe Issuing webhook
    // above so customer subscription events can never authorize agent spend.
    if (p === '/api/subscriptions/paddle/checkout-config' && method === 'GET') {
      const c = await this.deps.paidLaunchSettings?.paddleConfig();
      if (!c?.clientToken) return this.json(res, 503, { error: 'Paddle checkout is unavailable' });
      res.setHeader('Cache-Control', 'no-store');
      return this.json(res, 200, { environment: c.environment, clientToken: c.clientToken });
    }
    if ((p === '/api/subscriptions/webhook' || p === '/api/subscriptions/paddle/webhook') && method === 'POST') {
      try {
        if (!this.deps.subscriptions) return this.json(res, 503, { error: 'subscription billing is unavailable' });
        const raw = await this.rawBody(req, 2 * 1024 * 1024);
        const paddle = p === '/api/subscriptions/paddle/webhook';
        const signature = req.headers[paddle ? 'paddle-signature' : 'stripe-signature'];
        const result = (await this.deps.subscriptions.handleWebhook(raw,
          typeof signature === 'string' ? signature : undefined, paddle ? 'paddle-billing' : undefined));
        return this.json(res, 200, { received: true, ...result });
      } catch (error) {
        return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (p === '/api/payments/stripe/callback' && method === 'GET') {
      const callbackSession = await this.auth(req);
      if (!callbackSession?.userId) return this.json(res, 401, { error: 'sign in to complete Stripe connection' });
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const oauthError = url.searchParams.get('error_description') ?? url.searchParams.get('error');
      if (oauthError) return (await this.paymentCallbackPage(res, 400, `Stripe connection was not completed: ${oauthError}`));
      if (!code || !state) return (await this.paymentCallbackPage(res, 400, 'The Stripe callback is incomplete.'));
      try {
        const provider = this.deps.paymentRegistry?.get('stripe');
        const { StripeIssuingProvider } = await import('../autonomy/payments.js');
        if (!(provider instanceof StripeIssuingProvider)) throw new Error('Stripe Issuing is unavailable');
        const connection = await provider.completeOAuth(state, code, callbackSession.userId);
        const destination = `${(await organizationSettingsPath(this.deps.store, connection.organizationId))}?payments=stripe-connected&organizationId=${encodeURIComponent(connection.organizationId)}`;
        res.writeHead(303, { location: destination });
        return void res.end();
      } catch (error) {
        return (await this.paymentCallbackPage(res, 502,
          `Stripe could not be connected: ${error instanceof Error ? error.message : String(error)}`));
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
        const deliveryId = String(req.headers['x-github-delivery'] ?? '');
        let recoveries = 0;
        const result = await this.deps.githubApp.deliverWebhook(
          String(req.headers['x-github-event'] ?? ''), deliveryId, raw,
          typeof req.headers['x-hub-signature-256'] === 'string' ? req.headers['x-hub-signature-256'] : undefined,
          async (result) => { recoveries = await this.dispatchGithubWebhook(result); },
        );
        return this.json(res, 200, { accepted: result.accepted,
          ...(result.reconciled !== undefined ? { reconciled: result.reconciled } : {}),
          ...(result.events?.length ? { dispatched: result.events.length } : {}),
          ...(recoveries ? { recoveries } : {}),
          ...(result.vaultPushes?.length ? { vaultSyncsQueued: result.vaultPushes.length } : {}),
        });
      } catch (error) {
        // Verified failures remain in the durable inbox for local retry.
        const message = error instanceof Error ? error.message : String(error);
        return this.json(res, /webhook signature/i.test(message) ? 401 : 500, { error: message });
      }
    }
    // Agent mailbox inbound webhook (wiki plans/PLAN-passwords §8): authenticated by a
    // configured shared secret, not a karmax session — so it sits with the other
    // unauthenticated endpoints, before the session gate.
    if (p === '/api/agent-mail/ingest' && method === 'POST') {
      const mailMod = await import('../autonomy/agent-mail.js');
      // Auth: the minted secret (in the copy-pasted webhook URL or a Bearer
      // header) — forwarding services can rarely set custom headers, so the
      // query form is the primary one. Legacy env secret stays accepted.
      const presented = url.searchParams.get('secret')
        ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
      // The secret names the organization it may deliver to (compared in constant
      // time inside); an installation-wide legacy secret still reaches every one.
      const scope = (await mailMod.ingestScope(this.deps.store, presented, process.env.KARMAX_AGENT_MAIL_SECRET));
      if (!scope)
        return this.json(res, 401, { error: `agent-mail ingest requires the webhook secret (the ?secret= in the URL ${(await this.siteName)} shows the operator)` });
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
      const { delivered } = (await new mailMod.AgentMail(this.deps.store)
        .ingest({ to: mailMod.cleanAddress(msg.to), from: mailMod.cleanAddress(msg.from), subject: msg.subject ? String(msg.subject) : undefined, text: String(msg.text ?? '') },
          scope.organizationId));
      return this.json(res, 200, { delivered });
    }
    const githubManifestCallback = p.match(/^\/api\/github\/manifest\/callback(?:\/([^/]+))?$/);
    if (githubManifestCallback && method === 'GET' && this.deps.githubApp && this.deps.identity) {
      const code = url.searchParams.get('code') ?? '';
      // Query-form state remains accepted for setup links created by the prior
      // release; new manifests use the validator-safe path form.
      const state = githubManifestCallback[1] ? decodeURIComponent(githubManifestCallback[1]) : url.searchParams.get('state') ?? '';
      const identity = await this.deps.identity.session(requestHeaders(req.headers));
      if (!identity || !code || !state) return (await this.githubCallbackPage(res, 400, 'The GitHub App setup callback is incomplete.'));
      const pending = (await this.deps.store.consumeGithubInstallState(state, identity.user.id));
      // Only a state minted by the App-creation route (which requires
      // settings:write and an unconfigured App) may configure the shared App:
      // any member can mint an ordinary GitHub state, and on a hosted cell this
      // App serves every tenant.
      if (!pending || pending.purpose !== 'manifest')
        return (await this.githubCallbackPage(res, 400, 'This GitHub App setup link is invalid, expired, or belongs to another user.'));
      if (this.deps.githubApp.configured())
        return (await this.githubCallbackPage(res, 409, 'A GitHub App is already configured.'));
      try {
        await this.deps.githubApp.convertManifest(code);
        const installState = (await this.deps.store.createGithubInstallState(pending.organizationId, identity.user.id,
          pending.returnTo === 'profile' ? { returnTo: 'profile', selectAccount: pending.selectAccount,
            githubAccountId: pending.githubAccountId, githubLogin: pending.githubLogin } : {}));
        res.writeHead(303, { location: this.deps.githubApp.installationUrl(installState) });
        return void res.end();
      } catch (error) {
        return (await this.githubCallbackPage(res, 502, `GitHub App setup failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    if (p === '/api/github/oauth/callback' && method === 'GET' && this.deps.githubApp && this.deps.identity) {
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const identity = await this.deps.identity.session(requestHeaders(req.headers));
      if (!identity || !code || !state) return (await this.githubCallbackPage(res, 400, 'The GitHub authorization callback is incomplete.'));
      const pending = (await this.deps.store.consumeGithubInstallState(state, identity.user.id));
      if (!pending) return (await this.githubCallbackPage(res, 400, 'This GitHub authorization link is invalid, expired, or belongs to another user.'));
      try {
        const githubIdentity = await this.deps.githubApp.authorizeUser(identity.user.id, code, (await this.githubPublicUrl(req)), {
          expectedAccountId: pending.githubAccountId,
          makeActive: pending.selectAccount || !pending.githubAccountId,
        });
        await this.saveGithubIdentity(identity.user.id, githubIdentity);
        const activeAccountId = (await this.deps.githubApp.activeUserAccountId(identity.user.id));
        if (activeAccountId) {
          const { GitProfiles, userGitScope } = await import('../autonomy/git-profiles.js');
          (await new GitProfiles(this.deps.store, this.deps.broker, undefined, userGitScope(identity.user.id))
            .setActiveGithub(activeAccountId));
        }
        if (pending.returnTo !== 'installation') {
          const installUrl = (await this.linkPersonalGithubInstallation(identity.user.id, githubIdentity, pending.returnTo === 'profile'));
          if (installUrl) {
            res.writeHead(303, { location: installUrl });
            return void res.end();
          }
          for (const project of (await this.deps.store.listProjects()).filter((candidate) => candidate.organizationId === pending.organizationId))
            await this.ensureProjectWiki(project, identity.user.id);
        }
        const destination = pending.returnTo === 'profile'
          ? (await userProfilePath(this.deps.store, pending.organizationId))
          : (await organizationSettingsPath(this.deps.store, pending.organizationId));
        res.writeHead(303, { location: `${destination}?github=${pending.returnTo === 'installation' ? 'choose-installation' : 'ready'}&organizationId=${encodeURIComponent(pending.organizationId)}${pending.returnTo === 'installation' ? '#settings-code' : ''}` });
        return void res.end();
      } catch (error) {
        return (await this.githubCallbackPage(res, 502, `GitHub authorization failed: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    if (p === '/api/github/callback' && method === 'GET' && this.deps.githubApp && this.deps.identity) {
      const installationId = url.searchParams.get('installation_id') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const identity = await this.deps.identity.session(requestHeaders(req.headers));
      if (!identity || !installationId || !state) return (await this.githubCallbackPage(res, 400, 'The GitHub installation callback is incomplete.'));
      const pending = (await this.deps.store.consumeGithubInstallState(state, identity.user.id));
      if (!pending) return (await this.githubCallbackPage(res, 400, 'This GitHub installation link is invalid, expired, or belongs to another user.'));
      try {
        // `installation_id` is a public number in a URL anyone can forge, and on
        // a hosted cell the App's installations belong to every tenant. Link
        // one only when this person can administer it on GitHub.
        const verification = (await this.deps.githubApp.status(identity.user.id));
        if (verification.userAuthorized) {
          await this.deps.githubApp.connectExistingInstallation(pending.organizationId, identity.user.id, installationId);
        } else if (verification.oauthConfigured) {
          // Verify through GitHub first; they then pick the installation they just made.
          const oauthState = (await this.deps.store.createGithubInstallState(pending.organizationId, identity.user.id,
            { returnTo: 'installation' }));
          res.writeHead(303, { location: this.deps.githubApp.userAuthorizationUrl(oauthState, (await this.githubPublicUrl(req))) });
          return void res.end();
        } else if (this.deps.hosted) {
          return (await this.githubCallbackPage(res, 403, 'Connect your GitHub account first, then install the App.'));
        } else {
          // A self-hosted App configured without OAuth cannot verify anything;
          // its installations are the operator's own.
          await this.deps.githubApp.connectInstallation(pending.organizationId, installationId);
        }
        const status = (await this.deps.githubApp.status(identity.user.id));
        // Sign-in that continued to installation already authorized this exact account.
        const authorized = Boolean(pending.githubAccountId && (await this.deps.githubApp.listUserAccounts(identity.user.id))
          .some((account) => account.id === pending.githubAccountId));
        if (pending.returnTo === 'profile' && status.oauthConfigured && !authorized) {
          const oauthState = (await this.deps.store.createGithubInstallState(pending.organizationId, identity.user.id,
            { returnTo: 'profile', selectAccount: pending.selectAccount,
              githubAccountId: pending.githubAccountId, githubLogin: pending.githubLogin }));
          const publicUrl = (await this.githubPublicUrl(req));
          res.writeHead(303, { location: this.deps.githubApp.userAuthorizationUrl(oauthState, publicUrl, {
            login: pending.githubLogin, selectAccount: pending.selectAccount,
          }) });
          return void res.end();
        }
        // Repository provisioning needs a human user authorization. Installing
        // the organization App is still a complete repository-transport setup on
        // its own; defer wiki creation until a connected person is available.
        if (status.userAuthorized) {
          for (const project of (await this.deps.store.listProjects()).filter((candidate) => candidate.organizationId === pending.organizationId))
            await this.ensureProjectWiki(project, identity.user.id);
        }
        const destination = pending.returnTo === 'profile'
          ? (await userProfilePath(this.deps.store, pending.organizationId))
          : (await organizationSettingsPath(this.deps.store, pending.organizationId));
        res.writeHead(303, { location: `${destination}?github=connected&organizationId=${encodeURIComponent(pending.organizationId)}` });
        return void res.end();
      } catch (error) {
        return (await this.githubCallbackPage(res, 502, `GitHub could not be connected: ${error instanceof Error ? error.message : String(error)}`));
      }
    }
    if (p === '/api/login' && method === 'POST') {
      const b = await this.body(req);
      const email = String(b.email ?? '').trim().toLowerCase();
      const throttleKeys = [`ip:${this.clientAddress(req)}`, ...(email ? [`email:${email}`] : [])];
      if (this.loginBlocked(throttleKeys))
        return this.json(res, 429, { error: 'too many failed sign-in attempts; try again in a few minutes' });
      if (this.deps.identity) {
        try {
          const response = await this.deps.identity.signIn(String(b.email ?? ''), String(b.password ?? ''), requestHeaders(req.headers));
          if (response.ok) this.clearLoginFailures(throttleKeys); else this.noteLoginFailure(throttleKeys);
          return this.sendWebResponse(res, response);
        } catch { this.noteLoginFailure(throttleKeys); return this.json(res, 401, { error: 'invalid email or password' }); }
      }
      if (this.deps.hosted) return this.json(res, 503, { error: 'hosted mode requires the identity service' });
      // Constant-time, like the Stripe webhook and the agent-mail ingest secret:
      // this compares a shared secret on an unauthenticated route.
      if (this.deps.password && timingSafeEqualStr(String(b.password ?? ''), this.deps.password)) {
        this.clearLoginFailures(throttleKeys);
        const { sid } = (await this.newSession());
        res.setHeader('set-cookie', this.sessionCookie(req, sid));
        return this.json(res, 200, { token: sid, user: 'me' });
      }
      this.noteLoginFailure(throttleKeys);
      return this.json(res, 401, { error: 'invalid password' });
    }
    if (p === '/api/setup' && method === 'POST' && this.deps.identity) {
      if ((await this.deps.identity.hasUsers())) return this.json(res, 409, { error: `${(await this.siteName)} has already been set up` });
      const b = await this.body(req);
      try {
        const { response, user } = await this.deps.identity.bootstrap(
          { name: String(b.name ?? ''), email: String(b.email ?? ''), password: String(b.password ?? '') },
          requestHeaders(req.headers),
        );
        (await this.deps.authorization?.bootstrapAdministrator(user.id));
        (await this.deps.store.claimPersonalOrganization(user.id, user.name));
        (await this.deps.store.kvSet(`git:onboarding:${user.id}`, 'pending'));
        if (this.deps.hosted) (await this.enableHostedOnboarding(user.id, 'org_personal'));
        for (const project of (await this.deps.store.listProjects()).filter((candidate) => candidate.organizationId === 'org_personal')) {
          (await this.deps.store.setProjectMembership(project.id, { kind: 'user', userId: user.id }, 'owner'));
        }
        return this.sendWebResponse(res, response);
      } catch (e) { return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (p === '/api/signup' && method === 'POST' && this.deps.identity) {
      // The first account must still go through /setup so it becomes the one
      // explicit trust root. Later self-signups each land in their own personal
      // workspace organization (provisioned below) — a usable app immediately,
      // and they can still be invited into other organizations.
      if (!(await this.deps.identity.hasUsers())) return this.json(res, 409, { error: 'set up the first administrator before signing up' });
      const b = await this.body(req);
      try {
        const versions = assertPolicyAcceptance('signup', b.acceptedPolicies, b.policyVersions);
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
        if (userId) {
          (await this.provisionPersonalWorkspace(userId, String(created?.user?.name ?? b.name ?? '')));
          (await this.deps.store.kvSet(`git:onboarding:${userId}`, 'pending'));
          (await this.deps.store.recordPolicyAcceptance({ userId, email: String(created?.user?.email ?? b.email ?? ''),
            context: 'signup', versions }));
        }
        return this.sendWebResponse(res, response);
      } catch (e) { return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
    }
    if (p === '/api/meta' && method === 'GET') {
      const consoleRevision = staticAssetRevision(path.join(this.deps.staticDir, 'app.js'));
      return this.json(res, 200, {
        agent: this.deps.agentInfo,
        version: this.deps.version ?? '1.0.0',
        ...(consoleRevision ? { consoleRevision } : {}),
        timingEnabled: (await this.cachedTimingEnabled()),
        resolveAgentEnabled: RESOLVE_AGENT_ENABLED,
        cellId: this.deps.cellId ?? 'local',
        hosted: this.deps.hosted ?? false,
        hostLocal: this.hostLocal,
        siteName: (await this.siteName),
        worldProviders: this.deps.worlds.catalog(),
        // Which inbox delivery channels actually have an adapter wired. The console
        // used to render Email/Slack switches unconditionally and toast "saved" for
        // them, but `src/main.ts` only registers those adapters when
        // KARMAX_EMAIL_DELIVERY_URL / KARMAX_SLACK_DELIVERY_URL are set — so a user
        // could enable Email, be told it saved, and then simply never be notified
        // again (the failure was logged server-side only). Report the truth and let
        // the UI disable what cannot work.
        deliveryChannels: this.deps.deliveryChannels ?? ['browser'],
        sso: ssoSession(this.deps.identity),
        google: this.deps.identity?.googleEnabled ?? false,
        github: this.deps.identity?.githubEnabled ?? false,
      });
    }
    if (p === '/api/health/live' && method === 'GET') return this.json(res, 200, { ok: true, ts: Date.now() });
    if (p === '/api/health/ready' && method === 'GET') {
      try {
        await withTimeout(this.deps.store.checkDatabaseAsync(), 2_000);
        await withTimeout(this.deps.client.workflowService.getSystemInfo({}), 2_000);
        return this.json(res, 200, { ok: true, database: 'ready', temporal: 'ready', ts: Date.now() });
      } catch {
        return this.json(res, 503, { ok: false, ts: Date.now() });
      }
    }

    // Browser attachments use HttpOnly session cookies; API clients use headers.
    const attGet = p.match(/^\/api\/attachments\/([^/]+)$/);
    if (attGet && method === 'GET') {
      const projectId = url.searchParams.get('projectId') ?? undefined;
      const attachmentSession = await this.auth(req, projectId);
      if (!attachmentSession) return this.json(res, 401, { error: 'unauthorized' });
      if (projectId && !(await this.deps.tokens.check(attachmentSession.apiToken, 'task:read', { projectId })).ok)
        return this.json(res, 403, { error: 'missing capability task:read' });
      // New uploads are project-scoped. Unscoped rows are legacy attachments
      // created before the ACL table existed and remain readable for migration.
      if ((await this.deps.store.attachmentIsScoped(attGet[1]!)) && (!projectId || !(await this.deps.store.attachmentAllowed(attGet[1]!, projectId))))
        return this.json(res, 404, { error: 'attachment not found' });
      const got = this.attachments.read(attGet[1]!);
      if (!got) return void res.writeHead(404).end('not found');
      res.writeHead(200, {
        'content-type': got.mediaType,
        'cache-control': 'private, max-age=31536000, immutable',
        ...(url.searchParams.get('name')
          ? { 'content-disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(url.searchParams.get('name')!)}` }
          : {}),
        'x-content-type-options': 'nosniff',
      });
      return void res.end(got.buf);
    }

    // ── authenticated endpoints ──
    const requestedScope = await this.requestScope(p, url);
    const auditScope = requestedScope.projectId ? `project:${requestedScope.projectId}`
      : requestedScope.organizationId ? `organization:${requestedScope.organizationId}` : 'global';
    if (requestedScope.conflict) {
      (await this.deps.authorization?.audit('anonymous', 'http.denied.scope-conflict', auditScope, { path: p, method, reason: requestedScope.conflict }));
      return this.json(res, 403, { error: requestedScope.conflict });
    }
    const session = await this.auth(req, requestedScope.projectId, requestedScope.organizationId);
    if (!session) {
      // Denials are audited too: cross-tenant probing must be visible to an
      // administrator, not only successful requests.
      (await this.deps.authorization?.audit('anonymous', 'http.denied.unauthenticated', auditScope, { path: p, method }));
      return this.json(res, 401, { error: 'unauthorized' });
    }
    const token = session.apiToken;
    const { api, store } = this.deps;
    let authRecord = (await this.deps.tokens.verify(token));
    if (!authRecord) return this.json(res, 401, { error: 'unauthorized' });
    let callerIdentity = resolveCallerIdentity(authRecord, session.userId);
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

    // Authorization is independent of actor type. Personal self-service routes
    // below require the same verified account subject for browsers and delegates.
    const decision = await this.routeDecision(token, authRecord, session, method, p, url, requestedScope);
    const required = decision.required;
    if (decision.required) {
      const { checked } = decision;
      const auditedIdentity = resolveCallerIdentity(checked.record ?? authRecord, session.userId);
      const principal = actorPrincipal(auditedIdentity.actor);
      if (!decision.allowed) {
        (await this.deps.authorization?.audit(principal, `http.denied.${required}`, auditScope,
          { path: p, method, reason: checked.reason ?? `missing capability ${required}`,
            ...identityAuditDetail(auditedIdentity) }));
        return this.json(res, 403, { error: await this.routeRefusal(decision, authRecord) });
      }
      if (checked.ok && checked.record) {
        authRecord = checked.record;
        callerIdentity = resolveCallerIdentity(authRecord, session.userId);
      }
      if (method !== 'GET' && method !== 'HEAD')
        (await this.deps.authorization?.audit(principal, `http.${method.toLowerCase()}.${required}`, auditScope,
          { path: p, ...identityAuditDetail(auditedIdentity) }));
    }

    if (required && requestedScope.projectId && !['GET', 'HEAD'].includes(method)) {
      const originalOrganization = (await store.getProject(requestedScope.projectId))?.organizationId;
      this.requestGuards.set(req, async () => {
        if ((await store.getProject(requestedScope.projectId!))?.organizationId !== originalOrganization)
          throw new ProjectTransferError('Project moved while this request was being prepared. Reload and retry.');
        const checked = await this.deps.tokens.check(token, required, requestedScope);
        if (!checked.ok) throw new CapabilityError(checked.reason ?? 'Access changed. Reload and retry.');
      });
    }
    try {
      const sharingSettings = p.match(/^\/api\/(organizations|projects)\/([^/]+)\/conversation-sharing$/);
      if (sharingSettings) {
        const [, scope, id] = sharingSettings;
        const organization = scope === 'organizations';
        if (!(organization ? (await store.getOrganization(id!)) : (await store.getProject(id!)))) return this.json(res, 404, { error: 'scope not found' });
        const key = `conversation-sharing:${organization ? 'organization' : 'project'}:${id}`;
        if (method === 'PUT') {
          const body = await this.body(req);
          if (organization ? typeof body.enabled !== 'boolean' : !['inherit', 'disabled'].includes(body.value))
            return this.json(res, 400, { error: 'invalid sharing setting' });
          (await store.kvSet(key, organization ? (body.enabled ? 'enabled' : 'disabled') : body.value));
        } else if (method !== 'GET') return this.json(res, 405, { error: 'method not allowed' });
        return this.json(res, 200, { ...(organization ? { enabled: (await store.kvGet(key)) === 'enabled' } : (await sharingPolicy(store, id!))),
          canManage: (await this.deps.tokens.check(token, organization ? 'organization:edit' : 'project:settings:write', requestedScope)).ok });
      }
      const conversationShare = p.match(/^\/api\/tasks\/([^/]+)\/conversation-share$/);
      if (conversationShare) {
        const taskId = conversationShare[1]!;
        const task = (await store.getTask(taskId));
        if (!task) return this.json(res, 404, { error: 'task not found' });
        // Bind mutations and link discovery to the record itself, even when a
        // caller supplies a conflicting projectId query parameter.
        const actualScope = { taskId, projectId: task.projectId, organizationId: (await store.getProject(task.projectId))?.organizationId };
        if (!(await this.deps.tokens.check(token, 'task:conversation:share', actualScope)).ok)
          return this.json(res, 403, { error: 'conversation sharing is not allowed in this project' });
        const role = url.searchParams.get('role') ?? 'do';
        const policy = (await sharingPolicy(store, task.projectId));
        if (method === 'DELETE') {
          (await revokeShare(store, taskId, role));
          return this.json(res, 200, { revoked: true });
        }
        let share = (await currentShare(store, taskId, role));
        if (method === 'POST') {
          if (!policy.effective) return this.json(res, 403, { error: 'Public conversation sharing is disabled by organization or project settings' });
          const view = await api.getTaskView(token, taskId);
          const transcript = view?.transcripts?.find(t => t.role === role);
          const messages = transcript?.messages ?? (role === 'do' ? view?.messages : undefined);
          if (!messages?.length) return this.json(res, 404, { error: 'conversation not found' });
          share = (await createShare(store, taskId, role, messages));
        } else if (method !== 'GET') return this.json(res, 405, { error: 'method not allowed' });
        // Give the dialog an actionable destination for the policy that blocks
        // sharing. Match the settings endpoint's scope when checking management.
        const settings = policy.effective ? null : !policy.organization
          ? { scope: 'organization', id: actualScope.organizationId!, canManage: (await this.deps.tokens.check(token,
            'organization:edit', { organizationId: actualScope.organizationId })).ok }
          : { scope: 'project', id: task.projectId, canManage: (await this.deps.tokens.check(token,
            'project:settings:write', { projectId: task.projectId, organizationId: actualScope.organizationId })).ok };
        return this.json(res, 200, { enabled: policy.effective, settings,
          url: share ? `/share/conversations/${share.id}` : null, createdAt: share?.createdAt });
      }
      if (p === '/api/logout' && method === 'POST') {
        const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
        const legacyId = bearer ?? req.headers.cookie?.split(';').map(value => value.trim())
          .find(value => value.startsWith('krmax_session='))?.slice('krmax_session='.length);
        if (legacyId) {
          const legacy = this.sessions.get(legacyId);
          this.sessions.delete(legacyId);
          if (legacy) await this.deps.tokens.revoke(legacy.apiToken);
        }
        res.setHeader('set-cookie', this.sessionCookie(req, ''));
        if (this.deps.identity) return this.sendWebResponse(res, await this.deps.identity.signOut(requestHeaders(req.headers)));
        return this.json(res, 200, { ok: true });
      }
      if (p === '/api/user/account-deletion-request' && method === 'POST') {
        const subject = requireHumanSubject(callerIdentity);
        const privacyContact = ((await this.deps.paidLaunchSettings?.publicLaunchInfo()) ?? publicLaunchInfo()).contacts.privacy;
        const request = { requestedAt: Date.now(), userId: subject.userId,
          email: (await this.deps.identity?.listUsers())?.find((user) => user.id === subject.userId)?.email ?? session.email };
        (await store.kvSet(`account-deletion:${subject.userId}`, JSON.stringify(request)));
        if (privacyContact && this.deps.email && (await this.deps.email.configured())) {
          await this.deps.email.send({ to: privacyContact, subject: `${(await this.siteName)} account deletion request`,
            text: `A signed-in user requested account deletion.\n\nUser id: ${subject.userId}\nEmail: ${request.email ?? 'not available'}\nRequested at: ${new Date(request.requestedAt).toISOString()}\n\nVerify ownership and organization/resource transfer before deleting data.` })
            .catch((error) => console.error('[privacy] deletion-request notification failed:', error instanceof Error ? error.message : error));
        }
        return this.json(res, 202, { ...request, privacyContact: privacyContact ?? null,
          next: 'We will verify ownership and organization/resource transfer needs before irreversible deletion.' });
      }
      if (p === '/api/user/paid-subscriptions' && method === 'GET') {
        const subject = requireHumanSubject(callerIdentity);
        // Personal billing metadata is cross-organization. A scoped agent must
        // not use its human delegation to enumerate unrelated organizations.
        if (authRecord.organizationId || authRecord.projectId || authRecord.projectIds?.length)
          return this.json(res, 403, { error: 'unscoped personal access is required' });
        if (!this.deps.subscriptions) return this.json(res, 503, { error: 'subscription billing is unavailable' });
        const subscriptions = [];
        for (const subscription of await this.deps.subscriptions.paidSubscriptionsForUser(subject.userId)) {
          const organization = await store.getOrganization(subscription.organizationId);
          if (!organization) continue;
          const membership = await store.organizationMembership(organization.id, subject.userId);
          const paymentAllowed = this.deps.identity && session.userId === subject.userId && this.deps.authorization
            ? allows(await this.deps.authorization.capabilities(`user:${subject.userId}`, undefined, organization.id), 'payment:write')
            : (await this.deps.tokens.check(token, 'payment:write', { organizationId: organization.id })).ok;
          const canManage = membership?.role === 'owner' && paymentAllowed;
          subscriptions.push({ ...subscription, organizationName: organization.name, canManage: Boolean(canManage),
            settingsUrl: membership ? `${await organizationSettingsPath(store, organization.id)}#settings-plan` : null });
        }
        return this.json(res, 200, { subscriptions });
      }
      if (p === '/api/user/default-organization' && (method === 'GET' || method === 'PUT')) {
        const subject = requireHumanSubject(callerIdentity);
        const operator = allows(authRecord.caps, 'authorization:read');
        if (method === 'GET') {
          const organization = (await store.defaultOrganization(subject.userId, operator));
          return this.json(res, 200, { organizationId: organization?.id ?? null });
        }
        const b = await this.body(req);
        try {
          const organization = (await store.setDefaultOrganization(subject.userId, String(b.organizationId ?? ''), operator));
          return this.json(res, 200, { organizationId: organization.id });
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p === '/api/user/onboarding' && (method === 'GET' || method === 'PUT')) {
        const subject = requireHumanSubject(callerIdentity);
        const organizationId = String(url.searchParams.get('organizationId')
          ?? (await store.defaultOrganization(subject.userId, allows(authRecord.caps, 'authorization:read')))?.id ?? '');
        if (!organizationId || !(await store.organizationMembership(organizationId, subject.userId)))
          return this.json(res, 404, { error: 'organization not found' });
        const key = hostedOnboardingKey(subject.userId, organizationId);
        // Recover older accounts and interrupted signup provisioning on every read.
        if (this.deps.hosted) (await this.enableHostedOnboarding(subject.userId, organizationId));
        let record = parseHostedOnboardingRecord((await store.kvGet(key)));
        let finishReplay = false;
        if (method === 'PUT') {
          if (!this.deps.hosted || !record)
            return this.json(res, 404, { error: 'hosted onboarding is unavailable' });
          const b = await this.body(req);
          record = { ...record, display: parseHostedOnboardingDisplay(b.display) };
          finishReplay = b.finishReplay === true;
          (await store.kvSet(key, JSON.stringify(record)));
        }
        const credentials = enumerateCredentials(gatherCredentialSources({
          configHomes: this.deps.configHomes,
          broker: this.deps.broker,
          organizationId,
        })).filter((credential) => !this.deps.hosted
          || credential.kind === 'login' || Boolean(credential.apiKeyHandle));
        const enabledCredentials = resolveCredentials(credentials, {
          global: parsePolicy((await store.kvGet(credPolicyKey.organization(organizationId)))),
        });
        const e2b = (await store.getWorldProviderConnection(organizationId, 'e2b'));
        const daytona = await store.getWorldProviderConnection(organizationId, 'daytona');
        const facts = {
          github: Boolean((await this.deps.identity?.providersForUser(subject.userId))?.includes('github')
            || (await this.deps.githubApp?.status(subject.userId))?.userAuthorized
            || (await store.listGitConnections(organizationId)).some((connection) => !connection.suspendedAt)),
          agentLogin: enabledCredentials.length > 0,
          e2b: [e2b, daytona].some(connection => connection?.enabled
            && this.deps.broker?.hasHandle(connection.credentialHandle)),
          paidPlan: await this.deps.subscriptions?.hasPaidSubscription(organizationId) ?? false,
          vault: (await new VaultItems(store, this.deps.broker, undefined, organizationId).list())
            .some((item) => item.type === 'login' && item.fields.includes('password')),
          card: (await store.listOrganizationCards(organizationId)).length > 0,
          project: (await store.listProjects()).some((project) => project.organizationId === organizationId),
        };
        if (finishReplay && record?.replay && facts.github && facts.agentLogin && facts.e2b && facts.project) {
          record = { display: record.display, completedAt: Date.now() };
          (await store.kvSet(key, JSON.stringify(record)));
        }
        let status = hostedOnboardingStatus({
          hosted: this.deps.hosted === true,
          organizationId,
          record,
          facts,
        });
        // Completion is sticky. Once all required live facts have been observed,
        // removing a provider later is maintenance, not a reason to onboard an
        // established account again.
        if (status.complete && record && !record.completedAt) {
          record = { ...record, completedAt: Date.now() };
          (await store.kvSet(key, JSON.stringify(record)));
          status = hostedOnboardingStatus({ hosted: true, organizationId, record, facts });
        }
        return this.json(res, 200, status);
      }
      if (p === '/api/user/export' && method === 'GET') {
        // Broad task-agent capabilities never imply ownership of a human's
        // personal archive. Require an authority-verified user subject.
        const subject = requireHumanSubject(callerIdentity);
        if (!this.deps.identity)
          return this.json(res, 401, { error: 'a signed-in user account is required' });
        const identityData = (await this.deps.identity.exportUserData(subject.userId));
        const { GitProfiles, userGitScope } = await import('../autonomy/git-profiles.js');
        const gitProfiles = new GitProfiles(store, this.deps.broker, undefined, userGitScope(subject.userId));
        const linked = (await store.exportUserData(subject.userId, String(identityData.profile.email ?? session.email ?? '')));
        const { format, version, exportedAt, security, ...linkedData } = linked;
        const value = {
          format,
          version,
          exportedAt,
          profile: identityData.profile,
          authentication: identityData.authentication,
          git: { defaultProfile: (await gitProfiles.defaultProfile()) ?? null, profiles: (await gitProfiles.list()) },
          security,
          policyAcceptances: (await store.policyAcceptances(subject.userId)),
          ...linkedData,
        };
        const label = String(identityData.profile.email ?? identityData.profile.name ?? 'user')
          .split('@')[0]!.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'user';
        return this.downloadJson(res, `${BRAND}-${label}-export-${new Date().toISOString().slice(0, 10)}.json`, value);
      }
      if (p === '/api/authorization/me' && method === 'GET') {
        const target = url.searchParams.get('path');
        const targetMethod = (url.searchParams.get('method') ?? 'GET').toUpperCase();
        if (target !== null && (!target.startsWith('/api/') || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(targetMethod)))
          return this.json(res, 400, { error: 'path must be a /api/ path and method one of GET, POST, PUT, PATCH, DELETE' });
        const organizationId = authRecord.organizationId ?? requestedScope.organizationId
          ?? (authRecord.projectId ? await store.projectOrganizationAsync(authRecord.projectId) : undefined);
        const summary = await resolveAuthorizationSummary(store, this.deps.authorization, {
          caps: authRecord.caps, level: await this.callerLevel(authRecord, organizationId),
          projectId: authRecord.projectId, projectIds: authRecord.projectIds, organizationId,
        });
        return this.json(res, 200, {
          actor: authRecord.kind === 'agent' ? 'agent' : authRecord.kind,
          ...(summary.level ? { level: summary.level } : {}),
          scope: summary.scope,
          capabilities: summary.held,
          missing: summary.missing,
          ...(target !== null ? { check: await this.routeCheck(req, authRecord, targetMethod, target) } : {}),
        });
      }
      if (p === '/api/settings/access' && method === 'GET') {
        if (!requestedScope.projectId && !requestedScope.organizationId)
          return this.json(res, 400, { error: 'Choose a project or organization.' });
        const allowed = async (capability: string, scope: { projectId?: string; organizationId?: string } = {}) =>
          (await this.deps.tokens.check(token, capability, scope)).ok;
        return this.json(res, 200, {
          organization: requestedScope.organizationId
            ? (await allowed('organization:edit', { organizationId: requestedScope.organizationId })) : false,
          project: requestedScope.projectId
            ? (await allowed('project:edit', { projectId: requestedScope.projectId })) : false,
          projectTransfer: requestedScope.projectId
            ? await allowed('project:transfer-out', { projectId: requestedScope.projectId, organizationId: requestedScope.organizationId }) : false,
          projectDelete: requestedScope.projectId
            ? (await allowed('project:delete', { projectId: requestedScope.projectId })) : false,
        });
      }
      if (p === '/api/settings/installation' && method === 'GET') {
        return this.json(res, 200, { canManage: (await this.deps.tokens.check(token, 'settings:write')).ok,
          hostLocal: this.hostLocal, siteName: (await this.siteName) });
      }
      if (p === '/api/settings/installation' && method === 'PUT') {
        const b = await this.body(req);
        const error = siteNameError(b.siteName);
        if (error) return this.json(res, 400, { error });
        const appearance = (await store.getSettings('global', 'appearance')) ?? {};
        const siteName = String(b.siteName).trim();
        (await store.setSettings('global', 'appearance', { ...appearance, siteName }));
        return this.json(res, 200, { ok: true, siteName });
      }
      if (p === '/api/settings/paid-launch/paddle/provision' && method === 'POST') {
        if (!(await this.deps.tokens.check(token, 'settings:write')).ok)
          return this.json(res, 403, { error: 'installation administrator access is required' });
        if (!this.deps.paidLaunchSettings) return this.json(res, 503, { error: 'paid-launch settings are unavailable' });
        try {
          return this.json(res, 200, await this.deps.paidLaunchSettings.provisionPaddle(this.publicUrl(req), await this.siteName));
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (p === '/api/settings/paid-launch') {
        if (!this.deps.paidLaunchSettings)
          return this.json(res, 503, { error: 'paid-launch settings are unavailable' });
        const publicUrl = this.publicUrl(req);
        if (method === 'GET') return this.json(res, 200, {
          ...(await this.deps.paidLaunchSettings.status(publicUrl)),
          canManage: (await this.deps.tokens.check(token, 'settings:write')).ok,
        });
        if (method === 'PUT') {
          if (!(await this.deps.tokens.check(token, 'settings:write')).ok)
            return this.json(res, 403, { error: `Only a ${(await this.siteName)} installation administrator can configure paid launch` });
          try {
            return this.json(res, 200, { ...(await this.deps.paidLaunchSettings.configure(await this.body(req), publicUrl)),
              canManage: true });
          } catch (error) {
            return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
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
      if (p === '/api/organization-directory' && method === 'GET') {
        const subject = requireHumanSubject(callerIdentity);
        return this.json(res, 200, (await store.organizationDirectory(subject.userId,
          allows(authRecord.caps, 'authorization:read'))));
      }
      if (p === '/api/organizations' && method === 'GET') {
        const canAuditAll = Boolean(authRecord && allows(authRecord.caps, 'authorization:read'));
        if (canAuditAll) return this.json(res, 200, (await store.listOrganizations()));
        if (authRecord.organizationId)
          return this.json(res, 200, [(await store.getOrganization(authRecord.organizationId))].filter(Boolean));
        const scopedOrganizationIds = new Set([
          ...(authRecord.projectId ? [(await store.getProject(authRecord.projectId))?.organizationId] : []),
          ...(await __asyncCollections.map((authRecord.projectIds ?? []), async (projectId) => (await store.getProject(projectId))?.organizationId)),
        ].filter((value): value is string => Boolean(value)));
        if (scopedOrganizationIds.size)
          return this.json(res, 200, (await __asyncCollections.map([...scopedOrganizationIds], async (id) => (await store.getOrganization(id)))).filter(Boolean));
        return this.json(res, 200, (await store.listOrganizations(callerIdentity.humanSubject?.userId)));
      }
      if (p === '/api/organizations' && method === 'POST') {
        const subject = requireHumanSubject(callerIdentity);
        const b = await this.body(req);
        let organization;
        try {
          organization = (await store.createOrganization({ name: String(b.name ?? 'My organization'),
            slug: b.slug ? String(b.slug) : undefined, kind: b.kind === 'personal' ? 'personal' : 'team', ownerUserId: subject.userId,
            ...(this.deps.hosted ? { maxOwned: 10 } : {}) }));
        } catch (error) { return this.badRequest(res, error); }
        (await this.deps.authorization?.bootstrapOrganizationOwner(actorPrincipal(callerIdentity.actor), subject.userId, organization.id));
        (await this.deps.resources?.storageLocationService()?.ensureManaged(organization.id));
        if (this.deps.hosted) (await this.enableHostedOnboarding(subject.userId, organization.id));
        return this.json(res, 200, organization);
      }
      if (p === '/api/invitations/accept' && method === 'POST') {
        const subject = requireHumanSubject(callerIdentity);
        const subjectEmail = (await this.deps.identity?.listUsers())?.find((user) => user.id === subject.userId)?.email;
        if (!subjectEmail) return this.json(res, 400, { error: 'a verified account is required' });
        const b = await this.body(req);
        try {
          const invitationToken = String(b.token ?? '');
          const membership = (await store.acceptOrganizationInvitation(invitationToken, subject.userId, subjectEmail));
          (await this.deps.authorization?.replacePrincipalAuthorization('system:invitation', `user:${subject.userId}`,
            membership.organizationId, membership.authorization ?? legacyAuthorizationSelection(membership.profileId), ['*']));
          void this.deps.subscriptions?.syncSeats(membership.organizationId).catch((error) =>
            console.error('[subscription] seat sync failed:', error instanceof Error ? error.message : String(error)));
          return this.json(res, 200, membership);
        } catch (e) {
          // Expired / already-used / wrong-email are user-facing, not 500s.
          return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      const organizationRoles = p.match(/^\/api\/organizations\/([^/]+)\/roles$/);
      if (organizationRoles && this.deps.authorization) {
        const organizationId = organizationRoles[1]!;
        const actor = actorPrincipal(callerIdentity.actor);
        const caps = authRecord.caps;
        if (method === 'GET') return this.json(res, 200, {
          profiles: (await this.deps.authorization.profiles(undefined, organizationId)),
          capabilityGroups: CAPABILITY_GROUPS,
          creatableCapabilities: CAPABILITY_GROUPS.flatMap((group) => group.capabilities)
            .filter((cap) => allows(ORGANIZATION_GRANT_CEILING, cap.id)
              && allows(caps, cap.id)).map((cap) => cap.id),
          canCreate: allows(caps, 'organization:edit'),
        });
        if (method === 'POST') {
          const body = await this.body(req);
          try { return this.json(res, 201, (await this.deps.authorization.createOrganizationRole(actor, organizationId, body, caps))); }
          catch (error) { return this.json(res, error instanceof AuthorizationGrantError ? 403 : 400, { error: (error as Error).message }); }
        }
      }
      const organizationMatch = p.match(/^\/api\/organizations\/([^/]+)$/);
      if (organizationMatch && method === 'GET') return this.json(res, 200, (await store.getOrganization(organizationMatch[1]!)) ?? null);
      const organizationEntitlementsMatch = p.match(/^\/api\/organizations\/([^/]+)\/entitlements$/);
      if (organizationEntitlementsMatch && method === 'GET') {
        const organizationId = organizationEntitlementsMatch[1]!;
        if (!(await store.getOrganization(organizationId))) return this.json(res, 404, { error: 'organization not found' });
        const entitlements = (await store.organizationEntitlements(organizationId));
        const activeUsers = (await store.listOrganizationMemberships(organizationId)).length;
        let activeAgentRuns = 0;
        let queuedAgentRuns = 0;
        if (entitlements.deployment === 'hosted') {
          try {
            const queue = await this.deps.client.workflow.getHandle(agentQueueId(organizationId))
              .query(QRY_AGENT_QUEUE) as { current: unknown[]; queue: unknown[] };
            activeAgentRuns = queue.current.length;
            queuedAgentRuns = queue.queue.length;
          } catch { /* The organization has not run an agent yet. */ }
        }
        return this.json(res, 200, {
          ...entitlements,
          gift: await this.deps.subscriptions?.currentGift(organizationId) ?? null,
          activeUsers,
          currentMonthlyPriceCents: entitlements.plan
            ? hostedMonthlyPriceCents(entitlements.plan, activeUsers, entitlements.storagePacks)
            : null,
          activeAgentRuns,
          queuedAgentRuns,
        });
      }
      const subscription = p.match(/^\/api\/organizations\/([^/]+)\/subscription\/(status|checkout|portal|change|cancel|sync-seats|storage-packs|reconcile|gift|gift-storage)$/);
      if (subscription) {
        const organizationId = subscription[1]!;
        const action = subscription[2]!;
        if (!(await store.getOrganization(organizationId))) return this.json(res, 404, { error: 'organization not found' });
        const billing = this.deps.subscriptions;
        if (!billing) return this.json(res, 503, { error: 'subscription billing is unavailable' });
        if (action === 'status') {
          if (method !== 'GET') return this.json(res, 405, { error: 'method not allowed' });
          const billingUserId = callerIdentity.humanSubject?.userId;
          const canManage = Boolean(billingUserId
            && (await this.deps.tokens.check(token, 'payment:write', { organizationId })).ok
            && (await store.organizationMembership(organizationId, billingUserId))?.role === 'owner');
          const canGift = (await this.deps.tokens.check(token, 'subscription:gift', { organizationId })).ok;
          return this.json(res, 200, { ...(await billing.current(organizationId)), canManage, canGift });
        }
        if (method !== 'POST') return this.json(res, 405, { error: 'method not allowed' });
        if (action === 'gift-storage') {
          try {
            const body = await this.body(req);
            const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : '';
            const actor = actorPrincipal(callerIdentity.actor);
            const result = await billing.giftStoragePacks(organizationId, body.packs, actor, key);
            await this.deps.authorization?.audit(actor, 'subscription.gift-storage', `organization:${organizationId}`,
              { packs: body.packs, requestKey: key, ...identityAuditDetail(callerIdentity) });
            return this.json(res, 200, result);
          } catch (error) {
            return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (action === 'gift') {
          try {
            const body = await this.body(req);
            const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : '';
            const actor = actorPrincipal(callerIdentity.actor);
            const result = await billing.gift(organizationId, body.plan, actor, key);
            await this.deps.authorization?.audit(actor, 'subscription.gift', `organization:${organizationId}`,
              { plan: body.plan, requestKey: key, ...identityAuditDetail(callerIdentity) });
            return this.json(res, 200, result);
          } catch (error) {
            return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        // Billing requires payment authority and a verified owner subject,
        // including securely delegated agents.
        const billingSubject = requireHumanSubject(callerIdentity);
        if ((await store.organizationMembership(organizationId, billingSubject.userId))?.role !== 'owner')
          return this.json(res, 403, { error: 'organization owner access is required to administer its subscription' });
        const idempotencyKey = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : '';
        const settingsBase = `${this.publicUrl(req)}${(await organizationSettingsPath(store, organizationId))}`;
        const settingsUrl = `${settingsBase}#settings-billing`;
        try {
          if (action === 'checkout') {
            const body = await this.body(req);
            const plan = String(body.plan ?? '');
            if (this.deps.paidLaunchSettings) (await this.deps.paidLaunchSettings.assertReady());
            else assertPaidLaunchReady();
            const versions = assertPolicyAcceptance('checkout', body.acceptedPolicies, body.policyVersions);
            const result = await billing.checkout(organizationId, plan,
              { success: `${settingsBase}?billing=success#settings-billing`,
                cancel: `${settingsBase}?billing=canceled#settings-billing` }, idempotencyKey);
            (await store.recordPolicyAcceptance({
              userId: billingSubject.userId,
              email: (await this.deps.identity?.listUsers())?.find((user) => user.id === billingSubject.userId)?.email ?? session.email,
              organizationId,
              context: 'checkout',
              versions,
              checkoutRequestReference: result.checkoutRequestReference,
              checkoutSessionReference: result.checkoutSessionReference,
              commercialTerms: { ...result.commercialTerms, ...CHECKOUT_DISCLOSURES,
                checkoutProvider: result.checkoutProvider },
            }));
            return this.json(res, 200, result);
          }
          if (action === 'portal') return this.json(res, 200, await billing.portal(organizationId, settingsUrl, idempotencyKey));
          if (action === 'change') {
            const body = await this.body(req);
            return this.json(res, 202, await billing.changePlan(organizationId,
              String(body.plan ?? ''), idempotencyKey));
          }
          if (action === 'cancel') return this.json(res, 202, await billing.cancel(organizationId, idempotencyKey));
          if (action === 'storage-packs')
            return this.json(res, 202, await billing.storagePacks(organizationId, (await this.body(req)).packs, idempotencyKey));
          if (action === 'reconcile') return this.json(res, 200, await billing.reconcilePending(organizationId));
          await billing.syncSeats(organizationId);
          return this.json(res, 202, { syncing: true });
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      // What managed storage holds and the over-quota state (GET), and the
      // clean-up actions; all need organization:edit (routeCapability).
      const storageContents = p.match(/^\/api\/organizations\/([^/]+)\/storage-contents(?:\/(resources|projects)\/([^/]+)\/(older-versions|finished-workspaces))?$/);
      if (storageContents) {
        const organizationId = storageContents[1]!;
        const managed = this.deps.managedStorage;
        if (!(await store.getOrganization(organizationId))) return this.json(res, 404, { error: 'organization not found' });
        if (!managed) return this.json(res, 503, { error: 'managed storage is unavailable' });
        try {
          if (method === 'GET' && !storageContents[2]) return this.json(res, 200, (await managed.contents(organizationId)));
          if (method === 'DELETE' && storageContents[2] === 'resources' && storageContents[4] === 'older-versions') {
            const attachment = (await store.getResourceAttachment(storageContents[3]!));
            if (!attachment || attachment.organizationId !== organizationId) return this.json(res, 404, { error: 'data resource not found' });
            return this.json(res, 200, (await managed.deleteOlderVersions(attachment.id)));
          }
          if (method === 'DELETE' && storageContents[2] === 'projects' && storageContents[4] === 'finished-workspaces')
            return this.json(res, 200, (await managed.deleteFinishedWorkspaces(organizationId, storageContents[3]!)));
          return this.json(res, 405, { error: 'method not allowed' });
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const organizationStorage = p.match(/^\/api\/organizations\/([^/]+)\/storage(?:\/([^/]+))?(?:\/(test|default))?$/);
      if (organizationStorage) {
        const organizationId = organizationStorage[1]!;
        const storage = this.deps.resources?.storageLocationService();
        if (!(await store.getOrganization(organizationId))) return this.json(res, 404, { error: 'organization not found' });
        if (!storage) return this.json(res, 503, { error: 'organization storage is unavailable' });
        try {
          if (method === 'GET' && !organizationStorage[2]) return this.json(res, 200, (await storage.list(organizationId)));
          if (method === 'POST' && !organizationStorage[2]) {
            const b = await this.body(req);
            const location = await storage.connectS3(organizationId, {
              name: String(b.name ?? 'Customer S3'), endpoint: String(b.endpoint ?? ''), bucket: String(b.bucket ?? ''),
              region: b.region == null ? undefined : String(b.region), prefix: b.prefix == null ? undefined : String(b.prefix),
              accessKeyId: b.accessKeyId == null ? undefined : String(b.accessKeyId),
              secretAccessKey: b.secretAccessKey == null ? undefined : String(b.secretAccessKey),
              sessionToken: b.sessionToken == null ? undefined : String(b.sessionToken),
            });
            return this.json(res, 200, (await storage.view(organizationId, location.id)));
          }
          const id = organizationStorage[2]!;
          if (method === 'PUT' && organizationStorage[3] === 'default')
            return this.json(res, 200, (await storage.view(organizationId, (await storage.setDefault(organizationId, id)).id)));
          if (method === 'POST' && organizationStorage[3] === 'test')
            return this.json(res, 200, (await storage.view(organizationId, (await storage.test(organizationId, id)).id)));
          if (method === 'PUT' && !organizationStorage[3]) {
            const b = await this.body(req);
            const location = await storage.connectS3(organizationId, { id,
              name: String(b.name ?? 'Customer S3'), endpoint: String(b.endpoint ?? ''), bucket: String(b.bucket ?? ''),
              region: b.region == null ? undefined : String(b.region), prefix: b.prefix == null ? undefined : String(b.prefix),
              accessKeyId: b.accessKeyId == null ? undefined : String(b.accessKeyId),
              secretAccessKey: b.secretAccessKey == null ? undefined : String(b.secretAccessKey),
              sessionToken: b.sessionToken == null ? undefined : String(b.sessionToken),
            });
            return this.json(res, 200, (await storage.view(organizationId, location.id)));
          }
          if (method === 'DELETE' && !organizationStorage[3]) {
            (await storage.delete(organizationId, id)); return this.json(res, 200, { deleted: true });
          }
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (organizationMatch && method === 'PATCH') {
        const b = await this.body(req);
        if (b.nameVisibility !== undefined && b.nameVisibility !== 'members' && b.nameVisibility !== 'public')
          return this.json(res, 400, { error: 'nameVisibility must be members or public' });
        if (b.name !== undefined && typeof b.name !== 'string')
          return this.json(res, 400, { error: 'organization name must be a string' });
        if (b.name === undefined && b.nameVisibility === undefined)
          return this.json(res, 400, { error: 'organization name or nameVisibility is required' });
        try {
          const id = organizationMatch[1]!;
          if (b.name !== undefined) (await store.renameOrganization(id, b.name));
          if (b.nameVisibility !== undefined) (await store.setOrganizationNameVisibility(id, b.nameVisibility));
          return this.json(res, 200, (await store.getOrganization(id)));
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const organizationExecution = p.match(/^\/api\/organizations\/([^/]+)\/execution-policy$/);
      if (organizationExecution) {
        const organizationId = organizationExecution[1]!;
        if (method === 'GET') return this.json(res, 200, (await store.getOrganizationExecutionPolicy(organizationId)));
        if (method === 'PUT') {
          const b = await this.body(req);
          const policy = b.policy && typeof b.policy === 'object' ? b.policy : {};
          try {
            if (policy.worldProvider && !['worktree', 'container', 'memory'].includes(String(policy.worldProvider))
              && !(await this.deps.providerConnections?.available(organizationId, String(policy.worldProvider))))
              throw new Error(`${policy.worldProvider} is not connected and verified`);
            if (policy.runnerPoolId) {
              const pool = (await store.getRunnerPool(String(policy.runnerPoolId)));
              if (!pool || pool.organizationId !== organizationId) throw new Error('runner pool does not belong to this organization');
              if (policy.worldProvider && pool.provider !== policy.worldProvider) throw new Error('runner pool provider must match the default provider');
            }
            return this.json(res, 200, (await store.setOrganizationExecutionPolicy(organizationId, policy)));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
      }
      const organizationExport = p.match(/^\/api\/organizations\/([^/]+)\/export$/);
      if (organizationExport && method === 'GET') {
        const organizationId = organizationExport[1]!;
        const organization = (await store.getOrganization(organizationId));
        const value = (await store.exportOrganization(organizationId));
        const label = String(organization?.slug || organizationId).toLowerCase()
          .replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'organization';
        return this.downloadJson(res,
          `${BRAND}-${label}-export-${new Date().toISOString().slice(0, 10)}.json`, value);
      }
      if (organizationMatch && method === 'DELETE') {
        const organizationId = organizationMatch[1]!;
        const organization = (await store.getOrganization(organizationId));
        if (!organization) return this.json(res, 404, { error: 'organization not found' });
        if (organization.kind === 'personal' || organization.id === 'org_personal')
          return this.json(res, 400, { error: 'the installation personal organization cannot be deleted' });
        const b = await this.body(req);
        if (String(b.confirmSlug ?? '') !== organization.slug)
          return this.json(res, 400, { error: `type the organization slug (${organization.slug}) to confirm deletion` });
        try { (await this.deps.subscriptions?.assertOrganizationDeletionAllowed(organizationId)); }
        catch (error) {
          return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }

        // External resources go first. These operations are idempotent, so an
        // outage never commits a deceptively successful partial deletion.
        return this.withDeletionFence([], organizationId, async (projectIds) => {
        const resources = (await store.organizationResources(organizationId));
        for (const projectId of projectIds) await this.removeProjectExternalResources(projectId, 'organization deleted');
        for (const connection of (await store.listPaymentConnections(organizationId))) {
          const provider = this.deps.paymentRegistry?.get(connection.provider) as any;
          if (provider && typeof provider.disconnect === 'function') await provider.disconnect(organizationId);
        }
        await this.deps.githubApp?.disconnectOrganization(organizationId);
        for (const connection of (await this.deps.providerConnections?.list(organizationId)) ?? [])
          (await this.deps.providerConnections?.delete(organizationId, connection.provider));
        const storageLocations = this.deps.resources?.storageLocationService();
        for (const location of (await storageLocations?.list(organizationId)) ?? [])
          if (location.kind === 's3') (await storageLocations!.delete(organizationId, location.id));
        await this.deps.resources?.deleteOrganizationKey(organizationId);
        const { GitProfiles } = await import('../autonomy/git-profiles.js');
        const gitProfiles = new GitProfiles(store, this.deps.broker, undefined, organizationId);
        for (const profile of (await gitProfiles.list())) (await gitProfiles.delete(profile.name));
        const { agentAccountHandles } = await import('../platform/credential-sources.js');
        for (const handle of agentAccountHandles(this.deps.broker?.listHandles() ?? [], organizationId))
          (await this.deps.broker?.deleteHandle(handle));
        this.deps.configHomes?.removeOrganization(organizationId);
        await this.deps.workflows?.removeOrganization(organizationId);
        const { deleteOrganizationAutonomy } = await import('../autonomy/cleanup.js');
        await deleteOrganizationAutonomy(store, this.deps.broker, organizationId);
        // Before the metadata, so a failed removal leaves the ids a retry needs.
        await this.deps.api.removeTenantContent({ organizationId, projectIds });
        (await store.deleteOrganization(organizationId));
        for (const attachmentId of resources.attachmentIds)
          if (!(await store.attachmentIsScoped(attachmentId))) this.attachments.delete(attachmentId);
        return this.json(res, 200, { deleted: true, organizationId });
        });
      }
      const identityPolicy = p.match(/^\/api\/organizations\/([^/]+)\/identity-policy$/);
      if (identityPolicy) {
        if (method === 'GET') return this.json(res, 200, (await store.getOrganizationIdentityPolicy(identityPolicy[1]!)));
        if (method === 'PUT') {
          const b = await this.body(req);
          return this.json(res, 200, (await store.setOrganizationIdentityPolicy({ organizationId: identityPolicy[1]!,
            oidcProviderId: b.oidcProviderId ? String(b.oidcProviderId) : undefined,
            verifiedDomains: Array.isArray(b.verifiedDomains) ? b.verifiedDomains.map(String) : [], enforceSso: Boolean(b.enforceSso) })));
        }
      }
      const scimToken = p.match(/^\/api\/organizations\/([^/]+)\/scim-token$/);
      if (scimToken && method === 'POST') return this.json(res, 200, (await store.rotateScimToken(scimToken[1]!)));
      const organizationMembers = p.match(/^\/api\/organizations\/([^/]+)\/members$/);
      if (organizationMembers) {
        const organizationId = organizationMembers[1]!;
        if (method === 'GET') {
          const users = new Map(((await this.deps.identity?.listUsers()) ?? []).map((user) => [user.id, user]));
          return this.json(res, 200, (await __asyncCollections.map((await store.listOrganizationMemberships(organizationId)), async (membership) => {
            const user = users.get(membership.userId);
            const authorization = (await this.deps.authorization?.selectionForPrincipal(`user:${membership.userId}`, organizationId))
              ?? (membership.role === 'owner' ? { level: 'superadmin', scope: 'organization' } : undefined);
            return { ...membership, authorization, profileId: authorization?.level ?? 'viewer',
              protectedOwner: membership.role === 'owner', ...(user ? { user: { id: user.id, name: user.name, email: user.email } } : {}) };
          })));
        }
        if (method === 'POST') {
          const b = await this.body(req);
          const authorization = authorizationSelectionFromBody(b.authorization) ?? legacyAuthorizationSelection(b.profileId);
          (await this.deps.authorization?.assertCanGrantSelection(actorPrincipal(callerIdentity.actor),
            organizationId, authorization, authRecord?.kind === 'human' ? undefined : authRecord?.caps));
          const existing = (await store.organizationMembership(organizationId, String(b.userId)));
          const membership = (await store.setOrganizationMembership(organizationId, String(b.userId), existing?.role === 'owner' ? 'owner' : 'member'));
          (await this.deps.authorization?.replacePrincipalAuthorization(actorPrincipal(callerIdentity.actor),
            `user:${membership.userId}`, organizationId, authorization,
            authRecord?.kind === 'human' ? undefined : authRecord?.caps));
          void this.deps.subscriptions?.syncSeats(organizationId).catch((error) =>
            console.error('[subscription] seat sync failed:', error instanceof Error ? error.message : String(error)));
          return this.json(res, 200, { ...membership, authorization });
        }
      }
      const organizationMember = p.match(/^\/api\/organizations\/([^/]+)\/members\/([^/]+)$/);
      if (organizationMember && method === 'DELETE') {
        (await this.deps.authorization?.assertCanChangePrincipal(actorPrincipal(callerIdentity.actor),
          `user:${organizationMember[2]!}`, organizationMember[1]!, authRecord?.kind === 'human' ? undefined : authRecord?.caps));
        (await store.deprovisionOrganizationUser(organizationMember[1]!, organizationMember[2]!));
        (await this.deps.authorization?.revoke(actorPrincipal(callerIdentity.actor), `user:${organizationMember[2]!}`, `organization:${organizationMember[1]!}`));
        void this.deps.subscriptions?.syncSeats(organizationMember[1]!).catch((error) =>
          console.error('[subscription] seat sync failed:', error instanceof Error ? error.message : String(error)));
        return this.json(res, 200, { ok: true });
      }
      const invitations = p.match(/^\/api\/organizations\/([^/]+)\/invitations$/);
      if (invitations) {
        const organizationId = invitations[1]!;
        if (method === 'GET') return this.json(res, 200, (await store.listOrganizationInvitations(organizationId)));
        if (method === 'POST') {
          const b = await this.body(req);
          const authorization = authorizationSelectionFromBody(b.authorization) ?? legacyAuthorizationSelection(b.profileId);
          (await this.deps.authorization?.assertCanGrantSelection(actorPrincipal(callerIdentity.actor),
            organizationId, authorization, authRecord?.kind === 'human' ? undefined : authRecord?.caps));
          const result = (await store.createOrganizationInvitation({ organizationId, email: String(b.email ?? ''),
            role: 'member', authorization, invitedBy: actorPrincipal(callerIdentity.actor) }));
          // Auto-deliver the invite when outbound email is configured; the copyable
          // link is still returned as a fallback (and for email-less installs).
          let emailed = false;
          if (this.deps.email && (await this.deps.email.configured()) && result.invitation.email) {
            const link = `${this.publicUrl(req)}/invite?token=${encodeURIComponent(result.token)}`;
            const organization = (await store.getOrganization(organizationId));
            const orgName = organization?.name ?? `a ${(await this.siteName)} organization`;
            const { emailHtml } = await import('../auth/identity.js');
            try {
              await this.deps.email.send({
                to: result.invitation.email,
                subject: `You've been invited to ${orgName} on ${(await this.siteName)}`,
                text: `You've been invited to join ${orgName} on ${(await this.siteName)}.\n\nAccept the invitation:\n\n${link}\n\nThis is a one-time link. If you weren't expecting this, you can ignore it.`,
                html: emailHtml(`You've been invited to ${orgName}`,
                  `You've been invited to join ${orgName} on ${(await this.siteName)}. Accept the invitation to get started.`,
                  'Accept invitation', link, `This is a one-time link. If you weren't expecting this, you can ignore it.`,
                  (await this.siteName)),
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
        if (method === 'GET') return this.json(res, 200, (await store.listTeams(organizationId, url.searchParams.get('projectId') ?? undefined)));
        if (method === 'POST') {
          const b = await this.body(req);
          return this.json(res, 200, (await store.createTeam({ organizationId, name: String(b.name ?? ''),
            projectId: b.projectId ? String(b.projectId) : undefined, slug: b.slug ? String(b.slug) : undefined })));
        }
      }
      const organizationTeam = p.match(/^\/api\/organizations\/([^/]+)\/teams\/([^/]+)$/);
      if (organizationTeam) {
        const team = (await store.getTeam(organizationTeam[2]!));
        if (!team || team.organizationId !== organizationTeam[1]) return this.json(res, 404, { error: 'team not found' });
        try {
          if (method === 'PATCH') {
            const b = await this.body(req);
            return this.json(res, 200, (await store.updateTeam(team.id, { name: String(b.name ?? '') })));
          }
          if (method === 'DELETE') {
            (await store.deleteTeam(team.id));
            return this.json(res, 200, { ok: true });
          }
        } catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const teamMembers = p.match(/^\/api\/organizations\/([^/]+)\/teams\/([^/]+)\/members$/);
      if (teamMembers) {
        if ((await store.getTeam(teamMembers[2]!))?.organizationId !== teamMembers[1]) return this.json(res, 404, { error: 'team not found' });
        if (method === 'GET') {
          const users = new Map(((await this.deps.identity?.listUsers()) ?? []).map((user) => [user.id, user]));
          return this.json(res, 200, (await store.listTeamMemberships(teamMembers[2]!)).map((membership) => {
            const user = users.get(membership.userId);
            return { ...membership, ...(user ? { user: { id: user.id, name: user.name, email: user.email } } : {}) };
          }));
        }
        if (method === 'POST') {
          const b = await this.body(req);
          return this.json(res, 200, (await store.setTeamMembership(teamMembers[2]!, String(b.userId))));
        }
      }
      const teamMember = p.match(/^\/api\/organizations\/([^/]+)\/teams\/([^/]+)\/members\/([^/]+)$/);
      if (teamMember && method === 'DELETE') {
        if ((await store.getTeam(teamMember[2]!))?.organizationId !== teamMember[1]) return this.json(res, 404, { error: 'team not found' });
        (await store.removeTeamMembership(teamMember[2]!, teamMember[3]!));
        return this.json(res, 200, { ok: true });
      }
      const gitConnections = p.match(/^\/api\/organizations\/([^/]+)\/git-connections(?:\/([^/]+))?$/);
      if (gitConnections) {
        const organizationId = gitConnections[1]!;
        const connectionId = gitConnections[2] ? decodeURIComponent(gitConnections[2]) : undefined;
        if (method === 'GET' && !connectionId) {
          const connections = (await store.listGitConnections(organizationId));
          if (!this.deps.githubApp) return this.json(res, 200, connections);
          return this.json(res, 200, await Promise.all(connections.map(async (connection) => ({
            ...connection,
            permissionStatus: await this.deps.githubApp!.permissionStatus(connection)
              .catch((error) => ({ ready: false, unavailable: true,
                error: error instanceof Error ? error.message : String(error) })),
          }))));
        }
        if (method === 'DELETE' && connectionId) {
          const connections = (await store.listGitConnections(organizationId));
          if (!connections.some((connection) => connection.id === connectionId))
            return this.json(res, 404, { error: 'GitHub connection not found' });
          if (this.deps.githubApp) (await this.deps.githubApp.disconnectInstallation(connectionId));
          else (await store.deleteGitConnection(connectionId));
          return this.json(res, 200, { ok: true });
        }
      }
      const githubIdentity = p.match(/^\/api\/organizations\/([^/]+)\/github\/identity$/);
      if (githubIdentity) {
        const { GitProfiles } = await import('../autonomy/git-profiles.js');
        const gp = new GitProfiles(store, this.deps.broker, undefined, githubIdentity[1]!);
        if (method === 'GET') return this.json(res, 200, { profile: (await gp.automationIdentity()) ?? null });
        if (method === 'PUT') {
          const b = await this.body(req);
          try {
            return this.json(res, 200, { profile: (await gp.saveAutomationIdentity({
              userName: b.userName ? String(b.userName) : undefined,
              userEmail: b.userEmail ? String(b.userEmail) : undefined,
              signingKey: b.signingKey ? String(b.signingKey) : undefined,
              removeSigningKey: b.removeSigningKey === true,
            })) ?? null });
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
      }
      const githubAppSetup = p.match(/^\/api\/organizations\/([^/]+)\/github\/app$/);
      if (githubAppSetup) {
        if (!this.deps.githubApp) return this.json(res, 503, { error: 'GitHub integration is unavailable' });
        if (method === 'GET') {
          const status = (await this.deps.githubApp.status(callerIdentity.humanSubject?.userId));
          const permissionStatus = status.configured
            ? await this.deps.githubApp.permissionStatus()
              .catch((error) => ({ ready: false, unavailable: true,
                error: error instanceof Error ? error.message : String(error) }))
            : undefined;
          return this.json(res, 200, { ...status, ...(permissionStatus ? { permissionStatus } : {}) });
        }
        if (method === 'PUT') {
          if (!(await this.deps.tokens.check(token, 'settings:write')).ok)
            return this.json(res, 403, { error: `Only a ${(await this.siteName)} installation administrator can configure the shared GitHub App` });
          const b = await this.body(req);
          try {
            return this.json(res, 200, (await this.deps.githubApp.configure({ appId: b.appId, appSlug: String(b.appSlug ?? ''),
              privateKey: String(b.privateKey ?? '').replace(/\\n/g, '\n'), webhookSecret: b.webhookSecret ? String(b.webhookSecret) : undefined,
              clientId: b.clientId ? String(b.clientId) : undefined, clientSecret: b.clientSecret ? String(b.clientSecret) : undefined })));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
      }
      const githubManifest = p.match(/^\/api\/organizations\/([^/]+)\/github\/app-manifest$/);
      if (githubManifest && method === 'POST') {
        const subject = requireHumanSubject(callerIdentity);
        if (!this.deps.githubApp) return this.json(res, 503, { error: 'GitHub integration is unavailable' });
        if (!(await this.deps.tokens.check(token, 'settings:write')).ok)
          return this.json(res, 403, { error: `Only a ${(await this.siteName)} installation administrator can create the shared GitHub App` });
        if (this.deps.githubApp.configured()) return this.json(res, 409, { error: 'a GitHub App is already configured' });
        const b = await this.body(req);
        const state = (await store.createGithubInstallState(githubManifest[1]!, subject.userId,
          { purpose: 'manifest', ...(b.returnTo === 'profile' ? { returnTo: 'profile' as const, selectAccount: true } : {}) }));
        try {
          const publicUrl = (await this.githubPublicUrl(req, b.publicUrl));
          return this.json(res, 200, this.deps.githubApp.manifest(publicUrl, state));
        }
        catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const githubAuthorize = p.match(/^\/api\/organizations\/([^/]+)\/github\/authorize$/);
      if (githubAuthorize && method === 'POST') {
        const subject = requireHumanSubject(callerIdentity);
        if (!this.deps.githubApp) return this.json(res, 503, { error: 'GitHub integration is unavailable' });
        const b = await this.body(req);
        const reconnectAccountId = b.accountId ? String(b.accountId) : undefined;
        let reconnectLogin: string | undefined;
        if (reconnectAccountId) {
          const account = (await this.deps.githubApp.listUserAccounts(subject.userId))
            .find((candidate) => candidate.id === reconnectAccountId);
          if (!account) return this.json(res, 404, { error: 'GitHub account is not connected' });
          reconnectLogin = account.login;
        }
        const state = (await store.createGithubInstallState(githubAuthorize[1]!, subject.userId,
          b.returnTo === 'profile' || b.returnTo === 'installation' ? { returnTo: b.returnTo, githubAccountId: reconnectAccountId,
            githubLogin: reconnectLogin, selectAccount: b.mode === 'add' } : {}));
        try { return this.json(res, 200, { url: this.deps.githubApp.userAuthorizationUrl(state, (await this.githubPublicUrl(req)), {
          login: reconnectLogin, selectAccount: b.mode === 'add',
        }) }); }
        catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const githubInstallUrl = p.match(/^\/api\/organizations\/([^/]+)\/github\/install-url$/);
      if (githubInstallUrl && method === 'POST') {
        const subject = requireHumanSubject(callerIdentity);
        const githubApp = this.deps.githubApp;
        if (!githubApp?.configured()) return this.json(res, 503, { error: 'Set up the GitHub App first' });
        const state = (await store.createGithubInstallState(githubInstallUrl[1]!, subject.userId));
        const status = await githubApp.status(subject.userId);
        const authorize = async () => {
          const oauthState = await store.createGithubInstallState(githubInstallUrl[1]!, subject.userId, { returnTo: 'installation' });
          return this.json(res, 200, { url: githubApp.userAuthorizationUrl(oauthState, await this.githubPublicUrl(req)) });
        };
        if (!status.userAuthorized && status.oauthConfigured) return authorize();
        try {
          const installations = status.userAuthorized ? await githubApp.connectableInstallations(subject.userId) : [];
          return this.json(res, 200, { url: githubApp.installationUrl(state), installations, canAuthorize: status.oauthConfigured });
        } catch (error) {
          // A revoked/expired user token may be removed during discovery. Resume
          // authorization instead of sending an existing installation to GitHub's dead end.
          if (status.oauthConfigured && !(await githubApp.status(subject.userId)).userAuthorized) return authorize();
          throw error;
        }
      }
      const githubConnectExisting = p.match(/^\/api\/organizations\/([^/]+)\/github\/connect-existing$/);
      if (githubConnectExisting && method === 'POST') {
        const subject = requireHumanSubject(callerIdentity);
        if (!this.deps.githubApp?.configured()) return this.json(res, 503, { error: 'Set up the GitHub App first' });
        if (!(await store.organizationMembership(githubConnectExisting[1]!, subject.userId)))
          return this.json(res, 403, { error: 'user is not an organization member' });
        const body = await this.body(req);
        try {
          return this.json(res, 200, await this.deps.githubApp.connectExistingInstallation(
            githubConnectExisting[1]!, subject.userId, String(body.installationId ?? '')));
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const githubRefresh = p.match(/^\/api\/organizations\/([^/]+)\/github\/refresh$/);
      if (githubRefresh && method === 'POST') {
        if (!this.deps.githubApp?.configured()) return this.json(res, 503, { error: 'Set up and install the GitHub App first' });
        try {
          const repositories: import('../domain/types.js').Repository[] = [];
          for (const connection of (await store.listGitConnections(githubRefresh[1]!)))
            repositories.push(...await this.deps.githubApp.reconcile(connection));
          for (const project of (await store.listProjects()).filter((candidate) => candidate.organizationId === githubRefresh[1]))
            await this.ensureProjectWiki(project, callerIdentity.humanSubject?.userId);
          return this.json(res, 200, { repositories, count: repositories.length });
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const organizationRepositories = p.match(/^\/api\/organizations\/([^/]+)\/repositories$/);
      if (organizationRepositories) {
        const organizationId = organizationRepositories[1]!;
        if (method === 'GET') return this.json(res, 200,
          (await __asyncCollections.filter((await store.listRepositories(organizationId)), async (repository) => !(await store.repositoryIsProjectWiki(repository.id)))));
        if (method === 'POST') {
          if (this.deps.hosted) return this.json(res, 400, { error: 'Hosted repositories must be imported through the GitHub App' });
          const b = await this.body(req);
          return this.json(res, 200, (await store.upsertRepository({ organizationId, provider: 'github',
            providerId: b.providerId ? String(b.providerId) : undefined, owner: String(b.owner ?? ''), name: String(b.name ?? ''),
            sshUrl: String(b.sshUrl ?? ''), defaultBranch: String(b.defaultBranch ?? 'main'), private: b.private !== false,
            gitConnectionId: b.gitConnectionId ? String(b.gitConnectionId) : undefined })));
        }
      }
      const createOrganizationRepository = p.match(/^\/api\/organizations\/([^/]+)\/repositories\/create$/);
      if (createOrganizationRepository && method === 'POST') {
        const subject = requireHumanSubject(callerIdentity);
        if (!this.deps.githubApp?.configured()) return this.json(res, 503, { error: 'Set up and install the GitHub App first' });
        const b = await this.body(req);
        const connection = (await store.getGitConnection(String(b.gitConnectionId ?? '')));
        if (!connection || connection.organizationId !== createOrganizationRepository[1])
          return this.json(res, 404, { error: 'GitHub connection not found in this organization' });
        try {
          // Honor an explicit account scope for either actor; otherwise use
          // the represented user's active account, including after onboarding.
          const githubAccountId = subject.externalIdentities?.githubAccountId;
          return this.json(res, 200, await this.deps.githubApp.createRepository(connection.id, subject.userId,
            { name: String(b.name ?? ''), description: b.description ? String(b.description) : undefined,
              private: b.private !== false, autoInit: b.autoInit !== false }, { accountId: githubAccountId }));
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const organizationProjects = p.match(/^\/api\/organizations\/([^/]+)\/projects$/);
      if (organizationProjects) {
        const organizationId = organizationProjects[1]!;
        if (method === 'GET') {
          // Same per-project filter as GET /api/projects: an organization member
          // sees the projects they can read, not every project in the tenant.
          const principal = session.userId && this.deps.authorization && !authRecord?.projectId ? `user:${session.userId}` : undefined;
          return this.json(res, 200, (await __asyncCollections.filter((await store.listProjects()), async (project) => project.organizationId === organizationId
            && (!principal || allows((await this.deps.authorization!.capabilities(principal, project.id)), 'project:read')))));
        }
        if (method === 'POST') {
          const b = await this.body(req);
          let project;
          try {
            project = (await store.createProject(String(b.name ?? 'New project'),
              normalizeConfig(b.config, false, this.deps.hosted === true), organizationId));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
          if (callerIdentity.humanSubject) (await store.setProjectMembership(project.id,
            { kind: 'user', userId: callerIdentity.humanSubject.userId }, 'owner'));
          await this.ensureProjectWiki(project, callerIdentity.humanSubject?.userId);
          await this.spawnProjectPrepTask(token, project.id);
          return this.json(res, 200, project);
        }
      }
      const runnerPools = p.match(/^\/api\/organizations\/([^/]+)\/runner-pools$/);
      if (runnerPools) {
        const organizationId = runnerPools[1]!;
        if (method === 'GET') return this.json(res, 200, (await store.listRunnerPools(organizationId)));
        if (method === 'POST') {
          const b = await this.body(req);
          if (b.mode === 'managed') return this.json(res, 400, {
            error: 'centrally funded remote runner pools require a separate installation authorization boundary; organization BYOK is the supported default',
          });
          const provider = String(b.provider ?? 'e2b');
          const hostedCustomerWorld = this.deps.hosted === true
            && !['worktree', 'container', 'memory'].includes(provider);
          return this.json(res, 200, (await store.createRunnerPool({ organizationId, name: String(b.name ?? 'Runner pool'),
            provider, region: b.region ? String(b.region) : undefined,
            mode: b.mode === 'managed' ? 'managed' : 'customer', enabled: b.enabled !== false,
            capacity: { activeWorlds: hostedCustomerWorld
              ? (await store.getOrganizationUsagePolicy(organizationId)).maxActiveWorlds
              : Math.max(1, Number(b.capacity?.activeWorlds ?? 20)),
              cpu: Math.max(1, Number(b.capacity?.cpu ?? 40)), memoryMb: Math.max(128, Number(b.capacity?.memoryMb ?? 81920)),
              gpu: Math.max(0, Number(b.capacity?.gpu ?? 0)) } })));
        }
      }
      const runnerPool = p.match(/^\/api\/organizations\/([^/]+)\/runner-pools\/([^/]+)$/);
      if (runnerPool) {
        const current = (await store.getRunnerPool(runnerPool[2]!));
        if (!current || current.organizationId !== runnerPool[1]) return this.json(res, 404, { error: 'runner pool not found' });
        if (method === 'PATCH') {
          const b = await this.body(req);
          try {
            const hostedCustomerWorld = this.deps.hosted === true && current.mode === 'customer'
              && !['worktree', 'container', 'memory'].includes(current.provider);
            return this.json(res, 200, (await store.createRunnerPool({ ...current,
              name: b.name == null ? current.name : String(b.name),
              region: b.region === null ? undefined : b.region == null ? current.region : String(b.region),
              enabled: b.enabled == null ? current.enabled : Boolean(b.enabled),
              capacity: b.capacity && typeof b.capacity === 'object' ? {
                activeWorlds: hostedCustomerWorld
                  ? (await store.getOrganizationUsagePolicy(current.organizationId)).maxActiveWorlds
                  : Math.max(1, Number(b.capacity.activeWorlds ?? current.capacity.activeWorlds)),
                cpu: Math.max(1, Number(b.capacity.cpu ?? current.capacity.cpu)),
                memoryMb: Math.max(128, Number(b.capacity.memoryMb ?? current.capacity.memoryMb)),
                gpu: Math.max(0, Number(b.capacity.gpu ?? current.capacity.gpu)),
              } : current.capacity })));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
        if (method === 'DELETE') {
          try { return this.json(res, 200, { deleted: Boolean((await store.deleteRunnerPool(current.id))) }); }
          catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
        }
      }
      const worldProviders = p.match(/^\/api\/organizations\/([^/]+)\/world-providers$/);
      if (worldProviders && method === 'GET') {
        return this.json(res, 200, (await this.deps.providerConnections?.list(worldProviders[1]!)) ?? []);
      }
      const worldProvider = p.match(/^\/api\/organizations\/([^/]+)\/world-providers\/([^/]+)$/);
      if (worldProvider) {
        const organizationId = worldProvider[1]!;
        const provider = worldProvider[2]!;
        if (!this.deps.providerConnections) return this.json(res, 503, { error: 'provider connections are unavailable' });
        if (method === 'PUT') {
          const b = await this.body(req);
          try {
            return this.json(res, 200, (await this.deps.providerConnections.save({ organizationId, provider,
              apiKey: b.apiKey ? String(b.apiKey) : undefined, name: b.name ? String(b.name) : undefined,
              config: b.config && typeof b.config === 'object' ? b.config as any : {}, enabled: b.enabled !== false })));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
        if (method === 'DELETE') {
          const active = (await store.organizationResources(organizationId)).worlds
            .filter((handle) => (handle.provider ?? handle.kind) === provider);
          if (active.length) return this.json(res, 409, { error: `${active.length} task world(s) still use ${provider}; finish or delete them first` });
          return this.json(res, 200, { deleted: Boolean((await this.deps.providerConnections.delete(organizationId, provider))) });
        }
      }
      const testWorldProvider = p.match(/^\/api\/organizations\/([^/]+)\/world-providers\/([^/]+)\/test$/);
      if (testWorldProvider && method === 'POST') {
        if (!this.deps.providerConnections) return this.json(res, 503, { error: 'provider connections are unavailable' });
        try { return this.json(res, 200, await this.deps.providerConnections.test(testWorldProvider[1]!, testWorldProvider[2]!)); }
        catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const insights = p.match(/^\/api\/organizations\/([^/]+)\/insights$/);
      if (insights && method === 'GET') {
        const organizationId = insights[1]!;
        const { organizationInsights } = await import('../platform/insights.js');
        return this.json(res, 200, await organizationInsights(store, organizationId, {
          days: Number(url.searchParams.get('days') ?? 30),
          utcOffsetMinutes: Number(url.searchParams.get('utcOffset') ?? 0),
          includeSpend: (await this.deps.tokens.check(token, 'payment:read', { organizationId })).ok,
        }));
      }
      const usage = p.match(/^\/api\/organizations\/([^/]+)\/usage$/);
      if (usage && method === 'GET') {
        const now = Date.now();
        const date = new Date(now);
        const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
        const from = Number(url.searchParams.get('from') ?? monthStart);
        const to = Number(url.searchParams.get('to') ?? now);
        const sync = (await __asyncCollections.map((await store.listWorldProviderConnections(usage[1]!)), async (connection) => {
          try { return { provider: connection.provider,
            ...JSON.parse((await store.kvGet(`usage-sync:${usage[1]}:${connection.provider}`)) ?? '{"status":"pending"}') }; }
          catch { return { provider: connection.provider, status: 'pending' }; }
        }));
        return this.json(res, 200, { ...(await store.usageSummary(usage[1]!, from, to)), from, to, sync });
      }
      const usagePolicy = p.match(/^\/api\/organizations\/([^/]+)\/usage-policy$/);
      if (usagePolicy) {
        const organizationId = usagePolicy[1]!;
        if (method === 'GET') return this.json(res, 200, (await store.getOrganizationUsagePolicy(organizationId)));
        if (method === 'PUT') {
          const b = await this.body(req);
          const policy = b.policy && typeof b.policy === 'object' ? b.policy : {};
          const currentPolicy = (await store.getOrganizationUsagePolicy(organizationId));
          const normalizedManagedProviders = (value: unknown): string[] | undefined => Array.isArray(value)
            ? [...new Set(value.map((provider) => String(provider).trim()).filter(Boolean))].sort()
            : undefined;
          const requestedManagedProviders = normalizedManagedProviders((policy as any).managedModelProviders);
          const managedProvidersChanged = Object.prototype.hasOwnProperty.call(policy, 'managedModelProviders')
            && (requestedManagedProviders == null || JSON.stringify(requestedManagedProviders)
              !== JSON.stringify(normalizedManagedProviders(currentPolicy.managedModelProviders)));
          const ownerOnlyChange = ([
            ['managedSpendCapMicros', currentPolicy.managedSpendCapMicros ?? null],
            ['maxActiveAgentTurns', currentPolicy.maxActiveAgentTurns ?? null],
          ] as const).some(([key, current]) => Object.prototype.hasOwnProperty.call(policy, key)
            && (policy as any)[key] !== current) || managedProvidersChanged;
          if (ownerOnlyChange) {
            const subject = requireHumanSubject(callerIdentity);
            if ((await store.organizationMembership(organizationId, subject.userId))?.role !== 'owner')
              return this.json(res, 403, { error: 'only an organization owner can change managed funding or agent concurrency guardrails' });
          }
          try { return this.json(res, 200, (await store.setOrganizationUsagePolicy(organizationId, policy))); }
          catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
      }

      if (p === '/api/inbox' && method === 'GET') {
        const subject = requireHumanSubject(callerIdentity);
        if (!requestedScope.organizationId) return this.json(res, 400, { error: 'organizationId is required' });
        const items = (await store.listInbox(subject.userId, requestedScope.organizationId,
          { unreadOnly: url.searchParams.get('unread') === '1', limit: Number(url.searchParams.get('limit') ?? 200) }));
        const headers = await store.taskHeaders(items.map((item) => item.taskId));
        return this.json(res, 200, (await __asyncCollections.map(items, async (item) => {
          const avatar = item.subject?.kind === 'avatar-authorization'
            ? (await store.getAvatar(item.subject.avatarId)) : undefined;
          return { ...item, task: headers.get(item.taskId),
            ...(avatar ? { resource: { kind: 'avatar', id: avatar.id, name: avatar.name, projectId: avatar.projectId } } : {}) };
        })));
      }
      if (p === '/api/inbox' && method === 'PATCH') {
        const subject = requireHumanSubject(callerIdentity);
        if (!requestedScope.organizationId) return this.json(res, 400, { error: 'organizationId is required' });
        const body = await this.body(req);
        if (!Array.isArray(body.ids) || body.ids.length > 500 || body.ids.some((id: unknown) => typeof id !== 'string'))
          return this.json(res, 400, { error: 'Pass up to 500 inbox item IDs' });
        return this.json(res, 200, await store.markInboxMany(subject.userId, requestedScope.organizationId, body.ids));
      }
      const inboxItem = p.match(/^\/api\/inbox\/([^/]+)$/);
      if (inboxItem && method === 'PATCH') {
        const subject = requireHumanSubject(callerIdentity);
        const b = await this.body(req);
        return this.json(res, 200, (await store.markInbox(subject.userId, inboxItem[1]!, b.unread !== false)) ?? null);
      }
      if (p === '/api/inbox/preferences') {
        const subject = requireHumanSubject(callerIdentity);
        if (!requestedScope.organizationId) return this.json(res, 400, { error: 'organizationId is required' });
        if (method === 'GET') return this.json(res, 200, (await store.getDeliveryPreferences(subject.userId, requestedScope.organizationId)));
        if (method === 'PUT') {
          const b = await this.body(req);
          if (b.emailUrgencies !== undefined && (!b.emailUrgencies || typeof b.emailUrgencies !== 'object'
            || Array.isArray(b.emailUrgencies) || Object.entries(b.emailUrgencies).some(([key, value]) =>
              !['low', 'normal', 'high', 'critical'].includes(key) || typeof value !== 'boolean')))
            return this.json(res, 400, { error: 'emailUrgencies must map urgency levels to booleans' });
          const previous = (await store.getDeliveryPreferences(subject.userId, requestedScope.organizationId));
          return this.json(res, 200, (await store.setDeliveryPreferences({ userId: subject.userId, organizationId: requestedScope.organizationId,
            emailUrgencies: b.emailUrgencies ?? previous.emailUrgencies,
            browser: b.browser !== false, email: Boolean(b.email), slack: Boolean(b.slack), routine: b.routine !== false })));
        }
      }

      // Multiple human accounts + karmax authorization. Better Auth owns the
      // account/session records; these routes only attach karmax grants.
      const erasureRoute = p.match(/^\/api\/users\/([^/]+)\/erasure(?:\/(export))?$/);
      if (p === '/api/users/erasure-cases' || erasureRoute) {
        // The inventory spans tenants and potentially sensitive privacy cases.
        // Possessing user:write in a narrowed task is not installation authority.
        if (authRecord.organizationId || authRecord.projectId || authRecord.projectIds?.length)
          return this.json(res, 403, { error: 'Account erasure requires unscoped installation user:write authority.' });
        if (!this.deps.identity) return this.json(res, 503, { error: 'identity service unavailable' });
        const service = new AccountErasureService(store, this.deps.identity, this.deps.broker);
        try {
          if (p === '/api/users/erasure-cases' && method === 'GET') return this.json(res, 200, await service.list());
          if (!erasureRoute) return this.json(res, 405, { error: 'method not allowed' });
          const userId = erasureRoute[1]!;
          if (erasureRoute[2] === 'export' && method === 'GET') {
            const record = await service.get(userId);
            if (!record) return this.json(res, 404, { error: 'case not found' });
            return this.downloadJson(res, `account-erasure-${userId}.json`, { format: 'karmax-erasure-suppression', version: 1, case: record,
              restoreInstructions: 'Store securely outside the backup restore set. Before restoring service, reapply the account closure fence and documented erasure/redaction actions to all restored copies. Review retained records and outstanding decisions. This manifest does not execute a restore or claim external erasure.' });
          }
          if (method === 'GET') return this.json(res, 200, await service.preview(userId));
          if (method !== 'POST' || erasureRoute[2]) return this.json(res, 405, { error: 'method not allowed' });
          const body = await this.body(req), actor = actorPrincipal(callerIdentity.actor);
          if (body.action === 'close') {
            if (userId === callerIdentity.humanSubject?.userId || actor === `user:${userId}`)
              return this.json(res, 400, { error: 'Another operator must close the current account.' });
            return this.json(res, 200, await service.close(userId, body, actor));
          }
          if (body.action === 'decision') return this.json(res, 200, await service.decide(userId, body, actor));
          if (body.action === 'complete') return this.json(res, 200, await service.complete(userId, body.revision, body.confirmation, actor));
          return this.json(res, 400, { error: 'action must be close, decision or complete' });
        } catch (error) {
          if (error instanceof ErasureError) return this.json(res, error.status, { error: error.message });
          throw error;
        }
      }
      if (p === '/api/users' && method === 'GET') {
        return this.json(res, 200, (await __asyncCollections.map(((await this.deps.identity?.listUsers()) ?? []), async (u) => ({ ...u, grants: (await this.deps.authorization?.grants(`user:${u.id}`)) ?? [] }))));
      }
      if (p === '/api/users' && method === 'POST') {
        if (!this.deps.identity) return this.json(res, 400, { error: 'identity service unavailable' });
        const b = await this.body(req);
        if (b.profileId) {
          const profile = (await this.deps.authorization?.profile(String(b.profileId), b.projectId));
          if (!profile) return this.json(res, 400, { error: 'unknown authorization profile' });
          if (!b.projectId && (authRecord.projectId || authRecord.projectIds?.length || authRecord.organizationId))
            return this.json(res, 403, { error: 'this token cannot delegate global access' });
          for (const capability of profile.capabilities) {
            if (!(await this.deps.tokens.check(token, capability, { projectId: b.projectId,
              organizationId: b.projectId ? (await store.getProject(String(b.projectId)))?.organizationId : undefined })).ok)
              return this.json(res, 403, { error: `you cannot delegate ${capability}` });
          }
        }
        const user = await this.deps.identity.createUser({ name: String(b.name ?? ''), email: String(b.email ?? ''), password: String(b.password ?? '') });
        if (b.profileId) (await this.deps.authorization?.grant(actorPrincipal(callerIdentity.actor), { principalId: `user:${user.id}`, scopeKey: b.projectId ? `project:${b.projectId}` : 'global', profileId: String(b.profileId) }));
        return this.json(res, 200, user);
      }
      const resetOnboarding = p.match(/^\/api\/users\/([^/]+)\/onboarding\/reset$/);
      if ((resetOnboarding || p === '/api/user/onboarding/reset') && method === 'POST') {
        if (!this.deps.hosted)
          return this.json(res, 404, { error: 'hosted onboarding is unavailable' });
        // The self-service route takes its target solely from the verified subject.
        // The operator route retains its user:write capability requirement.
        const userId = resetOnboarding?.[1] ?? requireHumanSubject(callerIdentity).userId;
        if (!(await this.deps.identity?.listUsers())?.some((user) => user.id === userId))
          return this.json(res, 404, { error: 'user not found' });
        // Only presentation state changes. Live setup facts and user work remain intact.
        for (const organization of (await store.listOrganizations(userId)))
          (await store.kvSet(hostedOnboardingKey(userId, organization.id), JSON.stringify({ display: 'expanded', replay: true })));
        return this.json(res, 200, { ok: true });
      }
      const userMatch = p.match(/^\/api\/users\/([^/]+)$/);
      if (userMatch && method === 'DELETE') {
        return this.json(res, 409, { error: 'Preview /api/users/:id/erasure, then explicitly confirm account closure. Direct identity deletion bypasses ownership and privacy safeguards.' });
      }
      if (p === '/api/authorization/profiles' && method === 'GET') {
        const projectId = url.searchParams.get('projectId') ?? undefined;
        return this.json(res, 200, {
          profiles: (await this.deps.authorization?.profiles(projectId)) ?? [],
          defaultProfile: (await this.deps.authorization?.defaultProfile(projectId)),
          capabilityGroups: CAPABILITY_GROUPS,
        });
      }
      if (p === '/api/authorization/profiles' && method === 'PUT') {
        const b = await this.body(req);
        const scopeKey = (b.projectId ? `project:${b.projectId}` : 'global') as import('../platform/authorization.js').AuthorizationScope;
        return this.json(res, 200, (await this.deps.authorization?.saveProfile(actorPrincipal(callerIdentity.actor), scopeKey, b.profile)));
      }
      if (p === '/api/authorization/default' && method === 'PUT') {
        const b = await this.body(req);
        (await this.deps.authorization?.setDefault(actorPrincipal(callerIdentity.actor), String(b.profileId), b.projectId ? String(b.projectId) : undefined));
        return this.json(res, 200, { ok: true });
      }
      if (p === '/api/authorization/grants' && method === 'GET') return this.json(res, 200, (await this.deps.authorization?.grants()) ?? []);
      if (p === '/api/authorization/grants' && method === 'PUT') {
        const b = await this.body(req);
        return this.json(res, 200, (await this.deps.authorization?.grant(actorPrincipal(callerIdentity.actor), {
          principalId: String(b.principalId), scopeKey: b.projectId ? `project:${b.projectId}` : 'global',
          profileId: String(b.profileId), ...(Array.isArray(b.capabilities) ? { capabilities: b.capabilities } : {}),
        })));
      }
      if (p === '/api/audit' && method === 'GET') return this.json(res, 200, (await store.auditSince(Number(url.searchParams.get('since') ?? 0), Number(url.searchParams.get('limit') ?? 500))));

      // Host diagnostics + agent-turn admission state (SPEC §12): loadavg,
      // free/total memory, and whether either pressure gate is currently holding
      // new agent leases back. Reporting only — the gate itself lives in
      // src/activities/agent-slots.ts (same process as the worker).
      if (p === '/api/diagnostics' && method === 'GET') {
        const { hostStats, agentSlotStats } = await import('../activities/agent-slots.js');
        const { runtimeAuditTrail } = await import('../util/runtime-lifecycle.js');
        const safety = agentSlotStats();
        const scoped = !!(authRecord.organizationId || authRecord.projectId || authRecord.projectIds?.length
          || requestedScope.organizationId || requestedScope.projectId);
        // The panel needs only counts. `agentQueueView` is bound to `queue:read`
        // (it is a queue surface), so a principal holding `diagnostic:read`
        // alone still gets host stats rather than a blanket 403.
        const queue = await api.agentQueueView(token).catch(async () => ({
          capacity: Number((await store.getSettings('global', 'agent-queue'))?.capacity) || 3,
          queue: [] as unknown[], current: [] as unknown[],
        }));
        return this.json(res, 200, {
          host: hostStats(),
          agentSlots: { ...safety, capacity: queue.capacity, inUse: queue.current.length, waiting: queue.queue.length },
          ...(scoped ? {} : { controlPlane: await store.operationalSnapshot() }),
          runtimeLifecycle: scoped ? [] : await runtimeAuditTrail(store),
          providers: this.deps.worlds.catalog(),
          ts: Date.now(),
        });
      }
      if (p === '/api/metrics' && method === 'GET') {
        const pool = store.asyncReadStats;
        const value = prometheusMetrics((await store.operationalSnapshot())) + (this.operationalMetrics?.prometheus(this.deps.workerStoreMetrics?.()) ?? '')
          + `# TYPE karmax_database_pending gauge\nkarmax_database_pending ${pool.pending}\n`
          + `# TYPE karmax_database_connections gauge\nkarmax_database_connections ${pool.connections}\n`
          + `# TYPE karmax_database_waiting gauge\nkarmax_database_waiting ${pool.waiting}\n`;
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
        const sample = sampleProcesses();
        const scoped = !!(authRecord.organizationId || authRecord.projectId || authRecord.projectIds?.length
          || requestedScope.organizationId || requestedScope.projectId);
        const groups = scoped ? await __asyncCollections.filter(sample.groups, async (group) => {
          if (!group.taskId) return false;
          const projectId = await store.taskProjectIdAsync(group.taskId);
          if (!projectId || (requestedScope.projectId && requestedScope.projectId !== projectId)) return false;
          const organizationId = await store.projectOrganizationAsync(projectId);
          if (requestedScope.organizationId && requestedScope.organizationId !== organizationId) return false;
          return (await this.deps.tokens.check(token, 'process:read', { projectId, organizationId })).ok;
        }) : sample.groups;
        return this.json(res, 200, { ...sample, groups,
          canKill: !scoped && allows(authRecord.caps, 'process:kill'),
          totals: groups.reduce((sum, group) => ({ procs: sum.procs + group.procs.length,
            cpuPct: sum.cpuPct + group.cpuPct, rssMb: sum.rssMb + group.rssMb }), { procs: 0, cpuPct: 0, rssMb: 0 }),
        });
      }
      if (p === '/api/processes/kill' && method === 'POST') {
        const b = await this.body(req);
        const { killTracked } = await import('../util/processes.js');
        const out = await killTracked(Number(b.pid), b.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM',
          (taskId) => api.signalTask(token, taskId, 'cancel'));
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
          if (requestedScope.projectId) (await store.grantAttachment(ref.id, requestedScope.projectId));
          return this.json(res, 200, ref);
        } catch (e) {
          if (e instanceof AttachmentError) return this.json(res, 400, { error: e.message });
          throw e;
        }
      }

      // Ordinary prompt files use the same durable, content-addressed store as
      // images but are not sent to a model API. Agent turns materialize them into
      // `.karmax-injection/attachments/` inside the task world.
      if (p === '/api/files' && method === 'POST') {
        if (!requestedScope.projectId) return this.json(res, 400, { error: 'projectId is required' });
        try {
          const data = await this.rawBody(req, MAX_FILE_BYTES);
          let name = 'attachment';
          try { name = decodeURIComponent(String(req.headers['x-file-name'] || name)); } catch { /* use default */ }
          const ref = this.attachments.putFile(data, name, String(req.headers['content-type'] ?? ''));
          (await store.grantAttachment(ref.id, requestedScope.projectId));
          return this.json(res, 200, ref);
        } catch (error) {
          if (error instanceof AttachmentError)
            return this.json(res, /too large/i.test(error.message) ? 413 : 400, { error: error.message });
          throw error;
        }
      }

      // Uploaded Codex/Claude histories are stored out of workflow params; the
      // task carries only this project-scoped content-addressed reference.
      if (p === '/api/conversation-imports' && method === 'POST') {
        if (!requestedScope.projectId) return this.json(res, 400, { error: 'projectId is required' });
        if (!(await store.getProject(requestedScope.projectId))) return this.json(res, 404, { error: 'project not found' });
        if (!this.deps.objects) return this.json(res, 503, { error: 'conversation import storage is unavailable' });
        try {
          const data = await this.rawBody(req, MAX_CONVERSATION_IMPORT_BYTES);
          let name = 'conversation.jsonl';
          try { name = decodeURIComponent(String(req.headers['x-file-name'] || name)); } catch { /* use default */ }
          const ref = await putConversationImport(this.deps.objects, requestedScope.projectId, data, name);
          return this.json(res, 200, ref);
        } catch (error) {
          if (error instanceof ConversationImportError || error instanceof AttachmentError)
            return this.json(res, 400, { error: error.message });
          throw error;
        }
      }

      // Avatars are durable autonomous principals owned by one user. Their
      // prompt/runtime/authority are edited together so a caller never observes
      // a half-updated identity. Organization defaults and project overrides are separate
      // policy and therefore do not rewrite the Avatar itself.
      const organizationAvatarSettings = p.match(/^\/api\/organizations\/([^/]+)\/avatar-settings$/);
      if (organizationAvatarSettings) {
        const organizationId = organizationAvatarSettings[1]!;
        if (!(await store.getOrganization(organizationId))) return this.json(res, 404, { error: 'organization not found' });
        if (method === 'GET') return this.json(res, 200, {
          enabled: (await store.kvGet(`avatars:organization:${organizationId}`)) === 'enabled',
        });
        if (method === 'PUT') {
          const b = await this.body(req);
          if (typeof b.enabled !== 'boolean') return this.json(res, 400, { error: 'enabled must be a boolean' });
          (await store.kvSet(`avatars:organization:${organizationId}`, b.enabled === false ? 'disabled' : 'enabled'));
          (await store.appendAudit({ principalId: actorPrincipal(callerIdentity.actor), action: 'avatar.organization-policy.changed',
            scopeKey: `organization:${organizationId}`, detail: { enabled: b.enabled !== false } }));
          return this.json(res, 200, { enabled: b.enabled !== false });
        }
      }
      const projectAvatarSettings = p.match(/^\/api\/projects\/([^/]+)\/avatar-settings$/);
      if (projectAvatarSettings) {
        const projectId = projectAvatarSettings[1]!;
        if (!(await store.getProject(projectId))) return this.json(res, 404, { error: 'project not found' });
        if (method === 'GET') return this.json(res, 200, (await store.avatarAvailability(projectId)));
        if (method === 'PUT') {
          const b = await this.body(req);
          const value = String(b.value ?? 'inherit');
          if (!['inherit', 'enabled', 'disabled'].includes(value))
            return this.json(res, 400, { error: 'value must be inherit | enabled | disabled' });
          if (value === 'inherit') (await store.kvSet(`avatars:project:${projectId}`, 'inherit'));
          else (await store.kvSet(`avatars:project:${projectId}`, value));
          (await store.appendAudit({ principalId: actorPrincipal(callerIdentity.actor), action: 'avatar.project-policy.changed',
            scopeKey: `project:${projectId}`, detail: { value } }));
          return this.json(res, 200, (await store.avatarAvailability(projectId)));
        }
      }
      const avatarsMatch = p.match(/^\/api\/projects\/([^/]+)\/avatars(?:\/([^/]+))?$/);
      if (avatarsMatch) {
        const projectId = avatarsMatch[1]!;
        const avatarId = avatarsMatch[2];
        const project = (await store.getProject(projectId));
        if (!project) return this.json(res, 404, { error: 'project not found' });
        const organizationId = project.organizationId ?? 'org_personal';
        const availability = (await store.avatarAvailability(projectId));
        const subjectId = callerIdentity.humanSubject?.userId;
        const canAdmin = (await this.deps.tokens.check(token, 'project:edit', { projectId, organizationId })).ok;
        const view = async (avatar: Avatar) => ({
          ...avatar,
          effectiveEnabled: (await avatarEnabled(store, avatar)),
          callable: Boolean(subjectId && (await avatarCallableBy(store, avatar, subjectId))),
          canEdit: avatar.ownerUserId === subjectId,
          canDisable: avatar.ownerUserId === subjectId || canAdmin,
        });
        if (method === 'GET') {
          if (avatarId) {
            const avatar = (await store.getAvatar(avatarId));
            return avatar?.projectId === projectId
              ? this.json(res, 200, (await view(avatar)))
              : this.json(res, 404, { error: 'avatar not found' });
          }
          return this.json(res, 200, { availability, avatars: (await Promise.all((await store.listAvatars(projectId)).map(view))) });
        }

        const subject = requireHumanSubject(callerIdentity);
        const existing = avatarId ? (await store.getAvatar(avatarId)) : undefined;
        if (avatarId && !existing) return this.json(res, 404, { error: 'avatar not found' });
        if (existing && existing.projectId !== projectId) return this.json(res, 404, { error: 'avatar not found' });
        if (method === 'DELETE') {
          if (existing!.ownerUserId !== subject.userId && !canAdmin)
            return this.json(res, 403, { error: 'only the owner or a project administrator can remove this Avatar' });
          const removed = (await store.deleteAvatar(existing!.id))!;
          (await store.appendAudit({ principalId: `user:${subject.userId}`, action: 'avatar.removed',
            scopeKey: `project:${projectId}`, detail: { avatarId: removed.id, ownerUserId: removed.ownerUserId } }));
          return this.json(res, 200, { removed: true, id: removed.id });
        }
        if (method !== 'POST' && method !== 'PUT') return this.json(res, 405, { error: 'method not allowed' });
        const b = await this.body(req);
        if (existing && existing.ownerUserId !== subject.userId) {
          // Administrators get a kill switch, never the ability to rewrite the
          // owner's trusted prompt or delegation package.
          if (!canAdmin || Object.keys(b).some((key) => key !== 'enabled'))
            return this.json(res, 403, { error: 'only the Avatar owner can edit it; administrators may only enable or disable it' });
          const updated = (await store.upsertAvatar({ ...existing, enabled: b.enabled !== false, updatedAt: Date.now() }));
          (await store.appendAudit({ principalId: `user:${subject.userId}`, action: 'avatar.enabled.changed',
            scopeKey: `project:${projectId}`, detail: { avatarId: updated.id, enabled: updated.enabled } }));
          return this.json(res, 200, (await view(updated)));
        }
        if (!existing && !availability.effective)
          return this.json(res, 409, { error: 'Avatars are disabled for this project' });

        try {
          const name = String(b.name ?? existing?.name ?? '').trim();
          const purpose = String(b.purpose ?? existing?.purpose ?? '').trim();
          const prompt = String(b.prompt ?? existing?.prompt ?? '').trim();
          if (!name) throw new Error('name is required');
          if ([...name].length > 80) throw new Error('name must be at most 80 characters');
          if ([...purpose].length > 240) throw new Error('purpose must be at most 240 characters');
          if (!prompt) throw new Error('instructions are required');
          if ([...prompt].length > 100_000) throw new Error('instructions must be at most 100,000 characters');
          if ((await store.listAvatars(projectId)).some((candidate) => candidate.id !== existing?.id
            && candidate.name.toLowerCase() === name.toLowerCase())) throw new Error(`an Avatar named "${name}" already exists`);

          const runtimeInput = b.runtime && typeof b.runtime === 'object' ? b.runtime : existing?.runtime;
          const fallback = (await roleDefaultProfile(store, 'do', projectId));
          const provider = String(runtimeInput?.provider ?? fallback?.provider ?? this.deps.agentInfo.provider) as Provider;
          if (!isAgentProvider(provider)) throw new Error(`unknown agent provider "${provider}"`);
          const runtime: Avatar['runtime'] = {
            provider,
            ...(runtimeInput?.model ? { model: String(runtimeInput.model) } : fallback?.model ? { model: fallback.model } : {}),
            ...(runtimeInput?.effort ? { effort: String(runtimeInput.effort) as Avatar['runtime']['effort'] }
              : fallback?.effort ? { effort: fallback.effort } : {}),
          };
          if (runtime.effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(runtime.effort))
            throw new Error('invalid reasoning effort');

          const callableInput: string[] = (Array.isArray(b.callableBy)
            ? b.callableBy.map((value: unknown) => String(value))
            : existing?.callableBy ?? [`user:${subject.userId}`]);
          const callableBy = [...new Set(callableInput.map((value: string) => value.trim()).filter(Boolean))];
          if (!callableBy.length) callableBy.push(`user:${subject.userId}`);
          for (const selector of callableBy) {
            if (selector === '@project') continue;
            if (selector.startsWith('user:')) {
              if (!(await store.organizationMembership(organizationId, selector.slice(5)))) throw new Error(`unknown organization user ${selector}`);
              continue;
            }
            const team = selector.startsWith('@team:')
              ? (await store.listTeams(organizationId, projectId)).find((candidate) => candidate.slug === selector.slice(6))
              : selector.startsWith('team:') ? (await store.getTeam(selector.slice(5))) : undefined;
            if (!team || team.organizationId !== organizationId) throw new Error(`unknown Avatar caller ${selector}`);
          }
          const roleInput: string[] = Array.isArray(b.roles)
            ? b.roles.map((value: unknown) => String(value)) : existing?.roles ?? [];
          const roles = [...new Set(roleInput.filter(Boolean))];
          const { allRoles } = await import('../contrib/manifests.js');
          const knownRoles = new Set([...allRoles().map((role) => role.name), 'authorize', 'respond']);
          if (roles.some((role) => !knownRoles.has(role))) throw new Error(`unknown Avatar role ${roles.find((role) => !knownRoles.has(role))}`);

          const ownerPrincipal = `user:${subject.userId}`;
          const ownerCaps = (await this.deps.authorization?.capabilities(ownerPrincipal, projectId, organizationId))
            ?? authRecord?.caps ?? [];
          const authorityMode: Avatar['authorityMode'] = b.authorityMode === 'restricted' ? 'restricted'
            : b.authorityMode === 'full' ? 'full' : existing?.authorityMode ?? 'full';
          let authorization: Avatar['authorization'];
          if (authorityMode === 'full') {
            authorization = { level: 'full', profileId: 'full', scope: 'projects', projectIds: [projectId],
              organizationId, capabilities: [...ownerCaps], principal: ownerPrincipal };
          } else {
            const selection = authorizationSelectionFromBody(b.authorization)
              ?? (existing?.authorityMode === 'restricted' ? existing.authorization : { level: 'developer', scope: 'projects', projectIds: [projectId] });
            const keepsApprovedSelection = existing?.authorityMode === 'restricted'
              && existing.authorization.principal && existing.authorization.principal !== ownerPrincipal
              && selection.level === existing.authorization.level
              && selection.scope === existing.authorization.scope
              && JSON.stringify(selection.projectIds ?? []) === JSON.stringify(existing.authorization.projectIds ?? []);
            if (keepsApprovedSelection) authorization = { ...existing.authorization };
            else {
              const effective = (await this.deps.authorization?.taskGrant(ownerPrincipal, projectId, selection, ownerCaps))
                ?? { ...selection, profileId: selection.level, capabilities: ownerCaps, attenuated: false };
              if (effective.attenuated && b.limitAuthorization !== true)
                throw await api.authorizationGap(token, projectId, selection, { kind: 'avatar', ...(existing ? { avatarId: existing.id } : {}) });
              authorization = { ...effective, principal: ownerPrincipal };
            }
          }
          const retainedCredentialIds = existing?.authorization.capabilities
            .filter((capability) => capability.startsWith('use-credential:item:'))
            .map((capability) => capability.slice('use-credential:item:'.length)) ?? [];
          const credentialInput: string[] = Array.isArray(b.credentialIds)
            ? b.credentialIds.map((value: unknown) => String(value)) : retainedCredentialIds;
          const credentialIds = [...new Set(credentialInput.filter(Boolean))];
          if (credentialIds.length) {
            const vault = new VaultItems(store, this.deps.broker, undefined, organizationId);
            for (const id of credentialIds) {
              if (!(await vault.get(id))) throw new Error(`unknown vault credential ${id}`);
              const capability = `use-credential:item:${id}`;
              if (!allows(ownerCaps, capability)) throw new Error(`you cannot delegate vault credential ${id}`);
              authorization.capabilities.push(capability);
            }
          }
          authorization.capabilities = [...new Set(authorization.capabilities)];
          // No caller may delegate beyond its grant, including when editing an
          // Avatar previously authorized by someone else.
          if (authorization.scope === 'organization'
            && (authRecord.organizationId && authRecord.organizationId !== organizationId || authRecord.projectId || authRecord.projectIds?.length)
            || authorization.scope === 'global'
            && (authRecord.organizationId || authRecord.projectId || authRecord.projectIds?.length))
            throw new AuthorizationGrantError('this token cannot delegate the selected scope');
          for (const selectedProject of authorization.projectIds?.length ? authorization.projectIds : [projectId]) {
            for (const capability of authorization.capabilities) {
              if (!(await this.deps.tokens.check(token, capability, { projectId: selectedProject, organizationId })).ok)
                throw new AuthorizationGrantError(`you cannot delegate ${capability} in project ${selectedProject}`);
            }
          }

          const githubAccountId = b.githubAccountId === null ? undefined
            : b.githubAccountId ? String(b.githubAccountId) : existing?.githubAccountId;
          if (githubAccountId && authRecord.externalIdentities?.githubAccountId
            && githubAccountId !== authRecord.externalIdentities.githubAccountId)
            throw new AuthorizationGrantError('the selected GitHub account is outside this caller’s account scope');
          if (githubAccountId && (await this.deps.githubApp?.activeUserAccountId(subject.userId)) !== githubAccountId)
            throw new Error('the selected GitHub account is not your active connected account');

          const now = Date.now();
          const avatar: Avatar = {
            id: existing?.id ?? newId('avatar'), organizationId, projectId,
            ownerUserId: subject.userId, name, ...(purpose ? { purpose } : {}), prompt,
            promptVersion: existing ? existing.promptVersion + (prompt === existing.prompt ? 0 : 1) : 1,
            enabled: b.enabled === undefined ? existing?.enabled ?? true : b.enabled !== false,
            authorityMode, authorization,
            ...(b.credentialPolicies && typeof b.credentialPolicies === 'object'
              ? { credentialPolicies: b.credentialPolicies } : existing?.credentialPolicies ? { credentialPolicies: existing.credentialPolicies } : {}),
            ...(githubAccountId ? { githubAccountId } : {}), callableBy, roles, runtime,
            createdAt: existing?.createdAt ?? now, updatedAt: now,
          };
          (await store.upsertAvatar(avatar));
          (await store.appendAudit({ principalId: ownerPrincipal, action: existing ? 'avatar.updated' : 'avatar.created',
            scopeKey: `project:${projectId}`, detail: { avatarId: avatar.id, promptVersion: avatar.promptVersion,
              authorityMode, roles, callableBy, capabilities: authorization.capabilities } }));
          return this.json(res, existing ? 200 : 201, (await view(avatar)));
        } catch (error) {
          return this.json(res, Number((error as any)?.status ?? 400), {
            error: error instanceof Error ? error.message : String(error),
            ...((error as any)?.code ? { code: (error as any).code } : {}),
            ...(error instanceof AuthorizationGrantError ? error.gap : {}),
          });
        }
      }

      // projects
      if (p === '/api/projects' && method === 'GET') {
        const projects = (await store.listProjects());
        if (authRecord?.projectId) return this.json(res, 200, projects.filter((x) => x.id === authRecord!.projectId));
        if (authRecord?.projectIds?.length) return this.json(res, 200,
          projects.filter((x) => authRecord!.projectIds!.includes(x.id)));
        // An organization-scoped token discovers its own tenant's projects only.
        if (authRecord?.organizationId) return this.json(res, 200,
          projects.filter((x) => (x.organizationId ?? 'org_personal') === authRecord!.organizationId));
        if (session.userId && this.deps.authorization) {
          const principal = `user:${session.userId}`;
          return this.json(res, 200, (await __asyncCollections.filter(projects, async (x) => allows((await this.deps.authorization!.capabilities(principal, x.id)), 'project:read'))));
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
          project = (await store.createProject(b.name ?? 'New project',
            normalizeConfig(b.config, true, false)));
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        // The legacy unhosted collection route creates inside the personal
        // organization. Keep its creator discoverable through the same durable
        // membership authorization used by the production project listing.
        if (callerIdentity.humanSubject)
          (await store.setProjectMembership(project.id,
            { kind: 'user', userId: callerIdentity.humanSubject.userId }, 'owner'));
        await this.ensureProjectWiki(project, callerIdentity.humanSubject?.userId);
        await this.spawnProjectPrepTask(token, project.id);
        return this.json(res, 200, project);
      }
      const projectTransfer = p.match(/^\/api\/projects\/([^/]+)\/transfer$/);
      if (projectTransfer) {
        if (!['GET', 'POST'].includes(method)) return this.json(res, 405, { error: 'Method not allowed.' });
        const projectId = projectTransfer[1]!;
        const project = await store.getProject(projectId);
        if (!project) return this.json(res, 404, { error: 'Project not found.' });
        const body = method === 'POST' ? await this.body(req) : {};
        const destination = method === 'POST' ? body.destinationOrganizationId : url.searchParams.get('destinationOrganizationId');
        if (destination != null && (typeof destination !== 'string' || !destination || destination.length > 200))
          return this.json(res, 400, { error: 'Choose a destination organization.' });
        if (method === 'POST' && (typeof body.previewId !== 'string' || !destination))
          return this.json(res, 400, { error: 'Preview the move before confirming it.' });
        // Cookie sessions may independently authorize both orgs. Bearers always
        // retain their exact minted scope; never reload a delegated human's grants.
        const orgSessions = new Map<string, Session>();
        const candidates = destination ? [destination, project.organizationId!] : (await store.listOrganizations()).map(o => o.id);
        if (method === 'POST') {
          const saved = await store.kvGet(`project-transfer:${body.previewId}`);
          if (saved) candidates.push(JSON.parse(saved).sourceOrganizationId);
        }
        for (const org of new Set(candidates)) {
          const orgSession = await this.auth(req, undefined, org);
          if (orgSession) orgSessions.set(org, orgSession);
        }
        const authorize = async (cap: string, org: string) => {
          const scoped = orgSessions.get(org);
          const checked = scoped && await this.deps.tokens.check(scoped.apiToken, cap, { organizationId: org });
          if (!checked?.ok || checked.record?.projectId || checked.record?.projectIds?.length)
            throw new CapabilityError(`Missing organization permission ${cap}.`);
          if (scoped?.userId && this.deps.identity && this.deps.authorization
            && !allows(await this.deps.authorization.capabilities(`user:${scoped.userId}`, undefined, org), cap))
            throw new CapabilityError(`Missing organization permission ${cap}.`);
        };
        if (!destination) {
          await authorize('project:transfer-out', project.organizationId!);
          return this.json(res, 200, { organizations: (await __asyncCollections.filter(await store.listOrganizations(), async o => {
            if (o.id === project.organizationId) return false;
            try { await authorize('project:transfer-in', o.id); return true; } catch { return false; }
          })).map(o => ({ id: o.id, name: o.name })) });
        }
        const transfers = new ProjectTransfers(store, {
          principal: actorPrincipal(callerIdentity.actor), authorize,
          workflowClosed: async taskId => {
            try {
              const description = await withTimeout(this.deps.client.workflow.getHandle(taskId).describe(), 5_000);
              return ['COMPLETED', 'FAILED', 'CANCELED', 'TERMINATED', 'TIMED_OUT'].includes(description.status.name);
            } catch (error) {
              if (isWorkflowGone(error)) return true;
              throw new ProjectTransferError('Could not verify task workflows. Retry when the workflow service is available.', 503);
            }
          },
        });
        return this.json(res, 200, method === 'GET' ? await transfers.preview(projectId, destination)
          : await transfers.move(projectId, destination, body.previewId));
      }
      const projMatch = p.match(/^\/api\/projects\/([^/]+)$/);
      if (projMatch) {
        const id = projMatch[1]!;
        if (method === 'GET') return this.json(res, 200, (await store.getProject(id)) ?? null);
        if (method === 'PATCH') {
          const b = await this.body(req);
          try {
            // A project name may be a full sidebar path ("Work/Clients/Site").
            // The store atomically derives folder=Work/Clients and name=Site.
            // Folder-only PATCH remains for API clients that mirror drag moves.
            if (Object.prototype.hasOwnProperty.call(b, 'name') || Object.prototype.hasOwnProperty.call(b, 'folder')) {
              if (Object.prototype.hasOwnProperty.call(b, 'config'))
                throw new Error('update the project name and configuration separately');
              if (Object.prototype.hasOwnProperty.call(b, 'name')) {
                if (typeof b.name !== 'string') throw new Error('project name is required');
                if (Object.prototype.hasOwnProperty.call(b, 'folder'))
                  throw new Error('include the folder in the project name, for example "Work/Project"');
                return this.json(res, 200, (await store.renameProject(id, b.name)));
              }
              return this.json(res, 200, (await store.setProjectFolder(id, String(b.folder ?? ''))));
            }
            const config = normalizeConfig(b.config, false, this.deps.hosted === true);
            const project = (await store.getProject(id));
            if (config.worldProvider && !['worktree', 'container', 'memory'].includes(config.worldProvider) && project?.organizationId &&
                !(await this.deps.providerConnections?.available(project.organizationId, config.worldProvider))) {
              throw new Error(`${config.worldProvider} is not connected. Connect and verify it in Organization settings first.`);
            }
            if (config.runnerPoolId) {
              const pool = (await store.getRunnerPool(config.runnerPoolId));
              if (!pool || pool.organizationId !== project?.organizationId) throw new Error('runner pool does not belong to this project organization');
              if (config.worldProvider && pool.provider !== config.worldProvider) throw new Error('runner pool provider must match the execution provider');
            }
            return this.json(res, 200, (await store.updateProjectConfig(id, config)));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
        if (method === 'DELETE') {
          if (!(await store.getProject(id))) return this.json(res, 404, { error: 'project not found' });
          return this.withDeletionFence([id], undefined, async () => {
            await this.requestGuards.get(req)?.();
            const resources = await this.removeProjectExternalResources(id, 'project deleted');
            await this.deps.api.removeTenantContent({ projectIds: [id] });
            await store.deleteProject(id);
            for (const attachmentId of resources.attachmentIds)
              if (!(await store.attachmentIsScoped(attachmentId))) this.attachments.delete(attachmentId);
            return this.json(res, 200, { deleted: true, projectId: id });
          });
        }
      }
      // Folder headers are projections of project.folder, not separate records.
      // Renaming one therefore rewrites every project in that subtree atomically.
      // The route is anchored to one member project for tenant scoping, then the
      // explicit loop prevents that one grant from conferring write access to
      // sibling projects the caller can only read.
      const projectFolder = p.match(/^\/api\/projects\/([^/]+)\/folder$/);
      if (projectFolder && method === 'PATCH') {
        const b = await this.body(req);
        try {
          const projects = (await store.projectFolderProjects(projectFolder[1]!, b.folder));
          // Browser tokens are minted for the request's anchor project. Resolve
          // the signed-in user's grants independently for each sibling instead
          // of treating that token's scope as the user's full authority. Bearers
          // (including delegated agents) must remain within their minted scope.
          const forbidden = (await __asyncCollections.find(projects, async (project) => {
            if (session.userId && this.deps.authorization)
              return !allows((await this.deps.authorization.capabilities(`user:${session.userId}`, project.id, project.organizationId)), 'project:edit');
            return !(await this.deps.tokens.check(token, 'project:edit', {
              projectId: project.id,
              organizationId: project.organizationId,
            })).ok;
          }));
          if (forbidden)
            return this.json(res, 403, { error: 'Renaming this folder requires edit access to every project it contains.' });
          return this.json(res, 200, (await store.renameProjectFolder(projectFolder[1]!, b.folder, b.name)));
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      // Sidebar order. The drop tells us which project the dragged one now sits
      // above (`before`); omitting it means "last". Sending the neighbour rather
      // than an absolute index keeps a drag correct against a list that changed
      // under the user, and the store re-densifies the organization's positions.
      // A drop may also land in a folder: `folder` carries the destination path
      // ('' = top level) so the one gesture persists as one request.
      const projReorder = p.match(/^\/api\/projects\/([^/]+)\/reorder$/);
      if (projReorder && method === 'POST') {
        const b = await this.body(req);
        try {
          return this.json(res, 200, (await store.reorderProject(projReorder[1]!, b.before ?? undefined,
            typeof b.folder === 'string' ? b.folder : undefined)));
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const projectExecution = p.match(/^\/api\/projects\/([^/]+)\/execution-policy$/);
      if (projectExecution) {
        const project = (await store.getProject(projectExecution[1]!));
        if (!project) return this.json(res, 404, { error: 'no project' });
        if (method === 'GET') return this.json(res, 200, {
          override: pickExecutionConfig(project.config),
          organization: (await store.getOrganizationExecutionPolicy(project.organizationId!)),
          effective: pickExecutionConfig((await store.effectiveProjectConfig(project))),
        });
        if (method === 'PUT') {
          const b = await this.body(req);
          const override = b.override && typeof b.override === 'object' ? b.override : {};
          try {
            const candidate = { ...project, config: applyExecutionOverride(project.config, override) };
            const effective = (await store.effectiveProjectConfig(candidate));
            if (effective.worldProvider && !['worktree', 'container', 'memory'].includes(effective.worldProvider)
              && !(await this.deps.providerConnections?.available(project.organizationId!, effective.worldProvider)))
              throw new Error(`${effective.worldProvider} is not connected and verified in Organization settings`);
            if (effective.runnerPoolId) {
              const pool = (await store.getRunnerPool(effective.runnerPoolId));
              if (!pool || pool.organizationId !== project.organizationId) throw new Error('runner pool does not belong to this organization');
              if (pool.provider !== effective.worldProvider) throw new Error('runner pool provider must match the execution provider');
            }
            const saved = (await store.setProjectExecutionPolicy(project.id, override));
            return this.json(res, 200, { override: pickExecutionConfig(saved.config), organization: (await store.getOrganizationExecutionPolicy(project.organizationId!)), effective: pickExecutionConfig(effective) });
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
      }
      // Product-facing secret view over typed resource attachments. Values are
      // write-only; .env example files provide lazy suggestions.
      const projectSecrets = p.match(/^\/api\/projects\/([^/]+)\/secrets(?:\/([^/]+))?$/);
      if (projectSecrets && ['GET', 'POST', 'DELETE'].includes(method)) {
        const project = (await store.getProject(projectSecrets[1]!));
        if (!project?.organizationId) return this.json(res, 404, { error: 'project not found' });
        if (!this.deps.broker || !this.deps.resources)
          return this.json(res, 503, { error: 'project resources are unavailable' });
        const resources = (await store.listResourceAttachments(project.id, true))
          .filter((resource) => resource.driver === 'secret@1' && !stagedResourceCandidate(resource));
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
                // A new value becomes the resource's own secret; a stored
                // handle may name someone else's (AU-40).
                const handle = entry.value ? resourceSecretHandle(existing.id)
                  : existing.credentialHandles[0] ?? resourceSecretHandle(existing.id);
                if (entry.value) (await this.deps.broker.registerHandle(handle, entry.value, organizationScope(project.organizationId)));
                saved.push((await store.updateResourceAttachment(existing.id, {
                  target: entry.file ? { kind: 'path', path: entry.file } : { kind: 'environment', name: entry.name },
                  credentialHandles: [handle], enabled: true,
                  ...(entry.value ? { source: withoutVaultProjection(existing.source) } : {}),
                })));
              } else {
                if (!entry.value) continue;
                const id = newId('resource'), handle = `resource:${id}:credential`;
                (await this.deps.broker.registerHandle(handle, entry.value, organizationScope(project.organizationId)));
                saved.push((await store.createResourceAttachment({ id, organizationId: project.organizationId,
                  projectId: project.id, name: entry.name, driver: 'secret@1',
                  target: entry.file ? { kind: 'path', path: entry.file } : { kind: 'environment', name: entry.name },
                  access: 'read', isolation: 'fork', source: { discovered: typeof body.env === 'string' },
                  credentialHandles: [handle], publish: 'discard' })));
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
      const projectEnvironment = p.match(/^\/api\/projects\/([^/]+)\/environment(?:\/(proposal|build(?:\/recover)?))?$/);
      if (projectEnvironment && ['GET', 'PUT', 'POST'].includes(method)) {
        const project = (await store.getProject(projectEnvironment[1]!));
        if (!project?.organizationId) return this.json(res, 404, { error: 'project not found' });
        const buildScope = { organizationId: project.organizationId,
          transferGeneration: (await store.kvGet(`project-transfer-current:${project.id}`)) ?? '' };
        const { ProjectEnvironment, proposeEnvironment, beginEnvironmentBuild, finishEnvironmentBuild,
          recoverEnvironmentBuild, environmentBuildRevision, environmentBuildIsActive, recordEnvironmentBuilder,
        } = await import('../store/project-environment.js');
        const environments = new ProjectEnvironment(store);
        const sub = projectEnvironment[2];
        try {
          if (method === 'GET' && !sub) {
            const spec = (await environments.spec(project.id));
            const { remoteName } = await import('../world/provision-git.js');
            const repositories = [...new Set([...(project.config.repos ?? []).map(remoteName),
              ...(await store.listProjectRepositories(project.id)).map(({ repository }) => repository.name)])];
            const { environmentBase } = await import('../world/project-runtime.js');
            const bases = new Map<string, string | undefined>();
            const builds = [];
            for (const build of (await environments.builds(project.id))) {
              if (!bases.has(build.provider)) bases.set(build.provider, await environmentBase(store, project.id, build.provider));
              const base = bases.get(build.provider);
              // Worlds skip a build made on another template (selectProjectEnvironment).
              builds.push({ ...build, recoveryRevision: environmentBuildRevision(build),
                ...(base !== undefined && build.base !== base ? { stale: true } : {}) });
            }
            return this.json(res, 200, { spec: spec ?? null, repositories,
              digest: spec ? environments.digest(spec) : null, builds });
          }
          if (method === 'PUT' && !sub) {
            const body = await this.body(req);
            const list = (value: unknown) => Array.isArray(value) ? value.map(String)
              : typeof value === 'string' ? value.split('\n') : [];
            const spec = (await environments.setSpec(project.id, { image: body.image ? String(body.image) : undefined,
              setup: list(body.setup), install: body.install && typeof body.install === 'object' && !Array.isArray(body.install)
                ? Object.fromEntries(Object.entries(body.install).map(([name, commands]) => [name, list(commands)])) : undefined,
              boot: list(body.boot), includeDocker: Boolean(body.includeDocker) }));
            return this.json(res, 200, { spec, digest: environments.digest(spec) });
          }
          if (method === 'GET' && sub === 'proposal') {
            const repos = await projectRepositoryFiles(project, store, this.deps.githubApp);
            const { ProjectServices } = await import('../store/project-services.js');
            return this.json(res, 200, await proposeEnvironment(repos, {
              hasPerWorldServices: (await new ProjectServices(store).list(project.id))
                .some((service) => service.kind === 'per-world'),
            }));
          }
          if (method === 'POST' && sub === 'build/recover') {
            const body = await this.body(req);
            if (typeof body.provider !== 'string' || typeof body.digest !== 'string' || typeof body.revision !== 'string'
              || typeof body.cleanupNote !== 'string') return this.json(res, 400, { error: 'Inspect the build and confirm provider cleanup before recovering it.' });
            await recoverEnvironmentBuild(store, project.id, buildScope, body, actorPrincipal(callerIdentity.actor));
            return this.json(res, 200, { recovered: true });
          }
          if (method === 'POST' && sub === 'build') {
            const spec = (await environments.spec(project.id));
            if (!spec) return this.json(res, 400, { error: 'accept or configure an environment proposal first' });
            const body = await this.body(req);
            const provider = String(body.provider ?? (await store.effectiveProjectConfig(project)).worldProvider ?? 'worktree');
            const digest = environments.digest(spec);
            const connection = ['e2b', 'daytona'].includes(provider)
              ? (await this.deps.providerConnections?.resolve(project.organizationId, provider)) : undefined;
            const { buildEnvironment } = await import('../world/environment-build.js');
            const attempt = await beginEnvironmentBuild(store, project.id, buildScope, provider, digest);
            void buildEnvironment({ provider, projectId: project.id, digest, spec, buildId: attempt.buildId,
              onBuilderCreated: id => recordEnvironmentBuilder(store, attempt, id),
              assertActive: async () => { if (!await environmentBuildIsActive(store, attempt)) throw new Error('Environment build was invalidated.'); },
              ...(connection ? { connection: { apiKey: connection.apiKey,
                apiUrl: (connection.config as any)?.apiUrl, target: (connection.config as any)?.target,
                template: (connection.config as any)?.template } } : {}) })
              .then((result) => finishEnvironmentBuild(store, attempt, { ref: result.ref, ...(result.base ? { base: result.base } : {}), status: 'ready' }),
                (error) => finishEnvironmentBuild(store, attempt,
                  { status: 'failed', error: String(error instanceof Error ? error.message : error).slice(0, 800) }))
              .catch(error => console.error('Failed to persist environment build completion', error));
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
        const project = (await store.getProject(projectServices[1]!));
        if (!project) return this.json(res, 404, { error: 'project not found' });
        const { ProjectServices, composeServiceProposals } = await import('../store/project-services.js');
        const services = new ProjectServices(store);
        try {
          if (method === 'GET' && projectServices[2] === 'compose-import') {
            const { localRepositoryFiles, readDevcontainer } = await import('../store/project-environment.js');
            const proposals = [];
            for (const dir of projectRepositoryDirectories(project)) {
              const devcontainer = await readDevcontainer(localRepositoryFiles(dir, path.basename(dir)));
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
            const existing = new Set((await services.list(project.id)).map((service) => service.name));
            return this.json(res, 200, { proposals: proposals.filter((service) => !existing.has(service.name)) });
          }
          if (method === 'GET') return this.json(res, 200, { services: (await services.list(project.id)) });
          if (method === 'POST' && !projectServices[2]) {
            const body = await this.body(req);
            if (body.seedResourceId) {
              const resource = (await store.getResourceAttachment(String(body.seedResourceId)));
              if (!resource || resource.projectId !== project.id || !resource.enabled
                || stagedResourceCandidate(resource) || resource.target.kind !== 'path')
                return this.json(res, 400, { error: 'seed resource must be a path resource in this project' });
            }
            if (body.connectionResourceId) {
              const resource = (await store.getResourceAttachment(String(body.connectionResourceId)));
              if (!resource || resource.projectId !== project.id || !resource.enabled
                || stagedResourceCandidate(resource) || !credentialResource(resource))
                return this.json(res, 400, { error: 'connection resource must be a secret/service attachment in this project' });
            }
            return this.json(res, 200, { service: (await services.save(project.id, body as any)) });
          }
          if (method === 'DELETE') {
            const name = url.searchParams.get('name');
            if (!name) return this.json(res, 400, { error: 'name required' });
            (await services.delete(project.id, name));
            return this.json(res, 200, { deleted: true });
          }
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }

      const projectResources = p.match(/^\/api\/projects\/([^/]+)\/resources$/);
      if (projectResources) {
        const project = (await store.getProject(projectResources[1]!));
        if (!project?.organizationId) return this.json(res, 404, { error: 'project not found' });
        if (!this.deps.resources) return this.json(res, 503, { error: 'project resources are unavailable' });
        if (method === 'GET') return this.json(res, 200, (await __asyncCollections.map((await store.listResourceAttachments(project.id, true))
          .filter((resource) => !stagedResourceCandidate(resource)), async (resource) => ({
          ...redactResource(resource),
          revision: resource.currentRevisionId ? redactResourceRevision((await store.getResourceRevision(resource.currentRevisionId))) : undefined,
        }))));
        if (method === 'POST') {
          const b = await this.body(req);
          const id = newId('resource');
          const driver = String(b.driver ?? 'volume@1');
          const secret = typeof b.secret === 'string' ? b.secret : undefined;
          const credentialHandles: string[] = [];
          if (credentialResource(driver)) {
            if (!secret) return this.json(res, 400, { error: 'secret value is required for this resource driver' });
            if (!this.deps.broker) return this.json(res, 503, { error: 'credential broker is unavailable' });
            const handle = resourceSecretHandle(id);
            (await this.deps.broker.registerHandle(handle, secret, organizationScope(project.organizationId)));
            credentialHandles.push(handle);
          }
          try {
            const resource = (await store.createResourceAttachment({ id, organizationId: project.organizationId,
              projectId: project.id, name: String(b.name ?? 'Resource'), driver,
              target: normalizeResourceTarget(b.target, driver, String(b.name ?? 'resource')),
              access: b.access === 'write' ? 'write' : 'read', isolation: b.isolation === 'shared' ? 'shared' : 'fork',
              source: b.source && typeof b.source === 'object' ? b.source : {}, credentialHandles,
              storageLocationId: isSnapshotResourceDriver(driver)
                ? (await this.deps.resources.storageLocationFor(project.organizationId, b.storageLocationId == null ? undefined : String(b.storageLocationId)))
                : undefined,
              publish: b.publish === 'review' ? 'review' : 'discard' }));
            let revision;
            if (isSnapshotResourceDriver(driver)) {
              if (typeof b.sourcePath === 'string') {
                // A host filesystem path only means something when the browser and
                // the host are the same machine. Gating on `hosted` alone let a
                // remote caller on a public self-host import `/etc` or `~/.ssh`
                // and download it back as a resource revision.
                if (!this.hostLocal) throw new Error(`resource imports must upload bytes; a browser-local path is not available unless ${(await this.siteName)} runs on your machine`);
                revision = await this.deps.resources.importDirectory(resource.id, expandPath(b.sourcePath));
              } else if (Array.isArray(b.files)) {
                revision = await this.deps.resources.importFiles(resource.id, decodeResourceFiles(b.files));
              }
            }
            (await store.appendAudit({ principalId: actorPrincipal(callerIdentity.actor),
              action: 'resource:create', scopeKey: `project:${project.id}`, detail: { resourceId: resource.id, driver } }));
            return this.json(res, 200, { ...redactResource((await store.getResourceAttachment(resource.id))!),
              revision: redactResourceRevision(revision) });
          } catch (error) {
            for (const handle of credentialHandles) (await this.deps.broker?.deleteHandle(handle));
            (await store.deleteResourceAttachment(id));
            return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      const copyGlobsMigration = p.match(/^\/api\/projects\/([^/]+)\/resources\/import-copyglobs$/);
      if (copyGlobsMigration && method === 'POST') {
        const project = (await store.getProject(copyGlobsMigration[1]!));
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
      const resourceVerification = p.match(/^\/api\/projects\/([^/]+)\/resources\/([^/]+)\/revisions\/([^/]+)\/verify$/);
      if (resourceVerification && method === 'GET') {
        // The common request gate requires project:settings:read in the URL's project scope.
        if (!this.deps.resources) return this.json(res, 503, { error: 'project resources are unavailable' });
        const [, projectId, resourceId, revisionId] = resourceVerification;
        const resource = (await store.getResourceAttachment(resourceId!));
        const revision = (await store.getResourceRevision(revisionId!));
        const project = (await store.getProject(projectId!));
        // Use canonical ownership here, regardless of optional scope query parameters.
        if (project && !(await this.deps.tokens.check(token, 'project:settings:read',
          { projectId: project.id, organizationId: project.organizationId })).ok)
          return this.json(res, 403, { error: 'forbidden' });
        if (!project || !resource || resource.projectId !== project.id
          || resource.organizationId !== project.organizationId || !revision || revision.attachmentId !== resource.id)
          return this.json(res, 404, { error: 'resource revision not found' });
        if (stagedResourceCandidate(resource)) return this.json(res, 409,
          { error: 'this staged resource must be adopted or discarded from its task Review' });
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 100);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
          return this.json(res, 400, { error: 'offset must be a nonnegative integer; limit must be 1–1000' });
        res.setHeader('Cache-Control', 'no-store');
        try {
          return this.json(res, 200, await this.deps.resources.verifyRevision(projectId!, resourceId!, revisionId!, offset, limit));
        } catch {
          return this.json(res, 422, { error: 'resource revision verification is unsupported or unavailable' });
        }
      }
      const projectResource = p.match(/^\/api\/projects\/([^/]+)\/resources\/(?!scan$)([^/]+)$/);
      if (projectResource) {
        const resource = (await store.getResourceAttachment(projectResource[2]!));
        if (!resource || resource.projectId !== projectResource[1]) return this.json(res, 404, { error: 'resource not found' });
        if (stagedResourceCandidate(resource)) return this.json(res, 409,
          { error: 'this staged resource must be adopted or discarded from its task Review' });
        if (method === 'GET') return this.json(res, 200, { ...redactResource(resource),
          revisions: (await store.listResourceRevisions(resource.id)).map(redactResourceRevision) });
        if (method === 'PATCH') {
          const b = await this.body(req);
          // The server alone decides which vault handles a resource uses, since
          // the resource grants itself their use (AU-40).
          if (b.credentialHandles !== undefined)
            return this.json(res, 400, { error: 'a resource\'s credential is set by sending its secret, not a vault handle' });
          try {
            let secretUpdate: { handle: string; value: string } | undefined;
            let source = b.source && typeof b.source === 'object' ? withReservedSource(b.source, resource.source) : undefined;
            if (typeof b.secret === 'string') {
              if (!this.deps.broker) throw new Error('credential broker is unavailable');
              // A new value becomes the resource's own secret, never the handle
              // it names: that may be a vault item's or someone else's.
              const handle = resourceSecretHandle(resource.id);
              b.credentialHandles = [handle];
              source = withoutVaultProjection(source ?? resource.source);
              secretUpdate = { handle, value: b.secret };
            }
            const next = (await store.updateResourceAttachment(resource.id, {
              ...(b.name !== undefined ? { name: String(b.name) } : {}),
              ...(b.target !== undefined ? { target: normalizeResourceTarget(b.target, resource.driver, resource.name) } : {}),
              ...(b.access !== undefined ? { access: b.access } : {}), ...(b.isolation !== undefined ? { isolation: b.isolation } : {}),
              ...(b.publish !== undefined ? { publish: b.publish } : {}), ...(b.enabled !== undefined ? { enabled: Boolean(b.enabled) } : {}),
              ...(source ? { source } : {}),
              ...(b.storageLocationId !== undefined && isSnapshotResourceDriver(resource.driver)
                ? { storageLocationId: (await this.deps.resources?.storageLocationFor(resource.organizationId, String(b.storageLocationId))) }
                : {}),
              ...(b.credentialHandles ? { credentialHandles: b.credentialHandles } : {}),
            }));
            if (secretUpdate) (await this.deps.broker!.registerHandle(secretUpdate.handle, secretUpdate.value, organizationScope(resource.organizationId)));
            return this.json(res, 200, redactResource(next));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
        if (method === 'DELETE') {
          await this.deps.resources?.deleteAttachment(resource.id);
          if (!this.deps.resources) {
            if (resource.credentialHandles.includes(resourceSecretHandle(resource.id)))
              (await this.deps.broker?.deleteHandle(resourceSecretHandle(resource.id)));
            (await store.deleteResourceAttachment(resource.id));
          }
          return this.json(res, 200, { deleted: true, resourceId: resource.id });
        }
      }
      const projectResourceScan = p.match(/^\/api\/projects\/([^/]+)\/resources\/scan$/);
      if (projectResourceScan && method === 'GET') {
        const project = (await store.getProject(projectResourceScan[1]!));
        if (!project) return this.json(res, 404, { error: 'project not found' });
        // `hosted` and `hostLocal` are orthogonal: a self-host served on a public
        // URL is `hosted:false, hostLocal:false`. This route reads the HOST
        // filesystem, and the console hides it on `hostLocal()` — gate the server
        // on the same predicate, or a remote user still gets the host's file tree.
        if (!this.hostLocal) return this.json(res, 200, { proposals: [], unavailable: project.config.repos ?? [],
          note: `${(await this.siteName)} is not running on your machine, so it cannot see this workstation’s ignored files. Choose files or use the uploader.` });
        return this.json(res, 200, await scanProjectResources(project));
      }
      const resourceUploadCreate = p.match(/^\/api\/projects\/([^/]+)\/resources\/([^/]+)\/uploads$/);
      if (resourceUploadCreate && method === 'POST') {
        const resource = (await store.getResourceAttachment(resourceUploadCreate[2]!));
        if (!resource || resource.projectId !== resourceUploadCreate[1]) return this.json(res, 404, { error: 'resource not found' });
        if (stagedResourceCandidate(resource)) return this.json(res, 409,
          { error: 'staged resource candidates cannot be modified before Review' });
        if (!isSnapshotResourceDriver(resource.driver) || !this.deps.objects || !this.deps.resources)
          return this.json(res, 400, { error: 'resumable uploads require a snapshot resource and object store' });
        await cleanupExpiredResourceUploads(store, this.deps.resources, this.deps.objects);
        const id = newId('resource-upload');
        const storageLocationId = (await this.deps.resources.storageLocationFor(resource.organizationId, resource.storageLocationId));
        const upload: ResourceUploadSession = { id, organizationId: resource.organizationId, projectId: resource.projectId,
          attachmentId: resource.id, storageLocationId, files: {}, bytes: 0, createdAt: Date.now(), expiresAt: Date.now() + 24 * 60 * 60_000 };
        (await store.kvSet(resourceUploadKey(id), JSON.stringify(upload)));
        if (storageLocationId) (await this.deps.resources.storageLocationService()
          ?.reserveUpload(id, resource.organizationId, storageLocationId, 0, upload.expiresAt));
        return this.json(res, 200, { id, partBytes: RESOURCE_UPLOAD_PART_BYTES, expiresAt: upload.expiresAt });
      }
      const resourceUpload = p.match(/^\/api\/resource-uploads\/([^/]+)$/);
      if (resourceUpload) {
        const upload = (await resourceUploadSession(store, resourceUpload[1]!));
        if (!upload || upload.projectId !== url.searchParams.get('projectId')) return this.json(res, 404, { error: 'resource upload not found' });
        if (!this.deps.resources) return this.json(res, 503, { error: 'resource upload services unavailable' });
        const attachment = (await store.getResourceAttachment(upload.attachmentId));
        if (!attachment || attachment.organizationId !== upload.organizationId) return this.json(res, 410, { error: 'resource upload target no longer exists' });
        const uploadObjects = (await this.deps.resources.objectStoreFor({ ...attachment, storageLocationId: upload.storageLocationId }));
        if (upload.expiresAt < Date.now()) {
          await discardResourceUpload(store, upload, uploadObjects, this.deps.resources.storageLocationService());
          return this.json(res, 410, { error: 'resource upload expired' });
        }
        if (method === 'PUT') {
          const relative = String(url.searchParams.get('path') ?? '');
          const part = Number(url.searchParams.get('part'));
          if (!safeUploadPath(relative) || !Number.isInteger(part) || part < 0) return this.json(res, 400, { error: 'invalid upload path or part' });
          const data = await this.rawBody(req, RESOURCE_UPLOAD_PART_BYTES);
          // A zero-byte first part represents an empty file.
          if (!data.length && part !== 0) return this.json(res, 400, { error: 'empty upload part' });
          const record = upload.files[relative] ?? { parts: [], bytes: 0 };
          if (part !== record.parts.length) return this.json(res, 409, { error: `expected part ${record.parts.length}` });
          const objectKey = resourceUploadObjectKey(upload, relative, part);
          const previousBytes = upload.bytes;
          try {
            if (upload.storageLocationId) (await this.deps.resources.storageLocationService()
              ?.reserveUpload(upload.id, upload.organizationId, upload.storageLocationId,
                previousBytes + data.length, upload.expiresAt));
            await uploadObjects.put(objectKey, data);
          }
          catch (error) {
            if (upload.storageLocationId) (await this.deps.resources.storageLocationService()
              ?.reserveUpload(upload.id, upload.organizationId, upload.storageLocationId, previousBytes, upload.expiresAt));
            const message = error instanceof Error ? error.message : String(error);
            return this.json(res, /quota exceeded/i.test(message) ? 413 : 502, { error: message });
          }
          record.parts.push({ objectKey, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
          record.bytes += data.length; upload.bytes += data.length; upload.files[relative] = record;
          (await store.kvSet(resourceUploadKey(upload.id), JSON.stringify(upload)));
          return this.json(res, 200, { path: relative, part, bytes: data.length, totalBytes: upload.bytes });
        }
        if (method === 'POST') {
          try {
            if (!Object.keys(upload.files).length) throw new Error('upload has no files');
            const revision = await this.deps.resources.importFiles(upload.attachmentId,
              Object.entries(upload.files).map(([relative, record]) => ({ path: relative, bytes: record.bytes,
                data: uploadedFileChunks(uploadObjects, record.parts) })));
            await Promise.allSettled(Object.values(upload.files).flatMap((record) => record.parts)
              .map((part) => uploadObjects.delete(part.objectKey)));
            (await store.kvDelete(resourceUploadKey(upload.id)));
            (await this.deps.resources.storageLocationService()?.releaseUpload(upload.id));
            return this.json(res, 200, redactResourceRevision(revision));
          } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
        if (method === 'DELETE') {
          await discardResourceUpload(store, upload, uploadObjects, this.deps.resources.storageLocationService());
          return this.json(res, 200, { deleted: true });
        }
      }
      const resourceImport = p.match(/^\/api\/projects\/([^/]+)\/resources\/([^/]+)\/import$/);
      if (resourceImport && method === 'POST') {
        const resource = (await store.getResourceAttachment(resourceImport[2]!));
        if (!resource || resource.projectId !== resourceImport[1]) return this.json(res, 404, { error: 'resource not found' });
        if (stagedResourceCandidate(resource)) return this.json(res, 409,
          { error: 'staged resource candidates cannot be modified before Review' });
        if (!this.deps.resources) return this.json(res, 503, { error: 'project resources are unavailable' });
        const b = await this.body(req);
        try {
          const revision = typeof b.sourcePath === 'string'
            // Same host-filesystem gate as the create path above: `hostLocal`,
            // not `hosted`.
            ? !this.hostLocal ? (await (async () => { throw new Error(`imports require uploaded files unless ${(await this.siteName)} runs on your machine`); })())
              : await this.deps.resources.importDirectory(resource.id, expandPath(b.sourcePath))
            : await this.deps.resources.importFiles(resource.id, decodeResourceFiles(b.files));
          return this.json(res, 200, redactResourceRevision(revision));
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const taskResources = p.match(/^\/api\/tasks\/([^/]+)\/resources$/);
      if (taskResources && method === 'GET') {
        const task = (await store.getTask(taskResources[1]!));
        if (!task || !this.deps.resources) return this.json(res, task ? 503 : 404, { error: task ? 'project resources are unavailable' : 'task not found' });
        const summaries = [];
        const review = await store.resourceReview(task.id);
        const metadataOnly = url.searchParams.get('summary') === 'metadata';
        const world = metadataOnly ? await store.currentWorld(task.id) as import('../world/types.js').WorldHandle | undefined : undefined;
        const leases = world ? await store.listResourceLeases(world.id, world.generation ?? 1) : [];
        const candidates = (await store.listResourceCandidates(task.id));
        const candidateAttachments = new Set(candidates.map((candidate) => candidate.attachmentId));
        for (const resource of (await store.listResourceAttachments(task.projectId))) {
          if (candidateAttachments.has(resource.id)) continue;
          if (resource.access !== 'write' || resource.target.kind !== 'path') continue;
          if (metadataOnly) {
            if (resource.publish === 'review' && leases.some((lease) => lease.attachmentId === resource.id && lease.state === 'active'))
              summaries.push({ resource: redactResource(resource), pendingInspection: true });
            continue;
          }
          try { summaries.push({ resource: redactResource(resource), summary: await this.deps.resources.summarize(task.id, resource.id) }); }
          catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            summaries.push(message.includes('no active lease')
              ? { resource: redactResource(resource), discarded: true }
              : { resource: redactResource(resource), error: message });
          }
        }
        for (const candidate of candidates) {
          const resource = (await store.getResourceAttachment(candidate.attachmentId));
          summaries.push({ candidate,
            ...(resource ? { resource: redactResource(resource), revision: resource.currentRevisionId
              ? redactResourceRevision((await store.getResourceRevision(resource.currentRevisionId))) : undefined }
              : { resource: { id: candidate.attachmentId, name: 'Resource candidate' } }) });
        }
        return this.json(res, 200, summaries.map((item) => ({ ...item,
          excluded: review.excluded.includes(item.resource.id), automaticReview: !!review.reviewId, selectionFrozen: review.frozen })));
      }
      const taskResourceInventory = p.match(/^\/api\/tasks\/([^/]+)\/resources\/inventory$/);
      if (taskResourceInventory && method === 'GET') {
        if (!this.deps.resources) return this.json(res, 503, { error: 'project resources are unavailable' });
        try { return this.json(res, 200, await this.deps.resources.ignoredInventory(taskResourceInventory[1]!)); }
        catch (error) {
          const checkpointed = (await store.latestWorldCheckpoint(taskResourceInventory[1]!))?.ignored;
          if (checkpointed) return this.json(res, 200, checkpointed);
          return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const taskResourceSelection = p.match(/^\/api\/tasks\/([^/]+)\/resources\/([^/]+)\/selection$/);
      if (taskResourceSelection && method === 'PUT') {
        if (!this.deps.resources) return this.json(res, 503, { error: 'project resources are unavailable' });
        const body = await this.body(req);
        if (typeof body.excluded !== 'boolean') return this.json(res, 400, { error: 'excluded must be a boolean' });
        const task = await store.getTask(taskResourceSelection[1]!);
        if (task?.lastView?.stage !== 'review' || task.lastView.state?.applyingResources)
          return this.json(res, 409, { error: 'resource choices can only be changed before Review is confirmed' });
        if (!(await store.resourceReview(task.id)).reviewId) return this.json(res, 409, { error: 'this historical review requires an explicit Adopt or Discard decision' });
        try { return this.json(res, 200, await this.deps.resources.setReviewExcluded(task.id, taskResourceSelection[2]!, body.excluded)); }
        catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
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
      const taskResourceCandidate = p.match(/^\/api\/tasks\/([^/]+)\/resource-candidates\/([^/]+)\/(adopt|discard)$/);
      if (taskResourceCandidate && method === 'POST') {
        try {
          const result = taskResourceCandidate[3] === 'adopt'
            ? await api.adoptProjectResource(token, taskResourceCandidate[1]!, taskResourceCandidate[2]!)
            : await api.discardProjectResource(token, taskResourceCandidate[1]!, taskResourceCandidate[2]!);
          return this.json(res, 200, result);
        } catch (error) { return this.json(res, Number((error as any)?.status ?? 409),
          { error: error instanceof Error ? error.message : String(error) }); }
      }
      const projectMembers = p.match(/^\/api\/projects\/([^/]+)\/members$/);
      if (projectMembers) {
        const projectId = projectMembers[1]!;
        if (method === 'GET') return this.json(res, 200, (await __asyncCollections.map((await store.listProjectMemberships(projectId)), async (membership) => {
          if (membership.principal.kind !== 'user') return { ...membership,
            profileId: (await this.deps.authorization?.profile(membership.role, projectId))?.id
              ?? (membership.role === 'owner' || membership.role === 'admin' ? 'maintainer' : 'developer') };
          const grant = (await this.deps.authorization?.grants(`user:${membership.principal.userId}`))?.find((candidate) => candidate.scopeKey === `project:${projectId}`);
          return { ...membership, profileId: grant?.profileId ?? (membership.role === 'owner' || membership.role === 'admin' ? 'maintainer' : 'developer'), protectedOwner: membership.role === 'owner' };
        })));
        if (method === 'POST') {
          const b = await this.body(req);
          const project = (await store.getProject(projectId));
          if (!project?.organizationId) return this.json(res, 404, { error: 'project organization not found' });
          const principal = projectPrincipalFromBody(b.principal, project.organizationId);
          const profileId = String(b.profileId ?? 'developer');
          if (!['viewer', 'developer', 'maintainer'].includes(profileId)
            && !(await store.getAuthorizationProfile(`organization:${project.organizationId}`, profileId)))
            return this.json(res, 400, { error: 'choose a project authorization role' });
          (await this.deps.authorization?.assertCanGrantSelection(actorPrincipal(callerIdentity.actor),
            project.organizationId, { level: profileId, scope: 'projects', projectIds: [projectId] },
            authRecord?.kind === 'human' ? undefined : authRecord?.caps));
          const previous = (await store.listProjectMemberships(projectId)).find((member) => JSON.stringify(member.principal) === JSON.stringify(principal));
          const membership = (await store.setProjectMembership(projectId, principal, previous?.role === 'owner' ? 'owner'
            : principal.kind === 'user' ? 'member' : profileId));
          if (principal.kind === 'user') {
            (await this.deps.authorization?.grant(actorPrincipal(callerIdentity.actor), { principalId: `user:${principal.userId}`,
              scopeKey: `project:${projectId}`, profileId }));
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
        (await store.removeProjectMembership(projectMember[1]!, principal));
        if (principal.kind === 'user') (await this.deps.authorization?.revoke(actorPrincipal(callerIdentity.actor),
          `user:${principal.userId}`, `project:${projectMember[1]!}`));
        return this.json(res, 200, { ok: true });
      }
      const projectRepositories = p.match(/^\/api\/projects\/([^/]+)\/repositories$/);
      if (projectRepositories) {
        const projectId = projectRepositories[1]!;
        if (method === 'GET') return this.json(res, 200, (await store.listProjectRepositories(projectId)));
        if (method === 'POST') {
          const b = await this.body(req);
          try {
            const attached = await api.attachProjectRepository(token, {
              projectId, repositoryId: String(b.repositoryId),
              baseBranch: b.baseBranch ? String(b.baseBranch) : undefined,
              targetBranch: b.targetBranch ? String(b.targetBranch) : undefined,
              order: Number.isFinite(Number(b.order)) ? Number(b.order) : undefined,
            });
            const project = (await store.getProject(projectId));
            if (project) await this.ensureProjectWiki(project, callerIdentity.humanSubject?.userId);
            return this.json(res, 200, attached);
          } catch (error) {
            return this.json(res, Number((error as any)?.status ?? 409),
              { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      const projectCheckout = p.match(/^\/api\/projects\/([^/]+)\/checkout$/);
      if (projectCheckout && method === 'GET') {
        if (!this.deps.handoffs) return this.json(res, 503, { error: 'local checkout handoff is unavailable' });
        try { return this.json(res, 200, (await this.deps.handoffs.projectCheckout(projectCheckout[1]!))); }
        catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const githubMergeEligibility = p.match(/^\/api\/projects\/([^/]+)\/github-merge-eligibility$/);
      if (githubMergeEligibility && method === 'GET') {
        const project = (await store.getProject(githubMergeEligibility[1]!));
        if (!project) return this.json(res, 404, { error: 'project not found' });
        const subject = requireHumanSubject(callerIdentity);
        if (!this.deps.githubApp) return this.json(res, 200, {
          remotePolicy: (await store.effectiveProjectConfig(project)).remote ?? 'none', repositories: [], creatorCanMerge: false, eligibleUserIds: [],
          detail: `GitHub is not connected for this ${(await this.siteName)} organization.`,
        });
        const repositories = [...new Set([
          ...(await store.listProjectRepositories(project.id)).map((linked) => `${linked.repository.owner}/${linked.repository.name}`),
          ...((await store.projectWiki(project.id))?.repository
            ? [`${(await store.projectWiki(project.id))!.repository!.owner}/${(await store.projectWiki(project.id))!.repository!.name}`]
            : []),
        ])];
        if (!repositories.length) return this.json(res, 200, {
          remotePolicy: (await store.effectiveProjectConfig(project)).remote ?? 'none', repositories, creatorCanMerge: false, eligibleUserIds: [],
          detail: 'No GitHub repositories are connected to this project.',
        });
        const users = (await __asyncCollections.filter((project.organizationId ? (await store.listOrganizationMemberships(project.organizationId)) : [])
          .map((membership) => membership.userId), async (userId) => (await store.userIsProjectMember(project.id, userId))));
        const eligibleUserIds: string[] = [];
        const errors: Record<string, string> = {};
        for (const userId of users) {
          const accountId = (await this.deps.githubApp.activeUserAccountId(userId));
          if (!accountId) continue;
          const permissions = await Promise.all(repositories.map(async (slug) => {
            try { return await this.deps.githubApp!.repositoryPermission(userId, slug, accountId); }
            catch (error) { errors[userId] = error instanceof Error ? error.message : String(error); return undefined; }
          }));
          if (permissions.every((permission) => permission?.canMerge)) eligibleUserIds.push(userId);
        }
        return this.json(res, 200, {
          remotePolicy: (await store.effectiveProjectConfig(project)).remote ?? 'none',
          repositories,
          creatorCanMerge: eligibleUserIds.includes(subject.userId),
          eligibleUserIds,
          ...(errors[subject.userId] ? { detail: errors[subject.userId] } : {}),
        });
      }
      const projectRepositorySources = p.match(/^\/api\/projects\/([^/]+)\/repository-sources$/);
      if (projectRepositorySources) {
        const project = (await store.getProject(projectRepositorySources[1]!));
        if (!project) return this.json(res, 404, { error: 'project not found' });
        if (method === 'GET') return this.json(res, 200, { repos: project.config.repos ?? [] });
        if (method === 'PUT') {
          const b = await this.body(req);
          try {
            const repos = Array.isArray(b.repos) ? b.repos.map(String) : [];
            if (this.deps.hosted) {
              const known = (await store.listRepositories(project.organizationId!)).map((repository) => repository.sshUrl);
              const unknown = repos.filter((repo: string) => !known.some((candidate) => sameRepository(candidate, repo)));
              if (unknown.length) throw new Error('Hosted projects must select repositories available through the organization GitHub connection');
            }
            const saved = (await store.setProjectRepositorySources(project.id, repos));
            await this.ensureProjectWiki(saved, callerIdentity.humanSubject?.userId);
            return this.json(res, 200, saved); }
          catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
        }
      }
      const projectRepository = p.match(/^\/api\/projects\/([^/]+)\/repositories\/([^/]+)$/);
      if (projectRepository && method === 'DELETE') {
        (await store.detachProjectRepository(projectRepository[1]!, projectRepository[2]!));
        return this.json(res, 200, { ok: true });
      }
      const tasksMatch = p.match(/^\/api\/projects\/([^/]+)\/tasks$/);
      if (tasksMatch) {
        const projectId = tasksMatch[1]!;
        if (method === 'GET') {
          if (url.searchParams.get('page') === '1') {
            const limit = Number(url.searchParams.get('limit') ?? '200');
            const offset = Number(url.searchParams.get('offset') ?? '0');
            if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0)
              return this.json(res, 400, { error: 'limit must be 1–200 and offset a nonnegative integer' });
            const result = await api.taskSummaryPage(token, projectId, {
              includeArchived: url.searchParams.get('includeArchived') === '1', limit, offset,
            });
            const organizationId = (await store.getProject(projectId))?.organizationId;
            const counts: ApprovalCounts = organizationId ? (await this.approvalCounts(organizationId)) : new Map();
            return this.json(res, 200, { ...result, tasks: (await __asyncCollections.map(result.tasks, async task => ({ ...task,
              lastView: (await this.withApprovalRequests(task.lastView, task.id, counts)) }))) });
          }
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
          const organizationId = (await store.getProject(projectId))?.organizationId;
          const approvalCounts: ApprovalCounts = organizationId ? (await this.approvalCounts(organizationId)) : new Map();
          const listed = (await __asyncCollections.map(page, async (t) => ({
            ...t,
            lastView: trimListView((await this.withApprovalRequests(t.lastView, t.id, approvalCounts))),
          })));
          if (limit > 0) return this.json(res, 200, { tasks: listed, total: filtered.length, offset });
          return this.json(res, 200, listed);
        }
        if (method === 'POST') {
          const b = await this.body(req);
          const project = (await store.getProject(projectId));
          if (project) await this.wikiForTaskStart(project, callerIdentity.humanSubject?.userId);
          const task = await api.createTask(token, { projectId, ...b }, receivedAt);
          return this.json(res, 200, task);
        }
      }

      // ── search / organization (a view is a saved query) ──
      // The searchable-field registry the UI reads to build its filter/sort/group menus.
      if (p === '/api/search' && method === 'GET') {
        const query = url.searchParams.get('q')?.trim() ?? '';
        if (query.length > 2000) return this.json(res, 400, { error: 'Search is too long' });
        return this.json(res, 200, await this.searchProjects(req, res, session, query));
      }
      if (p === '/api/search/fields' && method === 'GET') return this.json(res, 200, (await api.searchFields(token)));
      const organizationSearch = p.match(/^\/api\/organizations\/([^/]+)\/search$/);
      if (organizationSearch && method === 'GET') {
        if ((url.searchParams.get('q') ?? '').length > 2000) return this.json(res, 400, { error: 'Search is too long' });
        return await this.searchOrganization(res, session, decodeURIComponent(organizationSearch[1]!), url);
      }

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
          const task = (await store.getTask(responsibilityMatch[1]!));
          return this.json(res, 200, task ? { createdBy: task.createdBy, assignee: task.assignee,
            delegate: task.delegate, confirmationPolicy: task.confirmationPolicy, subscribers: task.subscribers } : null);
        }
        if (method === 'PATCH') {
          const b = await this.body(req);
          return this.json(res, 200, (await store.setTaskResponsibility(responsibilityMatch[1]!, {
            assignee: b.assignee === null ? null : b.assignee === undefined ? undefined : principalFromBody(b.assignee),
            delegate: b.delegate === null ? null : b.delegate === undefined ? undefined : principalFromBody(b.delegate),
            confirmationPolicy: b.confirmationPolicy === null ? null : b.confirmationPolicy,
          })));
        }
      }
      const subscribersMatch = p.match(/^\/api\/tasks\/([^/]+)\/subscribers$/);
      if (subscribersMatch) {
        if (method === 'GET') return this.json(res, 200, (await store.subscribersFor(subscribersMatch[1]!)));
        if (method === 'POST' || method === 'DELETE') {
          const b = await this.body(req);
          const principal = principalFromBody(b.principal);
          if (method === 'POST') (await store.subscribeTask(subscribersMatch[1]!, principal));
          else (await store.unsubscribeTask(subscribersMatch[1]!, principal));
          return this.json(res, 200, { subscribers: (await store.subscribersFor(subscribersMatch[1]!)) });
        }
      }

      // tasks
      // Resolve a per-project sequential number (SPEC §10.6) → its canonical id, so a
      // `/projects/<name>/tasks/<num>` permalink can be opened even when the task
      // isn't in the client's loaded list (e.g. an archived task).
      const byNumMatch = p.match(/^\/api\/projects\/([^/]+)\/tasks\/by-num\/(\d+)$/);
      if (byNumMatch && method === 'GET') {
        const rec = await store.taskPointerByNumAsync(byNumMatch[1]!, Number(byNumMatch[2]!));
        if (!rec) return this.json(res, 404, { error: 'no such task' });
        return this.json(res, 200, { id: rec.id, num: rec.num, projectId: rec.projectId });
      }
      const viewMatch = p.match(/^\/api\/tasks\/([^/]+)$/);
      if (viewMatch && method === 'GET') {
        const rec = await store.taskMetadataAsync(viewMatch[1]!);
        // Draft attempts have no Temporal execution, but are still selectable in
        // the drawer. Keep that synthetic projection separate from getTaskView so
        // list snapshots continue to truthfully report no execution view.
        const view = rec?.params?.draft
          ? await api.getDraftViewAsync(token, viewMatch[1]!)
          : await api.getTaskView(token, viewMatch[1]!);
        if (!view) return this.json(res, 200, null);
        // Mirror the record's sequential number onto the view (the workflow only
        // knows the opaque id) so the drawer can show `#num` + a permalink.
        const projected = (await this.withApprovalRequests(view, viewMatch[1]!))!;
        return this.json(res, 200, rec?.num != null ? { ...projected, num: rec.num } : projected);
      }
      // Agent-authored review HTML is its own document under the untrusted-content
      // sandbox; as a srcdoc it would inherit the console's policy and lose its script.
      const reviewHtmlMatch = p.match(/^\/api\/tasks\/([^/]+)\/review-info\.html$/);
      if (reviewHtmlMatch && method === 'GET') {
        const html = (await api.getTaskView(token, reviewHtmlMatch[1]!))?.reviewInfo?.html;
        if (!html) return this.json(res, 404, { error: 'no review HTML' });
        res.writeHead(200, { ...untrustedContentHeaders('text/html; charset=utf-8', 'review.html'),
          'content-length': String(Buffer.byteLength(html)), 'cache-control': 'private, no-store' });
        return void res.end(html);
      }
      if (viewMatch && method === 'DELETE') {
        // Hard-delete is for drafts only (they never started a workflow). Running
        // tasks must be cancelled, not deleted out from under their workflow.
        const t = (await store.getTask(viewMatch[1]!));
        if (!t) return this.json(res, 404, { error: 'no such task' });
        if (!t.params?.draft) return this.json(res, 400, { error: 'only drafts can be deleted; cancel a running task instead' });
        (await store.deleteTask(viewMatch[1]!));
        return this.json(res, 200, { ok: true });
      }
      const principalMatch = p.match(/^\/api\/tasks\/([^/]+)\/principal$/);
      if (principalMatch && method === 'POST') {
        try {
          return this.json(res, 200, (await api.setPrincipalAttempt(token, principalMatch[1]!)));
        } catch (e) { return this.badRequest(res, e); }
      }
      const attemptsMatch = p.match(/^\/api\/tasks\/([^/]+)\/attempts$/);
      if (attemptsMatch && method === 'GET') {
        const group = (await api.attemptGroup(token, attemptsMatch[1]!));
        return this.json(res, 200, group ? {
          ...group,
          attempts: (await __asyncCollections.map(group.attempts, async (attempt) => ({
            ...attempt,
            lastView: (await this.withApprovalRequests(attempt.lastView, attempt.id)),
          }))),
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
        const queued = (await store.getTask(queueMatch[1]!));
        const project = queued ? (await store.getProject(queued.projectId)) : undefined;
        if (project) await this.wikiForTaskStart(project, callerIdentity.humanSubject?.userId);
        return this.json(res, 200, await api.queueTask(token, queueMatch[1]!));
      }
      const taskPayments = p.match(/^\/api\/tasks\/([^/]+)\/payments$/);
      if (taskPayments && (method === 'GET' || method === 'PUT')) {
        const task = (await store.getTask(taskPayments[1]!));
        if (!task) return this.json(res, 404, { error: 'no such task' });
        const { BudgetService, resolvePaymentPolicy } = await import('../autonomy/payments.js');
        let released: string[] = [];
        if (method === 'PUT') {
          const body = await this.body(req);
          await api.setTaskPaymentPolicy(token, task.id, body);
          if (this.deps.paymentRegistry || this.deps.payments) {
            const service = new BudgetService(store, this.deps.paymentRegistry ?? this.deps.payments!);
            const results = await service.reconcileTask({ projectId: task.projectId, taskId: task.id });
            released = results.filter(r => r.status === 'granted').map(r => r.requestId!);
            if (released.length) await api.signalTask(token, task.id, 'followUp',
              `Payment requests ${released.join(', ')} now fit the task budget and are ready. Continue using the same requests.`).catch(() => undefined);
          }
        }
        const policy = (await resolvePaymentPolicy(store, task.projectId, task.id));
        const cards = (await store.listCards(task.projectId)).filter(card => policy.cardIds.includes(card.id))
          .map(({ id, label, last4, status, currency }) => ({ id, label, last4, status, currency }));
        return this.json(res, 200, { ...policy, cards,
          canEdit: !['done', 'cancelled', 'failed'].includes(task.lastView?.status ?? '')
            && (await this.deps.tokens.check(token, 'payment:write', { projectId: task.projectId })).ok,
          spent: (await store.paymentSpent(task.id, false, policy.currency)), released });
      }
      const editMatch = p.match(/^\/api\/tasks\/([^/]+)\/params$/);
      if (editMatch && method === 'PATCH') {
        const b = await this.body(req);
        const id = editMatch[1]!;
        const t = (await store.getTask(id));
        if (!t) return this.json(res, 404, { error: 'no such task' });
        // A waiting (armed) task or a repeatable series hasn't started its own
        // workflow — edit its stored params + triggers in place, then re-arm (or
        // drop to a draft). `keepArmed:false` (Save as draft) disarms it.
        const attenuation = { allowAttenuation: b.allowAttenuation === true, acceptAttenuation: attenuationAcceptance(b.acceptAttenuation) };
        if (t.params?.triggerState === 'armed' || t.params?.repeatable) {
          try {
            const updated = await api.updateArmedParams(token, id, b.params ?? {}, { replace: b.replace === true, keepArmed: b.keepArmed !== false, ...attenuation });
            return this.json(res, 200, updated);
          } catch (e) {
            return this.json(res, grantRefusal(e).code ? 403 : 400, { error: e instanceof Error ? e.message : String(e), ...grantRefusal(e) });
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
              ...attenuation,
            });
            return this.json(res, 200, updated);
          } catch (e) {
            return this.json(res, grantRefusal(e).code ? 403 : 409, { error: e instanceof Error ? e.message : String(e), ...grantRefusal(e) });
          }
        }
        // Once queued, params are frozen except the ones the workflow declares
        // in-flight-editable (SPEC §4.5/§5.5). Forward to its validated update and
        // let the validator reject anything frozen — a clear 409, never a silent
        // no-op on the stored record (which the running workflow would ignore).
        try {
          const applied = await api.updateParams(token, id, b.params ?? {}, { acceptAttenuation: attenuation.acceptAttenuation });
          // Authoritative read: reflect the just-applied update, not a snapshot that
          // may pre-date the workflow's next publish.
          return this.json(res, 200, { ...applied, view: await api.getTaskView(token, id, { live: true }) });
        } catch (e) {
          return this.json(res, grantRefusal(e).code ? 403 : 409, { error: e instanceof Error ? e.message : String(e), ...grantRefusal(e) });
        }
      }
      // One agent's own authority (not the main agent's, which is the task's
      // authorization below): the Responder, a Reviewer, or an agent called in.
      const agentAuthorityMatch = p.match(/^\/api\/tasks\/([^/]+)\/agents\/([^/]+)\/authority$/);
      if (agentAuthorityMatch && (method === 'PUT' || method === 'DELETE')) {
        const b = method === 'PUT' ? await this.body(req) : {};
        try {
          return this.json(res, 200, await api.setAgentAuthority(token, agentAuthorityMatch[1]!, decodeURIComponent(agentAuthorityMatch[2]!),
            method === 'PUT' ? b.authority as AgentAuthority | undefined : undefined,
            { allowAttenuation: b.allowAttenuation === true, acceptAttenuation: b.acceptAttenuation === true }));
        } catch (e) { return this.fail(res, e); }
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
              ? b.credentialPolicies as any : undefined,
            { allowAttenuation: b.allowAttenuation === true, acceptAttenuation: b.acceptAttenuation === true }));
        } catch (e) {
          // Frozen in-flight (cancelled / past the point of no return / finished),
          // or a stale draft edit — the workflow validator's reason is authoritative.
          return this.json(res, Number((e as any)?.status ?? 409), {
            error: e instanceof Error ? e.message : String(e),
            ...((e as any)?.code ? { code: (e as any).code } : {}),
            ...(e instanceof AuthorizationGrantError ? e.gap : {}),
          });
        }
      }
      const archiveMatch = p.match(/^\/api\/tasks\/([^/]+)\/archive$/);
      if (archiveMatch && method === 'POST') {
        const b = await this.body(req);
        const t = (await store.getTask(archiveMatch[1]!));
        if (!t) return this.json(res, 404, { error: 'no such task' });
        const archived = b.archived !== false; // default: archive
        // Archiving only hides from the default list; it never touches the task's
        // execution. It applies to the logical task, not just the selected attempt:
        // list/search project one principal row, so divergent sibling flags would
        // make the task appear in the wrong section after principal re-election.
        // A running task keeps running while hidden, and the built-in `is:archived`
        // view (or `includeArchived=1`) brings it back into view at any time.
        (await store.setTaskArchived(archiveMatch[1]!, archived));
        return this.json(res, 200, { ok: true, archived });
      }
      const notesMatch = p.match(/^\/api\/tasks\/([^/]+)\/notes$/);
      if (notesMatch && method === 'PATCH') {
        const b = await this.body(req);
        const t = (await store.getTask(notesMatch[1]!));
        if (!t) return this.json(res, 404, { error: 'no such task' });
        // Purely cosmetic human notes — stored on the record, never sent to any agent.
        const notes = typeof b.notes === 'string' ? b.notes : '';
        (await store.setTaskNotes(notesMatch[1]!, notes));
        return this.json(res, 200, { ok: true, notes });
      }
      const signalMatch = p.match(/^\/api\/tasks\/([^/]+)\/signal$/);
      if (signalMatch && method === 'POST') {
        const b = await this.body(req);
        const message = await api.signalTask(token, signalMatch[1]!, b.signal, b.text, b.role, b.images, b.files, { otherAttempts: b.otherAttempts, saveOtherAttemptsDefault: b.saveOtherAttemptsDefault }, receivedAt);
        return this.json(res, 200, { ok: true, ...(message ? { message, role: b.role ?? 'do' } : {}) });
      }
      const messageMatch = p.match(/^\/api\/tasks\/([^/]+)\/messages$/);
      if (messageMatch && method === 'POST') {
        const b = await this.body(req);
        // Recipients (@ mentions) and agents added for them: one shared conversation.
        if (Array.isArray(b.to) || (b.agents && typeof b.agents === 'object')) {
          const posted = await api.postTaskMessage(token, messageMatch[1]!, {
            text: String(b.text ?? ''),
            ...(Array.isArray(b.to) ? { to: b.to.map(String) } : {}),
            ...(b.agents && typeof b.agents === 'object' && !Array.isArray(b.agents) ? { agents: b.agents } : {}),
            ...(Array.isArray(b.images) ? { images: b.images } : {}),
            ...(Array.isArray(b.files) ? { files: b.files } : {}),
            ...(b.urgency ? { urgency: normalizeUrgency(b.urgency) } : {}),
          });
          return this.json(res, 200, { ok: true, ...posted });
        }
        const message = await api.messageAgent(token, messageMatch[1]!, String(b.text ?? ''), b.role);
        return this.json(res, 200, { ok: true, ...(message ? { message, role: b.role ?? 'do' } : {}) });
      }
      const mergeEligibilityMatch = p.match(/^\/api\/tasks\/([^/]+)\/merge-eligibility$/);
      if (mergeEligibilityMatch && method === 'GET') {
        try {
          const answer = await api.mergeEligibility(token, mergeEligibilityMatch[1]!);
          const names = new Map(((await this.deps.identity?.listUsers()) ?? []).map((user) => [user.id, { name: user.name, email: user.email }]));
          return this.json(res, 200, { ...answer, people: answer.eligibleUserIds.map((id) => ({ id, selector: `user:${id}`, ...names.get(id) })) });
        } catch (e) { return this.badRequest(res, e); }
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
        return this.json(res, 200, (await store.runsOf(runsMatch[1]!)));
      }
      const executionsMatch = p.match(/^\/api\/tasks\/([^/]+)\/executions$/);
      if (executionsMatch && method === 'GET') {
        return this.json(res, 200, (await store.listExecutions(executionsMatch[1]!)));
      }
      const terminalTicketMatch = p.match(/^\/api\/tasks\/([^/]+)\/terminal-ticket$/);
      if (terminalTicketMatch && method === 'POST') {
        const taskId = terminalTicketMatch[1]!;
        if (!(await store.getTask(taskId))) return this.json(res, 404, { error: 'task not found' });
        const ticket = crypto.randomBytes(24).toString('base64url');
        const ttlMs = 5 * 60_000;
        const expiresAt = Date.now() + ttlMs;
        // Each ticket holds its session until it is used or expires: bound what one
        // session can keep outstanding, oldest first, and drop each at expiry (PS-14c).
        const own = [...this.terminalTickets].filter(([, record]) => record.session.apiToken === session.apiToken);
        for (const [candidate] of own.slice(0, Math.max(0, own.length - (MAX_TERMINAL_TICKETS_PER_SESSION - 1))))
          this.terminalTickets.delete(candidate);
        this.terminalTickets.set(ticket, { taskId, session, expiresAt });
        setTimeout(() => this.terminalTickets.delete(ticket), ttlMs).unref();
        // A path into this install's checkout only means something to the machine it lives on.
        const attachArgv = this.hostLocal ? [process.execPath, fileURLToPath(new URL('../../bin/tavya.js', import.meta.url))] : [BRAND];
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
        try { return this.json(res, 200, (await this.deps.handoffs.checkout(checkoutMatch[1]!))); }
        catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const materializeMatch = p.match(/^\/api\/tasks\/([^/]+)\/materialize-local$/);
      if (materializeMatch && method === 'POST') {
        if (!this.deps.handoffs) return this.json(res, 503, { error: 'local checkout handoff is unavailable' });
        if (!this.hostLocal) return this.json(res, 409, { error: `use the Git checkout handoff when ${(await this.siteName)} is not running on your machine` });
        const taskId = materializeMatch[1]!;
        const view = (await api.getTaskView(token, taskId, { live: true }).catch(liveViewUnavailable)) ?? (await store.getTask(taskId))?.lastView;
        if (!view) return this.json(res, 404, { error: 'task view is unavailable' });
        try { return this.json(res, 200, await this.deps.handoffs.materialize(taskId, view)); }
        catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const openCommandMatch = p.match(/^\/api\/tasks\/([^/]+)\/open-command$/);
      if (openCommandMatch && method === 'POST') {
        if (!this.deps.handoffs) return this.json(res, 503, { error: 'local checkout handoff is unavailable' });
        if (!this.hostLocal) return this.json(res, 409, { error: `file open commands are available only on the machine running ${(await this.siteName)}` });
        const taskId = openCommandMatch[1]!;
        const view = (await api.getTaskView(token, taskId, { live: true }).catch(liveViewUnavailable)) ?? (await store.getTask(taskId))?.lastView;
        if (!view) return this.json(res, 404, { error: 'task view is unavailable' });
        const body = await this.body(req);
        const line = body.line == null ? undefined : Number(body.line);
        if (line !== undefined && (!Number.isInteger(line) || line < 1))
          return this.json(res, 400, { error: 'line must be a positive integer' });
        const wiki = await this.deps.handoffs.wikiCitation(taskId, String(body.path ?? ''));
        if (wiki) return this.json(res, 200, wiki);
        try { return this.json(res, 200, await this.deps.handoffs.openFile(taskId, view, String(body.path ?? ''), line)); }
        catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      const fileCheckoutMatch = p.match(/^\/api\/tasks\/([^/]+)\/file-checkout$/);
      if (fileCheckoutMatch && method === 'POST') {
        if (!this.deps.handoffs) return this.json(res, 503, { error: 'local checkout handoff is unavailable' });
        const taskId = fileCheckoutMatch[1]!;
        const view = (await api.getTaskView(token, taskId, { live: true }).catch(liveViewUnavailable)) ?? (await store.getTask(taskId))?.lastView;
        if (!view) return this.json(res, 404, { error: 'task view is unavailable' });
        const body = await this.body(req);
        const line = body.line == null ? undefined : Number(body.line);
        if (line !== undefined && (!Number.isInteger(line) || line < 1))
          return this.json(res, 400, { error: 'line must be a positive integer' });
        const wiki = await this.deps.handoffs.wikiCitation(taskId, String(body.path ?? ''));
        if (wiki) return this.json(res, 200, wiki);
        try { return this.json(res, 200,
          (await this.deps.handoffs.fileCheckout(taskId, view, String(body.path ?? ''), line))); }
        catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (p === '/api/agent/git/publish' && method === 'POST') {
        try { return this.json(res, 200, await api.publishTaskBranch(token)); }
        catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (p === '/api/agent/github/actions/workflows' && method === 'GET') {
        try { return this.json(res, 200, await api.listGithubActionsWorkflows(token, {
          taskId: url.searchParams.get('taskId') ?? undefined,
          repository: url.searchParams.get('repository') ?? undefined,
          page: url.searchParams.has('page') ? Number(url.searchParams.get('page')) : undefined,
          perPage: url.searchParams.has('perPage') ? Number(url.searchParams.get('perPage')) : undefined,
        })); } catch (error) { return this.json(res, Number((error as any)?.status ?? 409),
          { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (p === '/api/agent/github/actions/runs' && method === 'GET') {
        try {
          return this.json(res, 200, await api.listGithubActionsRuns(token, {
            taskId: url.searchParams.get('taskId') ?? undefined,
          repository: url.searchParams.get('repository') ?? undefined,
            branch: url.searchParams.get('branch') ?? undefined,
            event: url.searchParams.get('event') ?? undefined,
            status: (url.searchParams.get('status') as any) ?? undefined,
            workflow: url.searchParams.get('workflow') ?? undefined,
            page: url.searchParams.has('page') ? Number(url.searchParams.get('page')) : undefined,
            perPage: url.searchParams.has('perPage') ? Number(url.searchParams.get('perPage')) : undefined,
          }));
        } catch (error) { return this.json(res, Number((error as any)?.status ?? 409),
          { error: error instanceof Error ? error.message : String(error) }); }
      }
      const githubActionsRun = p.match(/^\/api\/agent\/github\/actions\/runs\/(\d+)$/);
      if (githubActionsRun && method === 'GET') {
        try { return this.json(res, 200, await api.inspectGithubActionsRun(token, {
          taskId: url.searchParams.get('taskId') ?? undefined,
          repository: url.searchParams.get('repository') ?? undefined, runId: Number(githubActionsRun[1]),
          view: (url.searchParams.get('view') ?? undefined) as any,
          attempt: url.searchParams.has('attempt') ? Number(url.searchParams.get('attempt')) : undefined,
          jobId: url.searchParams.has('jobId') ? Number(url.searchParams.get('jobId')) : undefined,
          page: url.searchParams.has('page') ? Number(url.searchParams.get('page')) : undefined,
          perPage: url.searchParams.has('perPage') ? Number(url.searchParams.get('perPage')) : undefined,
          offsetLines: url.searchParams.has('offsetLines') ? Number(url.searchParams.get('offsetLines')) : undefined,
          tailLines: url.searchParams.has('tailLines') ? Number(url.searchParams.get('tailLines')) : undefined,
          maxChars: url.searchParams.has('maxChars') ? Number(url.searchParams.get('maxChars')) : undefined,
        })); }
        catch (error) { return this.json(res, Number((error as any)?.status ?? 409),
          { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (githubActionsRun && method === 'POST') {
        const b = await this.body(req);
        try { return this.json(res, 200, await api.manageGithubActionsRun(token, {
          taskId: b.taskId, repository: b.repository ? String(b.repository) : undefined, runId: Number(githubActionsRun[1]),
          action: String(b.action ?? '') as any,
        })); }
        catch (error) { return this.json(res, Number((error as any)?.status ?? 409),
          { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (p === '/api/agent/github/actions/dispatch' && method === 'POST') {
        const b = await this.body(req);
        try { return this.json(res, 200, await api.dispatchGithubActionsWorkflow(token, {
          taskId: b.taskId, repository: b.repository ? String(b.repository) : undefined,
          workflow: typeof b.workflow === 'number' ? b.workflow : String(b.workflow ?? ''),
          ref: String(b.ref ?? ''), inputs: b.inputs && typeof b.inputs === 'object' && !Array.isArray(b.inputs) ? b.inputs : undefined,
        })); }
        catch (error) { return this.json(res, Number((error as any)?.status ?? 409),
          { error: error instanceof Error ? error.message : String(error) }); }
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
      if (p === '/api/agent/resource-candidates' && method === 'POST') {
        const b = await this.body(req);
        try { return this.json(res, 200, await api.proposeProjectResource(token, b as any)); }
        catch (error) { return this.json(res, Number((error as any)?.status ?? 409),
          { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (p === '/api/agent/escalate' && method === 'POST') {
        const b = await this.body(req);
        try {
          return this.json(res, 200, await api.escalateToHuman(token, {
            ...(typeof b.taskId === 'string' && b.taskId ? { taskId: b.taskId } : {}),
            audience: Array.isArray(b.audience) ? b.audience.map(String) : [],
            message: String(b.message ?? ''),
            ...(b.urgency ? { urgency: normalizeUrgency(b.urgency) } : {}),
          }));
        } catch (error) {
          return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p === '/api/agent/notify' && method === 'POST') {
        const b = await this.body(req);
        return this.json(res, 200, await api.notify(token, {
          to: Array.isArray(b.to) ? b.to.map(String) : [],
          message: String(b.message ?? ''),
          ...(b.urgency ? { urgency: normalizeUrgency(b.urgency) } : {}),
        }));
      }
      if (p === '/api/agent/permission-requests' && method === 'POST') {
        const b = await this.body(req);
        try {
          return this.json(res, 200, await api.requestPermission(token, {
            ...(b.projectIds !== undefined ? { projectIds: b.projectIds as string[] } : {}),
            capabilities: Array.isArray(b.capabilities) ? b.capabilities.map(String) : [],
            audience: Array.isArray(b.audience) ? b.audience.map(String) : [],
            reason: String(b.reason ?? ''),
            ...(b.urgency ? { urgency: normalizeUrgency(b.urgency) } : {}),
          }));
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      // The project these act in decides the caller's authority, so it must be
      // in the URL (`?projectId=`), where the gateway scopes the session to it.
      const bodyScopedProject = (b: any) => requestedScope.projectId
        && (b.projectId === undefined || String(b.projectId) === requestedScope.projectId) ? requestedScope.projectId : undefined;
      const unscopedProject = 'pass the project as ?projectId= (it must match any projectId in the body)';
      if (p === '/api/authorization/escalation-targets' && method === 'POST') {
        const b = await this.body(req);
        const authorization = authorizationSelectionFromBody(b.authorization);
        if (!authorization) return this.json(res, 400, { error: 'authorization is required' });
        const projectId = bodyScopedProject(b);
        if (!projectId) return this.json(res, 400, { error: unscopedProject });
        try {
          const result = (await api.authorizationEscalationTargets(token, {
            projectId, authorization,
          }));
          const names = new Map(((await this.deps.identity?.listUsers()) ?? []).map((user) =>
            [user.id, { name: user.name, email: user.email }]));
          return this.json(res, 200, {
            ...result,
            users: result.users.map((user) => ({ ...user, ...names.get(user.id) })),
          });
        } catch (error) {
          return this.json(res, Number((error as any)?.status ?? 400), { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p === '/api/authorization-requests') {
        if (method === 'POST') {
          const b = await this.body(req);
          const authorization = authorizationSelectionFromBody(b.authorization);
          if (!authorization || !b.target || typeof b.target !== 'object')
            return this.json(res, 400, { error: 'target and authorization are required' });
          const projectId = bodyScopedProject(b);
          if (!projectId) return this.json(res, 400, { error: unscopedProject });
          try {
            return this.json(res, 200, await api.requestAuthorization(token, {
              projectId, target: b.target as any, authorization,
              audience: Array.isArray(b.audience) ? b.audience.map(String) : [],
              reason: b.reason == null ? undefined : String(b.reason),
            }));
          } catch (error) {
            return this.json(res, Number((error as any)?.status ?? 400), { error: error instanceof Error ? error.message : String(error) });
          }
        }
        if (method === 'GET') {
          const organizationId = String(url.searchParams.get('organizationId') ?? '');
          if (!organizationId) return this.json(res, 400, { error: 'organizationId is required' });
          try {
            return this.json(res, 200, (await api.listAuthorizationRequests(token, {
              organizationId,
              status: (url.searchParams.get('status') || undefined) as any,
              taskId: url.searchParams.get('taskId') || undefined,
              avatarId: url.searchParams.get('avatarId') || undefined,
            })));
          } catch (error) {
            return this.json(res, Number((error as any)?.status ?? 400), { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      const authorizationResolution = p.match(/^\/api\/authorization-requests\/([^/]+)\/resolve$/);
      if (authorizationResolution && method === 'POST') {
        const b = await this.body(req);
        const organizationId = String(url.searchParams.get('organizationId') ?? '');
        if (!organizationId) return this.json(res, 400, { error: 'organizationId is required' });
        if (b.action !== 'approve' && b.action !== 'deny' && b.action !== 'dismiss')
          return this.json(res, 400, { error: 'action must be approve | deny | dismiss' });
        try {
          return this.json(res, 200, await api.resolveAuthorizationRequest(token, {
            organizationId, requestId: authorizationResolution[1]!, action: b.action,
          }));
        } catch (error) {
          return this.json(res, Number((error as any)?.status ?? 400), { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (p === '/api/agent/escalation-targets' && method === 'GET') {
        try { return this.json(res, 200, (await api.humanEscalationTargets(token))); }
        catch (error) { return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
      }
      if (p === '/api/permission-requests' && method === 'GET') {
        const organizationId = String(url.searchParams.get('organizationId') ?? '');
        const taskId = String(url.searchParams.get('taskId') ?? '');
        if (!organizationId || !taskId)
          return this.json(res, 400, { error: 'organizationId and taskId are required' });
        try {
          return this.json(res, 200, (await api.listPermissionRequests(token, {
            organizationId,
            taskId,
            status: (url.searchParams.get('status') as any) ?? undefined,
          })));
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
        if (action !== 'approve' && action !== 'deny' && action !== 'dismiss')
          return this.json(res, 400, { error: 'action must be approve | deny | dismiss' });
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
          return this.json(res, error instanceof CapabilityError ? 403 : 409, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const collaborationCancel = p.match(/^\/api\/agent\/collaboration\/([^/]+)\/cancel$/);
      if (collaborationCancel && method === 'POST') {
        try {
          return this.json(res, 200, await api.cancelAgentAction(token, collaborationCancel[1]!));
        } catch (error) {
          return this.json(res, error instanceof CapabilityError ? 403 : 409, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const desktopMatch = p.match(/^\/api\/tasks\/([^/]+)\/desktop$/);
      if (desktopMatch && method !== 'POST') return this.json(res, 405, { error: 'use POST to open a desktop' });
      if (desktopMatch && method === 'POST') {
        const taskId = desktopMatch[1]!;
        const task = (await store.getTask(taskId));
        const handle = worldHandleForView(task?.lastView, taskId, task ? (await store.effectiveProjectConfig(task.projectId)) : undefined);
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
            const project = (await store.getProject(task.projectId))!;
            (await store.createPreviewLease({ id: newId('desktop'), organizationId: project.organizationId!,
              projectId: project.id, taskId, worldId: access.handle.id, generation: access.handle.generation ?? 1,
              port: 6080, public: false, runnerLeaseId: access.runnerLeaseId, provider: access.handle.kind,
              createdBy: authRecord?.principal ?? session.user, createdAt: Date.now(), expiresAt }));
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
        const view = (await api.getTaskView(token, taskId, { live: true }).catch(liveViewUnavailable)) ?? (await store.getTask(taskId))?.lastView;
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
        const view = (await api.getTaskView(token, taskId, { live: true }).catch(liveViewUnavailable)) ?? (await store.getTask(taskId))?.lastView;
        const action = view?.reviewInfo?.actions?.[Number(b.index)];
        if (!action) return this.json(res, 404, { error: 'no such review action' });
        const task = (await store.getTask(taskId));
        if (action.kind === 'payment') {
          const request = action.requestId ? (await store.getPaymentSpendRequest(action.requestId)) : undefined;
          const organizationId = task ? (await store.getProject(task.projectId))?.organizationId : undefined;
          if (!request || request.taskId !== taskId || request.organizationId !== organizationId)
            return this.json(res, 404, { error: 'spend request not found for this task' });
          const paymentPermission = (await this.deps.tokens.check(token, 'payment:write',
            { organizationId, projectId: task?.projectId, taskId }));
          if (!paymentPermission.ok)
            return this.json(res, 403, { error: paymentPermission.reason ?? 'missing capability payment:write' });
          if (!this.deps.paymentRegistry && !this.deps.payments)
            return this.json(res, 503, { error: 'payments are unavailable' });
          const { BudgetService } = await import('../autonomy/payments.js');
          const budget = new BudgetService(store, this.deps.paymentRegistry ?? this.deps.payments!);
          const principal = actorPrincipal(callerIdentity.actor);
          const result = action.operation === 'deny'
            ? (await budget.deny(request.id, principal))
            : await budget.approve(request.id, principal);
          let resumed = false;
          if (result.status === 'granted') {
            resumed = await api.signalTask(token, taskId, 'followUp',
              `Payment request ${request.id} is approved and ready. Continue the purchase using the same request.`)
              .then(() => true, () => false);
          }
          return this.json(res, 200, { kind: 'payment', result, resumed });
        }
        const handle = worldHandleForView(view, taskId, task ? (await store.effectiveProjectConfig(task.projectId)) : undefined);
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
      // The capability check above scoped to the task in the path; the process
      // id must belong to that task too, or a caller could read (or stop) another
      // tenant's review action — or interactive terminal — by guessing its id.
      const raStopMatch = p.match(/^\/api\/tasks\/([^/]+)\/review-action\/([^/]+)\/stop$/);
      if (raStopMatch && method === 'POST') {
        if (!(await this.reviewActionBelongsTo(raStopMatch[2]!, raStopMatch[1]!))) return this.json(res, 404, { error: 'no such action process' });
        return this.json(res, 200, { ok: (await this.reviewActions.stop(raStopMatch[2]!)) });
      }
      const raStatusMatch = p.match(/^\/api\/tasks\/([^/]+)\/review-action\/([^/]+)$/);
      if (raStatusMatch && method === 'GET') {
        const st = (await this.reviewActionBelongsTo(raStatusMatch[2]!, raStatusMatch[1]!)) ? (await this.reviewActions.status(raStatusMatch[2]!)) : undefined;
        return this.json(res, st ? 200 : 404, st ?? { error: 'no such action process' });
      }
      const artifactMatch = p.match(/^\/api\/tasks\/([^/]+)\/artifact$/);
      if (artifactMatch && method === 'GET') {
        return this.serveArtifact(res, artifactMatch[1]!, url.searchParams.get('path') ?? '');
      }
      const artifactList = p.match(/^\/api\/tasks\/([^/]+)\/artifacts$/);
      if (artifactList && method === 'GET') return this.json(res, 200, (await store.listPromotedArtifacts(artifactList[1]!)));
      const artifactPromote = p.match(/^\/api\/tasks\/([^/]+)\/artifacts\/promote$/);
      if (artifactPromote && method === 'POST') {
        if (!this.deps.objects) return this.json(res, 503, { error: 'promoted artifact storage is not configured' });
        const taskId = artifactPromote[1]!;
        const task = (await store.getTask(taskId));
        const project = task ? (await store.getProject(task.projectId)) : undefined;
        const b = await this.body(req);
          const relPath = String(b.path ?? '');
        if (!task || !project?.organizationId || !relPath) return this.json(res, 400, { error: 'task and artifact path are required' });
        const handle = worldHandleForView(task.lastView, taskId, (await store.effectiveProjectConfig(project)));
        if (!handle) return this.json(res, 404, { error: 'no world for this task' });
        let access: Awaited<ReturnType<NonNullable<GatewayDeps['worldAccess']>['open']>> | undefined;
        try {
          access = this.deps.worldAccess ? await this.deps.worldAccess.open(taskId, handle) : undefined;
          const world = access?.world ?? await this.deps.worlds.open(handle);
          const data = await world.readFileBuffer(worldWorkingRelativePath(handle, relPath));
          if (data.length > MAX_REVIEW_ARTIFACT_BYTES) return this.json(res, 413, { error: 'artifact exceeds 100 MiB' });
          const id = newId('artifact');
          const name = String(b.name ?? path.basename(relPath)).slice(0, 240) || 'artifact';
          // The type is derived from the name, never taken from the request: a
          // caller-chosen `text/html` would be echoed back inline on this origin.
          const mediaType = ARTIFACT_MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
          const objectKey = `artifacts/${project.organizationId}/${project.id}/${taskId}/${id}`;
          const managedStorage = (await store.listStorageLocations(project.organizationId)).find((location) => location.kind === 'managed');
          if (managedStorage) (await store.reserveStorageUpload(`artifact:${id}`, project.organizationId, managedStorage.id,
            data.length, Date.now() + 60 * 60_000));
          try { await this.deps.objects.put(objectKey, data, mediaType); }
          catch (error) { if (managedStorage) (await store.releaseStorageUpload(`artifact:${id}`)); throw error; }
          const ttlMs = b.ttlMs == null ? undefined : Math.max(60_000, Math.min(Number(b.ttlMs), 365 * 24 * 60 * 60 * 1000));
          let artifact: Awaited<ReturnType<Store['savePromotedArtifact']>>;
          try {
            artifact = (await store.savePromotedArtifact({ id, organizationId: project.organizationId, projectId: project.id,
              taskId, objectKey, sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.length,
              mediaType, name, createdAt: Date.now(), ...(ttlMs ? { expiresAt: Date.now() + ttlMs } : {}) }));
            (await store.recordUsage({ id: `usage:artifact:${id}`, organizationId: project.organizationId,
              projectId: project.id, taskId, worldId: handle.id, provider: 'managed-object-store',
              kind: 'resource.storage', quantity: data.length, unit: 'byte', costMicros: 0, fundingSource: 'managed',
              startedAt: artifact.createdAt, endedAt: artifact.createdAt, metadata: { artifactId: id, mediaType } }));
          } catch (error) {
            await this.deps.objects.delete(objectKey).catch(() => undefined);
            throw error;
          } finally { if (managedStorage) (await store.releaseStorageUpload(`artifact:${id}`)); }
          return this.json(res, 200, artifact);
        } finally { await access?.release(); }
      }
      const promotedArtifact = p.match(/^\/api\/artifacts\/([^/]+)$/);
      if (promotedArtifact) {
        const artifact = (await store.getPromotedArtifact(promotedArtifact[1]!));
        if (!artifact || (artifact.expiresAt != null && artifact.expiresAt <= Date.now())) return this.json(res, 404, { error: 'artifact not found' });
        if (method === 'GET') {
          if (!this.deps.objects) return this.json(res, 503, { error: 'artifact storage is unavailable' });
          const data = await this.deps.objects.get(artifact.objectKey);
          if (crypto.createHash('sha256').update(data).digest('hex') !== artifact.sha256)
            return this.json(res, 502, { error: 'artifact integrity check failed' });
          res.writeHead(200, { ...untrustedContentHeaders(artifact.mediaType, artifact.name),
            'content-length': String(data.length), 'cache-control': 'private, no-store' });
          return void res.end(data);
        }
        if (method === 'DELETE') {
          (await store.deletePromotedArtifact(artifact.id));
          await this.deps.objects?.delete(artifact.objectKey);
          return this.json(res, 200, { ok: true });
        }
      }
      const previewMatch = p.match(/^\/api\/tasks\/([^/]+)\/preview\/(\d+)(\/.*)?$/);
      if (previewMatch) return this.json(res, 405,
        { error: 'create a preview with POST /api/tasks/:id/preview-leases' });
      const previewLeases = p.match(/^\/api\/tasks\/([^/]+)\/preview-leases$/);
      if (previewLeases && method === 'GET') return this.json(res, 200,
        (await store.listPreviewLeases(previewLeases[1]!)).map((lease) => ({ ...lease, tokenHash: undefined })));
      if (previewLeases && method === 'POST') {
        const taskId = previewLeases[1]!;
        const task = (await store.getTask(taskId));
        const project = task ? (await store.getProject(task.projectId)) : undefined;
        const handle = worldHandleForView(task?.lastView, taskId, project ? (await store.effectiveProjectConfig(project)) : undefined);
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
          lease = (await store.createPreviewLease({ id: newId('preview'), organizationId: project.organizationId,
            projectId: project.id, taskId, worldId: handle.id, generation: handle.generation ?? 1, port,
            public: isPublic, ...(rawToken ? { tokenHash: hashPreviewToken(rawToken) } : {}),
            runnerLeaseId, provider: handle.kind, createdBy: authRecord?.principal ?? session.user,
            createdAt: Date.now(), expiresAt: Date.now() + ttlMs }));
        } catch (error) {
          if (runnerLeaseId) (await this.deps.runners?.release(runnerLeaseId, handle.kind));
          throw error;
        }
        return this.json(res, 200, { ...lease, tokenHash: undefined,
          url: previewLeaseUrl(lease.id, '/', rawToken) });
      }
      const previewLease = p.match(/^\/api\/preview-leases\/([^/]+)$/);
      if (previewLease && method === 'DELETE') {
        const lease = (await store.revokePreviewLease(previewLease[1]!));
        if (!lease) return this.json(res, 404, { error: 'preview lease not found' });
        const handle = (await store.currentWorld(lease.worldId)) as import('../world/types.js').WorldHandle | undefined;
        if (handle && this.deps.worldAccess) await this.deps.worldAccess.releaseLeaseAndParkIfIdle(handle, lease.runnerLeaseId);
        else if (lease.runnerLeaseId) (await this.deps.runners?.release(lease.runnerLeaseId, lease.provider));
        return this.json(res, 200, { ok: true });
      }
      // Conversation file links are readable wherever the conversation itself
      // is readable. They use the same world confinement as review artifacts,
      // but unknown extensions default to inline text for a useful source view.
      const fileMatch = p.match(/^\/api\/tasks\/([^/]+)\/file$/);
      if (fileMatch && method === 'GET') {
        return this.serveArtifact(res, fileMatch[1]!, url.searchParams.get('path') ?? '', true);
      }
      const timingMatch = p.match(/^\/api\/tasks\/([^/]+)\/timing$/);
      if (timingMatch && method === 'GET') return this.json(res, 200, await api.taskTiming(token, timingMatch[1]!));
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
      const conversationDownloadMatch = p.match(/^\/api\/tasks\/([^/]+)\/conversation\.jsonl$/);
      if (conversationDownloadMatch && method === 'GET') {
        const taskId = conversationDownloadMatch[1]!;
        const task = (await store.getTask(taskId));
        if (!task) return this.json(res, 404, { error: 'task not found' });
        const requestedRole = url.searchParams.get('role') ?? 'do';
        if (!/^[a-z0-9_-]+$/i.test(requestedRole)) return this.json(res, 400, { error: 'invalid agent role' });
        // Keep the raw native file behind the same service-level authorization as
        // the ordinary conversation API. Native JSONL is what the provider CLI
        // can actually fork; a re-serialized UI transcript is not resumable.
        const conversation = await api.taskConversation(token, taskId, requestedRole);
        const view = await api.getTaskView(token, taskId).catch(() => task.lastView);
        try {
          const objects = this.deps.objects ?? new LocalObjectStore(paths().objects);
          const boundId = url.searchParams.get('exportId');
          let data: Buffer, filename: string, source: string, warnings: PanagentWarning[] = [];
          if (boundId) {
            const exported = await readCodexConversationExport(objects, taskId, requestedRole, boundId, store);
            ({ data, filename, source, warnings } = exported);
          } else {
            const stored = (await storedConversationSession(store, taskId, task.intentId, requestedRole,
              view?.agents?.[requestedRole]?.provider));
            const provider = stored.provider;
            if (!provider || (!stored.source && !conversation.messages.length))
              return this.json(res, 404, { error: 'this agent does not have a downloadable conversation' });
            const sessionId = stored.id ?? conversationExportSessionId(taskId, requestedRole, provider);
            const generate = () => exportConversationWithPanagent({ messages: conversation.messages,
              provider, sessionId, title: `${task.title} · ${requestedRole}`, cwd: view?.worldPath });
            if (provider === 'codex') {
              const exported = await createCodexConversationExport(objects, taskId, requestedRole, sessionId,
                stored.home && stored.id ? { home: stored.home } : { generated: await generate() }, store,
                (await (await this.taskSecrets(taskId)).refresh()));
              ({ data, filename, source, warnings } = exported);
            } else {
              if (stored.source) data = await fs.promises.readFile(stored.source);
              else ({ data, warnings } = await generate());
              filename = `${provider}-${sessionId}.jsonl`.replace(/[^a-zA-Z0-9_.-]/g, '_');
              source = stored.source ? 'native' : 'generated';
            }
          }
          // The provider's own file stays intact for resume; the copy served is
          // masked byte for byte of everything the task received (SS-3).
          data = (await (await this.taskSecrets(taskId)).refresh()).mask(data);
          const warningsHeader = conversionWarningsHeader(warnings);
          res.writeHead(200, {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-disposition': `attachment; filename="${filename}"`,
            'content-length': String(data.length),
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
            'x-karmax-conversation-source': source,
            ...(warningsHeader ? { 'x-karmax-conversation-warnings': warningsHeader } : {}),
            'x-karmax-cell': this.deps.cellId ?? 'local',
          });
          return void res.end(data);
        } catch (error) {
          if (error instanceof ConversationExportExpired) return this.json(res, 410, { error: error.message });
          return this.json(res, 409, { error: `conversation export failed: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
      const explanationMatch = p.match(/^\/api\/tasks\/([^/]+)\/explanations$/);
      if (explanationMatch) {
        const taskId = explanationMatch[1]!;
        const task = (await store.getTask(taskId));
        if (!task) return this.json(res, 404, { error: 'task not found' });
        if (method === 'GET') {
          // Explanations are sparse and loaded outside the task page's bounded
          // event window. Recover the original provider message with each older
          // annotation so the browser can still place it directly beneath its
          // source instead of treating it as an orphan at the end of the thread.
          const explanations = (await __asyncCollections.map((await store.eventsOfType(taskId, 'conversation.explanation')), async (event) => {
            if (event.payload?.sourceEvent || !String(event.payload?.sourceKey ?? '').startsWith('activity:')) return event;
            const seq = Number(String(event.payload.sourceKey).slice('activity:'.length));
            const sourceEvent = Number.isSafeInteger(seq) ? (await store.eventBySeq(taskId, seq)) : undefined;
            if (sourceEvent?.type !== 'agent.activity' || sourceEvent.payload?.role !== event.payload?.role
              || sourceEvent.payload?.kind !== 'message') return event;
            return { ...event, payload: { ...event.payload, sourceEvent } };
          }));
          return this.json(res, 200, explanations);
        }
        if (method !== 'POST') return this.json(res, 405, { error: 'method not allowed' });
        const project = (await store.getProject(task.projectId));
        if (!project) return this.json(res, 404, { error: 'task project not found' });
        const body = await this.body(req);
        const role = typeof body.role === 'string' && /^[a-z0-9_-]+$/i.test(body.role) ? body.role : 'do';
        const sourceKey = typeof body.sourceKey === 'string' ? body.sourceKey.slice(0, 500) : '';
        const conversation = await api.taskConversation(token, taskId, role);
        let message: string | undefined;
        let sourceEvent: Awaited<ReturnType<typeof store.eventBySeq>>;
        let sourceRequest: { text: string; ts: number } | undefined;
        let userContext: string[] = [];
        if (sourceKey.startsWith('input-request:')) {
          const saved = (await store.eventsOfType(taskId, 'conversation.explanation'))
            .find((event) => event.payload?.role === role && event.payload?.sourceKey === sourceKey && event.payload?.sourceRequest);
          if (saved) {
            const source = saved.payload.sourceRequest as { text?: unknown; ts?: unknown };
            if (typeof source.text === 'string' && typeof source.ts === 'number') {
              sourceRequest = { text: source.text, ts: source.ts };
            }
          } else {
            const view = await api.getTaskView(token, taskId);
            const followUp = view?.actions.find((action) => action.name === 'followUp');
            const detail = view?.waitingFor?.detail?.trim();
            if (!view || view.status !== 'waiting' || view.waitingFor?.kind !== 'human' || !detail
              || !followUp || (followUp.roles?.length && !followUp.roles.includes(role))
              || sourceKey !== `input-request:${view.updatedAt}` || body.inputRequest !== detail) {
              return this.json(res, 409, { error: 'This input request has changed. Refresh the conversation and try again.' });
            }
            sourceRequest = { text: detail, ts: view.updatedAt };
          }
          message = sourceRequest?.text;
          userContext = conversation.messages.filter((item) => item.role === 'user'
            && (!Number(item.ts) || Number(item.ts) <= Number(sourceRequest?.ts))).map((item) => item.text);
        } else if (sourceKey.startsWith('message:')) {
          const id = sourceKey.slice('message:'.length);
          const index = conversation.messages.findIndex((item) => item.id === id && item.role === 'agent');
          if (index >= 0) {
            message = conversation.messages[index]!.text;
            userContext = conversation.messages.slice(0, index)
              .filter((item) => item.role === 'user').map((item) => item.text);
          }
        } else if (sourceKey.startsWith('activity:')) {
          const seq = Number(sourceKey.slice('activity:'.length));
          const candidate = Number.isSafeInteger(seq) ? (await store.eventBySeq(taskId, seq)) : undefined;
          const event = candidate?.type === 'agent.activity' && candidate.payload?.role === role
            && candidate.payload?.kind === 'message' ? candidate : undefined;
          if (event) {
            sourceEvent = event;
            message = String(event.payload.title ?? '');
            userContext = conversation.messages.filter((item) => item.role === 'user'
              && (!Number(item.ts) || Number(item.ts) <= Number(event.ts))).map((item) => item.text);
          }
        }
        if (!message?.trim()) return this.json(res, 404, { error: 'agent message not found' });
        if (message.length > 500_000) return this.json(res, 400, { error: 'agent message is too long to explain' });
        let totalContext = 0;
        userContext = userContext.slice(-100).reverse().filter((text) => {
          if (totalContext + text.length > 500_000) return false;
          totalContext += text.length;
          return true;
        }).reverse();
        const defaults = (await this.explanationSettings(project.id)).effective;
        let settings: ExplanationSettings;
        let provider: string;
        try {
          settings = normalizeExplanationSettings(body.settings, defaults);
          provider = explanationProvider(settings.endpoint);
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        // Where the organization's key goes is a settings decision (RT-2): anyone
        // explaining a message may switch between known providers' own APIs, but
        // any other endpoint needs the authority that could save it as the default.
        if (settings.endpoint !== defaults.endpoint && !knownProviderEndpoint(settings.endpoint)
          && !(await this.deps.tokens.check(token, 'project:settings:write',
            { projectId: project.id, organizationId: project.organizationId, taskId })).ok)
          return this.json(res, 403, { error: 'Only someone who can change this project\'s explanation settings can use another endpoint' });
        const apiKey = (await this.explanationApiKey(provider, project.organizationId ?? 'org_personal', project.id, taskId));
        if (!apiKey) return this.json(res, 400, {
          error: `API key for ${provider} not found`,
          code: 'explanation_api_key_missing',
          provider,
        });
        try {
          // A hosted cell shares its network with every tenant: only public
          // HTTPS endpoints, resolved once and pinned (no DNS rebinding).
          const explanation = await requestExplanation({ settings, apiKey, message, userContext,
            ...(this.deps.hosted ? { fetchImpl: publicModelFetch } : {}) });
          const event = { taskId, type: 'conversation.explanation', ts: Date.now(), payload: {
            role, sourceKey, text: explanation, provider, model: settings.model,
            ...(sourceEvent ? { sourceEvent } : {}),
            ...(sourceRequest ? { sourceRequest } : {}),
          } };
          const seq = (await this.emitTaskEvent(event));
          return this.json(res, 200, { ...event, seq });
        } catch (error) {
          return this.json(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const forkAgentMatch = p.match(/^\/api\/tasks\/([^/]+)\/fork-agent$/);
      if (forkAgentMatch && method === 'POST') {
        const b = await this.body(req);
        return this.json(res, 200, await api.forkTaskAgent(token, { ...b, taskId: forkAgentMatch[1]! }));
      }
      const sessMatch = p.match(/^\/api\/tasks\/([^/]+)\/sessions$/);
      if (sessMatch && method === 'GET') {
        const id = sessMatch[1]!;
        const metadataOnly = url.searchParams.get('metadata') === '1';
        const t = (await store.getTask(id));
        // Include the exact effective agent selection captured at queue time (and
        // kept current after an accepted in-flight retune). Besides powering the
        // CLI fork command, the expanded task form uses this to prefill a newly
        // selected fork with the source agent's provider/model/effort.
        const view = await api.getTaskView(token, id).catch(liveViewUnavailable);
        const agents = view?.agents;
        const transcriptRoles = (view?.transcripts ?? []).map((transcript) => transcript.role);
        const roles = [...new Set(['do', 'merge', ...(RESOLVE_AGENT_ENABLED ? ['resolve'] : []), 'confirm', ...transcriptRoles])];
        const out: Record<string, { id: string; home?: string; provider?: string; model?: string; effort?: AgentSpec['effort'];
          exportId?: string; downloadable?: boolean; generated?: boolean; filename?: string;
          downloadUrl?: string; requiredCodexVersion?: string; exportError?: string }> = {};
        for (const role of roles) {
          const sessionTaskId = role === 'confirm' ? (t?.intentId ?? id) : id;
          const s = (await store.kvGet(`session:${sessionTaskId}:${role}`));
          let home: string | undefined;
          let provider: string | undefined;
          let model: string | undefined;
          let effort: AgentSpec['effort'];
          const meta = (await store.kvGet(`sessionmeta:${sessionTaskId}:${role}`));
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
          try {
            const stored = (await storedConversationSession(store, id, t?.intentId, role, spec?.provider ?? provider, metadataOnly));
            const resolvedProvider = stored.provider ?? spec?.provider ?? provider;
            const transcript = role === 'do'
              ? (view?.transcripts?.find((candidate) => candidate.role === role)?.messages ?? view?.messages ?? [])
              : (view?.transcripts?.find((candidate) => candidate.role === role)?.messages ?? []);
            const generated = !stored.source && !!downloadableProvider(resolvedProvider) && transcript.length > 0;
            let exportId = stored.source && stored.id
              ? stored.id
              : generated ? conversationExportSessionId(id, role, downloadableProvider(resolvedProvider)!) : undefined;
            let exportMetadata = {};
            if (!metadataOnly && resolvedProvider === 'codex' && (exportId || (stored.id && stored.home))) {
              const sessionId = stored.id ?? exportId!;
              const exported = await createCodexConversationExport(this.deps.objects ?? new LocalObjectStore(paths().objects),
                id, role, sessionId, stored.home && stored.id ? { home: stored.home } : {
                  generated: await exportConversationWithPanagent({ messages: transcript, provider: 'codex',
                    sessionId, title: `${t?.title} · ${role}`, cwd: view?.worldPath }),
                }, store, (await (await this.taskSecrets(id)).refresh()));
              exportId = exported.exportId;
              exportMetadata = { filename: exported.filename, requiredCodexVersion: exported.requiredCodexVersion,
                downloadUrl: `/api/tasks/${encodeURIComponent(id)}/conversation.jsonl?role=${encodeURIComponent(role)}&exportId=${exportId}` };
            }
            if (!s && !exportId) continue;
            out[role] = {
              id: s ?? exportId!,
              ...exportMetadata,
              ...((stored.home ?? home) ? { home: stored.home ?? home } : {}),
              ...(resolvedProvider ? { provider: resolvedProvider } : {}),
              ...(spec?.model || model ? { model: spec?.model ?? model } : {}),
              ...(spec?.effort || effort ? { effort: spec?.effort ?? effort } : {}),
              ...(exportId ? { ...(!metadataOnly ? { exportId } : {}), downloadable: true, ...(generated ? { generated: true } : {}) } : {}),
            };
          } catch (error) {
            if (s) out[role] = { id: s, provider: spec?.provider ?? provider, downloadable: false,
              exportError: error instanceof Error ? error.message : String(error) };
          }
        }
        return this.json(res, 200, out);
      }
      // Tier-2 declarative widgets (SPEC §10.2): resolve each contribution's
      // declared widget tree against the live view-model, server-side, so the UI
      // is a pure host widget library (draws descriptors, owns no resolve logic).
      const widgetsMatch = p.match(/^\/api\/tasks\/([^/]+)\/widgets$/);
      if (widgetsMatch && method === 'GET') {
        const id = widgetsMatch[1]!;
        const t = (await store.getTask(id));
        const view = (await api.getTaskView(token, id).catch(liveViewUnavailable)) ?? t?.lastView;
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
        return this.json(res, 200, await api.agentQueueView(token,
          url.searchParams.get('organizationId') ?? undefined));
      }
      if (p === '/api/agent-queue/move' && method === 'POST') {
        const b = await this.body(req);
        await api.moveAgentQueueItem(token, String(b.turnId), b.beforeTurnId ? String(b.beforeTurnId) : undefined,
          url.searchParams.get('organizationId') ?? undefined);
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
          if (sub === 'refs' && method === 'GET' && scope === 'project') return this.json(res, 200, (await api.wikiViews(token, id)));
          if (sub === 'history' && method === 'GET' && scope === 'organization')
            return this.json(res, 200, (await api.organizationWikiHistory(token, id, url.searchParams.get('path') ?? undefined)));
        } catch (error) {
          if (error instanceof CapabilityError) throw error;
          const conflict = /already exists/.test(String((error as Error)?.message));
          const declaredStatus = Number((error as { status?: unknown })?.status);
          const status = Number.isInteger(declaredStatus) && declaredStatus >= 400 && declaredStatus <= 599
            ? declaredStatus
            : conflict ? 409 : 400;
          return this.json(res, status, { error: error instanceof Error ? error.message : String(error) });
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
        return this.json(res, 200, (await api.listWorkflows(token, resourceOrganizationId)));
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
      if (pinsMatch && method === 'GET') return this.json(res, 200, (await api.workflowPins(token, pinsMatch[1]!)));
      if (pinsMatch && method === 'POST') {
        const b = await this.body(req);
        if (!b.workflow) return this.json(res, 400, { error: 'workflow required' });
        return this.json(res, 200, (await api.pinWorkflow(token, { projectId: pinsMatch[1]!, workflow: String(b.workflow), version: b.version ? String(b.version) : undefined })));
      }

      // Agent-role defaults resolve project → organization → bundled/legacy.
      // Unscoped access is reserved for the operator-owned fallback records.
      if (p === '/api/mcp' || p.startsWith('/api/mcp/')) {
        const organizationId = requestedScope.organizationId;
        const projectId = requestedScope.projectId;
        if (!organizationId || !(await store.getOrganization(organizationId))) return this.json(res, 400, { error: 'Choose an organization or project' });
        if (projectId && (await store.getProject(projectId))?.organizationId !== organizationId) return this.json(res, 404, { error: 'Project not found in this organization' });
        if (!this.deps.broker) return this.json(res, 503, { error: 'Credential vault unavailable' });
        const connections = new McpConnections(store, this.deps.broker, organizationId);
        const actor = actorPrincipal(callerIdentity.actor);
        try {
          if (p === '/api/mcp/oauth-info' && method === 'GET') {
            const origin = process.env.KARMAX_PUBLIC_URL ?? (hostLocal() ? url.origin : undefined);
            return this.json(res, 200, { redirectUri: origin ? new URL('/mcp-callback', origin).href : undefined,
              clientMetadataUrl: mcpClientMetadata()?.client_id });
          }
          if (p === '/api/mcp/registry' && method === 'GET')
            return this.json(res, 200, await registrySearch(url.searchParams.get('search') ?? '', url.searchParams.get('cursor') ?? ''));
          if (p === '/api/mcp' && method === 'GET') return this.json(res, 200, (await connections.list(projectId)).map((c) => ({ ...c,
            connected: c.auth === 'none' || (c.auth === 'secrets' ? c.secretNames.length > 0 : !!connections.secret(c).tokens?.access_token) })));
          if (p === '/api/mcp' && method === 'POST') {
            const saved = (await connections.save(await this.body(req), projectId));
            (await store.appendAudit({ principalId: actor, action: 'mcp.connection.saved', scopeKey: auditScope, detail: { id: saved.id, revision: saved.revision } }));
            return this.json(res, 200, saved);
          }
          const match = p.match(/^\/api\/mcp\/(mcp_[a-f0-9]{24})(?:\/(authorize|callback|test))?$/);
          if (match) {
            const c = (await connections.get(match[1]!, projectId));
            if (c.projectId !== projectId) return this.json(res, 403, { error: 'Manage this connection in its owning settings' });
            if (!match[2] && method === 'DELETE') {
              (await connections.remove(c.id, projectId));
              (await store.appendAudit({ principalId: actor, action: 'mcp.connection.deleted', scopeKey: auditScope, detail: { id: c.id } }));
              return this.json(res, 200, { ok: true });
            }
            if (match[2] === 'test' && method === 'POST') return this.json(res, 200, await probeConnection(connections, c));
            if (match[2] === 'authorize' && method === 'POST') {
              const origin = process.env.KARMAX_PUBLIC_URL ?? (hostLocal() ? url.origin : undefined);
              if (!origin) throw new Error('Configure the public Tavya URL before connecting OAuth');
              return this.json(res, 200, await beginOAuth(connections, c, actor, new URL('/mcp-callback', origin).href));
            }
            if (match[2] === 'callback' && method === 'POST') {
              const b = await this.body(req);
              await finishOAuth(connections, c, actor, b.state, b.code);
              (await store.appendAudit({ principalId: actor, action: 'mcp.connection.authorized', scopeKey: auditScope, detail: { id: c.id } }));
              return this.json(res, 200, { ok: true });
            }
          }
          return this.json(res, 404, { error: 'MCP route not found' });
        } catch (error) { return this.json(res, 400, { error: error instanceof Error ? error.message : 'Connection failed' }); }
      }
      if (p === '/api/profiles' && method === 'GET') {
        // Annotate each profile with the workflow(s) that declare its role, so the
        // UI can show a role belongs to (e.g.) software-dev + merge-only (SPEC §7.1).
        const { roleDef } = await import('../contrib/manifests.js');
        const withRole = (pr: any) => {
          const definition = roleDef(pr.role);
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
            visibleProfile.inherited = {
              ...visibleInherited,
              ...(definition ? { name: definition.label } : {}),
            };
          }
          return {
            ...visibleProfile,
            // Role labels are manifest vocabulary, not user data. This also
            // upgrades stored "Do agent" rows without rewriting the database.
            ...(definition ? { name: definition.label } : {}),
            roleWorkflows: definition?.workflows ?? [],
          };
        };
        const visible = (pr: { role: string }) => !!roleDef(pr.role);
        const pid = url.searchParams.get('projectId') ?? undefined;
        const requestedOrganizationId = url.searchParams.get('organizationId') ?? undefined;
        const globals = (await store.listProfiles()).filter((pr) => !pr.id.includes('::') && visible(pr))
          .map(pr => ({ ...pr, mcpConnections: pr.mcpConnections ?? [...DEFAULT_MCP_CONNECTIONS] }));
        if (!pid && !requestedOrganizationId) return this.json(res, 200, globals.map(withRole));
        const organizationId = requestedOrganizationId ?? (pid ? (await store.getProject(pid))?.organizationId : undefined);
        if (!organizationId) return this.json(res, 404, { error: 'organization not found' });
        const organizations = (await __asyncCollections.map(globals, async (global) => {
          const own = (await store.getProfile(organizationProfileId(organizationId, global.role)));
          return withRole({ ...(own ?? global), ...(own?.mcpConnections === undefined && global.mcpConnections !== undefined ? { mcpConnections: global.mcpConnections } : {}), id: organizationProfileId(organizationId, global.role), role: global.role,
            scope: own ? 'organization' : 'inherited', inherited: global });
        }));
        if (!pid) return this.json(res, 200, organizations);
        const view = (await __asyncCollections.map(organizations, async (organization) => {
          const own = (await store.getProfile(projectProfileId(pid, organization.role)));
          return withRole({ ...(own ?? organization), id: projectProfileId(pid, organization.role), role: organization.role,
            scope: own ? 'project' : 'inherited', inherited: organization });
        }));
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
        try { validateMcpSelection(b.mcpConnections); } catch (e) { return this.json(res, 400, { error: (e as Error).message }); }
        if (b.provider !== undefined && !isAgentProvider(b.provider)) {
          return this.json(res, 400, { error: `unknown agent provider "${String(b.provider)}"` });
        }
        const { roleDef } = await import('../contrib/manifests.js');
        const definition = roleDef(String(b.role));
        if (!definition) return this.json(res, 400, { error: `unknown or disabled agent role "${String(b.role)}"` });
        const queryProjectId = url.searchParams.get('projectId') ?? undefined;
        const queryOrganizationId = url.searchParams.get('organizationId') ?? undefined;
        if (b.projectId && String(b.projectId) !== queryProjectId)
          return this.json(res, 400, { error: 'project profile scope must match the request' });
        if (b.organizationId && String(b.organizationId) !== queryOrganizationId)
          return this.json(res, 400, { error: 'organization profile scope must match the request' });
        const id = queryProjectId ? projectProfileId(queryProjectId, String(b.role))
          : queryOrganizationId ? organizationProfileId(queryOrganizationId, String(b.role)) : b.id;
        if (!id) return this.json(res, 400, { error: 'profile needs id or projectId' });
        const {
          projectId: _pid,
          organizationId: _oid,
          scope: _s,
          inherited: _i,
          modelProvider: _legacyModelProvider,
          allowedAccounts: _legacyAllowedAccounts,
          auth: _legacyAuth,
          // Task authorization owns permissions. A runtime profile must neither
          // narrow nor escalate the grant selected for the task.
          capabilities: _legacyCapabilities,
          ...rest
        } = b;
        (await store.upsertProfile({ provider: 'claude', ...rest, name: definition.label, id }));
        return this.json(res, 200, (await store.getProfile(id)) ?? null);
      }
      // Reset one scoped override back to the next inherited layer.
      const profDelMatch = p.match(/^\/api\/profiles\/(.+)$/);
      if (profDelMatch && method === 'DELETE') {
        const id = decodeURIComponent(profDelMatch[1]!);
        const queryProjectId = url.searchParams.get('projectId') ?? undefined;
        const queryOrganizationId = url.searchParams.get('organizationId') ?? undefined;
        if (queryProjectId && !id.startsWith(`${queryProjectId}::`))
          return this.json(res, 400, { error: 'project profile scope must match the request' });
        if (queryOrganizationId && !id.startsWith(`organization:${queryOrganizationId}::`))
          return this.json(res, 400, { error: 'organization profile scope must match the request' });
        if (!queryProjectId && !queryOrganizationId && id.includes('::'))
          return this.json(res, 400, { error: 'scoped profile deletion needs its project or organization' });
        (await store.deleteProfile(id));
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
          ...await provider.platformStatus(),
          canManage: (await this.deps.tokens.check(token, 'settings:write')).ok,
          callbackUrl: `${publicUrl}/api/payments/stripe/callback`,
          webhookUrl: `${publicUrl}/api/payments/stripe/webhook`,
        });
        if (method === 'PUT') {
          if (!(await this.deps.tokens.check(token, 'settings:write')).ok)
            return this.json(res, 403, { error: `Only a ${(await this.siteName)} installation administrator can configure the shared Stripe Connect application` });
          const b = await this.body(req);
          try {
            return this.json(res, 200, {
              ...await provider.configurePlatform({
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
        const list = (await this.deps.paymentRegistry?.list(context))
          ?? (this.deps.payments ? [(await this.deps.payments.describe(context))] : []);
        const active = (await this.deps.paymentRegistry?.active(organizationId))?.name ?? this.deps.payments?.name ?? null;
        return this.json(res, 200, { providers: list, active });
      }
      if ((p === '/api/payments/connect' || organizationPayments?.[2] === 'connect') && method === 'POST') {
        const subject = requireHumanSubject(callerIdentity);
        const b = await this.body(req);
        const prov = this.deps.paymentRegistry?.get(b.provider) ?? this.deps.payments;
        if (!prov) return this.json(res, 400, { error: 'no payment provider configured' });
        const organizationId = authRecord?.organizationId ?? requestedScope.organizationId ?? 'org_personal';
        const result = await prov.connect({
          organizationId,
          userId: subject.userId,
          redirectUri: `${this.publicUrl(req)}/api/payments/stripe/callback`,
        });
        if (result.status === 'connected') {
          const current = (await store.getSettings(`organization:${organizationId}`, 'payments')) ?? {};
          (await store.setSettings(`organization:${organizationId}`, 'payments', { ...current, provider: prov.name }));
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
        const current = (await store.getSettings(`organization:${organizationId}`, 'payments')) ?? {};
        (await store.setSettings(`organization:${organizationId}`, 'payments', { ...current, provider: 'mock' }));
        return this.json(res, 200, { ok: true });
      }
      const paymentBalance = p.match(/^\/api\/organizations\/([^/]+)\/payments\/balance$/);
      if (paymentBalance && method === 'GET') {
        const providerName = url.searchParams.get('provider')
          ?? ((await store.getSettings(`organization:${paymentBalance[1]}`, 'payments')) as any)?.provider
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
        return this.json(res, 200, (await store.listPaymentSpendRequests({ organizationId: paymentRequests[1]! })));
      const paymentTransactions = p.match(/^\/api\/organizations\/([^/]+)\/payments\/transactions$/);
      if (paymentTransactions && method === 'GET')
        return this.json(res, 200, (await store.listPaymentTransactions(paymentTransactions[1]!)));
      const paymentResolve = p.match(/^\/api\/organizations\/([^/]+)\/payments\/requests\/([^/]+)\/(approve|deny)$/);
      if (paymentResolve && method === 'POST') {
        const request = (await store.getPaymentSpendRequest(paymentResolve[2]!));
        if (!request || request.organizationId !== paymentResolve[1])
          return this.json(res, 404, { error: 'spend request not found in this organization' });
        const { BudgetService } = await import('../autonomy/payments.js');
        if (!this.deps.paymentRegistry && !this.deps.payments)
          return this.json(res, 503, { error: 'payments are unavailable' });
        const budget = new BudgetService(store, this.deps.paymentRegistry ?? this.deps.payments!);
        const principal = actorPrincipal(callerIdentity.actor);
        const result = paymentResolve[3] === 'approve'
          ? await budget.approve(request.id, principal)
          : (await budget.deny(request.id, principal));
        let resumed = false;
        if (result.status === 'granted') {
          resumed = await api.signalTask(token, request.taskId, 'followUp',
            `Payment request ${request.id} is approved and ready. Continue the purchase using the same request.`)
            .then(() => true, () => false);
        }
        return this.json(res, 200, { ...result, resumed });
      }

      // Application connections. Derive tenant/task identity from the verified
      // token; body ids can only narrow the caller's existing authority.
      if (p === '/api/connections' || p.startsWith('/api/connections/')) {
        const service = this.connections();
        if (!service) return this.json(res, 503, { error: 'Connection storage is unavailable' });
        const org = authRecord.organizationId ?? requestedScope.organizationId ?? 'org_personal';
        const callerTaskId = authRecord.taskId && authRecord.taskId !== '*' ? authRecord.taskId : undefined;
        const taskId = callerTaskId ?? url.searchParams.get('taskId') ?? undefined;
        const task = taskId ? (await store.getTask(taskId)) : undefined;
        if (taskId && (!task || (await store.getProject(task.projectId))?.organizationId !== org ||
          !(await this.deps.tokens.check(token, 'task:read', { projectId: task.projectId, organizationId: org })).ok))
          return this.json(res, 403, { error: 'Task access denied' });
        const ownerId = callerIdentity.humanSubject?.userId;
        const requireOwner = () => requireHumanSubject(callerIdentity).userId;
        const projectId = task?.projectId ?? url.searchParams.get('projectId') ?? undefined;
        if (!task && projectId && ((await store.getProject(projectId))?.organizationId !== org || !(await this.deps.tokens.check(token, 'project:read', { projectId, organizationId: org })).ok)) return this.json(res, 403, { error: 'Project access denied' });
        const b = ['POST', 'PUT'].includes(method) ? await this.body(req) : {};
        try {
          if (p === '/api/connections/config') {
            if (method === 'PUT') await service.configure(String(b.apiKey ?? ''));
            if (method === 'GET' || method === 'PUT') return this.json(res, 200, { configured: service.configured(), canConfigure: (await this.deps.tokens.check(token, 'settings:write')).ok });
          }
          if (p === '/api/connections/catalog' && method === 'GET')
            return this.json(res, 200, await service.catalog(url.searchParams.get('search') ?? ''));
          if (p === '/api/connections' && method === 'GET') {
            if (!taskId && !ownerId) requireOwner();
            const listed = (await service.list(org, { ownerId, taskId, projectId }));
            // A person answering a task request may reuse their own connected account.
            if (!callerTaskId && ownerId && taskId) for (const c of listed as Array<typeof listed[number] & { reusable?: unknown }>)
              if (c.status === 'requested' && (!c.ownerId || c.ownerId === ownerId))
                c.reusable = (await service.reusable(org, ownerId, c)).map(({ id, label, createdAt }) => ({ id, label, createdAt }));
            return this.json(res, 200, listed);
          }
          if (p === '/api/connections/request' && method === 'POST') {
            if (!callerTaskId || !task) return this.json(res, 400, { error: 'A task-agent token is required' });
            const why = String(b.why ?? '');
            let c;
            if (typeof b.mcp === 'string' && b.mcp.trim()) {
              const server = await service.resolveMcp(b.mcp);
              const available = (await service.list(org, { taskId, projectId })).find(c => c.mcp?.url === server.transport.url && c.status === 'active');
              if (available) return this.json(res, 200, { status: 'connected', connection: available });
              c = (await service.requestMcp(org, server, task.id, authRecord.role ?? 'do', why));
            } else {
              const toolkit = String(b.toolkit ?? '');
              if (!toolkit) return this.json(res, 400, { error: 'Pass mcp (an MCP Registry name or HTTPS URL) or a Composio toolkit' });
              const available = (await service.list(org, { taskId, projectId })).find(c => !c.mcp && c.toolkit === toolkit && c.status === 'active');
              if (available) return this.json(res, 200, { status: 'connected', connection: available });
              c = (await service.request(org, toolkit, task.id, authRecord.role ?? 'do', why));
            }
            if (c.status === 'requested') (await this.emitTaskEvent({ taskId: task.id, type: 'connection.requested', ts: Date.now(),
              payload: { requestId: c.id, connectionId: c.id, toolkit: c.toolkit, why: c.why } }));
            return this.json(res, 200, { status: c.status === 'denied' || c.status === 'disconnected' ? 'denied' : 'needs_connection',
              connection: service.view(c), detail: 'A Connect button is available in this task’s Approval Requests. Continue independent work; the task resumes after sign-in.' });
          }
          if (p === '/api/connections/connect' && method === 'POST') {
            const userId = requireOwner();
            if (callerTaskId) return this.json(res, 403, { error: 'Connect accounts from the Connections or task page' });
            if (b.id) {
              const c = (await service.get(org, String(b.id)));
              if (c.taskId) {
                const t = (await store.getTask(c.taskId));
                if (!t || !(await this.deps.tokens.check(token, 'task:edit', { projectId: t.projectId, organizationId: org })).ok)
                  return this.json(res, 403, { error: 'Task access denied' });
              }
            }
            const origin = process.env.KARMAX_PUBLIC_URL ?? (hostLocal() ? url.origin : undefined);
            const result = await service.connect(org, userId, { id: b.id, toolkit: b.toolkit, label: b.label, restart: b.restart === true,
              useConnectionId: typeof b.useConnectionId === 'string' ? b.useConnectionId : undefined,
              redirect: origin ? new URL('/mcp-callback', origin).href : undefined });
            if (result.connection.status === 'active') this.sweepConnections();
            return this.json(res, 200, result);
          }
          const match = p.match(/^\/api\/connections\/([^/]+)\/(refresh|access|disconnect|callback|tools|execute)$/);
          if (match) {
            const id = match[1]!; const action = match[2]!;
            const c = (await service.get(org, id));
            if (action === 'tools' || action === 'execute') {
              if (!callerTaskId || !projectId) return this.json(res, 403, { error: 'A task-agent token is required' });
              const trace = (await installationTiming(this.deps.store, { taskId: callerTaskId, role: authRecord.role,
                turnId: authRecord.executionId, workflowRunId: authRecord.executionRunId, attempt: authRecord.executionAttempt }, async row => {
                (await store.appendEvent({ taskId: callerTaskId, type: 'timing', ts: row.wallMs, payload: { ...row } }));
              }));
              if (action === 'tools' && method === 'GET') return this.json(res, 200,
                await withTiming(trace, () => trace.measure('service.discovery', () => service.tools(org, id, callerTaskId, projectId, url.searchParams.get('search') ?? ''))));
              if (action === 'execute' && method === 'POST') {
                if (!b.arguments || typeof b.arguments !== 'object' || Array.isArray(b.arguments))
                  return this.json(res, 400, { error: 'arguments must be an object' });
                return this.json(res, 200, await withTiming(trace, () => trace.measure('service.execution', () => service.execute(org, id, callerTaskId, projectId, String(b.tool ?? ''), b.arguments), undefined, undefined, toolFailed)));
              }
            } else {
              const userId = requireOwner();
              if (callerTaskId || (c.ownerId !== userId && !(action === 'disconnect' && !c.ownerId && c.taskId && (await this.deps.tokens.check(token, 'task:edit', { projectId: (await store.getTask(c.taskId))?.projectId, organizationId: org })).ok))) return this.json(res, 403, { error: 'Only the connection owner can manage this account' });
              if (action === 'callback' && method === 'POST') {
                const result = await service.finishMcp(org, id, userId, b.state, b.code); this.sweepConnections();
                return this.json(res, 200, result);
              }
              if (action === 'refresh' && method === 'POST') {
                const result = await service.refresh(org, id); this.sweepConnections();
                return this.json(res, 200, service.view(result));
              }
              if (action === 'access' && method === 'PUT') {
                if (!Array.isArray(b.projectIds) || b.projectIds.some((id: unknown) => typeof id !== 'string'))
                  return this.json(res, 400, { error: 'projectIds must be an array of project IDs' });
                for (const projectId of b.projectIds) if (!(await this.deps.tokens.check(token, 'project:settings:write', { projectId, organizationId: org })).ok)
                  return this.json(res, 403, { error: 'Project settings access required to share an account' });
                return this.json(res, 200, await service.share(org, id, userId, b.projectIds));
              }
              if (action === 'disconnect' && method === 'POST') {
                const result = await service.disconnect(org, id, userId); this.sweepConnections();
                return this.json(res, 200, result);
              }
            }
          }
          return this.json(res, 404, { error: 'Unknown connection operation' });
        } catch (e) {
          if (e instanceof ConnectionError) return this.json(res, e.status, { error: e.message });
          throw e;
        }
      }

      // ── vault items + credential access requests (wiki plans/PLAN-passwords §§4–7) ──
      if (p.startsWith('/api/vault')) {
        // Bind to the caller's own organization (tenant boundary). The token org
        // is authoritative and cannot be spoofed — auth() validated it against
        // membership; the query-param org only ever narrows within it.
        const organizationId = authRecord?.organizationId ?? requestedScope.organizationId ?? 'org_personal';
        const vault = new VaultItems(store, this.deps.broker, undefined, organizationId, authRecord?.participant);
        const caps = authRecord?.caps ?? [];
        // A human session's token is task-unscoped; per-task passes/extensions
        // only ever apply to real task-agent bearers.
        const callerTaskId = authRecord?.taskId && authRecord.taskId !== '*' ? authRecord.taskId : undefined;
        const principal = actorPrincipal(callerIdentity.actor);
        const defaultField = (type: string): any =>
          ({ login: 'password', 'api-key': 'secret', 'ssh-key': 'privateKey', env: 'env', passkey: 'passkey', session: 'session', note: 'note' })[type];
        // A saved browser session is never what a lookup by site means: it has no
        // field to fill or reveal, and must not shadow the site's login.
        const findItem = async (b: any) => (b.itemId ? (await vault.get(String(b.itemId))) : b.domain ? (await vault.findByDomain(String(b.domain))).find((i) => i.type !== 'session') : undefined);
        // Reading the vault regardless of item policy is Super-administrator authority.
        const vaultReadRefusal = async (doing: string) => {
          const refused = (await this.refusal(token, 'credential:reveal', { organizationId }));
          return refused ? `You cannot ${doing}: ${refused}` : undefined;
        };
        const editRefusal = async (prior: VaultItem | undefined, next: { policy?: any; domains?: string[] }) => {
          const weakens = prior ? weakensProtection(prior, next) : undefined;
          return weakens ? (await vaultReadRefusal(weakens)) : undefined;
        };

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
            const result = (await importBitwardenExport(vault, source, policy));
            (await store.appendAudit({
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
            }));
            return this.json(res, 200, result);
          } catch (e) {
            const status = e instanceof AttachmentError && /too large/i.test(e.message) ? 413 : 400;
            return this.json(res, status, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (p === '/api/vault/available' && method === 'GET') {
          if (!callerTaskId) return this.json(res, 400, { error: 'a task-agent token is required' });
          return this.json(res, 200, (await __asyncCollections.map((await __asyncCollections.filter((await vault.list()), async (item) => (await vault.covered(caps, callerTaskId, item)))), async (item) => ({
              id: item.id,
              type: item.type,
              label: item.label,
              ...(item.domains?.length ? { domains: item.domains } : {}),
              ...(item.username ? { username: item.username } : {}),
              ...(item.envVar ? { envVar: item.envVar } : {}),
              fields: item.fields,
              policy: (await vault.effectivePolicy(callerTaskId, item)),
            }))));
        }
        if (p === '/api/vault/items' && method === 'GET') {
          const canReveal = (await this.deps.tokens.check(token, 'credential:reveal', { organizationId })).ok;
          return this.json(res, 200, (await vault.listForSelection()).map((item) => ({ ...item, canReveal })));
        }
        if (p === '/api/vault/items' && method === 'POST') {
          const b = await this.body(req);
          const domains = Array.isArray(b.domains) ? b.domains.map(String) : typeof b.domains === 'string' ? b.domains.split(/[,\s]+/).filter(Boolean) : undefined;
          const refused = (await editRefusal(b.id ? (await vault.get(String(b.id))) : undefined, { policy: b.policy, domains }));
          if (refused) return this.json(res, 403, { error: refused });
          const saved = (await vault.save({
            id: b.id ? String(b.id) : undefined,
            type: b.type,
            label: String(b.label ?? ''),
            domains,
            username: b.username ? String(b.username) : undefined,
            tags: Array.isArray(b.tags) ? b.tags.map(String) : typeof b.tags === 'string' ? b.tags.split(/[,\s]+/).filter(Boolean) : undefined,
            envVar: b.envVar ? String(b.envVar) : undefined,
            ...(typeof b.exclusive === 'boolean' ? { exclusive: b.exclusive } : {}),
            policy: b.policy,
            secrets: b.secrets,
            provenance: { source: 'manual' },
          }));
          // A human rotating a secret propagates to its imported source or
          // agent-created write-back targets (field-level, notes preserved)
          // when the corresponding connector's write-back is on.
          let propagated;
          if (b.id && b.secrets && Object.keys(b.secrets).length) {
            try {
              const { defaultConnectors } = await import('../autonomy/connectors.js');
              propagated = await defaultConnectors(store, vault, this.deps.broker, organizationId,
                { hostLocal: this.hostLocal, hosted: this.deps.hosted, githubApp: this.deps.githubApp })
                .propagate(saved.id, Object.keys(b.secrets) as any);
            } catch (e) {
              propagated = { error: `vault updated, but pushing to the source store failed: ${e instanceof Error ? e.message : String(e)}` } as any;
            }
          }
          return this.json(res, 200, { ...saved, ...(propagated ? { propagated } : {}) });
        }
        // Explicit credential administration permits audited inspection for any
        // authorized actor. Ordinary task use still follows /api/vault/resolve
        // and its independent per-item grants and reveal policy.
        const viReveal = p.match(/^\/api\/vault\/items\/([^/]+)\/reveal$/);
        if (viReveal && method === 'POST') {
          const item = (await vault.get(viReveal[1]!));
          if (!item) return this.json(res, 404, { error: `no vault item ${viReveal[1]}` });
          const refused = (await vaultReadRefusal(`reveal "${item.label}"`));
          if (refused) return this.json(res, 403, { error: refused });
          const b = await this.body(req);
          const field = String(b.field ?? defaultField(item.type)) as any;
          if (!ITEM_FIELDS[item.type].includes(field))
            return this.json(res, 400, { error: `item type ${item.type} has no field ${field}` });
          if (!item.fields.includes(field))
            return this.json(res, 400, { error: `item "${item.label}" has no stored ${field}` });
          const value = (await vault.resolveField(item, field, { principal, mode: 'reveal', ...(callerTaskId ? { taskId: callerTaskId } : {}) }));
          res.setHeader('cache-control', 'private, no-store');
          return this.json(res, 200, { itemId: item.id, field, value });
        }
        const viDel = p.match(/^\/api\/vault\/items\/([^/]+)$/);
        if (viDel && method === 'DELETE') {
          (await vault.delete(viDel[1]!));
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
          const prior = b.id ? (await vault.get(String(b.id))) : undefined;
          if (b.id && !prior) return this.json(res, 404, { error: `no vault item ${b.id}` });
          const ownItem = !prior || !callerTaskId || prior.provenance.taskId === callerTaskId || allows(caps, 'credential:write');
          let saved;
          if (ownItem) {
            // An item this task created holds a secret it already knows.
            if (prior && !(callerTaskId && prior.provenance.taskId === callerTaskId)) {
              const refused = (await editRefusal(prior, { policy: b.policy, domains: Array.isArray(b.domains) ? b.domains.map(String) : undefined }));
              if (refused) return this.json(res, 403, { error: refused });
            }
            saved = (await vault.save({
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
            }));
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
            if (!(await vault.covered(caps, callerTaskId, prior!)))
              return this.json(res, 403, { error: 'this task was not granted this credential — request_credential first, or create your own item' });
            const secretFields = Object.keys(b.secrets ?? {});
            if (!secretFields.length)
              return this.json(res, 403, { error: 'only the secrets of a granted item can be updated (metadata and policy stay with its owner)' });
            saved = (await vault.save({ id: prior!.id, type: prior!.type, secrets: b.secrets }));
            (await store.appendAudit({ principalId: `task:${callerTaskId}`, action: 'vault.rotated',
              detail: { itemId: prior!.id, label: prior!.label, fields: secretFields } }));
          }
          // Best-effort propagation of rotated fields back to imported sources
          // and agent-created write-back targets (§9 updateSecret) — the vault
          // is already correct either way.
          let propagated;
          if (prior && b.secrets) {
            try {
              const { defaultConnectors } = await import('../autonomy/connectors.js');
              propagated = await defaultConnectors(store, vault, this.deps.broker, organizationId,
                { hostLocal: this.hostLocal, hosted: this.deps.hosted, githubApp: this.deps.githubApp })
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
              { hostLocal: this.hostLocal, hosted: this.deps.hosted, githubApp: this.deps.githubApp }).writeBackCreated(saved.id);
            for (const result of writeBack) {
              (await store.appendAudit({ principalId: callerTaskId ? `task:${callerTaskId}` : principal,
                action: result.error ? 'vault.write_back.failed' : 'vault.write_back',
                detail: { itemId: saved.id, ...result } }));
            }
          }
          // The task knows what it stored; keep it out of what is kept of the task.
          (await recordSecretRefs(store, callerTaskId, Object.keys(b.secrets ?? {})
            .filter((field): field is VaultFieldName => saved.fields.includes(field as VaultFieldName)).map((field) => handleRef(itemHandle(saved.id, field)))));
          return this.json(res, 200, { id: saved.id, label: saved.label, type: saved.type, fields: saved.fields,
            ...(propagated ? { propagated } : {}), ...(writeBack?.length ? { writeBack } : {}) });
        }
        // Plaintext reveal (§5C) — per-item grant + reveal policy, audited.
        if (p === '/api/vault/resolve' && method === 'POST') {
          const b = await this.body(req);
          const item = (await findItem(b));
          if (!item) return this.json(res, 200, { status: 'not_in_vault', reason: 'no matching vault item — use request_credential to ask for it' });
          const field = (b.field as any) ?? defaultField(item.type);
          if (!ITEM_FIELDS[item.type].includes(field) || !item.fields.includes(field)) return this.json(res, 400, { error: `item type ${item.type} has no field ${field}` });
          const decision = (await vault.access(caps, callerTaskId, item, 'reveal', { consume: true }));
          if (decision.status !== 'granted')
            return this.json(res, 200, (await this.autoRaiseCredential(vault, decision, { caps, taskId: callerTaskId, projectId: authRecord?.projectId, item, field: b.field, mode: 'reveal', why: b.why })));
          const value = field === 'totp'
            ? (await vault.totp(item, { taskId: callerTaskId, principal }))
            : (await vault.resolveField(item, field, { taskId: callerTaskId, principal, mode: 'reveal' }));
          const notes = b.field == null && item.type === 'login' && item.fields.includes('note')
            ? (await vault.resolveField(item, 'note', { taskId: callerTaskId, principal, mode: 'reveal' })) : undefined;
          return this.json(res, 200, { status: 'granted', itemId: item.id, field, ...(item.username ? { username: item.username } : {}), value, ...(notes !== undefined ? { notes } : {}) });
        }
        // Zero-exposure browser fill (§5B) — the secret goes gateway → CDP,
        // never through the agent. `username` fills metadata; `totp` fills the
        // current code computed broker-side from the stored seed.
        if (p === '/api/vault/fill' && method === 'POST') {
          const b = await this.body(req);
          const item = (await findItem(b));
          if (!item) return this.json(res, 200, { status: 'not_in_vault', reason: 'no matching vault item — use request_credential to ask for it' });
          const field = String(b.field ?? 'password');
          if (item.type !== 'login' || !['username', 'password', 'totp'].includes(field))
            return this.json(res, 400, { error: 'browser fill supports only login fields: username, password, totp' });
          if (!item.domains?.length) return this.json(res, 400, { error: 'browser fill requires credential domains' });
          const decision = (await vault.access(caps, callerTaskId, item, 'use'));
          if (decision.status !== 'granted')
            return this.json(res, 200, (await this.autoRaiseCredential(vault, decision, { caps, taskId: callerTaskId, projectId: authRecord?.projectId, item, field: b.field, mode: 'use', why: b.why })));
          if (field === 'username' && !item.username) return this.json(res, 400, { error: `item "${item.label}" has no ${field}` });
          if (field !== 'username' && !item.fields.includes(field as any)) return this.json(res, 400, { error: `item "${item.label}" has no ${field}` });
          const resolveText = async () => {
            if (field === 'username') return item.username!;
            const granted = await vault.access(caps, callerTaskId, item, 'use', { consume: true });
            if (granted.status !== 'granted') throw new Error('credential approval is no longer available');
            return field === 'totp'
              ? await vault.totp(item, { taskId: callerTaskId, principal })
              : await vault.resolveField(item, field as any, { taskId: callerTaskId, principal, mode: 'use' });
          };
          try {
            const origin = await this.fillCredential(callerTaskId, {
              selector: String(b.selector ?? ''), expectDomains: item.domains, resolveText,
            });
            return this.json(res, 200, { status: 'granted', itemId: item.id, filled: true, origin });
          } catch (e) {
            return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        }
        if (p === '/api/vault/requests' && method === 'GET') {
          return this.json(res, 200, (await __asyncCollections.map((await vault.requests({
            taskId: url.searchParams.get('taskId') ?? undefined,
            status: (url.searchParams.get('status') as any) ?? undefined,
          })), async (request) => (await this.credentialRequestView(request, organizationId)))));
        }
        // The pull model (§7): an agent escalates for an item it lacks.
        if (p === '/api/vault/requests' && method === 'POST') {
          const b = await this.body(req);
          if (!callerTaskId) return this.json(res, 400, { error: 'a task-agent token is required to request credential access' });
          const priorPending = new Set((await vault.requests({ taskId: callerTaskId, status: 'pending' })).map((request) => request.id));
          const decision = (await vault.request({
            taskId: callerTaskId,
            projectId: authRecord?.projectId,
            caps,
            itemId: b.itemId ? String(b.itemId) : undefined,
            domain: b.domain ? String(b.domain) : undefined,
            field: b.field,
            mode: b.mode,
            kind: b.kind === 'reset' ? 'reset' : undefined,
            why: b.why ? String(b.why) : undefined,
          }));
          if (decision.requestId && !priorPending.has(decision.requestId)) {
            const task = (await store.getTask(callerTaskId));
            const taskOrganization = task && (await store.getProject(task.projectId))?.organizationId;
            if (task && taskOrganization === organizationId) (await this.emitTaskEvent({
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
            }));
          }
          return this.json(res, 200, decision);
        }
        const vres = p.match(/^\/api\/vault\/requests\/([^/]+)\/resolve$/);
        if (vres && method === 'POST') {
          const b = await this.body(req);
          const action = String(b.action ?? '');
          if (!['once', 'task', 'always', 'deny'].includes(action)) return this.json(res, 400, { error: 'action must be once | task | always | deny' });
          // Approving hands the requester the secret; anyone who manages credentials may refuse.
          if (action !== 'deny') {
            const refused = (await vaultReadRefusal('approve credential requests'));
            if (refused) return this.json(res, 403, { error: refused });
          }
          try {
            const resolved = (await vault.resolve(vres[1]!, { action: action as any, by: principal, itemId: b.itemId ? String(b.itemId) : undefined }));
            const item = resolved.itemId ? (await vault.get(resolved.itemId)) : undefined;
            const label = item?.label ?? resolved.domain ?? 'credential';
            const message = action === 'deny'
              ? `[${(await this.siteName)} credential decision]\n\nAccess to "${label}" was denied. Do not request it again; continue without it or explain why the task cannot proceed.`
              : `[${(await this.siteName)} credential decision]\n\nAccess to "${label}" was approved (${action}). Retry the blocked ${resolved.mode} operation now; the grant is already active.`;
            const resume = await api.resumeAfterCredentialDecision(resolved.taskId, message);
            const task = (await store.getTask(resolved.taskId));
            if (task && (await store.getProject(task.projectId))?.organizationId === organizationId) {
              (await this.emitTaskEvent({
                taskId: resolved.taskId,
                type: 'credential.approval-resolved',
                ts: Date.now(),
                payload: { requestId: resolved.id, itemId: resolved.itemId, action, resumed: resume.resumed },
              }));
            }
            return this.json(res, 200, { ...(await this.credentialRequestView(resolved, organizationId)), resume });
          } catch (e) {
            return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        }

        // ── external store connectors (§9) ──
        if (p.startsWith('/api/vault/connectors')) {
          if (!this.deps.broker) return this.json(res, 400, { error: 'no credential broker configured' });
          const { defaultConnectors } = await import('../autonomy/connectors.js');
          const connectors = defaultConnectors(store, vault, this.deps.broker, organizationId,
            { hostLocal: this.hostLocal, hosted: this.deps.hosted, githubApp: this.deps.githubApp });
          if (p === '/api/vault/connectors' && method === 'GET') return this.json(res, 200, await connectors.describe());
          const connName = p.match(/^\/api\/vault\/connectors\/([^/]+)(?:\/([^/]+))?$/);
          if (connName && !connectors.get(connName[1]!)) return this.json(res, 404, { error: `no connector "${connName[1]}"` });
          if (connName && method === 'POST') {
            const b = await this.body(req);
            const action = connName[2];
            // A connector the vault writes back to receives its secrets: choosing
            // or redirecting one is vault read access. Importing is not.
            const exports = ['connect', 'write-back', 'retry-write-back', 'retry-writes'].includes(action ?? '')
              || (action === 'config' && b.writeBack === true) || (action === 'sync' && b.writeBack === true);
            if (exports) {
              const refused = (await vaultReadRefusal(`connect a password store the vault is copied to`));
              if (refused) return this.json(res, 403, { error: refused });
            }
            try {
              if (action === 'connect') {
                return this.json(res, 200, { connected: true, ...(await connectors.connect(connName[1]!, String(b.secret ?? ''))) });
              }
              if (action === 'config') {
                let config = typeof b.writeBack === 'boolean'
                  ? (await connectors.setConfig(connName[1]!, { writeBack: b.writeBack }))
                  : (await connectors.config(connName[1]!));
                if (b.autoSync && typeof b.autoSync === 'object') config = (await connectors.setAutoSync(connName[1]!, {
                  keepUpdated: b.autoSync.keepUpdated === true,
                  importNew: b.autoSync.importNew === true,
                  externalIds: Array.isArray(b.autoSync.externalIds) ? b.autoSync.externalIds.map(String) : [],
                  policy: b.autoSync.policy,
                }));
                return this.json(res, 200, config);
              }
              if (connName[1] === 'pass-git') {
                if (action === 'check') {
                  const secret = connectors.secretFor('pass-git');
                  if (!secret) throw new Error('Connect a password store first');
                  return this.json(res, 200, await connectors.get('pass-git')!.validateSecret!(secret));
                }
                if (action === 'catalog') {
                  const { GitPassConnector } = await import('../autonomy/connectors.js');
                  const connector = connectors.get('pass-git');
                  if (connector instanceof GitPassConnector) return this.json(res, 200, await connector.catalog());
                }
                if (action === 'retry-write-back') return this.json(res, 200, await connectors.retryWriteBack(String(b.itemId ?? '')) ?? { skipped: 'write-back disabled' });
                if (action === 'accept-remote') return this.json(res, 200, await connectors.acceptRemote(String(b.itemId ?? '')));
              }
              if (action === 'list') return this.json(res, 200, await connectors.get(connName[1]!)!.list());
              if (action === 'sync') return this.json(res, 200, await connectors.sync(connName[1]!, Array.isArray(b.externalIds) ? b.externalIds.map(String) : [],
                { policy: b.policy, writeBack: typeof b.writeBack === 'boolean' ? b.writeBack : undefined }));
              if (action === 'discard-writes') return this.json(res, 200, {discarded:(await connectors.discardWrites(connName[1]!))});
              if (action === 'retry-writes') return this.json(res, 200, await connectors.retryWrites({connector:connName[1]!}));
              if (action === 'write-back') return this.json(res, 200, (await connectors.writeBack(connName[1]!, String(b.itemId ?? ''))) ?? { skipped: 'write-back disabled for this connector' });
            } catch (e) {
              return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
            }
            return this.json(res, 404, { error: 'unknown connector action' });
          }
        }

        // ── saved browser sessions ──
        // A site's sign-in, captured from one task's browser and restored into
        // another's (browser-session.ts). This is how a site reached through
        // "Sign in with Google" is shared without the identity provider's
        // password, which would open every site federated through it. Holding
        // tasks refresh it after every turn (session-holds.ts).
        if (p === '/api/vault/session/save' || p === '/api/vault/session/use') {
          if (method !== 'POST') return this.json(res, 405, { error: 'use POST' });
          if (!callerTaskId) return this.json(res, 400, { error: 'sessions are saved from and restored into a task\'s own browser; call this with a task-agent token' });
          const b = await this.body(req);
          const { captureSession, restoreSession, parseSavedSession, sessionDomainError, sessionState } = await import('../autonomy/browser-session.js');
          const holds = await import('../autonomy/session-holds.js');
          const raise = (decision: { status: AccessStatus; reason?: string }, item: VaultItem) =>
            this.autoRaiseCredential(vault, decision, { caps, taskId: callerTaskId, projectId: authRecord?.projectId, item, mode: 'use', why: b.why });
          const busy = (item: VaultItem, heldBy: { taskId: string; num?: number; title?: string }) => this.json(res, 200, {
            status: 'busy', itemId: item.id, heldBy,
            reason: `${heldBy.num !== undefined ? `task #${heldBy.num}` : 'another task'} is signed in with "${item.label}", which works in one task at a time. Pause, then call use_session again; it frees up when that task's world parks or the task ends.`,
          });
          try {
            if (p === '/api/vault/session/save') {
              const prior = b.itemId ? (await vault.get(String(b.itemId))) : undefined;
              if (b.itemId && !prior) return this.json(res, 404, { error: `no vault item ${b.itemId}` });
              if (prior && prior.type !== 'session') return this.json(res, 400, { error: `vault item ${prior.id} is a ${prior.type}, not a saved session` });
              // Replacing another task's session takes the grant that using it does.
              if (prior && prior.provenance.taskId !== callerTaskId && !allows(caps, 'credential:write')) {
                const decision = (await vault.access(caps, callerTaskId, prior, 'use'));
                if (decision.status !== 'granted') return this.json(res, 200, await raise(decision, prior));
              }
              const domains = prior?.domains ?? (Array.isArray(b.domains) ? b.domains.map(String) : b.domain ? [String(b.domain)] : []);
              if (!domains.length) return this.json(res, 400, { error: 'name the site, e.g. domain "notion.so"' });
              for (const domain of domains) {
                const error = sessionDomainError(domain);
                if (error) return this.json(res, 400, { error });
              }
              if (prior) {
                const lease = await holds.acquireLease(store, organizationId, prior, callerTaskId);
                if (!lease.granted) return busy(prior, lease.heldBy);
              }
              const opener = await this.taskPageOpener(callerTaskId, 'saved sessions');
              if ('error' in opener) return this.json(res, 400, { error: opener.error });
              const page = await opener.open(domains);
              let captured: Awaited<ReturnType<typeof captureSession>>;
              try { captured = await captureSession(page.session, domains); } finally { await page.session.close(); }
              if (!captured.saved.cookies.length && !captured.saved.storage.length)
                return this.json(res, 400, { error: `the browser holds no session for ${domains.join(', ')}; sign in on the site first` });
              const saved = (await vault.save({
                id: prior?.id,
                type: 'session',
                label: String(b.label ?? '').trim() || prior?.label || `${domains[0]} (signed in)`,
                domains,
                username: b.username ? String(b.username) : undefined,
                ...(typeof b.exclusive === 'boolean' ? { exclusive: b.exclusive } : {}),
                // A session skips the site's 2FA, so its value is never shown to an agent.
                ...(prior ? {} : { policy: { use: 'auto' as const, reveal: 'never' as const } }),
                secrets: { session: JSON.stringify(captured.saved) },
                provenance: { source: `task:${callerTaskId}`, taskId: callerTaskId },
              }));
              if (!prior && saved.exclusive) await holds.acquireLease(store, organizationId, saved, callerTaskId);
              await holds.recordHold(store, organizationId, callerTaskId, saved.id);
              (await store.appendAudit({ principalId: `task:${callerTaskId}`, action: 'vault.session.saved',
                detail: { itemId: saved.id, label: saved.label, cookies: captured.saved.cookies.length, replaced: !!prior } }));
              const storage = captured.saved.storage[0];
              return this.json(res, 200, { itemId: saved.id, label: saved.label, domains, cookies: captured.saved.cookies.length,
                localStorage: !!storage?.localStorage.length, sessionStorage: !!storage?.sessionStorage?.length,
                indexedDB: (storage?.indexedDB ?? []).map((db) => db.name),
                ...(saved.exclusive ? { exclusive: true } : {}), ...(captured.omitted.length ? { omitted: captured.omitted } : {}) });
            }
            const item = b.itemId ? (await vault.get(String(b.itemId)))
              : b.domain ? (await vault.findByDomain(String(b.domain))).find((i) => i.type === 'session') : undefined;
            if (!item || item.type !== 'session')
              return this.json(res, 200, { status: 'not_in_vault', reason: `no saved session${b.domain ? ` for ${b.domain}` : ''}; sign in on the site, then call save_session` });
            const domains = item.domains ?? [];
            // The site's own sign-in, for when the session no longer works.
            const fallback = (await vault.findByDomain(domains[0] ?? '')).filter((i) => i.type === 'login' || i.type === 'passkey')
              .map((i) => ({ itemId: i.id, label: i.label, type: i.type, tool: i.type === 'login' ? 'fill_credential' : 'use_passkey' }));
            const signInAgain = fallback.length
              ? `sign in with ${fallback.map((f) => `${f.tool} (itemId ${f.itemId}, "${f.label}")`).join(' or ')}, then call save_session with itemId ${item.id}`
              : `sign in again (or ask a person to, through this task's desktop), then call save_session with itemId ${item.id}`;
            const checked = (await vault.access(caps, callerTaskId, item, 'use'));
            if (checked.status !== 'granted') return this.json(res, 200, await raise(checked, item));
            const stored = vault.readSecret(item, 'session');
            if (!stored || !sessionState(parseSavedSession(stored), domains).usable)
              return this.json(res, 200, { status: 'expired', itemId: item.id, ...(fallback.length ? { fallback } : {}), next: `the saved session has expired: ${signInAgain}` });
            const opener = await this.taskPageOpener(callerTaskId, 'saved sessions');
            if ('error' in opener) return this.json(res, 400, { error: opener.error });
            // Open the page before a one-shot grant is spent on a restore that cannot run.
            const page = await opener.open(domains);
            try {
              const lease = await holds.acquireLease(store, organizationId, item, callerTaskId);
              if (!lease.granted) return busy(item, lease.heldBy);
              const decision = (await vault.access(caps, callerTaskId, item, 'use', { consume: true }));
              if (decision.status !== 'granted') {
                await holds.releaseLease(store, organizationId, item.id, callerTaskId);
                return this.json(res, 200, await raise(decision, item));
              }
              const saved = parseSavedSession((await vault.resolveField(item, 'session', { taskId: callerTaskId, principal, mode: 'use' })));
              const restored = await restoreSession(page.session, domains, saved);
              await holds.recordHold(store, organizationId, callerTaskId, item.id);
              return this.json(res, 200, { status: 'granted', itemId: item.id, ...restored, capturedAt: saved.capturedAt,
                ...(fallback.length ? { fallback } : {}),
                next: `the page reloaded with the saved session. If it is still signed out, ${signInAgain}` });
            } finally { await page.session.close(); }
          } catch (e) {
            return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        }

        // ── agent-enrolled passkeys (§8) ──
        if (p.startsWith('/api/vault/passkey')) {
          // A passkey ceremony runs in the calling task's own browser (AU-12,
          // AU-14): its world's, relayed over a world terminal, or on this host
          // the one its agent launched. Found before a one-shot grant is spent.
          let passkeyPage: TaskPageOpener = async () => { throw new Error('no browser session'); };
          if (p === '/api/vault/passkey/enroll' || p === '/api/vault/passkey/login') {
            const opener = await this.taskPageOpener(callerTaskId, 'passkeys');
            if ('error' in opener) return this.json(res, 400, { error: opener.error });
            passkeyPage = opener.open;
          }
          const passkeyOwner = JSON.stringify([organizationId, principal, callerTaskId]);
          if (!this.passkeys) {
            const { PasskeyManager } = await import('../autonomy/passkey.js');
            this.passkeys = new PasskeyManager();
          }
          const b = method === 'POST' ? await this.body(req) : {};
          const item = b.itemId ? (await vault.get(String(b.itemId))) : b.domain ? (await vault.findByDomain(String(b.domain))).find((i) => i.type !== 'session') : undefined;
          try {
            if (p === '/api/vault/passkey/enroll' && method === 'POST') {
              const domains = Array.isArray(b.domains) ? b.domains.map(String) : b.domain ? [String(b.domain)] : undefined;
              const started = await this.passkeys.begin(passkeyPage, { expectDomains: domains, mode: 'enroll', owner: passkeyOwner });
              return this.json(res, 200, { ...started, next: 'trigger the site\'s "create a passkey" button in the browser, then POST /api/vault/passkey/save with this authenticatorId' });
            }
            if (p === '/api/vault/passkey/save' && method === 'POST') {
              const creds = await this.passkeys.harvest(String(b.authenticatorId ?? ''), passkeyOwner);
              if (!creds.length) return this.json(res, 400, { error: 'no passkey was created on the page — trigger the site\'s enroll button first' });
              const saved = (await vault.save({
                type: 'passkey',
                label: String(b.label ?? (item?.label ? `${item.label} (passkey)` : 'passkey')),
                domains: Array.isArray(b.domains) ? b.domains.map(String) : creds[0]!.rpId ? [creds[0]!.rpId] : undefined,
                username: b.username ? String(b.username) : undefined,
                secrets: { passkey: JSON.stringify(creds) },
                provenance: { source: callerTaskId ? `task:${callerTaskId}` : 'manual', taskId: callerTaskId },
              }));
              const { defaultConnectors } = await import('../autonomy/connectors.js');
              const writeBack = await defaultConnectors(store, vault, this.deps.broker, organizationId,
                {hostLocal:this.hostLocal,hosted:this.deps.hosted,githubApp:this.deps.githubApp}).writeBackCreated(saved.id);
              for (const result of writeBack) (await store.appendAudit({principalId:callerTaskId ? `task:${callerTaskId}` : principal,
                action:result.error ? 'vault.write_back.failed' : 'vault.write_back',detail:{itemId:saved.id,...result}}));
              return this.json(res, 200, { itemId: saved.id, label: saved.label, count: creds.length, ...(writeBack.length ? {writeBack} : {}) });
            }
            if (p === '/api/vault/passkey/login' && method === 'POST') {
              if (!item) return this.json(res, 200, { status: 'not_in_vault', reason: 'no passkey item — enroll one first' });
              const checked = (await vault.access(caps, callerTaskId, item, 'use'));
              if (checked.status !== 'granted') return this.json(res, 200, { ...checked, itemId: item.id });
              // Open the page before a one-shot grant is spent on a ceremony that cannot run.
              const domains = item.domains;
              if (!domains?.length) return this.json(res, 400, { error: 'this passkey item has no domains' });
              // A slot is held before the page opens or the grant is spent.
              const releaseSlot = this.passkeys.reserve(passkeyOwner);
              try {
                const page = await passkeyPage(domains);
                let handedOff = false;
                try {
                  const decision = (await vault.access(caps, callerTaskId, item, 'use', { consume: true }));
                  if (decision.status !== 'granted') return this.json(res, 200, { ...decision, itemId: item.id });
                  const creds = JSON.parse((await vault.resolveField(item, 'passkey', { taskId: callerTaskId, principal, mode: 'use' }))) as PasskeyCredential[];
                  const started = await this.passkeys.begin(async () => page, { expectDomains: domains, mode: 'login', credential: creds[0], owner: passkeyOwner, reserved: true,
                    onCredentials: async updated => {
                      await store.transaction(async () => {
                        // The sign counter only grows: rewrite it under the vault lock.
                        await store.lock(`vault:${organizationId}`);
                        const current = await vault.get(item.id);
                        if (!current || current.type !== 'passkey') return;
                        const secret = await vault.readSecret(current, 'passkey');
                        if (secret === undefined) return;
                        const saved = JSON.parse(secret) as PasskeyCredential[];
                        for (const credential of saved) {
                          const next = updated.find(c => c.credentialId === credential.credentialId && c.privateKey === credential.privateKey);
                          if (next && Number.isSafeInteger(next.signCount) && next.signCount! > (credential.signCount ?? 0))
                            credential.signCount = next.signCount;
                        }
                        await vault.save({ id: current.id, type: 'passkey', secrets: { passkey: JSON.stringify(saved) } });
                      });
                    } });
                  handedOff = true; // held now; closing it twice on a failed begin is harmless
                  return this.json(res, 200, { status: 'granted', ...started, next: 'trigger "sign in with a passkey" in the browser, then POST /api/vault/passkey/release with this authenticatorId' });
                } finally { if (!handedOff) await page.session.close(); }
              } finally { releaseSlot(); }
            }
            if (p === '/api/vault/passkey/release' && method === 'POST') {
              (await this.passkeys.release(String(b.authenticatorId ?? ''), passkeyOwner));
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
        if (!sub && method === 'DELETE') {
          const { deleteAgentMail } = await import('../autonomy/cleanup.js');
          await deleteAgentMail(store, this.deps.broker, organizationId);
          return this.json(res, 200, { disconnected: true });
        }
        if (!sub && method === 'GET') {
          const config = (await this.mailboxConfig(organizationId));
          const mail = new AgentMail(
            store,
            (await this.mailboxDomain(organizationId)),
            (await this.mailboxFixedLocal(organizationId)),
            config.agentmailAddress,
          );
          return this.json(res, 200, { organizationId, address: (await mail.address(organizationId)), configured: mail.configured(),
            provider: config.provider, domain: (await this.mailboxDomain(organizationId)),
            messages: (await mail.recent(organizationId, { since: url.searchParams.get('since') ? Number(url.searchParams.get('since')) : undefined, match: url.searchParams.get('match') ?? undefined, limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined })) });
        }
        if (sub === 'providers' && method === 'GET') {
          const { defaultMailboxRegistry } = await import('../autonomy/mailbox.js');
          const { ingestSecret, cloudflareWorkerScript } = await import('../autonomy/agent-mail.js');
          const config = (await this.mailboxConfig(organizationId));
          if (!(await this.deps.tokens.check(token, 'credential:write')).ok)
            return this.json(res, 200, { providers: defaultMailboxRegistry().list(config), active: config.provider });
          // The push webhook URL (secret included) + Cloudflare worker are still
          // returned for the operator who wants them; the UI hides them for now.
          const base = process.env.KARMAX_GATEWAY_URL || `http://${req.headers.host ?? '127.0.0.1'}`;
          const webhookUrl = `${base}/api/agent-mail/ingest?secret=${(await ingestSecret(this.deps.store, organizationId))}`;
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
            if (result.config.provider === 'agentmail') {
              const { verifyAgentMailInbox } = await import('../autonomy/mail-pull.js');
              try {
                await verifyAgentMailInbox(String(b.apiKey), result.config.agentmailAddress!);
                await new AgentMail(store, undefined, undefined, result.config.agentmailAddress).address(organizationId);
              } catch (error) {
                return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
              }
            }
            // The provider secret (AgentMail key / IMAP password) → the vault under
            // an org-scoped handle the poller resolves; never echoed or stored raw.
            const apiKeyHandle = this.mailboxSecretHandle(organizationId, String(b.provider));
            if (b.apiKey && this.deps.broker) (await this.deps.broker.registerHandle(apiKeyHandle, String(b.apiKey), organizationScope(organizationId)));
            // REPLACE (not merge) so switching providers can't leave a stale field.
            const config = { ...result.config, ...(b.apiKey ? { apiKeyHandle } : {}) };
            (await this.setMailboxConfig(organizationId, config));
            if (config.provider === 'agentmail') {
              (await new AgentMail(store, config.agentmailDomain, undefined, config.agentmailAddress).address(organizationId));
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
        const config = (await this.outboundEmailConfig());
        return this.json(res, 200, {
          provider: config.provider, from: config.from,
          configured: (await this.deps.email?.configured()) ?? false,
          canManage: (await this.deps.tokens.check(token, 'settings:write')).ok,
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
          if (b.secret && this.deps.broker) (await this.deps.broker.registerHandle(handle, String(b.secret), INSTALLATION_SCOPE));
          // REPLACE, not merge, so switching providers can't leave a stale field.
          (await this.setOutboundEmailConfig({ ...result.config, secretHandle: handle }));
        }
        return this.json(res, result.status === 'unavailable' ? 400 : 200, result);
      }
      if (p === '/api/email/test' && method === 'POST') {
        if (!this.deps.email || !(await this.deps.email.configured())) return this.json(res, 400, { error: 'connect an email provider first' });
        const b = await this.body(req);
        const to = String(b.to ?? session.email ?? '').trim();
        if (!to) return this.json(res, 400, { error: 'no recipient — pass { to } or sign in with an email' });
        try {
          await this.deps.email.send({ to, subject: `${(await this.siteName)} test email`,
            text: `This is a test email from ${(await this.siteName)}. Outbound email is working.` });
          return this.json(res, 200, { ok: true, to });
        } catch (e) { return this.json(res, 502, { error: e instanceof Error ? e.message : String(e) }); }
      }

      // cards (payment resources; SPEC §7.6) — organization-scoped so a tenant
      // never spends from another's card. A project card narrows within its org.
      if (p === '/api/cards' && method === 'GET') {
        const pid = url.searchParams.get('projectId') ?? undefined;
        const cardOrg = authRecord?.organizationId ?? requestedScope.organizationId;
        if (pid && cardOrg && (await store.getProject(pid))?.organizationId !== cardOrg)
          return this.json(res, 404, { error: 'project not found in this organization' });
        const { cardRemaining } = await import('../autonomy/payments.js');
        // `available` is not what is left on the card — on an issuing rail it is
        // the organization's whole balance. Report the ceiling and what has been
        // counted against it, so the surface cannot claim more than the cap.
        return this.json(res, 200, (await __asyncCollections.map((await store.listCards(pid, cardOrg)), async (card) => {
          const spent = (await store.cardPaymentSpent(card.id));
          // An unregistered rail (a card left behind by a provider this
          // deployment no longer loads) still has a cap worth reporting.
          let enforces = true;
          try { enforces = this.deps.paymentRegistry?.forCard(card).enforcesCardCap !== false; } catch {}
          return { ...card, spent, remaining: cardRemaining(card, spent, enforces) };
        })));
      }
      if (p === '/api/cards' && method === 'POST') {
        if (!this.deps.paymentRegistry && !this.deps.payments)
          return this.json(res, 400, { error: 'no payment provider configured' });
        const b = await this.body(req);
        // A non-project card belongs to the caller's own organization (the old
        // installation-wide "global" card is gone in the multi-tenant model).
        const cardOrg = authRecord?.organizationId ?? requestedScope.organizationId
          ?? (b.projectId ? (await store.getProject(String(b.projectId)))?.organizationId : undefined) ?? 'org_personal';
        if (b.scope === 'project' && (!b.projectId || (await store.getProject(String(b.projectId)))?.organizationId !== cardOrg))
          return this.json(res, 400, { error: 'project does not belong to this organization' });
        const provider = b.provider
          ? this.deps.paymentRegistry?.get(String(b.provider))
          : (await this.deps.paymentRegistry?.active(cardOrg)) ?? this.deps.payments;
        if (!provider) return this.json(res, 400, { error: 'payment provider not found' });
        try {
          const name = String(b.label ?? 'Card').trim();
          if (!name || (await store.listOrganizationCards(cardOrg)).some(c => c.label.trim().toLowerCase() === name.toLowerCase()))
            return this.json(res, 400, { error: 'Card name must be unique in the organization' });
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
        const card = (await store.getCard(fundMatch[1]!));
        const belongs = card?.scope === 'organization'
          ? card.scopeId === cardOrg
          : card?.scope === 'project'
            ? Boolean(card.scopeId && (await store.getProject(card.scopeId))?.organizationId === cardOrg)
            : card?.scope === 'global' && cardOrg === 'org_personal';
        if (!belongs)
          return this.json(res, 404, { error: 'card not found in this organization' });
        const provider = this.deps.paymentRegistry?.forCard(card) ?? this.deps.payments;
        if (!provider) return this.json(res, 400, { error: 'payment provider not found' });
        const b = await this.body(req);
        try {
          await provider.fund(fundMatch[1]!, Number(b.amount ?? 0));
          return this.json(res, 200, (await store.getCard(fundMatch[1]!)) ?? null);
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const cardMatch = p.match(/^\/api\/cards\/([^/]+)$/);
      if (cardMatch && method === 'DELETE') {
        const cardOrg = authRecord?.organizationId ?? requestedScope.organizationId ?? 'org_personal';
        const card = (await store.getCard(cardMatch[1]!)) as import('../autonomy/payments.js').Card | undefined;
        const belongs = card?.scope === 'organization'
          ? card.scopeId === cardOrg
          : card?.scope === 'project'
            ? Boolean(card.scopeId && (await store.getProject(card.scopeId))?.organizationId === cardOrg)
            : card?.scope === 'global' && cardOrg === 'org_personal';
        if (!card || !belongs) return this.json(res, 404, { error: 'card not found in this organization' });
        const provider = this.deps.paymentRegistry?.forCard(card) ?? this.deps.payments;
        if (!provider) return this.json(res, 400, { error: 'payment provider not found' });
        await provider.revoke(card.id);
        return this.json(res, 200, (await store.getCard(card.id)));
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
        (await this.deps.broker.registerHandle(handle, String(b.apiKey), organizationScope(resourceOrganizationId)));
        await this.refreshLoginPool();
        return this.json(res, 200, { handle }); // never echoes the secret
      }
      // Edit (rename and/or rotate) and delete a write-only API-key handle. The
      // provider stays in the URL because changing vendors is a new credential.
      const apiKeyMatch = resourcePath.match(/^\/api\/accounts\/keys\/([^/]+)\/([^/]+)$/);
      if (apiKeyMatch && (method === 'DELETE' || method === 'PATCH')) {
        if (!this.deps.broker) return this.json(res, 400, { error: 'no credential broker configured' });
        const provider = decodeURIComponent(apiKeyMatch[1]!);
        const account = decodeURIComponent(apiKeyMatch[2]!);
        const simpleId = /^[a-z0-9][a-z0-9._-]*$/i;
        if (!simpleId.test(provider) || !simpleId.test(account))
          return this.json(res, 400, { error: 'provider and account must be simple ids' });
        const handleFor = (name: string) => resourceOrganizationId === 'org_personal'
          ? `${provider}:${name}`
          : `${provider}:${resourceOrganizationId}:${name}`;
        const handle = handleFor(account);
        if (!this.deps.broker.hasHandle(handle)) return this.json(res, 404, { error: 'API key not found' });
        const credentialKey = `key:handle:${handle}`;
        if (method === 'DELETE') {
          (await this.deps.broker.deleteHandle(handle));
          (await this.remapCredentialPolicies(resourceOrganizationId, credentialKey));
          await this.refreshLoginPool();
          return this.json(res, 200, { ok: true });
        }
        const b = await this.body(req);
        const nextAccount = b.account === undefined ? account : String(b.account);
        if (!simpleId.test(nextAccount)) return this.json(res, 400, { error: 'account must be a simple id' });
        const nextHandle = handleFor(nextAccount);
        if (nextHandle !== handle && this.deps.broker.hasHandle(nextHandle))
          return this.json(res, 409, { error: `API key ${provider}:${nextAccount} already exists` });
        const replacement = b.apiKey === undefined || b.apiKey === '' ? undefined : String(b.apiKey);
        (await this.deps.broker.updateHandle(handle, nextHandle, organizationScope(resourceOrganizationId), replacement));
        if (nextHandle !== handle)
          (await this.remapCredentialPolicies(resourceOrganizationId, credentialKey, `key:handle:${nextHandle}`));
        await this.refreshLoginPool();
        return this.json(res, 200, { ok: true, handle: nextHandle });
      }
      // connect an account login: mint a config home + launch the provider's own
      // OAuth, return the device URL for the user to complete (we never type creds).
      if (resourcePath === '/api/accounts/connect/code' && method === 'POST') {
        if (!this.deps.login) return this.json(res, 400, { error: 'no login manager configured' });
        const b = await this.body(req);
        if (!isLoginProvider(b.provider)) return this.json(res, 400, { error: `unsupported login provider: ${String(b.provider ?? '')}` });
        if (!b.account || !b.code) return this.json(res, 400, { error: 'provider, account, and code required' });
        const result = await this.deps.login.submitAuthorizationCode(
          b.provider,
          String(b.account),
          String(b.code),
          resourceOrganizationId,
        );
        await this.refreshLoginPool();
        const { configHome, ...safe } = result;
        return this.json(res, 200, safe);
      }
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
        const result = await this.deps.login.connect(provider, String(b.account), {
          modelProvider,
          authMethod,
          force: b.force === true,
        }, resourceOrganizationId);
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
        if (result.status === 'logged_in') {
          const credential = enumerateCredentials(gatherCredentialSources({
            configHomes: this.deps.configHomes,
            broker: this.deps.broker,
            organizationId: resourceOrganizationId,
          })).find((candidate) => candidate.provider === provider && candidate.account === String(b.account));
          if (credential) await this.refreshUsage(credential.key, resourceOrganizationId).catch(() => undefined);
        }
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

      const githubAccountsResource = p.match(/^\/api\/user\/github-accounts(?:\/([^/]+)(?:\/(active|identity))?)?$/);
      if (githubAccountsResource) {
        const subject = requireHumanSubject(callerIdentity);
        if (!this.deps.githubApp || !this.deps.broker)
          return this.json(res, 503, { error: 'GitHub integration is unavailable' });
        const { GitProfiles, userGitScope } = await import('../autonomy/git-profiles.js');
        const gp = new GitProfiles(store, this.deps.broker, undefined, userGitScope(subject.userId));
        const accountId = githubAccountsResource[1] ? decodeURIComponent(githubAccountsResource[1]) : undefined;
        const action = githubAccountsResource[2];
        try {
          if (method === 'GET' && !accountId) {
            const accounts = await this.deps.githubApp.listUserAccounts(subject.userId);
            for (const account of accounts) (await gp.saveGithubIdentity(account));
            const active = accounts.find((account) => account.active);
            if (active) (await gp.setActiveGithub(active.id));
            (await inheritPersonalGithubProfile(store, this.deps.broker, subject.userId));
            return this.json(res, 200, {
              accounts: (await __asyncCollections.map(accounts, async (account) => ({ ...account, profile: (await gp.githubProfile(account.id)) ?? null }))),
              githubApp: (await this.deps.githubApp.status(subject.userId)),
            });
          }
          if (method === 'POST' && accountId && action === 'active') {
            await this.deps.githubApp.setActiveUserAccount(subject.userId, accountId);
            return this.json(res, 200, { profile: (await gp.setActiveGithub(accountId)) });
          }
          if (method === 'PUT' && accountId && action === 'identity') {
            const b = await this.body(req);
            return this.json(res, 200, { profile: (await gp.saveGithubCustomIdentity(accountId, {
              userName: b.userName ? String(b.userName) : undefined,
              userEmail: b.userEmail ? String(b.userEmail) : undefined,
              signingKey: b.signingKey ? String(b.signingKey) : undefined,
              removeSigningKey: b.removeSigningKey === true,
            })) });
          }
          if (method === 'DELETE' && accountId && !action) {
            const active = await this.deps.githubApp.removeUserAccount(subject.userId, accountId);
            (await gp.deleteGithubIdentity(accountId));
            (await gp.setActiveGithub(active));
            return this.json(res, 200, { ok: true, activeAccountId: active });
          }
        } catch (error) {
          return this.json(res, error instanceof Error && error.message === 'Connect a new GitHub account first' ? 409 : 400,
            { error: error instanceof Error ? error.message : String(error) });
        }
      }

      // Git profiles: a person's development identity lives at /api/user/…;
      // organization profiles remain a distinct service/automation credential.
      // the repos karmax works on. The registry is public; secrets are write-only
      // into the vault (never echoed) and resolved JIT by the broker at use time.
      const userGitResource = p.match(/^\/api\/user\/git-profiles(\/.*)?$/);
      if (userGitResource || resourcePath.startsWith('/api/git-profiles')) {
      const gitResourcePath = userGitResource ? `/api/git-profiles${userGitResource[1] ?? ''}` : resourcePath;
      const { GitProfiles, userGitScope } = await import('../autonomy/git-profiles.js');
      const userGitSubject = userGitResource ? requireHumanSubject(callerIdentity) : undefined;
      const gitScope = userGitResource
        ? userGitScope(userGitSubject!.userId)
        : resourceOrganizationId;
      if (gitResourcePath === '/api/git-profiles' && method === 'GET') {
        const gp = new GitProfiles(store, this.deps.broker, undefined, gitScope!);
        const canManage = userGitResource ? true
          : (await this.deps.tokens.check(token, 'credential:write', { organizationId: resourceOrganizationId })).ok;
        return this.json(res, 200, {
          profiles: (await gp.list()), defaultProfile: (await gp.defaultProfile()) ?? null, canManage,
          ...(userGitResource && userGitSubject && this.deps.githubApp
            ? { githubApp: (await this.deps.githubApp.status(userGitSubject.userId)) }
            : {}),
        });
      }
      if (gitResourcePath === '/api/git-profiles' && method === 'POST') {
        const b = await this.body(req);
        if (!this.deps.broker) return this.json(res, 400, { error: 'no credential broker configured' });
        if (!b.name || !b.userName || !b.userEmail) return this.json(res, 400, { error: 'name, userName, userEmail required' });
        const gp = new GitProfiles(store, this.deps.broker, undefined, gitScope!);
        try {
          const rec = (await gp.save({
            name: String(b.name),
            userName: String(b.userName),
            userEmail: String(b.userEmail),
            sshKey: b.sshKey ? String(b.sshKey) : undefined,
            signingKey: b.signingKey ? String(b.signingKey) : undefined,
            githubToken: b.githubToken ? String(b.githubToken) : undefined,
          }));
          if (b.default || (userGitResource && !(await gp.defaultProfile()))) (await gp.setDefault(rec.name));
          return this.json(res, 200, { profile: rec }); // never echoes the secrets
        } catch (e) {
          return this.json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (userGitResource && gitResourcePath === '/api/git-profiles/signing-key' && method === 'POST') {
        const b = await this.body(req);
        if (!this.deps.broker) return this.json(res, 400, { error: 'no credential broker configured' });
        if (!String(b.signingKey ?? '').trim()) return this.json(res, 400, { error: 'signing key required' });
        try {
          const gp = new GitProfiles(store, this.deps.broker, undefined, gitScope!);
          const profile = (await gp.resolve(undefined))?.github
            ? (await gp.saveGithubCustomIdentity((await gp.resolve(undefined))!.github!.id, { signingKey: String(b.signingKey) }))
            : (() => { throw new Error('Connect GitHub before adding a signing key'); })();
          return this.json(res, 200, { profile });
        } catch (error) {
          return this.json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const gitProfileMatch = gitResourcePath.match(/^\/api\/git-profiles\/([^/]+)$/);
      if (gitProfileMatch && method === 'DELETE') {
        (await new GitProfiles(store, this.deps.broker, undefined, gitScope!)
          .delete(decodeURIComponent(gitProfileMatch[1]!)));
        return this.json(res, 200, { ok: true });
      }
      // The doctor check (wiki plans/PLAN-git-config §7): which tier a project's remote
      // ops resolve to (profile / host fallback) and whether it can reach the
      // repos' remotes non-interactively. Read-only.
      if (!userGitResource && gitResourcePath === '/api/git-profiles/preflight' && method === 'GET') {
        const projectId = url.searchParams.get('projectId') ?? undefined;
        const project = projectId ? (await store.getProject(projectId)) : undefined;
        const organizationId = project?.organizationId ?? resourceOrganizationId;
        if (project && organizationId !== resourceOrganizationId)
          return this.json(res, 400, { error: 'project does not belong to this organization' });
        return this.json(res, 200, await new GitProfiles(store, this.deps.broker, undefined, organizationId).preflight(project?.config));
      }
      if (gitResourcePath === '/api/git-profiles/default' && method === 'POST') {
        const b = await this.body(req);
        (await new GitProfiles(store, this.deps.broker, undefined, gitScope!)
          .setDefault(b.name ? String(b.name) : undefined));
        return this.json(res, 200, { ok: true });
      }
      if (!userGitResource && gitResourcePath === '/api/git-profiles/reuse-user' && method === 'POST') {
        const subject = requireHumanSubject(callerIdentity);
        const organizationProfiles = new GitProfiles(store, this.deps.broker, undefined, resourceOrganizationId);
        try {
          const profile = (await organizationProfiles.reuseUserProfile(
            new GitProfiles(store, this.deps.broker, undefined, userGitScope(subject.userId))));
          return this.json(res, 200, { profile, defaultProfile: profile.name });
        } catch (error) {
          return this.json(res, 409, { error: error instanceof Error ? error.message : String(error) });
        }
      }
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
        (await store.kvSet(concurrencyKey(String(b.accountId)), String(n)));
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
          const cached = (await store.kvGet(`usage:${c.key}`));
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
      // Live leasing state of THIS organization's agent accounts — availability,
      // in-use/concurrency, quota resets and the last credential incident — the
      // account coordinator's view filtered to the organization's own credentials.
      // Any member who may read credentials may see it; this used to ride on the
      // operator-only dashboard payload, which org-scoped browser sessions never got.
      if (resourcePath === '/api/accounts/status' && method === 'GET') {
        return this.json(res, 200, { accounts: await this.organizationAccountStatus(resourceOrganizationId) });
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
        const projectId = url.searchParams.get('projectId') ?? undefined;
        const taskId = url.searchParams.get('taskId') ?? undefined;
        const scopedProjectId = projectId ?? (taskId ? (await store.getTask(taskId))?.projectId : undefined);
        const scopedOrganizationId = scopedProjectId
          ? (await store.getProject(scopedProjectId))?.organizationId ?? resourceOrganizationId
          : resourceOrganizationId;
        if (scopedOrganizationId !== resourceOrganizationId)
          return this.json(res, 400, { error: 'credential scope does not belong to this organization' });
        const creds = enumerateCredentials(gatherCredentialSources({
          configHomes: this.deps.configHomes,
          broker: this.deps.broker,
          organizationId: scopedOrganizationId,
        }));
        const g = parsePolicy((await store.kvGet(credPolicyKey.organization(scopedOrganizationId))))
          ?? (scopedOrganizationId === 'org_personal' ? parsePolicy((await store.kvGet(credPolicyKey.global()))) : undefined);
        const pr = projectId ? parsePolicy((await store.kvGet(credPolicyKey.project(projectId)))) : undefined;
        const tk = taskId ? parsePolicy((await store.kvGet(credPolicyKey.task(taskId)))) : undefined;
        const resolved = (layers: { global?: unknown; project?: unknown; task?: unknown }) => {
          const enabled = resolveCredentials(creds, layers as any).map((c) => c.key);
          const explanationEnabled = new Set(resolveExplanationCredentials(creds, layers as any)
            .filter((credential) => credential.kind === 'key')
            .map((credential) => credential.key));
          return {
            enabled,
            modes: Object.fromEntries(creds.map((credential) => [credential.key,
              enabled.includes(credential.key) ? 'on'
                : credential.kind === 'key' && explanationEnabled.has(credential.key) ? 'explainer-only'
                  : 'off',
            ])),
          };
        };
        const global = resolved({ global: g });
        const project = projectId ? resolved({ global: g, project: pr }) : undefined;
        const task = taskId ? resolved({ global: g, project: pr, task: tk }) : undefined;
        const { claudeSignInExpiresAt } = await import('../autonomy/config-homes.js');
        // Logins the provider signed out cannot run, but must stay visible so a
        // person can sign in again; hiding them made a login silently vanish.
        const loginKey = (provider: string, account: string) => scopedOrganizationId === 'org_personal'
          ? `login:${provider}:${account}` : `login:${scopedOrganizationId}:${provider}:${account}`;
        const signedOut = (this.deps.configHomes?.list(scopedOrganizationId) ?? [])
          .filter((login) => !login.loggedIn && isLoginProvider(login.provider) && login.account)
          .map((login) => ({ key: loginKey(login.provider, login.account), label: `${login.provider}:${login.account}`,
            provider: login.provider, kind: 'login' as const, account: login.account, signedOut: true }));
        return this.json(res, 200, {
          credentials: [
            ...creds.map((c) => {
              const signInExpiresAt = c.kind === 'login' && c.provider === 'claude' && c.configHome
                ? claudeSignInExpiresAt(c.configHome) : undefined;
              return { key: c.key, label: c.label, provider: c.provider, kind: c.kind, account: c.account,
                ...(signInExpiresAt ? { signInExpiresAt } : {}) };
            }),
            ...signedOut,
          ],
          global: { own: g ?? {}, ...global },
          ...(projectId && project ? { project: { own: pr ?? {}, ...project } } : {}),
          ...(taskId && task ? { task: { own: tk ?? {}, ...task } } : {}),
        });
      }
      if (resourcePath === '/api/credentials/policy' && method === 'POST') {
        const b = await this.body(req);
        const { credPolicyKey } = await import('../platform/credential-sources.js');
        let key: string;
        if (b.scope === 'task') {
          const task = b.taskId ? (await store.getTask(String(b.taskId))) : undefined;
          const project = task ? (await store.getProject(task.projectId)) : undefined;
          if (!task || project?.organizationId !== resourceOrganizationId)
            return this.json(res, 400, { error: 'credential scope does not belong to this organization' });
          key = credPolicyKey.task(task.id);
        } else if (b.scope === 'project') {
          const project = b.projectId ? (await store.getProject(String(b.projectId))) : undefined;
          if (!project || project.organizationId !== resourceOrganizationId)
            return this.json(res, 400, { error: 'credential scope does not belong to this organization' });
          key = credPolicyKey.project(project.id);
        } else if (b.scope === 'global' || b.scope === 'organization') {
          key = credPolicyKey.organization(resourceOrganizationId);
        } else {
          return this.json(res, 400, { error: 'scope must be organization, global, project, or task' });
        }
        (await store.kvSet(key, JSON.stringify(b.policy ?? {})));
        // Parked turns resolved their allow-lists under the old policy.
        if (this.deps.client) {
          const { makeCoordinatorActivities } = await import('../activities/coordinator.js');
          await makeCoordinatorActivities({ client: this.deps.client, taskQueue: this.deps.taskQueue }).relistAccountLeases();
        }
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

      // A small model call outside task workflows: explanations are presentation
      // annotations, so their defaults inherit organization → project without
      // becoming workflow params or agent-session input.
      const organizationExplanation = p.match(/^\/api\/organizations\/([^/]+)\/explanation-settings$/);
      if (organizationExplanation) {
        const organizationId = organizationExplanation[1]!;
        const settings = (await this.explanationSettings(undefined, organizationId));
        if (method === 'GET') return this.json(res, 200, {
          own: settings.organizationOwn,
          inherited: DEFAULT_EXPLANATION_SETTINGS,
          effective: settings.inherited,
        });
        if (method === 'PUT') {
          const body = await this.body(req);
          const own = this.explanationSettingsOwn(body.values, DEFAULT_EXPLANATION_SETTINGS);
          (await store.setSettings(`organization:${organizationId}`, 'explanation', own));
          return this.json(res, 200, { own, effective: normalizeExplanationSettings(own) });
        }
      }
      const projectExplanation = p.match(/^\/api\/projects\/([^/]+)\/explanation-settings$/);
      if (projectExplanation) {
        const projectId = projectExplanation[1]!;
        const project = (await store.getProject(projectId));
        if (!project) return this.json(res, 404, { error: 'no project' });
        const settings = (await this.explanationSettings(projectId));
        if (method === 'GET') return this.json(res, 200, {
          own: settings.projectOwn,
          inherited: settings.inherited,
          effective: settings.effective,
        });
        if (method === 'PUT') {
          const body = await this.body(req);
          const own = this.explanationSettingsOwn(body.values, settings.inherited);
          (await store.setSettings(projectId, 'explanation', own));
          return this.json(res, 200, { own, effective: normalizeExplanationSettings(own, settings.inherited) });
        }
      }

      // resolved/inherited defaults per scope — drives form placeholders (SPEC §10.4)
      const defs = p.match(/^\/api\/defaults\/([^/]+)\/([^/]+)$/);
      if (defs && method === 'GET') {
        const projectId = defs[1]!;
        const wf = defs[2]!;
        const m = manifest(wf);
        if (!m) return this.json(res, 404, { error: 'no workflow' });
        const gs = async (s: string, w: string) => (await store.getSettings(s, w));
        const project = (await store.getProject(projectId));
        const organizationId = url.searchParams.get('organizationId') ?? project?.organizationId;
        let globalVals = { ...(await globalSettingsFor(gs, wf, organizationId ?? undefined)) };
        let projectVals = project ? { ...(await projectSettingsFor(gs, project, wf)) } : {};
        if (this.deps.hosted) {
          // Old hosted rows may have inherited or explicitly stored the former
          // local-only default. Show the effective hosted contract in every
          // settings form; newly started tasks are independently normalized in
          // KarmaxApi so an old client cannot bypass this presentation layer.
          if (globalVals.remote === undefined || globalVals.remote === 'none')
            globalVals = { ...globalVals, remote: 'pr' };
          if (projectVals.remote === 'none') projectVals = { ...projectVals, remote: 'pr' };
        }
        // "Agent environment" (worldProvider) is stored in the execution policy, not
        // the settings rows — surface the real organization default + project override
        // so the Task Defaults form shows and inherits the true selection (§11).
        if (organizationId && globalVals.worldProvider === undefined) {
          const orgProvider = (await store.getOrganizationExecutionPolicy(organizationId)).worldProvider;
          if (orgProvider !== undefined) globalVals.worldProvider = orgProvider;
        }
        if (project?.config.worldProvider !== undefined) projectVals.worldProvider = project.config.worldProvider;
        // Detect the effective repository policy so placeholders agree with the
        // branch provisioning and pull requests will actually use.
        const repo0 = project
          ? effectiveRepos(resolveParams(m, { project: projectVals, global: globalVals }), project.config)[0]
          : undefined;
        const branches = project ? await repositoryBranchDefaults(store, project, repo0) : undefined;
        const enrich = async (vals: Record<string, unknown>, lower: Record<string, unknown>) => {
          const out = (await this.enrichAgentDefaults(m, vals, projectId, organizationId ?? undefined));
          if (branches) {
            if (lower.base === undefined && globalVals.base === undefined && projectVals.base === undefined) out.base = branches.base;
            if (lower.target === undefined && globalVals.target === undefined && projectVals.target === undefined) out.target = branches.target;
          }
          return out;
        };
        // Quick-task agent defaults (SPEC §10.4): an agent-only overlay for tasks
        // added from the quick box. Project Quick agents inherit through the
        // organization Quick agents into the regular project/organization agents.
        const globalQuickVals = (await quickGlobalSettingsFor(gs, wf, organizationId ?? undefined));
        const projectQuickVals = project ? (await quickProjectSettingsFor(gs, project.id, wf)) : {};
        return this.json(res, 200, {
          task: { own: {}, inherited: (await enrich(resolveParams(m, { project: projectVals, global: globalVals }), {})) },
          project: { own: projectVals, inherited: (await enrich(resolveParams(m, { global: globalVals }), projectVals)) },
          global: { own: globalVals, inherited: (await enrich(resolveParams(m, {}), { ...projectVals, ...globalVals })) },
          globalQuick: { own: globalQuickVals, inherited: (await enrich(resolveParams(m, { global: globalVals }), globalQuickVals)) },
          projectQuick: {
            own: projectQuickVals,
            inherited: (await enrich(resolveParamsLayers(m, [globalQuickVals, projectVals, globalVals]), { ...projectVals, ...globalVals, ...globalQuickVals, ...projectQuickVals })),
          },
        });
      }

      // settings (global + per-project, per workflow)
      const organizationSettings = p.match(/^\/api\/organizations\/([^/]+)\/settings\/([^/]+)$/);
      if (organizationSettings) {
        const [_, organizationId, wf] = organizationSettings;
        if (method === 'GET') return this.json(res, 200, (await globalSettingsFor(async (s, w) => (await store.getSettings(s, w)), wf!, organizationId)));
        if (method === 'PUT') {
          const b = await this.body(req);
          const values = hostedSettingsValues(b.values ?? {}, this.deps.hosted === true);
          (await store.setSettings(`organization:${organizationId}`, wf!, values));
          // The organization "Agent environment" default lives in the execution
          // policy (so runner-pool compatibility and effectiveProjectConfig agree);
          // mirror a non-empty selection there. Blank at organization scope means
          // "unchanged" — the top-level default is always a concrete provider.
          if (values.worldProvider)
            (await store.setOrganizationExecutionPolicy(organizationId!, { worldProvider: values.worldProvider as string }));
          return this.json(res, 200, { ok: true });
        }
      }
      const organizationQuickSettings = p.match(/^\/api\/organizations\/([^/]+)\/quick-settings\/([^/]+)$/);
      if (organizationQuickSettings) {
        const [_, organizationId, wf] = organizationQuickSettings;
        if (method === 'GET') return this.json(res, 200, (await quickGlobalSettingsFor(async (s, w) => (await store.getSettings(s, w)), wf!, organizationId)));
        if (method === 'PUT') {
          const b = await this.body(req);
          (await store.setSettings(`quick:organization:${organizationId}`, wf!,
            hostedSettingsValues(b.values ?? {}, this.deps.hosted === true)));
          return this.json(res, 200, { ok: true });
        }
      }
      const gset = p.match(/^\/api\/settings\/global\/([^/]+)$/);
      if (gset) {
        const wf = gset[1]!;
        if (method === 'GET') return this.json(res, 200, wf === 'timing' ? { enabled: (await this.cachedTimingEnabled()) } : (await globalSettingsFor(async (s, w) => (await store.getSettings(s, w)), wf)));
        if (method === 'PUT') {
          const b = await this.body(req);
          if (wf === 'timing' && typeof b.values?.enabled !== 'boolean') return this.json(res, 400, { error: 'enabled must be a boolean' });
          if (wf === 'agent-queue' && (!Number.isFinite(Number(b.values?.capacity)) || Number(b.values.capacity) < 1)) {
            return this.json(res, 400, { error: 'Concurrent agent turns must be at least 1' });
          }
          if (wf === 'appearance' && !isBrandIcon(b.values?.icon)) {
            return this.json(res, 400, { error: 'Unknown brand icon' });
          }
          const values = hostedSettingsValues(b.values ?? {}, this.deps.hosted === true);
          // Appearance is installation identity rather than a replace-all task
          // default. Its name and icon have separate controls and API routes, so
          // changing either must retain the other.
          (await store.setSettings('global', wf, wf === 'appearance'
            ? { ...((await store.getSettings('global', wf)) ?? {}), ...values }
            : values));
          if (wf === 'timing') (await this.refreshTiming());
          if (wf === 'agent-queue') await api.setAgentCapacity(token, Number(values.capacity));
          return this.json(res, 200, { ok: true });
        }
      }
      const pset = p.match(/^\/api\/settings\/project\/([^/]+)\/([^/]+)$/);
      if (pset) {
        const projectId = pset[1]!;
        const wf = pset[2]!;
        if (method === 'GET') {
          const project = (await store.getProject(projectId));
          if (!project) return this.json(res, 404, { error: 'no project' });
          return this.json(res, 200, (await projectSettingsFor(async (s, w) => (await store.getSettings(s, w)), project, wf)));
        }
        if (method === 'PUT') {
          const b = await this.body(req);
          const values = hostedSettingsValues(b.values ?? {}, this.deps.hosted === true);
          (await store.setSettings(projectId, wf, values));
          // Mirror bound-project fields into ProjectConfig for back-compat.
          const m = manifest(wf);
          if (m) (await store.updateProjectConfig(projectId, settingsToProjectConfig(m, values)));
          // "Agent environment" is canonically an execution-policy value; mirror it so
          // effectiveProjectConfig, runner-pool compatibility, and the Compute section
          // stay coherent (empty ⇒ clear the override and inherit the organization).
          if (Object.prototype.hasOwnProperty.call(values, 'worldProvider'))
            (await store.setProjectExecutionPolicy(projectId, { worldProvider: (values.worldProvider as string) || null }));
          return this.json(res, 200, { ok: true });
        }
      }

      // quick-task defaults (SPEC §10.4) — a separate opt-in overlay stored under a
      // `quick:` namespaced scope; applied only to tasks from the quick-add box.
      const qgset = p.match(/^\/api\/settings\/quick\/global\/([^/]+)$/);
      if (qgset) {
        const wf = qgset[1]!;
        if (method === 'GET') return this.json(res, 200, (await quickGlobalSettingsFor(async (s, w) => (await store.getSettings(s, w)), wf)));
        if (method === 'PUT') {
          const b = await this.body(req);
          (await store.setSettings(quickScopeKey('global'), wf,
            hostedSettingsValues(b.values ?? {}, this.deps.hosted === true)));
          return this.json(res, 200, { ok: true });
        }
      }
      const qpset = p.match(/^\/api\/settings\/quick\/project\/([^/]+)\/([^/]+)$/);
      if (qpset) {
        const projectId = qpset[1]!;
        const wf = qpset[2]!;
        if (method === 'GET') {
          const project = (await store.getProject(projectId));
          if (!project) return this.json(res, 404, { error: 'no project' });
          return this.json(res, 200, (await quickProjectSettingsFor(async (s, w) => (await store.getSettings(s, w)), projectId, wf)));
        }
        if (method === 'PUT') {
          const b = await this.body(req);
          // Quick-task defaults are UI-only overlays (never mirrored into ProjectConfig,
          // which drives full-form/general resolution), so just persist the row.
          (await store.setSettings(quickScopeKey(projectId), wf,
            hostedSettingsValues(b.values ?? {}, this.deps.hosted === true)));
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
        // The event log is installation-wide; scope it to the caller's tenant.
        // A bearer pinned to one project sees that project; an organization- or
        // multi-project-scoped one sees its own organization/projects; a caller
        // with no resolvable scope sees nothing rather than everyone's events.
        const visibleProjects = authRecord?.projectId ? new Set([authRecord.projectId])
          : authRecord?.projectIds?.length ? new Set(authRecord.projectIds) : undefined;
        const visibleOrganization = authRecord?.organizationId ?? requestedScope.organizationId;
        if (!visibleProjects && !visibleOrganization) return this.json(res, 200, []);
        const projectCache = new Map<string, Project | undefined>();
        const projectOf = async (id: string) => {
          if (!projectCache.has(id)) projectCache.set(id, (await store.getProject(id)));
          return projectCache.get(id);
        };
        const recent = await store.allEventsSince(since, 300, !(await this.cachedTimingEnabled()));
        const taskProjects = await store.taskProjectIds(recent.map(event => event.taskId));
        const events = (await __asyncCollections.filter(recent, async (e) => {
          const projectId = taskProjects.get(e.taskId);
          if (!projectId) return false;
          if (visibleProjects) return visibleProjects.has(projectId);
          return ((await projectOf(projectId))?.organizationId ?? 'org_personal') === visibleOrganization;
        }));
        return this.json(res, 200, events);
      }

      return this.json(res, 404, { error: 'not found' });
    } catch (e) {
      // A status-bearing platform error (denied / not found / invalid input) is a
      // caller-facing answer, not a server fault: surface its own code rather
      // than letting `fail` flatten everything but CapabilityError to a 500.
      const declared = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : undefined;
      const code = (e as { code?: unknown })?.code;
      if (declared) return this.json(res, declared, { error: (e as Error).message,
        ...(code ? { code: String(code) } : {}), ...(e instanceof AuthorizationGrantError ? e.gap : {}) });
      throw e;
    }
  }

  /**
   * Seed a brand-new project with its preparation task (SPEC §4.6). A new project's
   * tasks default to the `software-dev` workflow, so we seed that workflow's
   * `onActivate` prep task — "make this project karmax-ready" — as the first task on
   * the list. The manifest supplies hosted-specific copy because isolated cloud
   * worlds do not need the local-worktree resource-collision scan. It's created as
   * a **draft** so project creation never immediately spends an agent turn. The
   * user may queue it before attaching a repository; software-dev treats that as
   * its supported state-only, zero-repo case.
   * Best-effort: a failure here must never fail project creation.
   */
  private async spawnProjectPrepTask(token: string, projectId: string): Promise<void> {
    const prep = manifest('software-dev')?.onActivate?.spawnTask;
    if (!prep) return;
    try {
      await this.deps.api.createTask(token, {
        projectId,
        title: prep.title,
        prompt: activationTaskPrompt(prep, this.deps.hosted === true),
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
  private trackWikiWork(work: Promise<void>): void {
    this.wikiWork.add(work);
    void work.finally(() => this.wikiWork.delete(work)).catch(() => {});
  }

  /** A task start needs its project's local wiki repository, and once this
   * gateway has ensured it, it exists. Ensuring it again waits in the wiki's
   * Git lane, which can sit behind a remote sync, so a start refreshes it
   * alongside rather than before creating the task (LT-16). */
  private async wikiForTaskStart(project: import('../domain/types.js').Project, userId?: string): Promise<void> {
    if (!this.wikiLocalReady.has(project.id)) return this.ensureProjectWiki(project, userId);
    this.trackWikiWork(this.ensureProjectWiki(project, userId).catch(error =>
      console.warn(`[karmax] could not refresh wiki for ${project.id}:`, error instanceof Error ? error.message : error)));
  }

  private async ensureProjectWiki(project: import('../domain/types.js').Project, userId?: string): Promise<void> {
    if (this.closing) return;
    const root = await ensureProjectWikiRepositoryAsync(paths().content, project.id);
    if (this.closing) return;
    if (!(await this.deps.store.projectWiki(project.id))) (await this.deps.store.setProjectWikiRepository(project.id));
    this.wikiLocalReady.add(project.id);
    const current = (await this.deps.store.projectWiki(project.id))?.repository;
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
      this.trackWikiWork((async () => {
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
      })());
      return;
    }
    const organizationId = project.organizationId ?? 'org_personal';
    const candidates = [...new Set([
      ...(userId ? [userId] : []),
      ...(await this.deps.store.listOrganizationMemberships(organizationId))
        .sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner'))
        .map((membership) => membership.userId),
    ])];
    const actor = (await __asyncCollections.find(candidates, async (candidate) => (await this.deps.githubApp!.status(candidate)).userAuthorized));
    if (!actor) return;
    const connections = (await this.deps.store.listGitConnections(organizationId));
    const attachedConnectionIds = [...new Set((await this.deps.store.listProjectRepositories(project.id))
      .map((candidate) => candidate.repository.gitConnectionId).filter((id): id is string => Boolean(id)))];
    const connection = current?.gitConnectionId
      ? connections.find((candidate) => candidate.id === current.gitConnectionId)
      : attachedConnectionIds.length === 1
      ? connections.find((candidate) => candidate.id === attachedConnectionIds[0])
      : connections.length === 1 ? connections[0] : undefined;
    if (!connection) return;
    if (this.wikiRemotesProvisioning.has(project.id)) return;
    this.wikiRemotesProvisioning.add(project.id);
    this.trackWikiWork((async () => {
      try {
        const base = project.name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'project';
        // Preserve the remote identity across project renames. The deterministic
        // name is only for the first provisioning attempt.
        const name = current?.name ?? `${base}-wiki-${project.id.slice(-8)}`;
        const repository = await githubApp.ensureRepository(connection.id, actor, {
          name, description: `${(await this.siteName)} project wiki for ${project.name}`,
          private: true, defaultBranch: 'main', autoInit: false,
        });
        // Link before the push so even a transient network failure keeps this
        // platform-owned repository out of the ordinary project repo picker.
        (await this.deps.store.setProjectWikiRepository(project.id, repository.id));
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
    })());
  }

  private async availableModels(refresh = false, organizationId = 'org_personal'): Promise<{ providers: ModelCatalog; refreshedAt: number }> {
    const catalog = await this.modelCatalog.get(organizationId, { fresh: refresh });
    return { providers: catalog.value, refreshedAt: catalog.at };
  }

  private async discoverModels(organizationId: string): Promise<ModelCatalog> {
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
      const results = await Promise.all(homes(provider).map((home) => fn(home).catch((error) => {
        // Discovery is best-effort, but a silent auth failure made connected
        // accounts appear to vanish with no causal trace. Log only a classified,
        // credential-safe reason; provider exceptions can contain sensitive data.
        console.warn(
          `[karmax] ${provider} model discovery failed for ${home ? 'a connected login' : 'an API credential'} `
          + `(${modelDiscoveryFailureReason(error)}); using the fallback catalog`,
        );
        return [];
      })));
      return mergeModels(results);
    };
    const [claude, codex, opencode] = await Promise.all([
      settled('claude'), settled('codex'), settled('opencode'),
    ]);
    // Discovery is best-effort (offline/old CLI/expired login). Keep the existing
    // safe presets so forms never degrade to an empty, non-actionable picker.
    const value: ModelCatalog = {
      // The SDK picker is account-aware but intentionally partial. Treat it as
      // metadata to add to the stable selections, not an exhaustive allowlist.
      claude: claudeModelCatalog(claude),
      codex: codexModelCatalog(codex),
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
    return value;
  }

  /** Re-register the connected-login pool with the account coordinator so lease
   *  rotation reflects the current set (called after connect/rename/delete). */
  private async refreshLoginPool(): Promise<void> {
    // Which models exist depends on which logins are connected.
    this.modelCatalog.invalidate();
    if (!this.deps.configHomes || !this.deps.client) return;
    const { concurrencyFor } = await import('../platform/credential-sources.js');
    const creds = (await this.deps.store.listOrganizations()).flatMap((organization) =>
      enumerateCredentials(gatherCredentialSources({
        configHomes: this.deps.configHomes,
        broker: this.deps.broker,
        organizationId: organization.id,
      })),
    );
    const pool = (await __asyncCollections.map(creds, async (c) => {
      const maxConcurrent = (await concurrencyFor(async (k) => (await this.deps.store.kvGet(k)), c.key));
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
    }));
    if (!pool.length) return;
    const { makeCoordinatorActivities } = await import('../activities/coordinator.js');
    await makeCoordinatorActivities({ client: this.deps.client, taskQueue: this.deps.taskQueue }).registerAccounts(pool).catch(() => undefined);
  }

  /** Probe usage for pollable subscription logins (all, or just `only`) and cache the
   *  snapshots in kv under `usage:<credKey>`. Concurrent Dashboard refreshes
   *  share the same in-flight provider probe. */
  private async refreshUsage(only?: string, organizationId = 'org_personal'): Promise<Record<string, unknown>> {
    const { refreshCredentialHealth } = await import('../agent/credential-health.js');
    return refreshCredentialHealth({
      store: this.deps.store,
      client: this.deps.client,
      taskQueue: this.deps.taskQueue,
      configHomes: this.deps.configHomes,
      broker: this.deps.broker,
    }, { organizationId, only });
  }

  private async organizationAccountStatus(organizationId: string): Promise<Array<Record<string, any>>> {
    const keys = new Set(this.organizationCredentialKeys(organizationId));
    let view: { accounts?: Array<Record<string, any>> } = {};
    try {
      view = await withTimeout(this.deps.client.workflow.getHandle(accountCoordinatorId()).query('accounts'), 3000) as typeof view;
    } catch {
      /* coordinator not running or wedged — show empty rather than hang */
    }
    return __asyncCollections.map((view.accounts ?? []).filter((account) => keys.has(account.id)), async (account) => {
      const sourceTaskId = account.lastTransition?.sourceTaskId;
      const task = sourceTaskId ? (await this.deps.store.getTask(sourceTaskId)) : undefined;
      // A source task in another tenant stays an opaque id, never a title.
      const visible = task && ((await this.deps.store.getProject(task.projectId))?.organizationId ?? 'org_personal') === organizationId;
      return {
        ...account,
        ...(visible ? { lastTransition: {
          ...account.lastTransition,
          sourceTask: { id: task.id, num: task.num, title: task.title, projectId: task.projectId },
        } } : {}),
      };
    });
  }

  private organizationCredentialKeys(organizationId: string): string[] {
    return enumerateCredentials(gatherCredentialSources({
      configHomes: this.deps.configHomes,
      broker: this.deps.broker,
      organizationId,
    })).map((credential) => credential.key);
  }

  private async enrichAgentDefaults(m: import('../contrib/manifests.js').WorkflowManifest, vals: Record<string, unknown>, projectId?: string, organizationId?: string) {
    const out = { ...vals };
    for (const f of m.params) {
      if ((f.type !== 'agent' && f.type !== 'confirmer' && f.type !== 'responder') || !f.role) continue;
      const spec = (out[f.name] as any) || {};
      // The project's role-default overlay overrides the global one (SPEC §9), so a
      // per-project model/provider default flows through to new tasks' inherited value.
      const prof = (await roleDefaultProfile(this.deps.store, f.role, projectId, organizationId));
      const provider = spec.provider ?? prof?.provider ?? defaultProvider().provider;
      const model = spec.model ?? prof?.model ?? defaultModel(provider);
      const effort = spec.effort ?? prof?.effort ?? defaultEffort(provider);
      const mcpConnections = spec.mcpConnections ?? prof?.mcpConnections;
      const agent = { ...(mcpConnections !== undefined ? { mcpConnections } : {}), provider, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(spec.resumeFrom ? { resumeFrom: spec.resumeFrom } : {}) };
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
              return { ...l, ...(l.mcpConnections === undefined && prof?.mcpConnections !== undefined ? { mcpConnections: prof.mcpConnections } : {}), provider: lprov, ...(lmodel ? { model: lmodel } : {}), ...(leffort ? { effort: leffort } : {}) };
            }),
            agentDefault: agent,
          }
        : f.type === 'responder'
          ? spec.kind === 'agent'
            ? {
                ...spec,
                kind: 'agent',
                provider: spec.provider ?? prof?.provider ?? defaultProvider().provider,
                model: spec.model ?? prof?.model ?? defaultModel(spec.provider ?? prof?.provider ?? defaultProvider().provider),
                effort: spec.effort ?? prof?.effort ?? defaultEffort(spec.provider ?? prof?.provider ?? defaultProvider().provider),
                agentDefault: agent,
              }
            : {
                kind: 'human',
                audience: spec.audience?.length ? spec.audience : ['@creator'],
                agentDefault: agent,
              }
        : agent;
    }
    return out;
  }

  /** Brand assets, resolved per request against the instance-wide icon setting.
   * Serving them from one stable path is what lets the favicon, the installed
   * app icon and the pre-auth login mark all follow the setting with no client
   * knowledge of it — and no build step over `web/`. */
  private async brand(p: string, res: http.ServerResponse, req: http.IncomingMessage) {
    const name = p.slice('/brand/'.length);
    // `/brand/<file>` follows the setting; `/brand/<variant>/<file>` addresses one
    // variant directly, which is how the settings picker previews the choices.
    if (!BRAND_FILES.includes(name as (typeof BRAND_FILES)[number])) return (await this.static(p, res, req));
    const icon = brandIconOf((await this.deps.store.getSettings('global', 'appearance')));
    const file = path.join(this.deps.staticDir, 'brand', icon, name);
    // Favicons are cached hard by default; revalidating (by ETag) keeps a switch instant.
    if (await assetExists(this.deps.staticDir, file)) return serveStaticAsset(req, res, file);
    // A variant need not ship every format (only the diamond has an SVG); the
    // browser falls through to the next <link rel="icon"> on a miss.
    res.writeHead(404).end('not found');
  }

  /** Unlike the static asset shell, the installable-app name follows the live
   * installation setting. Icons keep their stable setting-resolved URLs. */
  private async webManifest(res: http.ServerResponse) {
    const name = (await this.siteName);
    const body = JSON.stringify({
      name,
      short_name: name,
      description: 'Your agent task board',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#f6f7f9',
      theme_color: '#5b5bd6',
      icons: [
        { src: '/brand/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
    res.writeHead(200, { 'content-type': MIME['.webmanifest']!, 'cache-control': 'no-cache',
      'content-length': String(Buffer.byteLength(body)) });
    res.end(body);
  }

  // ── static SPA ──
  private async static(p: string, res: http.ServerResponse, req?: http.IncomingMessage) {
    const rel = p === '/' ? '/index.html' : p === '/billing/checkout' ? '/paddle-checkout.html' : p;
    let file = path.join(this.deps.staticDir, rel);
    if (unpublishedAsset(file)) return void res.writeHead(404).end('not found');
    if (!(await assetExists(this.deps.staticDir, file))) file = path.join(this.deps.staticDir, 'index.html'); // SPA fallback
    const name = path.basename(file);
    // Brand the HTML response itself, not just the hydrated SPA. That avoids a
    // flash of the default name and gives crawlers/non-JS clients the current
    // installation identity. The checked-in shell remains a portable fallback.
    const brandShell = async (data: Buffer) => {
      const siteName = escapeHtml((await this.siteName));
      return Buffer.from(data.toString('utf8')
        .replace(/(<meta name="description" content=")[^"]*(" \/>)/, `$1${siteName} is the to-do list for managing AI agents: parallel cloud worlds, review gates, permissions, credentials, and payments in one calm interface.$2`)
        .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(" \/>)/, `$1${siteName}$2`)
        .replace(/<title>[^<]*<\/title>/, `<title>${siteName}</title>`));
    };
    // `llms.txt` is also public product copy. Keep its checked-in version a
    // useful default, then brand both its prose and same-origin links at the
    // edge so hosted and self-hosted installations describe themselves.
    const brandLlms = async (data: Buffer) => {
      const siteName = (await this.siteName);
      const origin = req ? this.publicUrl(req) : process.env.KARMAX_PUBLIC_URL?.replace(/\/$/, '') ?? '';
      return Buffer.from(data.toString('utf8')
        .replace(/^# tavya$/m, `# ${siteName}`)
        .replace(/^> tavya is /m, `> ${siteName} is `)
        .replace(/^tavya gives /m, `${siteName} gives `)
        .replace(/https:\/\/tavya\.io/g, origin || 'https://tavya.io'));
    };
    try {
      await serveStaticAsset(req, res, file, name === 'index.html' ? brandShell : name === 'llms.txt' ? brandLlms : undefined);
    } catch {
      if (!res.headersSent) res.writeHead(404).end('not found');
    }
  }

  /** Serve an artifact through its world provider. The browser never receives a
   * host/sandbox path and remote worlds need no public filesystem endpoint.
   * `sourceFile` (conversation file links) defaults unknown extensions to an
   * inline text view instead of a download, for a useful source view. */
  private async serveArtifact(res: http.ServerResponse, taskId: string, relPath: string, sourceFile = false) {
    const task = (await this.deps.store.getTask(taskId));
    const saved = !sourceFile && task ? (await savedReviewArtifact(this.deps.store, taskId, relPath)) : undefined;
    if (saved) {
      if (!this.deps.objects) return this.json(res, 503, { error: 'artifact storage is unavailable' });
      try {
        const data = await this.deps.objects.get(saved.objectKey);
        if (crypto.createHash('sha256').update(data).digest('hex') !== saved.sha256)
          return this.json(res, 502, { error: 'artifact integrity check failed' });
        res.writeHead(200, { ...untrustedContentHeaders(saved.mediaType, saved.name),
          'content-length': String(data.length), 'cache-control': 'private, no-store' });
        return void res.end(data);
      } catch {
        return this.json(res, 503, { error: 'saved artifact is unavailable' });
      }
    }
    const handle = worldHandleForView(task?.lastView, taskId, task ? (await this.deps.store.effectiveProjectConfig(task.projectId)) : undefined);
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
        if ((await fs.promises.stat(real)).size > MAX_REVIEW_ARTIFACT_BYTES) return this.json(res, 413, { error: 'file exceeds 100 MiB' });
      }
      // One byte past the cap tells a larger file apart without loading it whole.
      const data = await readWorldFilePrefix(world, relPath, MAX_REVIEW_ARTIFACT_BYTES + 1);
      if (data.length > MAX_REVIEW_ARTIFACT_BYTES) return this.json(res, 413, { error: 'file exceeds 100 MiB' });
      const inferredType = ARTIFACT_MIME[path.extname(relPath).toLowerCase()];
      const looksTextual = !data.subarray(0, 8192).includes(0);
      res.writeHead(200, {
        ...untrustedContentHeaders(inferredType ?? (sourceFile && looksTextual ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
          path.basename(relPath)),
        'content-length': String(data.length),
        'cache-control': 'no-store',
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
    const task = (await this.deps.store.getTask(taskId));
    const handle = worldHandleForView(task?.lastView, taskId, task ? (await this.deps.store.effectiveProjectConfig(task.projectId)) : undefined);
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
      if (!configuredPreviewOrigin() || !this.requestIsPreviewOrigin(req))
        headers['content-security-policy'] = 'sandbox allow-scripts allow-forms allow-downloads';
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
    const lease = match ? (await this.deps.store.previewLease(match[1]!)) : undefined;
    if (!lease || lease.revokedAt || lease.expiresAt <= Date.now()) return this.previewStopped(req, res, 404, 'preview not found or expired');
    if (configuredPreviewOrigin() && String(req.headers.host ?? '').toLowerCase() !== new URL(previewLeaseOrigin(lease.id)).host.toLowerCase())
      return this.previewStopped(req, res, 404, 'preview not found or expired');
    const current = (await this.deps.store.currentWorld(lease.worldId));
    if (!current || (current.generation ?? 1) !== lease.generation) return this.previewStopped(req, res, 410, 'preview world generation is no longer current');
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
      if (!session || !(await this.deps.tokens.check(session.apiToken, 'task:read', { projectId: lease.projectId, taskId: lease.taskId })).ok)
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
    const lifetime = socketLifetime(browser);
    const url = new URL(req.url ?? '/', 'http://localhost');
    let taskId: string;
    let port: number;
    let requestPath: string;
    /** The connect-time decision, made again while the socket stays open. */
    let stillAllowed: () => Promise<boolean>;
    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/preview\/(\d+)(\/.*)?$/);
    if (taskMatch) {
      if (configuredPreviewOrigin()) { browser.close(4403, 'use isolated preview origin'); return; }
      taskId = decodeURIComponent(taskMatch[1]!);
      port = Number(taskMatch[2]);
      const task = (await this.deps.store.getTask(taskId));
      const auth = await this.socketAuth(req, url, task?.projectId);
      stillAllowed = async () => {
        const current = task && await this.socketAuth(req, url, task.projectId);
        return !!current && await this.sessionMay(current, 'task:review:execute', task!.projectId, taskId);
      };
      if (!task || !auth || !(await this.deps.tokens.check(auth.apiToken, 'task:review:execute', { projectId: task.projectId, taskId })).ok) {
        browser.close(4403, 'forbidden'); return;
      }
      const query = new URLSearchParams(url.searchParams); query.delete('token');
      requestPath = `${taskMatch[3] ?? '/'}${query.size ? `?${query}` : ''}`;
    } else {
      const leaseMatch = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
      const lease = leaseMatch ? (await this.deps.store.previewLease(leaseMatch[1]!)) : undefined;
      stillAllowed = async () => {
        const current = await this.deps.store.previewLease(lease!.id);
        if (!current || current.revokedAt || current.expiresAt <= Date.now()) return false;
        if (((await this.deps.store.currentWorld(current.worldId))?.generation ?? 1) !== current.generation) return false;
        if (current.tokenHash) return true;
        const session = await this.auth(req, current.projectId, current.organizationId);
        return !!session && await this.sessionMay(session, 'task:read', current.projectId, current.taskId);
      };
      if (!lease || lease.revokedAt || lease.expiresAt <= Date.now()) { browser.close(4404, 'preview expired'); return; }
      if (configuredPreviewOrigin() && String(req.headers.host ?? '').toLowerCase() !== new URL(previewLeaseOrigin(lease.id)).host.toLowerCase()) {
        browser.close(4404, 'preview expired'); return;
      }
      const current = (await this.deps.store.currentWorld(lease.worldId));
      if (!current || (current.generation ?? 1) !== lease.generation) { browser.close(4410, 'world changed'); return; }
      if (lease.tokenHash) {
        const queryToken = url.searchParams.get('token') ?? '';
        const cookieToken = previewCookieValue(typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined, lease.id);
        if (!previewTokenMatches(lease.tokenHash, queryToken || cookieToken)) {
          browser.close(4401, 'invalid token'); return;
        }
      } else {
        const auth = await this.auth(req, lease.projectId, lease.organizationId);
        if (!auth || !(await this.deps.tokens.check(auth.apiToken, 'task:read', { projectId: lease.projectId, taskId: lease.taskId })).ok) {
          browser.close(4401, 'unauthorized'); return;
        }
      }
      taskId = lease.taskId;
      port = lease.port;
      const query = new URLSearchParams(url.searchParams); query.delete('token');
      requestPath = `${leaseMatch?.[2] ?? '/'}${query.size ? `?${query}` : ''}`;
    }
    const task = (await this.deps.store.getTask(taskId));
    const handle = worldHandleForView(task?.lastView, taskId, task ? (await this.deps.store.effectiveProjectConfig(task.projectId)) : undefined);
    if (!handle) { browser.close(4404, 'world unavailable'); return; }
    const access = this.deps.worldAccess ? await this.deps.worldAccess.open(taskId, handle) : undefined;
    lifetime.add(() => access?.release());
    if (lifetime.closed) return;
    const world = access?.world ?? await this.deps.worlds.open(handle);
    if (!world.previewSocketTarget) { lifetime.close(); browser.close(4400, 'provider has no WebSocket previews'); return; }
    let target: Awaited<ReturnType<NonNullable<typeof world.previewSocketTarget>>>;
    try { target = await world.previewSocketTarget(port, requestPath); }
    catch { lifetime.close(); browser.close(1011, 'preview upstream unavailable'); return; }
    if (lifetime.closed) return;
    const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    const upstream = new WebSocketClient(target.url, protocols, { headers: target.headers });
    const pending: Array<{ data: import('ws').RawData; binary: boolean }> = [];
    browser.on('message', (data, binary) => {
      if (browser.readyState !== WebSocketClient.OPEN) return;
      if (upstream.readyState === WebSocketClient.OPEN) upstream.send(data, { binary });
      else if (upstream.readyState === WebSocketClient.CONNECTING && pending.length < 100) pending.push({ data, binary });
    });
    const release = () => lifetime.close();
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
    lifetime.add(() => { if (upstream.readyState !== WebSocketClient.CLOSED) upstream.terminate(); });
    keepAuthorized(browser, lifetime, stillAllowed);
  }

  /**
   * May a socket's session still do `capability`? A person is decided from
   * their current grants (with the account-closed and SSO checks), as their
   * event stream is: their socket token is minted for ten minutes, so it
   * would see a narrowed grant late and close a still-authorized session
   * once it expired. Decisions are shared for a second, so a pass over many
   * sockets of one person costs one lookup. Anything else is its token.
   */
  private async sessionMay(session: Session, capability: Capability, projectId: string | undefined, taskId: string): Promise<boolean> {
    if (!session.userId || !this.deps.authorization || !projectId)
      return (await this.deps.tokens.check(session.apiToken, capability, { projectId, taskId })).ok;
    const userId = session.userId;
    // Shared: what the person may do in the project. Per call: the task.
    const caps = await this.personCapabilities(userId, session.email, projectId);
    if (!caps) return false;
    if (['task:edit', 'task:review:execute'].includes(capability) && await this.deps.store.kvGet(`project-transfer-history:${taskId}`))
      return false; // as tokens.check: history from before a project move
    if (allows(caps, capability)) return true;
    // `task:manage-own` covers the tasks this person created, and their sub-tasks.
    if (!OWN_TASK_CAPABILITIES.has(capability) || !allows(caps, 'task:manage-own')) return false;
    for (let id: string | undefined = taskId, seen = new Set<string>(); id && !seen.has(id);) {
      seen.add(id);
      const record = await this.deps.store.taskMetadataAsync(id);
      if (record?.createdBy?.kind === 'user' && record.createdBy.userId === userId) return true;
      id = record?.parentTaskId;
    }
    return false;
  }

  /** A person's capabilities in a project, or undefined when their account is
   * closed or SSO no longer admits them; shared across their sockets for a
   * second within one authorization epoch. */
  private personCapabilities(userId: string, email: string | undefined, projectId: string): Promise<Capability[] | undefined> {
    const key = `${authorizationEpoch()}\0${userId}\0${projectId}`;
    const now = Date.now();
    const cached = this.personDecisions.get(key);
    if (cached && cached.until > now) return cached.caps;
    if (this.personDecisions.size > 1024) this.personDecisions.clear();
    const caps = (async () => {
      if (await this.deps.store.kvGet(`account-closed:${userId}`)) return undefined;
      const organizationId = await this.deps.store.projectOrganizationAsync(projectId);
      if (organizationId && !(await this.ssoAdmits(userId, email, organizationId))) return undefined;
      return this.deps.authorization!.capabilitiesAsync(`user:${userId}`, projectId, organizationId);
    })();
    caps.catch(() => this.personDecisions.delete(key));
    this.personDecisions.set(key, { caps, until: now + 1_000 });
    return caps;
  }

  /** Is the session a ticket was issued for still signed in? A browser
   * session can sign out, a local password session log out or expire. */
  private async sessionLive(session: Session): Promise<boolean> {
    if (session.identitySessionId && session.userId) return this.deps.tokens.identitySessionLive(session.identitySessionId, session.userId);
    // Passwordless local mode shares one session with no sign-in to protect:
    // its 12-hour expiry would only cut a shell off minutes after attaching.
    if ([...this.sessions.values()].includes(session))
      return (!this.deps.password && !this.deps.identity) || (session.expiresAt ?? Infinity) > Date.now();
    return !!(await this.deps.tokens.verify(session.apiToken)); // an API token: until it is revoked or expires
  }

  /** SCIM 2.0 provisioning boundary. A tenant-scoped bearer token is stored only
   * as a hash; deprovisioning removes every org/team/project grant and revokes
   * browser + platform sessions without deleting an identity used by another org. */
  private async scim(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const match = url.pathname.match(/^\/scim\/v2\/([^/]+)\/(Users|Groups)(?:\/([^/]+))?$/);
    if (!match || !this.deps.identity) return this.scimJson(res, 404, { detail: 'resource not found' });
    const organizationId = decodeURIComponent(match[1]!);
    const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!(await this.deps.store.verifyScimToken(organizationId, token))) return this.scimJson(res, 401, { detail: 'invalid bearer token' });
    const resource = match[2]!;
    const id = match[3] ? decodeURIComponent(match[3]) : undefined;
    const method = req.method ?? 'GET';
    try {
      const body = method === 'GET' || method === 'DELETE' ? {} : await this.body(req);
      if (resource === 'Users') {
        if (method === 'GET' && id) {
          const user = (await this.deps.identity.listUsers()).find((candidate) => candidate.id === id);
          if (!user || !(await this.deps.store.organizationMembership(organizationId, id))) return this.scimJson(res, 404, { detail: 'user not found' });
          return this.scimJson(res, 200, scimUser(user));
        }
        if (method === 'GET') {
          const filter = url.searchParams.get('filter')?.match(/^userName\s+eq\s+"([^"]+)"$/i)?.[1]?.toLowerCase();
          const members = new Set((await this.deps.store.listOrganizationMemberships(organizationId)).map((member) => member.userId));
          const users = (await this.deps.identity.listUsers()).filter((user) => members.has(user.id) && (!filter || user.email.toLowerCase() === filter));
          return this.scimJson(res, 200, scimList(users.map((user) => scimUser(user))));
        }
        if (method === 'POST') {
          const email = String(body.userName ?? body.emails?.find((entry: any) => entry.primary)?.value ?? '').trim().toLowerCase();
          if (!email) return this.scimJson(res, 400, { detail: 'userName is required' });
          let user = (await this.deps.identity.listUsers()).find((candidate) => candidate.email.toLowerCase() === email);
          if (!user) user = await this.deps.identity.createUser({ name: String(body.displayName ?? body.name?.formatted ?? email.split('@')[0]),
            email, password: crypto.randomBytes(24).toString('base64url') });
          (await this.deps.store.setOrganizationMembership(organizationId, user.id, 'member'));
          (await this.deps.authorization?.grant('system:scim', { principalId: `user:${user.id}`,
            scopeKey: `organization:${organizationId}`, profileId: 'developer',
            capabilities: ['organization:read', 'organization:member:read', 'team:read', 'repository:read', 'inbox:*'] }));
          void this.deps.subscriptions?.syncSeats(organizationId).catch(() => undefined);
          return this.scimJson(res, 201, scimUser(user));
        }
        if ((method === 'PATCH' || method === 'PUT') && id) {
          // An IdP administers its own organization's users only; `revokeUserSessions`
          // is installation-wide, so membership is checked before either branch.
          if (!(await this.deps.store.organizationMembership(organizationId, id))) return this.scimJson(res, 404, { detail: 'user not found' });
          const activeOperation = body.Operations?.find((operation: any) => String(operation.path ?? '').toLowerCase() === 'active');
          const active = activeOperation ? activeOperation.value !== false : body.active !== false;
          if (!active) {
            (await this.deps.store.deprovisionOrganizationUser(organizationId, id));
            (await this.deps.identity.revokeUserSessions(id));
          }
          void this.deps.subscriptions?.syncSeats(organizationId).catch(() => undefined);
          const user = (await this.deps.identity.listUsers()).find((candidate) => candidate.id === id);
          return this.scimJson(res, 200, user ? scimUser(user, active) : { id, active });
        }
        if (method === 'DELETE' && id) {
          if (!(await this.deps.store.organizationMembership(organizationId, id))) return this.scimJson(res, 404, { detail: 'user not found' });
          (await this.deps.store.deprovisionOrganizationUser(organizationId, id));
          (await this.deps.identity.revokeUserSessions(id));
          void this.deps.subscriptions?.syncSeats(organizationId).catch(() => undefined);
          res.writeHead(204); return void res.end();
        }
      }
      if (resource === 'Groups') {
        if (method === 'GET' && id) {
          const team = (await this.deps.store.getTeam(id));
          if (!team || team.organizationId !== organizationId) return this.scimJson(res, 404, { detail: 'group not found' });
          return this.scimJson(res, 200, scimGroup(team, (await this.deps.store.listTeamMemberships(team.id))));
        }
        if (method === 'GET') return this.scimJson(res, 200, scimList((await __asyncCollections.map((await this.deps.store.listTeams(organizationId)), async (team) => scimGroup(team, (await this.deps.store.listTeamMemberships(team.id)))))));
        if (method === 'POST') {
          const team = (await this.deps.store.createTeam({ organizationId, name: String(body.displayName ?? 'Team') }));
          for (const member of body.members ?? []) if ((await this.deps.store.organizationMembership(organizationId, String(member.value))))
            (await this.deps.store.setTeamMembership(team.id, String(member.value)));
          return this.scimJson(res, 201, scimGroup(team, (await this.deps.store.listTeamMemberships(team.id))));
        }
        if ((method === 'PUT' || method === 'PATCH') && id) {
          const team = (await this.deps.store.getTeam(id));
          if (!team || team.organizationId !== organizationId) return this.scimJson(res, 404, { detail: 'group not found' });
          const members = body.members ?? body.Operations?.find((operation: any) => String(operation.path ?? '').toLowerCase() === 'members')?.value;
          if (Array.isArray(members)) {
            (await this.deps.store.db.prepare('DELETE FROM team_memberships WHERE teamId=?').run(team.id));
            for (const member of members) if ((await this.deps.store.organizationMembership(organizationId, String(member.value))))
              (await this.deps.store.setTeamMembership(team.id, String(member.value)));
          }
          return this.scimJson(res, 200, scimGroup(team, (await this.deps.store.listTeamMemberships(team.id))));
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
  /** External deletion and tenant transfer must never overlap. A deletion fence
   * survives a gateway crash; retrying that same idempotent deletion replaces
   * it. It cannot expire underneath an outstanding provider delete request. */
  private async withDeletionFence<T>(projectIds: string[], organizationId: string | undefined, work: (projectIds: string[]) => Promise<T>): Promise<T> {
    const store = this.deps.store;
    const value = JSON.stringify({ id: crypto.randomUUID(), kind: 'delete', expiresAt: Number.MAX_SAFE_INTEGER });
    const keys = await store.transaction(async () => {
      // Built per attempt: a re-run transaction starts over.
      const keys: string[] = [];
      if (organizationId) {
        if (store.db.dialect === 'postgres') await store.db.prepare('SELECT id FROM organizations WHERE id=? FOR UPDATE').get(organizationId);
        projectIds = (await store.listProjects()).filter(p => p.organizationId === organizationId).map(p => p.id);
        keys.push(`organization-deleting:${organizationId}`);
      }
      keys.push(...projectIds.map(id => `project-transfer-lock:${id}`));
      for (const id of [...projectIds].sort()) {
        if (store.db.dialect === 'postgres') await store.db.prepare('SELECT id FROM projects WHERE id=? FOR UPDATE').get(id);
        const current = JSON.parse((await store.kvGet(`project-transfer-lock:${id}`)) ?? '{}');
        if (current.kind !== 'delete' && current.expiresAt > Date.now())
          throw new ProjectTransferError('A project move is in progress. Retry deletion when it finishes.');
      }
      for (const key of keys) await store.kvSet(key, value);
      return keys;
    });
    try { return await work(projectIds); }
    finally { for (const key of keys) await store.db.prepare('DELETE FROM kv WHERE k=? AND v=?').run(key, value); }
  }

  private async removeProjectExternalResources(projectId: string, reason: string) {
    const project = (await this.deps.store.getProject(projectId));
    if (!project) throw new Error('project not found');
    for (const card of (await this.deps.store.listCards(projectId, project.organizationId))
      .filter((candidate) => candidate.scope === 'project' && candidate.scopeId === projectId
        && candidate.status !== 'canceled')) {
      const provider = this.deps.paymentRegistry?.forCard(card)
        ?? (card.provider === this.deps.payments?.name ? this.deps.payments : undefined);
      if (!provider) throw new Error(`payment provider "${card.provider}" is unavailable; cannot safely revoke ${card.label}`);
      await provider.revoke(card.id);
    }
    const resources = (await this.deps.store.projectResources(projectId));
    for (const task of (await this.deps.store.listTasks(projectId))) {
      try { await this.deps.client.workflow.getHandle(task.id).terminate(reason); }
      catch (error) { if (!isWorkflowGone(error)) throw error; }
    }
    // Finalize billing before metadata disappears. Queued leases produce zero
    // usage; active leases keep the elapsed provider cost in the org ledger.
    for (const lease of resources.leases) {
      if (this.deps.runners) (await this.deps.runners.release(lease.id, lease.provider));
      else (await this.deps.store.releaseWorldLease(lease.id));
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
    if (this.deps.checkpoints) await this.deps.checkpoints.deleteProject(projectId);
    else if ((await this.deps.store.listProjectCheckpoints(projectId)).some(checkpoint => checkpoint.filesystemDelta?.format === 2))
      throw new Error('checkpoint storage is unavailable; project checkpoints were not deleted');
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
  private async autoRaiseCredential(
    vault: VaultItems,
    decision: { status: AccessStatus; reason?: string },
    ctx: { caps: string[]; taskId?: string; projectId?: string; item: { id: string }; field?: unknown; mode: AccessMode; why?: unknown },
  ): Promise<Record<string, unknown>> {
    const base: Record<string, unknown> = { ...decision, itemId: ctx.item.id };
    if (decision.status !== 'needs_approval' || !ctx.taskId) return base;
    const raised = (await vault.request({
      taskId: ctx.taskId, projectId: ctx.projectId, caps: ctx.caps,
      itemId: ctx.item.id, field: ctx.field as VaultFieldName | undefined, mode: ctx.mode,
      why: ctx.why != null ? String(ctx.why) : undefined,
    }));
    return raised.requestId ? { ...base, requestId: raised.requestId } : base;
  }

  /**
   * Type a resolved secret into the agent's browser (§5B). For a LOCAL world the
   * gateway drives CDP directly (agent + gateway share the host). For a REMOTE
   * world the browser lives in the sandbox with no private path from the host,
   * so the fill runs INSIDE the world via `world.exec`, the secret handed over
   * stdin (never argv/env/a file). The agent still controls its browser. Either way
   * the live page origin is re-verified against the item's domains before typing.
   * The browser is always the calling task's own, never one the agent names
   * (AU-14): its world's, or on the host the one its agent launched.
   */
  private async fillCredential(callerTaskId: string | undefined, args: {
    selector: string; expectDomains?: string[]; resolveText: () => string | Promise<string>;
  }): Promise<string> {
    const handle = await this.taskWorldHandle(callerTaskId);
    if (handle && this.agentRunsInWorld(handle)) {
      let access: Awaited<ReturnType<NonNullable<GatewayDeps['worldAccess']>['open']>> | undefined;
      try {
        access = this.deps.worldAccess ? await this.deps.worldAccess.open(callerTaskId!, handle) : undefined;
        const world = access?.world ?? await this.deps.worlds.open(handle);
        const { fillInWorld } = await import('../autonomy/world-fill.js');
        return (await fillInWorld(world, { selector: args.selector, expectDomains: args.expectDomains, cdpUrl: WORLD_CDP_URL, resolveText: args.resolveText })).origin;
      } finally {
        await access?.release();
      }
    }
    const { fillViaCdp } = await import('../autonomy/fill.js');
    return (await fillViaCdp({ cdpUrl: localTaskBrowserUrl(callerTaskId), selector: args.selector, resolveText: args.resolveText, expectDomains: args.expectDomains })).origin;
  }

  /** A page session in the task world's browser, holding the world open until it closes. */
  /** How to open a page on the calling task's own browser (AU-12, AU-14): its
   *  world's, relayed over a world terminal, or on this host the one its agent
   *  launched. `what` names the feature in the refusal. */
  private async taskPageOpener(callerTaskId: string | undefined, what: string): Promise<{ open: TaskPageOpener } | { error: string }> {
    const handle = await this.taskWorldHandle(callerTaskId);
    if (!handle) return { error: `${what} run in a task's own browser; call this from a task that has a world` };
    const inWorld = this.agentRunsInWorld(handle);
    if (this.deps.hosted && !inWorld) return { error: `hosted ${what} run in the task's remote world` };
    if (inWorld) return { open: (domains) => this.openTaskWorldPage(callerTaskId!, handle, domains) };
    let browser: string;
    try { browser = localTaskBrowserUrl(callerTaskId); }
    catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
    return { open: async (domains) => (await import('../autonomy/cdp.js')).openPage(browser, { expectDomains: domains }) };
  }

  private async openTaskWorldPage(taskId: string, handle: WorldHandle, expectDomains: string[]) {
    const access = this.deps.worldAccess ? await this.deps.worldAccess.open(taskId, handle) : undefined;
    let released = false;
    const release = async () => { if (!released) { released = true; await access?.release(); } };
    try {
      const world = access?.world ?? await this.deps.worlds.open(handle);
      const { openWorldPage } = await import('../autonomy/world-fill.js');
      return await openWorldPage(world, { expectDomains, cdpUrl: WORLD_CDP_URL, onClose: release });
    } catch (e) {
      await release();
      throw e;
    }
  }

  private async taskWorldHandle(taskId: string | undefined) {
    const task = taskId ? (await this.deps.store.getTask(taskId)) : undefined;
    return task ? worldHandleForView(task.lastView, taskId!, (await this.deps.store.effectiveProjectConfig(task.projectId))) : undefined;
  }

  /** Does the task's agent — and so its browser — run inside its world (a cloud
   *  sandbox or a container) rather than on this host? */
  private agentRunsInWorld(handle: WorldHandle): boolean {
    return handle.kind === 'container' || worldHandleIsRemote(handle) || !!this.deps.worlds.get(handle.kind)?.capabilities?.remote;
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
  private async githubPublicUrl(req: http.IncomingMessage, browserUrl?: unknown): Promise<string> {
    if (browserUrl != null) {
      const value = this.publicUrl(req, browserUrl);
      (await this.deps.store.kvSet(GITHUB_APP_PUBLIC_URL_KEY, value));
      return value;
    }
    // A deployment-domain migration is authoritative. The persisted browser
    // origin belongs to the original manifest setup and otherwise keeps OAuth
    // callbacks pinned to the retired host forever after a move.
    const configured = process.env.KARMAX_PUBLIC_URL?.trim();
    if (configured) return new URL(configured).origin;
    return (await this.deps.store.kvGet(GITHUB_APP_PUBLIC_URL_KEY)) ?? this.publicUrl(req);
  }

  /** Connecting GitHub must give the personal organization repository access,
   * not only a commit identity. Link the App installation on the user's own
   * GitHub account (the same check as connecting an existing installation);
   * when there is none, return the GitHub installation URL if `install`. */
  private async linkPersonalGithubInstallation(userId: string,
    account: import('../integrations/github-app.js').GitHubUserIdentity, install: boolean): Promise<string | undefined> {
    const githubApp = this.deps.githubApp!;
    const personal = (await this.deps.store.listOrganizations(userId)).find((organization) => organization.kind === 'personal');
    if (!personal || (await this.deps.store.listGitConnections(personal.id)).length) return undefined;
    try {
      const installationId = (await githubApp.ownInstallation(userId, account.id));
      if (!installationId) {
        return install ? githubApp.installationUrl((await this.deps.store.createGithubInstallState(personal.id, userId,
          { returnTo: 'profile', githubAccountId: account.id, githubLogin: account.login }))) : undefined;
      }
      await githubApp.connectInstallation(personal.id, installationId);
      for (const project of (await this.deps.store.listProjects()).filter((candidate) => candidate.organizationId === personal.id))
        await this.ensureProjectWiki(project, userId);
    } catch (error) {
      // A convenience only: sign-in succeeded, and organization settings can still connect.
      console.warn(`[github] personal installation link failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }

  private async saveGithubIdentity(userId: string,
    identity: import('../integrations/github-app.js').GitHubUserIdentity): Promise<void> {
    if (!this.deps.broker) throw new Error('GitHub identity storage is unavailable');
    const { GitProfiles, userGitScope } = await import('../autonomy/git-profiles.js');
    (await new GitProfiles(this.deps.store, this.deps.broker, undefined, userGitScope(userId))
      .saveGithubIdentity(identity));
    (await inheritPersonalGithubProfile(this.deps.store, this.deps.broker, userId));
  }

  /** An organization that enforces SSO admits only its provider's sessions. */
  private async ssoAdmits(userId: string, email: string | undefined, organizationId: string): Promise<boolean> {
    const policy = await this.deps.store.getOrganizationIdentityPolicyAsync(organizationId);
    if (!policy.enforceSso) return true;
    if (!policy.oidcProviderId || !(await this.deps.identity!.providersForUserAsync(userId)).includes(policy.oidcProviderId)) return false;
    if (policy.verifiedDomains.length && await this.deps.store.hasOrganizationMembershipAsync(organizationId, userId)) {
      const domain = email?.split('@')[1]?.toLowerCase();
      if (!domain || !policy.verifiedDomains.includes(domain)) return false;
    }
    return true;
  }

  /** Global search visits only the projects the caller can read, resolved once:
   *  a browser session's from its grants and memberships, authorized directly
   *  (minting a token per project wrote tokens on every keystroke); a bearer's
   *  from its own scope (UI-18/RQ-14). */
  private async searchProjects(_req: http.IncomingMessage, res: http.ServerResponse, session: Session, query: string) {
    const results: { projectId: string; tasks: EvalResult['tasks']; total: number }[] = [];
    if (query.length < 2) return results;
    const { api } = this.deps;
    const member = this.searchMember(session);
    for (const project of await this.searchableProjects(res, session)) {
      if (res.destroyed) break;
      const result = member ? await api.searchAuthorizedTasks(project.id, query, `user:${member}`)
        : await api.searchTasks(session.apiToken, project.id, query);
      results.push({ projectId: project.id, tasks: result.tasks.slice(0, 100), total: result.total });
    }
    return results;
  }

  /** The organization task list: one query over every project of the
   *  organization the caller can read, sorted together and paged. */
  private async searchOrganization(res: http.ServerResponse, session: Session, organizationId: string, url: URL) {
    const query = url.searchParams.get('q') ?? '';
    const page = { limit: Number(url.searchParams.get('limit') ?? 200), offset: Number(url.searchParams.get('offset') ?? 0) };
    if (!(await this.deps.store.getOrganization(organizationId))) return this.json(res, 404, { error: 'organization not found' });
    const member = this.searchMember(session);
    if (!member) return this.json(res, 200, await this.deps.api.searchOrganizationTasks(session.apiToken, organizationId, query, page));
    const projects = await this.searchableProjects(res, session, organizationId);
    // An empty list is an answer only to a member; anyone else is refused, like
    // every other route that names a foreign organization.
    if (!projects.length && !(await this.deps.store.organizationMembership(organizationId, member)))
      return this.json(res, 403, { error: 'You are not a member of this organization' });
    return this.json(res, 200, await this.deps.api.searchAuthorizedOrganization(projects, query, `user:${member}`, page));
  }

  /** A browser session searches as its signed-in person; a bearer by its token. */
  private searchMember(session: Session): string | undefined {
    const { authorization, identity } = this.deps;
    return session.userId && identity && authorization ? session.userId : undefined;
  }

  /** The projects a search may visit, optionally within one organization. */
  private async searchableProjects(res: http.ServerResponse, session: Session, organizationId?: string): Promise<Project[]> {
    const { authorization, store, tokens } = this.deps;
    const member = this.searchMember(session);
    let projects: Project[];
    if (member) projects = await store.listProjectsReachableBy(member);
    else {
      const record = await tokens.verify(session.apiToken);
      if (!record || !allows(record.caps, 'project:read') || !allows(record.caps, 'task:read')) return [];
      const ids = record.projectId ? [record.projectId] : record.projectIds;
      projects = ids?.length ? (await Promise.all(ids.map(id => store.getProject(id)))).filter((p): p is Project => !!p)
        : record.organizationId ? await store.listOrganizationProjects(record.organizationId)
        : await store.listProjects(); // installation-wide authority
    }
    const out: Project[] = [];
    for (const project of projects) {
      if (res.destroyed) break;
      const projectOrganization = project.organizationId ?? 'org_personal';
      if (organizationId && projectOrganization !== organizationId) continue;
      if (member) {
        const caps = await authorization!.capabilitiesAsync(`user:${member}`, project.id, projectOrganization);
        if (!allows(caps, 'project:read') || !allows(caps, 'task:read')
          || !(await this.ssoAdmits(member, session.email, projectOrganization))) continue;
      } else {
        const scope = { projectId: project.id, organizationId: projectOrganization };
        if (!(await tokens.check(session.apiToken, 'project:read', scope)).ok
          || !(await tokens.check(session.apiToken, 'task:read', scope)).ok) continue;
      }
      out.push(project);
    }
    return out;
  }

  private async auth(req: http.IncomingMessage, projectId?: string, organizationId?: string): Promise<Session | undefined> {
    const h = req.headers['authorization'];
    const sid = h?.startsWith('Bearer ') ? h.slice(7)
      : req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('krmax_session='))?.slice('krmax_session='.length);
    if (sid) {
      const legacy = this.sessions.get(sid);
      if (legacy) {
        if ((legacy.expiresAt ?? Infinity) > Date.now() && await this.deps.tokens.verify(legacy.apiToken)) return legacy;
        this.sessions.delete(sid);
        await this.deps.tokens.revoke(legacy.apiToken);
      }
      const agent = (await this.deps.tokens.verify(sid));
      if (agent) return { user: agent.principal, apiToken: sid };
    }
    if (!this.deps.identity) return undefined;
    const identity = await this.deps.identity.session(requestHeaders(req.headers));
    if (!identity) return undefined;
    if (await this.deps.store.kvGet(`account-closed:${identity.user.id}`)) return undefined;
    if (((await this.deps.paidLaunchSettings?.publicLaunchInfo()) ?? publicLaunchInfo()).paidLaunch && !await this.deps.store.hasSignupAcceptanceAsync(identity.user.id)) return undefined;
    const principal = `user:${identity.user.id}`;
    const resolvedOrganizationId = organizationId ?? (projectId ? await this.deps.store.projectOrganizationAsync(projectId) : undefined);
    if (resolvedOrganizationId && !(await this.ssoAdmits(identity.user.id, identity.user.email, resolvedOrganizationId)))
      return undefined;
    const caps = await this.deps.authorization?.capabilitiesAsync(principal, projectId, resolvedOrganizationId) ?? [];
    const fingerprint = JSON.stringify(caps.slice().sort());
    const cacheKey = `${identity.session.id}:${resolvedOrganizationId ?? 'global'}:${projectId ?? '*'}`;
    let cached = this.identityTokens.get(cacheKey);
    if (!cached || cached.fingerprint !== fingerprint || !(await this.deps.tokens.verify(cached.apiToken))) {
      if (cached) (await this.deps.tokens.revoke(cached.apiToken));
      const now = Date.now();
      for (const [key, entry] of this.identityTokens) if (entry.expiresAt <= now) {
        this.identityTokens.delete(key);
        await this.deps.tokens.revoke(entry.apiToken);
      }
      if (this.identityTokens.size >= 2_000) {
        const [key, entry] = this.identityTokens.entries().next().value!;
        this.identityTokens.delete(key);
        await this.deps.tokens.revoke(entry.apiToken);
      }
      const ttl = 10 * 60_000;
      cached = { apiToken: (await this.deps.tokens.mintPrincipal(principal, caps, projectId, ttl,
        resolvedOrganizationId, identity.session.id)).token, fingerprint, expiresAt: now + ttl, userId: identity.user.id };
      this.identityTokens.set(cacheKey, cached);
    }
    return { user: identity.user.name, userId: identity.user.id, email: identity.user.email, apiToken: cached.apiToken,
      identitySessionId: identity.session.id };
  }
  /** Browser sockets use HttpOnly cookies; API clients use Authorization. */
  private async socketAuth(req: http.IncomingMessage, _url: URL, projectId?: string): Promise<Session | undefined> {
    return this.auth(req, projectId);
  }
  /** Organization-scoped mailbox provider config (agent-mail §8). */
  /** Give a freshly self-registered user their own personal-workspace org (owner
   *  grant), so signup lands in a real workspace instead of the access-pending
   *  waiting room. Best-effort: a failure here never fails the signup itself. */
  private async provisionPersonalWorkspace(userId: string, name: string): Promise<boolean> {
    try {
      if ((await this.deps.store.listOrganizations(userId)).length) return false; // already has one
      const label = (name || '').trim();
      const organization = (await this.deps.store.createOrganization({
        name: label || 'Personal', kind: 'personal', ownerUserId: userId }));
      (await this.deps.store.setDefaultOrganization(userId, organization.id));
      (await this.deps.authorization?.bootstrapOrganizationOwner(`user:${userId}`, userId, organization.id));
      (await this.deps.resources?.storageLocationService()?.ensureManaged(organization.id));
      (await inheritPersonalGithubProfile(this.deps.store, this.deps.broker, userId));
      if (this.deps.hosted) (await this.enableHostedOnboarding(userId, organization.id));
      return true;
    } catch (e) {
      console.error('[signup] personal workspace provisioning failed:', e instanceof Error ? e.message : e);
      return false;
    }
  }

  private async enableHostedOnboarding(userId: string, organizationId: string): Promise<void> {
    const key = hostedOnboardingKey(userId, organizationId);
    if (!(await this.deps.store.kvGet(key)))
      (await this.deps.store.kvSet(key, JSON.stringify({ display: 'expanded' })));
  }

  /** Bind the pre-OAuth affirmative click to the identity returned by the social
   * provider. The opaque, short-lived HttpOnly cookie contains no policy data or
   * user identifier; the server consumes its hashed one-time record here. */
  private async consumeSignupPolicyAcceptance(req: http.IncomingMessage, userId: string, email: string): Promise<void> {
    const cookie = String(req.headers.cookie ?? '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith('krmax_policy_acceptance='));
    const token = cookie?.slice(cookie.indexOf('=') + 1);
    if (!token) return;
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const pending = this.pendingPolicyAcceptances.get(hash);
    if (!pending) return;
    this.pendingPolicyAcceptances.delete(hash);
    try {
      if (Number(pending.expiresAt) < Date.now()) return;
      const versions = assertPolicyAcceptance('signup', true, pending.versions);
      (await this.deps.store.recordPolicyAcceptance({ userId, email, context: 'signup', versions }));
    } catch { /* malformed/expired evidence is deliberately not recorded */ }
  }

  /** Installation-wide outbound email config (single row; operator-managed). */
  private async outboundEmailConfig(): Promise<import('../autonomy/email.js').OutboundEmailConfig> {
    try { return JSON.parse((await this.deps.store.kvGet('email:outbound')) ?? '{}'); } catch { return {}; }
  }
  private async setOutboundEmailConfig(config: import('../autonomy/email.js').OutboundEmailConfig): Promise<void> {
    (await this.deps.store.kvSet('email:outbound', JSON.stringify(config)));
  }
  private async mailboxConfig(organizationId: string): Promise<import('../autonomy/mailbox.js').MailboxConfig> {
    try {
      return JSON.parse((await this.deps.store.kvGet(`agent-mail:provider:${organizationId}`)) ?? '{}');
    } catch {
      return {};
    }
  }
  private async setMailboxConfig(organizationId: string, config: import('../autonomy/mailbox.js').MailboxConfig): Promise<void> {
    (await this.deps.store.kvSet(`agent-mail:provider:${organizationId}`, JSON.stringify(config)));
  }
  private async mailboxDomain(organizationId: string): Promise<string | undefined> {
    // The mint domain, resolved by the ACTIVE provider so a leftover field from a
    // previous provider can't win: imap/hosted-fixed use the address host,
    // agentmail its domain, hosted its domain, self-managed its domain.
    const c = (await this.mailboxConfig(organizationId));
    if (c.provider === 'imap') return c.fixedAddress?.split('@')[1] || undefined;
    if (c.provider === 'agentmail') return c.agentmailDomain || undefined;
    if (c.provider === 'hosted') return c.hostedDomain || undefined;
    if (c.provider === 'self-managed') return c.domain || process.env.KARMAX_AGENT_MAIL_DOMAIN || undefined;
    return c.domain || c.hostedDomain || c.agentmailDomain || c.fixedAddress?.split('@')[1] || process.env.KARMAX_AGENT_MAIL_DOMAIN || undefined;
  }
  /** The single-inbox base local part when addresses ride +tags on one mailbox
   *  (hosted fixed-address / IMAP); undefined for domain and AgentMail providers. */
  private async mailboxFixedLocal(organizationId: string): Promise<string | undefined> {
    return (await this.mailboxConfig(organizationId)).fixedAddress?.split('@')[0] || undefined;
  }
  /** The org-scoped vault handle a provider's secret is stored under. */
  private mailboxSecretHandle(organizationId: string, provider: string): string {
    return `mailbox:${provider}:${organizationId}:auth`;
  }

  private async requestScope(pathname: string, url: URL): Promise<{ projectId?: string; taskId?: string; organizationId?: string; conflict?: string }> {
    // Routes whose only identifier is a bare record id still belong to exactly
    // one project. Resolving that project here is what arms the tenant guard in
    // `TokenAuthority.check` — without it a `task:edit` token from any project
    // of any organization could rename or delete another tenant's tag or saved
    // view, because the check had no project to compare its scope against.
    const tagId = pathname.match(/^\/api\/tags\/([^/]+)/)?.[1];
    const viewId = pathname.match(/^\/api\/views\/([^/]+)/)?.[1];
    const pathProject = pathname.match(/^\/api\/projects\/([^/]+)/)?.[1]
      ?? pathname.match(/^\/api\/defaults\/([^/]+)/)?.[1]
      ?? pathname.match(/^\/api\/settings\/(?:quick\/)?project\/([^/]+)/)?.[1];
    const artifact = pathname.match(/^\/api\/artifacts\/([^/]+)/)?.[1];
    const artifactRecord = artifact ? (await this.deps.store.getPromotedArtifact(artifact)) : undefined;
    const previewId = pathname.match(/^\/api\/preview-leases\/([^/]+)/)?.[1];
    const previewRecord = previewId ? (await this.deps.store.previewLease(previewId)) : undefined;
    const taskId = pathname.match(/^\/api\/tasks\/([^/]+)/)?.[1] ?? artifactRecord?.taskId ?? previewRecord?.taskId
      ?? url.searchParams.get('taskId') ?? undefined;
    // A record the request addresses decides its own tenant. `?projectId=` and
    // `?organizationId=` only name a scope for routes that address none: letting
    // them outrank a task's own project handed any caller the right to read and
    // act on another tenant's task by naming a project of its own. Every
    // identifier that names a scope must agree, or the request is refused.
    const recordProject = (tagId ? (await this.deps.store.getTag(tagId))?.projectId : undefined)
      ?? (viewId ? (await this.deps.store.getView(viewId))?.projectId : undefined)
      ?? (taskId ? await this.deps.store.taskProjectIdAsync(taskId) : undefined);
    const queryProject = url.searchParams.get('projectId') ?? undefined;
    const projects = [recordProject, pathProject, queryProject].filter((value): value is string => Boolean(value));
    if (new Set(projects).size > 1) return { conflict: 'projectId does not match the addressed record' };
    const resolvedProjectId = projects[0];
    const projectOrganization = resolvedProjectId ? await this.deps.store.projectOrganizationAsync(resolvedProjectId) : undefined;
    const organizations = [pathname.match(/^\/api\/organizations\/([^/]+)/)?.[1], url.searchParams.get('organizationId') ?? undefined,
      projectOrganization].filter((value): value is string => Boolean(value));
    if (new Set(organizations).size > 1) return { conflict: 'organizationId does not match the addressed record' };
    return { projectId: resolvedProjectId, organizationId: organizations[0], ...(taskId ? { taskId } : {}) };
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
  /** A preview a person opened in a tab says it stopped; API clients keep JSON. */
  private previewStopped(req: http.IncomingMessage, res: http.ServerResponse, status: number, error: string) {
    if (!String(req.headers.accept ?? '').includes('text/html')) return this.json(res, status, { error });
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow',
      'content-security-policy': SERVER_PAGE_CSP });
    res.end(PREVIEW_STOPPED_HTML);
  }

  /** Who has a refused capability, and what the caller has there instead, so
   * a person knows whom to ask and an agent which authorization to request. */
  private async capabilityHint(capability: string, record: ScopedToken | undefined,
    scope: { projectId?: string; organizationId?: string; taskId?: string }): Promise<string> {
    // Best effort: a refusal must stay a refusal even if its hint cannot be worked out.
    try { return await this.capabilityHintUnsafe(capability, record, scope); } catch { return ''; }
  }

  private async capabilityHintUnsafe(capability: string, record: ScopedToken | undefined,
    scope: { projectId?: string; organizationId?: string; taskId?: string }): Promise<string> {
    const authorization = this.deps.authorization;
    if (typeof authorization?.profile !== 'function' || typeof authorization.selectionForPrincipal !== 'function') return '';
    const organizationId = scope.organizationId ?? (scope.projectId ? await this.deps.store.projectOrganizationAsync(scope.projectId) : undefined)
      ?? record?.organizationId;
    const levels = ['viewer', 'developer', 'maintainer', 'administrator', 'superadmin', 'god'];
    const name = async (level: string) => (await authorization.profile(level, undefined, organizationId))?.name ?? level;
    let lowest: string | undefined;
    for (const level of levels) {
      const profile = await authorization.profile(level, undefined, organizationId);
      if (profile && allows(profile.capabilities, capability)) { lowest = level; break; }
    }
    const holders = !lowest ? '' : lowest === 'god' ? 'only God has it' : `${await name(lowest)} and above have it`;
    let current = '';
    const level = record ? await this.callerLevel(record, organizationId) : undefined;
    if (record?.kind === 'human' && record.principal.startsWith('user:') && organizationId)
      current = level ? `your authorization there is ${await name(level)}` : 'you have no authorization there';
    else if (level) current = `this task is authorized as ${await name(level)}`;
    const parts = [current, holders].filter(Boolean);
    return parts.length ? `. ${parts.join('; ').replace(/^./, (first) => first.toUpperCase())}.` : '';
  }

  /**
   * The gateway's authorization decision for one request: the capability its
   * route needs, the scope it is checked in, and whether the caller holds it.
   * The gate enforces it; `GET /api/authorization/me` reports it without
   * making the request, so the two cannot disagree.
   */
  private async routeDecision(token: string, authRecord: ScopedToken, session: Session, method: string, p: string, url: URL,
    requestedScope: { projectId?: string; taskId?: string; organizationId?: string }): Promise<RouteDecision> {
    const required = capabilityForRequest(method, p, url);
    if (!required) return { allowed: true, scope: requestedScope };
    // These endpoints operate on the authenticated calling task. Collaboration
    // additionally authorizes its target in the service after parsing the body.
    const callingTaskRoute = p === '/api/agent/git/publish'
      || p === '/api/agent/resource-candidates' || p === '/api/agent/collaboration/request'
      || /^\/api\/agent\/collaboration\/[^/]+\/cancel$/.test(p);
    const scope = callingTaskRoute && authRecord.taskId && authRecord.taskId !== '*'
      ? { ...requestedScope, taskId: authRecord.taskId } : requestedScope;
    const checked = (await this.deps.tokens.check(token, required, scope));
    // The project collection has no single scope. A project-only human may
    // enter it when at least one project grant permits discovery; the response
    // below is filtered project-by-project. No other unscoped route gets this
    // exception.
    const collectionAllowed = !checked.ok && p === '/api/projects' && method === 'GET' && !!session.userId && (
      // A member of any organization may enter (even before any project exists)
      // — the response is filtered project-by-project, so an empty org just
      // yields an empty list and the app lands on that org's dashboard rather
      // than the "no access" waiting room.
      (await this.deps.store.listOrganizations(session.userId)).length > 0 ||
      (await __asyncCollections.some((await this.deps.store.listProjects()), async (project) => allows((await this.deps.authorization?.capabilities(`user:${session.userId}`, project.id)) ?? [], required))));
    const organizationCollectionAllowed = !checked.ok && p === '/api/organizations' && !!session.userId && (
      method === 'POST' || (await __asyncCollections.some((await this.deps.store.listOrganizations(session.userId)), async (organization) =>
        allows((await this.deps.authorization?.capabilities(`user:${session.userId}`, undefined, organization.id)) ?? [], required)))
    );
    return { required, scope, checked, allowed: checked.ok || collectionAllowed || organizationCollectionAllowed };
  }

  /** The 403 message for a refused `routeDecision`. */
  private async routeRefusal(decision: RouteDecision & { required: string }, authRecord: ScopedToken): Promise<string> {
    const { required, checked, scope } = decision;
    if (['settings:read', 'settings:write'].includes(required)
      && (authRecord.organizationId || authRecord.projectId || authRecord.projectIds?.length))
      return 'This endpoint configures the shared installation and requires global authority (God). Use /api/organizations/:id/settings/:workflow or /api/settings/project/:id/:workflow for your authorized scope.';
    if (required === 'organization:wiki:write' && checked.missing === required) return ORGANIZATION_WIKI_WRITE_DENIED;
    const record = checked.record ?? authRecord;
    const request = permissionRequestFor(checked, record);
    return `${checked.reason ?? `missing capability ${required}`}${checked.missing ? (await this.capabilityHint(checked.missing, record, scope)) : ''}`
      + (request?.capabilities.length ? ` Ask for it with request_permission (capabilities: ${JSON.stringify(request.capabilities)}).` : '');
  }

  /** The authorization level a caller holds: a person's selection in the
   * organization, or the level its task was authorized at. */
  private async callerLevel(record: ScopedToken, organizationId: string | undefined): Promise<string | undefined> {
    if (record.kind === 'human' && record.principal.startsWith('user:'))
      return organizationId ? (await this.deps.authorization?.selectionForPrincipal?.(record.principal, organizationId))?.level : undefined;
    if (record.taskId === '*') return undefined;
    const levels = ['viewer', 'developer', 'maintainer', 'administrator', 'superadmin', 'god'];
    // An agent other than the main one may act with its own authority.
    const params = (await this.deps.store.getTask(record.taskId))?.params;
    const stored = (participantAuthorization(params, record.participant) ?? params?._authorization) as { level?: string; profileId?: string } | undefined;
    return [stored?.level, stored?.profileId, record.profileId].find((candidate) => candidate && levels.includes(candidate));
  }

  /** Whether the caller could make `method target`, decided exactly as the
   * gate decides it, without making the request. */
  private async routeCheck(req: http.IncomingMessage, authRecord: ScopedToken, method: string, target: string) {
    const url = new URL(target, 'http://gateway.invalid');
    const p = url.pathname;
    const result = (allowed: boolean, extra: Record<string, unknown> = {}) =>
      ({ method, path: target, capability: capabilityForRequest(method, p, url) ?? null, allowed, ...extra });
    const excluded = platformRequestPathError(target);
    if (excluded) return result(false, { reason: excluded });
    const scope = await this.requestScope(p, url);
    if (scope.conflict) return result(false, { reason: scope.conflict });
    const session = await this.auth(req, scope.projectId, scope.organizationId);
    if (!session) return result(false, { reason: 'unauthorized' });
    const record = (await this.deps.tokens.verify(session.apiToken)) ?? authRecord;
    const decision = await this.routeDecision(session.apiToken, record, session, method, p, url, scope);
    if (decision.allowed || !decision.required) return result(true);
    const organizationId = scope.organizationId ?? (scope.projectId ? await this.deps.store.projectOrganizationAsync(scope.projectId) : undefined);
    const request = permissionRequestFor(decision.checked, decision.checked.record ?? record, { projectId: scope.projectId, organizationId });
    return result(false, { reason: await this.routeRefusal(decision, record), ...(request ? { request } : {}) });
  }

  /** The 403 message when the caller lacks `capability`, or undefined when it holds it. */
  private async refusal(token: string, capability: string,
    scope: { projectId?: string; organizationId?: string; taskId?: string }): Promise<string | undefined> {
    const checked = await this.deps.tokens.check(token, capability, scope);
    if (checked.ok) return undefined;
    return `${checked.reason ?? `missing capability ${capability}`}${checked.missing ? (await this.capabilityHint(checked.missing, checked.record, scope)) : ''}`;
  }

  private json(res: http.ServerResponse, status: number, obj: unknown) {
    const body = JSON.stringify(toPublicPayload(obj ?? null));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
      'x-karmax-cell': this.deps.cellId ?? 'local' });
    res.end(body);
  }
  private downloadJson(res: http.ServerResponse, filename: string, obj: unknown) {
    const body = `${JSON.stringify(toPublicPayload(obj ?? null), null, 2)}\n`;
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename.replace(/["\\\r\n]/g, '_')}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-length': String(Buffer.byteLength(body)),
      'x-karmax-cell': this.deps.cellId ?? 'local',
    });
    res.end(body);
  }
  private async githubCallbackPage(res: http.ServerResponse, status: number, message: string) {
    const name = escapeHtml((await this.siteName));
    const body = `<!doctype html><meta charset="utf-8"><title>${name} · GitHub</title><main style="font:16px system-ui;max-width:42rem;margin:12vh auto;padding:2rem"><h1>GitHub connection</h1><p>${escapeHtml(message)}</p><p><a href="/organization">Return to ${name}</a></p></main>`;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(body)),
      'content-security-policy': SERVER_PAGE_CSP, 'x-karmax-cell': this.deps.cellId ?? 'local' });
    res.end(body);
  }
  private async paymentCallbackPage(res: http.ServerResponse, status: number, message: string) {
    const name = escapeHtml((await this.siteName));
    const body = `<!doctype html><meta charset="utf-8"><title>${name} · Stripe</title><main style="font:16px system-ui;max-width:42rem;margin:12vh auto;padding:2rem"><h1>Stripe connection</h1><p>${escapeHtml(message)}</p><p><a href="/organization">Return to ${name}</a></p></main>`;
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(body)),
      'content-security-policy': SERVER_PAGE_CSP, 'x-karmax-cell': this.deps.cellId ?? 'local' });
    res.end(body);
  }
  private async body(req: http.IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<any> {
    const value = await this.rawBody(req, maxBytes);
    if (!value.length) return {};
    try {
      return JSON.parse(value.toString('utf8'));
    } catch {
      throw Object.assign(new Error('invalid JSON body'), { status: 400 });
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
    await this.requestGuards.get(req)?.();
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
        { error: String((e as Error)?.message ?? e), ...grantRefusal(e),
          ...(e instanceof AuthorizationGrantError ? e.gap : {}) });
    } catch {
      /* ignore */
    }
  }
}

/** A task's live view may be unavailable (no running workflow), and routes
 * then fall back to its stored view. A refusal must never take that path: the
 * stored view would be served without the caller's own access check. */
function liveViewUnavailable(error: unknown): undefined {
  if (error instanceof CapabilityError) throw error;
  return undefined;
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
  const lines = [`# HELP karmax_info ${BRAND} control-plane information.`, '# TYPE karmax_info gauge', 'karmax_info 1'];
  const scalar = (name: string, help: string, value: unknown) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${Number(value ?? 0)}`);
  };
  scalar('karmax_organizations', 'Organizations in this cell.', snapshot.organizations);
  scalar('karmax_projects', 'Projects in this cell.', snapshot.projects);
  scalar('karmax_event_cursor', 'Latest durable gateway event sequence.', snapshot.eventCursor);
  scalar('karmax_database_bytes', 'Control-plane database bytes.', snapshot.databaseBytes);
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

/** Headers for agent- or repository-authored bytes served on the console origin.
 *  Inert types (images, PDF, video, text) render inline. Active documents —
 *  `text/html`, `image/svg+xml` — render inline too, but under a CSP `sandbox`
 *  that gives the document an opaque origin: scripts run (so an HTML report
 *  works), but the page cannot read the console's cookies or storage, nor make
 *  a credentialed request to it. Everything else is a download. */
const INERT_MEDIA = /^(?:image\/(?:png|jpeg|gif|webp)|application\/pdf|video\/(?:mp4|webm|quicktime)|text\/(?:plain|csv)|application\/json)(?:;|$)/i;
const ACTIVE_DOCUMENT_MEDIA = /^(?:text\/html|image\/svg\+xml|application\/xhtml\+xml)(?:;|$)/i;
export function untrustedContentHeaders(mediaType: string, filename: string): Record<string, string> {
  const name = filename.replace(/["\\\r\n]/g, '_');
  const inert = INERT_MEDIA.test(mediaType);
  const active = ACTIVE_DOCUMENT_MEDIA.test(mediaType);
  return {
    'content-type': inert || active ? mediaType : 'application/octet-stream',
    'content-disposition': `${inert || active ? 'inline' : 'attachment'}; filename="${name}"`,
    'content-security-policy': active
      ? "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; form-action 'none'"
      : "sandbox; default-src 'none'",
    'x-content-type-options': 'nosniff',
  };
}

/** For the gateway's own static pages (callbacks, a stopped preview): markup and
 *  inline styles only, never framed, nothing to submit. */
const SERVER_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const PREVIEW_STOPPED_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Preview stopped</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;
font:15px/1.5 system-ui,sans-serif;color:CanvasText;background:Canvas}main{max-width:26rem;padding:2rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;opacity:.7}</style></head><body><main><h1>This preview has stopped</h1>
<p>Start it again from the task's Review.</p></main></body></html>`;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

/** Expand ~ / $HOME in repo paths so a configured repo resolves to a real dir. */
function normalizeConfig(
  config: ProjectConfig = {},
  defaultHostedProvider = false,
  hosted = process.env.KARMAX_DEPLOYMENT === 'hosted',
): ProjectConfig {
  if (hosted) {
    if (config.remote === 'none')
      throw new ValidationError('Hosted GitHub projects cannot use remote policy "none"; use "pr" or the advanced direct-push policy.');
    if (config.remote === undefined) config = { ...config, remote: 'pr' };
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

function hostedSettingsValues(values: Record<string, unknown>, hosted: boolean): Record<string, unknown> {
  if (hosted && values.remote === 'none')
    throw new ValidationError('Hosted GitHub projects cannot use remote policy "none"; use "pr" or the advanced direct-push policy.');
  return values;
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
  return (project.config.repos ?? []).map(localRepositoryDirectory).filter((value): value is string => Boolean(value));
}

function localRepositoryDirectory(source: string): string | undefined {
  const local = expandPath(source);
  if (fs.existsSync(local)) return local;
  const managed = managedRepoPath(source);
  return fs.existsSync(managed) ? managed : undefined;
}

/** Every project repository's tracked files: this host's checkout when it has
 * one, else the GitHub default branch (hosted projects keep no checkout). */
async function projectRepositoryFiles(project: Project, store: Store,
  githubApp?: import('../integrations/github-app.js').GitHubAppService): Promise<RepositoryFiles[]> {
  const { localRepositoryFiles } = await import('../store/project-environment.js');
  const { remoteName } = await import('../world/provision-git.js');
  const repos: RepositoryFiles[] = [];
  for (const source of project.config.repos ?? []) {
    const dir = localRepositoryDirectory(source);
    if (dir) repos.push(localRepositoryFiles(dir, remoteName(source)));
  }
  if (githubApp) for (const { repository } of await store.listProjectRepositories(project.id)) {
    if (repos.some((repo) => repo.name === repository.name)) continue;
    const files = await githubApp.rootEntries(repository);
    if (files) repos.push({ name: repository.name, files, read: (file) => githubApp.fileContents(repository, file) });
  }
  return repos;
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
  if (githubApp) for (const linked of (await store.listProjectRepositories(project.id))) for (const file of
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

/** Source keys that carry a resource's provenance and authority: which vault
 * item it projects, and whether it is a task's staged candidate. Only the
 * server sets them; a request keeps whatever is stored. */
const RESERVED_SOURCE_KEYS = ['vaultItemId', 'vaultField', 'vaultItemLabel', 'vaultItemType', 'candidate', 'createdByTaskId'];

function withReservedSource(requested: Record<string, unknown>, stored: Record<string, unknown>): Record<string, unknown> {
  const source = Object.fromEntries(Object.entries(requested).filter(([key]) => !RESERVED_SOURCE_KEYS.includes(key)));
  for (const key of RESERVED_SOURCE_KEYS) if (key in stored) source[key] = stored[key];
  return source;
}

/** A resource that now holds its own secret no longer projects a vault item. */
function withoutVaultProjection(source: Record<string, unknown>): Record<string, unknown> {
  const { vaultItemId: _item, vaultField: _field, vaultItemLabel: _label, vaultItemType: _type, ...rest } = source;
  return rest;
}

function stagedResourceCandidate(resource: ResourceAttachment): boolean {
  return resource.enabled === false && resource.source.candidate === true;
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
  storageLocationId?: string;
  files: Record<string, { parts: ResourceUploadPart[]; bytes: number }>;
  bytes: number; createdAt: number; expiresAt: number;
}
function resourceUploadKey(id: string): string { return `resource-upload:${id}`; }
async function resourceUploadSession(store: Store, id: string): Promise<ResourceUploadSession | undefined> {
  try { return JSON.parse((await store.kvGet(resourceUploadKey(id))) ?? '') as ResourceUploadSession; } catch { return undefined; }
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

async function discardResourceUpload(store: Store, upload: ResourceUploadSession, objects: ObjectStore,
  storage?: import('../store/storage-locations.js').StorageLocationService): Promise<void> {
  await Promise.allSettled(Object.values(upload.files).flatMap((record) => record.parts)
    .map((part) => objects.delete(part.objectKey)));
  (await store.kvDelete(resourceUploadKey(upload.id)));
  (await storage?.releaseUpload(upload.id));
}

/** Abandoned browser uploads are durable only for their 24-hour resume window.
 * Sweep opportunistically whenever another upload begins; S3 lifecycle rules
 * remain a second safety net for a completely idle installation. */
async function cleanupExpiredResourceUploads(store: Store,
  resources: import('../world/resources.js').ProjectResourceService, fallback: ObjectStore): Promise<void> {
  for (const entry of (await store.kvEntries('resource-upload:'))) {
    let upload: ResourceUploadSession;
    try { upload = JSON.parse(entry.value) as ResourceUploadSession; } catch { (await store.kvDelete(entry.key)); continue; }
    if (upload.expiresAt >= Date.now()) continue;
    let objects = fallback;
    try {
      if (upload.storageLocationId) objects = (await resources.storageLocationService()?.objectStore(upload.storageLocationId)) ?? fallback;
      else {
        const attachment = (await store.getResourceAttachment(upload.attachmentId));
        if (attachment) objects = (await resources.objectStoreFor(attachment));
      }
    } catch { continue; } // preserve metadata so a temporarily unavailable customer bucket can be retried
    await discardResourceUpload(store, upload, objects, resources.storageLocationService());
  }
}

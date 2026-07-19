import type { Client } from '@temporalio/client';
import { Context as activityContext } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import { classifyProviderTurnError, isTransportError, isResourceKill, type LimitClassification } from '../agent/limits.js';
import { hostStats, hostMemoryTight } from './agent-slots.js';
import { Store } from '../store/db.js';
import { WorldRegistry } from '../world/registry.js';
import { World, WorldHandle, WorldKind } from '../world/types.js';
import { finalizeMerge, MergeResult } from '../world/merge.js';
import { applyAgentSpec, ProfileResolver } from '../agent/profiles.js';
import { AgentAdapter } from '../agent/types.js';
import { KARMAX_RUNTIME_PROTOCOL, runRuntimeTurn } from '../agent/runtime.js';
import { acquireAgentSlot, awaitAgentResources } from './agent-slots.js';
import { assemblePrompt } from '../agent/prompt.js';
import { GLOBAL_INSTRUCTIONS } from '../agent/instructions.js';
import { autoResolve as runAutoResolve } from '../resolve/cases.js';
import { KarmaxBus } from '../contrib/bus.js';
import { TokenAuthority } from '../platform/tokens.js';
import { CredentialBroker } from '../autonomy/broker.js';
import { GitProfiles } from '../autonomy/git-profiles.js';
import { worldRepos } from '../world/types.js';
import { brokerFinalizeMerge, brokerOpenGithubPr, brokerPublishBranch, type GitBrokerAuth } from '../world/git-broker.js';
import { cloudGitSource } from '../world/cloud-source.js';
import { PaymentProvider, BudgetService } from '../autonomy/payments.js';
import { tokenToInject } from '../autonomy/config-homes.js';
import { materializeFork } from '../agent/fork.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifest } from '../contrib/manifests.js';
import { allows, attenuate } from '../platform/capabilities.js';
import { Provider, Message, TaskInput, TaskView, AgentRole, AuthSource } from '../domain/types.js';
import { newId } from '../util/id.js';
import { SIG_AGENT_TURN_STATE } from '../workflows/names.js';
import {
  AGENT_QUEUE_WORKFLOW,
  QRY_AGENT_QUEUE,
  SIG_CANCEL_AGENT,
  SIG_LEASE_AGENT,
  SIG_RELEASE_AGENT,
  SIG_SET_AGENT_CAPACITY,
  agentQueueId,
} from '../coordinators/names.js';

// Old executions without a recorded grant retain the normal developer workflow
// surface (but no administration). New tasks always carry a creator-attenuated
// stored grant, so this compatibility path disappears as legacy runs finish.
const DEFAULT_GRANT = [
  'project:read', 'task:*', 'queue:read', 'workflow:read', 'profile:read',
  'credential:read', 'skill:write', 'resolve-decision', 'confirm-decision', 'merge-into:*',
];

// A confirmer belongs to a logical task, so sibling attempts must not review in
// parallel against divergent copies of its conversation. The worker is the
// single activity host in v1; this keyed FIFO serializes those turns while each
// Temporal activity remains independently retryable.
const confirmLocks = new Map<string, { held: boolean; waiters: Array<() => void> }>();
async function acquireConfirmLock(key: string): Promise<() => void> {
  let lock = confirmLocks.get(key);
  if (!lock) {
    lock = { held: false, waiters: [] };
    confirmLocks.set(key, lock);
  }
  if (lock.held) await new Promise<void>((resolve) => lock!.waiters.push(resolve));
  else lock.held = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = lock!.waiters.shift();
    if (next) next();
    else {
      lock!.held = false;
      confirmLocks.delete(key);
    }
  };
}

/**
 * Tag a thrown turn error for Temporal's retry policy (the `turns` proxy in the
 * workflows) — see src/workflows/failures.ts for the taxonomy. Original
 * messages are preserved verbatim for display, while provider failure metadata
 * rides in ApplicationFailure.details for account rotation and auto-resolve.
 */
function classifyTurnError(err: unknown, provider?: Provider): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err : undefined;
  const { classification: cls, metadata } = classifyProviderTurnError(err, provider);
  if (cls.limited) {
    return ApplicationFailure.create({
      message: msg,
      type: 'agent-limit',
      nonRetryable: true,
      cause,
      ...(metadata ? { details: [metadata] } : {}),
    });
  }
  // A signal-9/SIGKILL agent death is environmental, not a code bug (karmax#4):
  // classify it as retryable 'agent-infra' with an ACTIONABLE message — the raw
  // "terminated by signal SIGKILL" tells an operator nothing. Temporal re-runs the
  // turn and the retry re-enters the host-admission gate (acquireAgentSlot) and
  // resumes the interrupted session. isResourceKill is the shared predicate
  // (src/agent/limits.ts) the software-dev auto-resolve task reuses.
  if (isResourceKill(msg)) return ApplicationFailure.create({ message: signalKillMessage(msg), type: 'agent-infra', nonRetryable: false, cause });
  if (isTransportError(msg)) return ApplicationFailure.create({ message: msg, type: 'agent-infra', nonRetryable: false, cause });
  return ApplicationFailure.create({ message: msg, type: 'agent-error', nonRetryable: true, cause });
}

/**
 * Turn an opaque SIGKILL into an operator-actionable line — WITHOUT asserting a
 * cause the evidence doesn't support. A signal-9 agent death has very different
 * senders on this single-host deployment, and the message must not name one when
 * another is true (karmax#4 diagnosis, 2026-07: the observed kills were karmax's
 * OWN reapOrphans() sweep after a tsx-watch reload — journalctl -k and
 * systemd-oomd logged zero kills — NOT the kernel OOM killer; 2026-07-12: a
 * dogfooding karmax booted from a task world swept prod's LIVE agents — since
 * fixed, reapOrphans now skips records whose owner process is alive). So branch
 * on LIVE host memory:
 *   - memory genuinely tight → likely the OS OOM killer; the operator should
 *     reduce concurrency / free RAM (and the gated retry waits for RAM to recover).
 *   - memory healthy → NOT OOM; most likely a karmax restart/reload/redeploy
 *     tearing down in-flight turns (orphan-sweep or shutdown escalation,
 *     src/agent/custody.ts) or an external kill. The retry admits immediately
 *     and resumes the session.
 * Either way the raw signal string is appended (truncated) for diagnostics.
 */
function signalKillMessage(raw: string): string {
  const h = hostStats();
  const mem = `${h.freeMemMb}MB free of ${h.totalMemMb}MB (${h.usedMemPct}% used, load ${h.loadPerCore}/core)`;
  const diagnosis = hostMemoryTight()
    ? `host out of memory — the agent was likely killed by the OS OOM killer (${mem}). ` +
      `Reduce Concurrent agent turns in Global settings (or raise KARMAX_AGENT_MIN_FREE_MB), or free RAM.`
    : `host memory is healthy (${mem}), so this is NOT an OOM kill — most likely a karmax ` +
      `restart/reload/redeploy tearing down in-flight turns (orphan-sweep or shutdown escalation) or an external kill.`;
  return `agent turn interrupted by SIGKILL: ${diagnosis} Retrying with session resume. [signal: ${raw.slice(0, 200)}]`;
}

/** Split an account ref that may be "<provider>:<name>" or just "<name>". */
function splitAccountRef(ref: string, fallback: Provider): { provider: Provider; name: string } {
  const [maybeProv, ...rest] = ref.split(':');
  const isProv = rest.length > 0 && (maybeProv === 'claude' || maybeProv === 'codex' || maybeProv === 'mock');
  return { provider: (isProv ? maybeProv : fallback) as Provider, name: isProv ? rest.join(':') : ref };
}

/** Derive a single AuthSource from the first usable entry of allowedAccounts
 *  (`login:<provider>:<account>` → configHome; `key:<handle>` → apiKeyHandle). */
function firstAllowedToAuth(allowed: string[] | undefined, provider: Provider): AuthSource | undefined {
  if (!allowed?.length) return undefined;
  // Prefer a login for the profile's provider; else the first login; else a key.
  const logins = allowed.filter((a) => a.startsWith('login:'));
  const preferred = logins.find((a) => a.slice('login:'.length).startsWith(`${provider}:`)) ?? logins[0];
  if (preferred) return { kind: 'configHome', account: preferred.slice('login:'.length) };
  const key = allowed.find((a) => a.startsWith('key:'));
  if (key) return { kind: 'apiKeyHandle', handle: key.slice('key:'.length) };
  return undefined;
}

export interface CoreActivityDeps {
  store: Store;
  worlds: WorldRegistry;
  adapters: Map<Provider, AgentAdapter>;
  profiles: ProfileResolver;
  client?: Client;
  taskQueue?: string;
  bus?: KarmaxBus;
  globalInstructions?: string;
  tokens?: TokenAuthority;
  broker?: CredentialBroker;
  githubApp?: import('../integrations/github-app.js').GitHubAppService;
  checkpoints?: import('../world/checkpoint.js').WorldCheckpointService;
  runners?: import('../world/runners.js').RunnerPoolService;
  payments?: PaymentProvider;
  configHomes?: import('../autonomy/config-homes.js').ConfigHomeManager;
}

export interface CreateWorldArgs {
  taskId: string;
  projectId?: string;
  repo?: string;
  /** Source repos for a multi-repo world; takes precedence over `repo`. */
  repos?: string[];
  base: string;
  target?: string;
  branch?: string;
  copyGlobs?: string[];
  kind: WorldKind;
  /** The project's git profile selection (PLAN-git-config.md §3); the activity
   *  resolves it (project → global default) and materializes identity/signing. */
  gitProfile?: string;
}

async function acquireWorkflowAgentSlot(args: {
  client: Client;
  taskQueue: string;
  store: Store;
  taskId: string;
  turnId: string;
  role: string;
  provider?: string;
  title?: string;
  projectId?: string;
  heartbeat?: () => void;
  signal?: AbortSignal;
}): Promise<() => Promise<void>> {
  const saved = Number(args.store.getSettings('global', 'agent-queue')?.capacity);
  const capacity = Number.isFinite(saved) && saved > 0
    ? Math.floor(saved)
    : 3;
  const id = agentQueueId();
  await args.client.workflow.signalWithStart(AGENT_QUEUE_WORKFLOW, {
    workflowId: id,
    taskQueue: args.taskQueue,
    args: [{ capacity }],
    signal: SIG_LEASE_AGENT,
    signalArgs: [{ taskId: args.taskId, turnId: args.turnId, role: args.role, provider: args.provider, title: args.title, projectId: args.projectId }],
  });
  await args.client.workflow.getHandle(id).signal(SIG_SET_AGENT_CAPACITY, { capacity });
  let lastHeartbeat = 0;
  try {
    for (;;) {
      if (args.signal?.aborted) throw args.signal.reason instanceof Error ? args.signal.reason : new Error('agent queue wait cancelled');
      const view = (await args.client.workflow.getHandle(id).query(QRY_AGENT_QUEUE)) as {
        current: Array<{ turnId: string }>;
      };
      if (view.current.some((x) => x.turnId === args.turnId)) break;
      if (Date.now() - lastHeartbeat >= 10_000) {
        args.heartbeat?.();
        lastHeartbeat = Date.now();
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  } catch (e) {
    await args.client.workflow.getHandle(id).signal(SIG_CANCEL_AGENT, { taskId: args.taskId, turnId: args.turnId }).catch(() => undefined);
    throw e;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await args.client.workflow.getHandle(id).signal(SIG_RELEASE_AGENT, { taskId: args.taskId, turnId: args.turnId }).catch(() => undefined);
  };
}

export interface RunAgentTurnArgs {
  taskId: string;
  role: AgentRole;
  worldHandle: WorldHandle;
  messages: Message[];
  session?: string;
  /** How many leading `messages` the resumed `session` already holds — forwarded to
   *  the adapter so a resumed turn sends only the delta, not the whole transcript. */
  deliveredMessages?: number;
  task: TaskInput;
  bindings?: Record<string, string>;
  explicitProfileId?: string;
  /** Config home leased by the account coordinator for this turn (SPEC §6.2);
   * overrides the profile's own auth home so turns rotate across logins. */
  accountConfigHome?: string;
  /** Broker API-key handle leased by the coordinator for this turn (a `key:handle:*`
   * credential); resolved JIT and overrides the auth. Env keys carry no handle —
   * they fall through to the adapter's env credential. */
  accountApiKeyHandle?: string;
  /** Workflow-generated id used to correlate live admission/running signals. */
  agentTurnId?: string;
}

export interface PrepareChildArgs {
  parentTaskId: string;
  projectId: string;
  title: string;
  prompt: string;
  base?: string;
  target?: string;
  project: TaskInput['project'];
  profiles?: Record<string, string>;
  resolveAgentEnabled?: boolean;
  /** The parent's world branch — the child's merge cap is scoped to exactly this
   *  (SPEC §8.2). The parent owns this branch, so it may grant merge into it. */
  parentBranch?: string;
  /** The parent's own capability grant; the child's delegation caps are attenuated
   *  by it (a restricted parent can't over-grant). Merge is scoped separately. */
  parentGrant?: string[];
}

/** Side-effecting activities the workflows drive (SPEC §3.1). */
export function makeCoreActivities(deps: CoreActivityDeps) {
  const { store, worlds, profiles } = deps;
  const gitProfiles = new GitProfiles(store, deps.broker);
  const isRemote = (kind: WorldKind) => worlds.get(kind).capabilities?.remote === true;

  function record(taskId: string, type: string, payload: Record<string, unknown>) {
    const ev = { type, taskId, ts: Date.now(), payload };
    const seq = store.appendEvent(ev);
    deps.bus?.emit({ ...ev, seq });
  }

  /** JIT env for remote git/gh operations in this world (PLAN-git-config.md §4B):
   *  the world's git profile (stamped on the handle at creation) → GIT_SSH_COMMAND /
   *  GH_TOKEN, per subprocess. Empty when the world has no profile (host fallback)
   *  or resolution fails — the op then runs with the host's own auth. */
  function gitEnvFor(handle: WorldHandle, taskId?: string): Record<string, string> {
    const name = handle.meta?.gitProfile;
    if (typeof name !== 'string' || !name) return {};
    try {
      const profile = gitProfiles.get(name);
      return profile ? gitProfiles.env(profile, { taskId }) : {};
    } catch {
      return {};
    }
  }

  function brokerAuthFor(handle: WorldHandle, taskId?: string): GitBrokerAuth {
    const projectId = typeof handle.meta?.projectId === 'string' ? handle.meta.projectId : undefined;
    const project = projectId ? store.getProject(projectId) : undefined;
    const linked = projectId ? store.listProjectRepositories(projectId) : [];
    if (project?.organizationId && linked.length && deps.githubApp) {
      return async (worldRepo) => {
        const repository = linked.find((candidate) => candidate.repository.sshUrl === worldRepo.repo)?.repository;
        if (!repository) throw new Error(`Git broker rejected repository outside project enrollment: ${worldRepo.repo}`);
        return deps.githubApp!.brokerCredentials(repository);
      };
    }
    return gitEnvFor(handle, taskId);
  }

  async function ensureRunnerLease(handleInput: WorldHandle, taskId: string): Promise<WorldHandle> {
    const handle = (store.currentWorld(handleInput.id) ?? handleInput) as WorldHandle;
    if (!isRemote(handle.kind) || !deps.runners) return handle;
    const existing = typeof handle.meta?.worldLeaseId === 'string' ? store.worldLease(handle.meta.worldLeaseId) : undefined;
    if (existing?.state === 'active') return handle;
    const projectId = String(handle.meta?.projectId ?? store.getTask(taskId)?.projectId ?? '');
    const project = store.getProject(projectId);
    if (!project) throw new Error('cloud world has no owning project');
    const ctx = activityContext.current();
    const acquired = await deps.runners.acquire({ project, taskId, worldId: handle.id, provider: handle.kind,
      priority: Number(store.getTask(taskId)?.params.priority ?? 0), signal: ctx.cancellationSignal,
      heartbeat: () => ctx.heartbeat({ waitingFor: 'world-capacity' }) });
    const next = store.updateWorldMeta(handle, { worldLeaseId: acquired.leaseId, runnerPoolId: acquired.runnerPoolId });
    store.setWorldState(next, 'ready');
    record(taskId, 'world.lease-acquired', { leaseId: acquired.leaseId, runnerPoolId: acquired.runnerPoolId });
    return next as WorldHandle;
  }

  async function openWorld(handle: WorldHandle, taskId = handle.id): Promise<World> {
    return worlds.open(await ensureRunnerLease(handle, taskId));
  }

  return {
    async createWorld(args: CreateWorldArgs): Promise<WorldHandle> {
      const remote = isRemote(args.kind);
      if (process.env.KARMAX_DEPLOYMENT === 'hosted' && !remote)
        throw new Error(`hosted deployments cannot run task code in the control plane (${args.kind}); select a remote runner`);
      record(args.taskId, 'world.provisioning', { provider: args.kind });
      // Resolve the git profile (project → global default → none) and materialize
      // its identity for worktree-scoped config (PLAN-git-config.md §4A). Identity
      // failure downgrades to a warning — the world is still usable locally.
      const profile = gitProfiles.resolve({ gitProfile: args.gitProfile });
      let gitIdentity;
      let gitCredentials;
      try {
        gitIdentity = profile ? gitProfiles.identity(profile, { taskId: args.taskId }) : undefined;
      } catch (e) {
        record(args.taskId, 'world.warning', { warning: `git profile "${profile?.name}": ${e instanceof Error ? e.message : e}` });
      }
      try {
        gitCredentials = profile && remote ? gitProfiles.worldCredentials(profile, { taskId: args.taskId }) : undefined;
      } catch (e) {
        record(args.taskId, 'world.warning', { warning: `git profile "${profile?.name}" cloud credentials: ${e instanceof Error ? e.message : e}` });
      }
      const requestedSources = args.repos?.length ? args.repos : args.repo ? [args.repo] : [];
      const cloudSources = remote ? await Promise.all(requestedSources.map((source) => cloudGitSource(source))) : [];
      const worldSources = remote ? cloudSources.map((resolved) => resolved.source) : requestedSources;
      for (let i = 0; i < cloudSources.length; i++) {
        if (cloudSources[i]!.localPath)
          record(args.taskId, 'world.repository-resolved', {
            localPath: cloudSources[i]!.localPath, remote: cloudSources[i]!.source,
          });
      }
      const linkedRepositories = args.projectId ? store.listProjectRepositories(args.projectId) : [];
      const repositoryBranches = Object.fromEntries(linkedRepositories.map((candidate) => {
        const base = candidate.baseBranch ?? candidate.repository.defaultBranch;
        return [candidate.repository.sshUrl, { base, target: candidate.targetBranch ?? base }];
      }));
      if (remote && linkedRepositories.length) {
        if (!deps.githubApp) throw new Error('hosted repositories require the configured GitHub App');
        const credentials: Record<string, string> = {};
        for (const source of worldSources) {
          const linked = linkedRepositories.find((candidate) => candidate.repository.sshUrl === source);
          if (!linked) throw new Error(`repository ${source} is not enrolled in this project`);
          credentials[source] = deps.githubApp.repositorySshKey(linked.repository.id, 'clone');
        }
        // Repository-scoped read-only keys completely replace personal/profile
        // SSH material for a hosted project.
        gitCredentials = { repositories: credentials };
      }
      const projectId = args.projectId ?? store.getTask(args.taskId)?.projectId;
      const project = projectId ? store.getProject(projectId) : undefined;
      const executionConfig = project ? store.effectiveProjectConfig(project) : undefined;
      let acquired: { leaseId: string; runnerPoolId: string } | undefined;
      if (remote && project && deps.runners) {
        const ctx = activityContext.current();
        acquired = await deps.runners.acquire({ project, taskId: args.taskId, worldId: args.taskId, provider: args.kind,
          priority: Number(store.getTask(args.taskId)?.params.priority ?? 0), signal: ctx.cancellationSignal,
          heartbeat: () => ctx.heartbeat({ waitingFor: 'world-capacity' }) });
      }
      let world: World;
      try {
        world = await worlds.create(args.kind, {
          taskId: args.taskId,
          organizationId: project?.organizationId,
          repo: args.repos?.length ? undefined : worldSources[0],
          repos: args.repos?.length ? worldSources : undefined,
          base: args.base,
          target: args.target,
          branch: args.branch,
          copyGlobs: args.copyGlobs,
          gitIdentity,
          gitCredentials,
          ...(Object.keys(repositoryBranches).length ? { repositoryBranches } : {}),
          network: executionConfig?.network,
          environment: executionConfig?.environment,
          resources: executionConfig?.resources,
        });
      } catch (error) {
        if (acquired) deps.runners?.release(acquired.leaseId, args.kind);
        throw error;
      }
      try {
        if (profile) world.handle.meta = { ...world.handle.meta, gitProfile: profile.name };
        if (args.projectId) world.handle.meta = { ...world.handle.meta, projectId: args.projectId,
          repositoryIds: linkedRepositories.map((candidate) => candidate.repository.id) };
        if (acquired) world.handle.meta = { ...world.handle.meta, worldLeaseId: acquired.leaseId };
        if (projectId) {
          world.handle = store.registerWorld(world.handle, projectId, {
            runnerPoolId: acquired?.runnerPoolId ?? (remote ? `managed-${args.kind}` : 'local'),
            environmentDigest: remote
              ? (process.env[`KARMAX_${args.kind.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_TEMPLATE`] ?? `karmax-${args.kind}`)
              : 'karmax-local',
          }) as WorldHandle;
        }
        record(args.taskId, 'world.created', { handle: world.handle });
        record(args.taskId, 'world.ready', { provider: world.handle.kind, generation: world.handle.generation ?? 1 });
        for (const warning of world.handle.warnings ?? []) record(args.taskId, 'world.warning', { warning });
      } catch (error) {
        await world.destroy().catch(() => undefined);
        if (acquired) deps.runners?.release(acquired.leaseId, args.kind);
        throw error;
      }
      return world.handle;
    },

    /** The effective provider for a role's turn (task override → seeded profile),
     *  so the workflow can lease an account of the right provider (SPEC §6.2). */
    async resolveProvider(args: { role: AgentRole; task: TaskInput }): Promise<Provider> {
      const baseProfile = profiles.resolve(args.role, args.task.profiles, undefined, args.task.projectId);
      return (args.task.agents?.[args.role]?.provider ?? baseProfile.provider) as Provider;
    },

    /** The ordered, enabled credential keys for a turn's provider, per the credential
     *  policy resolved global→project→task (SPEC §7/§9). The coordinator leases the
     *  first available one from this list. Empty ⇒ passthrough to the profile default. */
    async resolveCredentialOrder(args: { taskId: string; projectId: string; provider: 'claude' | 'codex' }): Promise<string[]> {
      const { gatherCredentialSources, readPolicyLayers } = await import('../platform/credential-sources.js');
      const { enumerateCredentials, credentialsForProvider } = await import('../platform/credentials.js');
      const sources = gatherCredentialSources({ configHomes: deps.configHomes, broker: deps.broker });
      const all = enumerateCredentials(sources);
      const layers = readPolicyLayers((k) => store.kvGet(k), { projectId: args.projectId, taskId: args.taskId });
      return credentialsForProvider(all, args.provider, layers).map((c) => c.key);
    },

    async runAgentTurn(args: RunAgentTurnArgs) {
      const baseProfile = profiles.resolve(args.role, args.task.profiles, args.explicitProfileId, args.task.projectId);
      // Apply the per-role agent override from the task form (SPEC §10.5).
      const spec = args.task.agents?.[args.role];
      const profile = applyAgentSpec(baseProfile, spec);
      const world = await openWorld(args.worldHandle, args.taskId);

      // Fork a prior agent (SPEC §10.5) — set up below, AFTER auth resolution, since
      // materializing the source session needs this turn's config home + world path.
      const conversationTaskId = args.role === 'confirm' ? (args.task.intentId ?? args.taskId) : args.taskId;
      let session = args.session;
      let messages = args.messages; // may be replaced by the shared confirmer transcript
      let deliveredMessages = args.deliveredMessages;
      let fork = false; // true → the adapter branches a NEW session id from `session`

      // Temporal wiring: cancellation aborts the in-flight turn (SPEC §5.6), and
      // heartbeats carry the live session id so a RETRY of this activity (stream
      // cut, host slept, heartbeat timeout) RESUMES the interrupted session from
      // heartbeat details instead of replaying the whole turn from scratch.
      let signal: AbortSignal | undefined;
      let heartbeat: (() => void) | undefined;
      let hbSession: string | undefined; // set once real progress exists (onSession)
      let legacyAgentTurnId: string | undefined;
      let turnSessionKey: string | undefined;
      let resumedActivityAttempt = false;
      // Live in-flight-injection channel: a streaming adapter polls the workflow for
      // follow-ups queued WHILE this turn runs and injects them into the live session
      // (SPEC §5.6). Off on a resumed retry — its `messages` were replaced by a single
      // continuation notice, so the workflow's msgs-index boundary no longer applies.
      let liveChannel = true;
      try {
        const actx = activityContext.current();
        signal = actx.cancellationSignal;
        heartbeat = () => actx.heartbeat(hbSession ? { session: hbSession } : undefined);
        // v1 workflows cannot add the new agentTurnId argument without changing
        // their recorded activity command. Derive a stable compatibility id from
        // the existing activity execution instead, so the activity can repair the
        // persisted view without changing workflow history.
        if (!args.agentTurnId && actx.info.workflowExecution) {
          legacyAgentTurnId = `legacy:${actx.info.workflowExecution.runId}:${actx.info.activityId}`;
        }
        const stableTurnId = args.agentTurnId ?? legacyAgentTurnId;
        turnSessionKey = stableTurnId ? `turnsession:${stableTurnId}` : undefined;
        // Heartbeat details are Temporal's primary retry checkpoint. The per-turn
        // SQLite key closes the small hard-kill window before a heartbeat reaches the
        // service; unlike session:<task>:<role>, it cannot accidentally pick up a
        // stale session from an earlier turn.
        const prior =
          (actx.info.heartbeatDetails as { session?: string } | undefined)?.session ??
          (actx.info.attempt > 1 && turnSessionKey ? store.kvGet(turnSessionKey) : undefined);
        if (actx.info.attempt > 1 && prior) {
          resumedActivityAttempt = true;
          liveChannel = false;
          // The interrupted attempt's session already holds the original prompt and
          // any partial work — continue it rather than re-sending the turn input.
          session = prior;
          hbSession = prior;
          // `messages` is replaced by the single continuation notice below, so the
          // delivered-boundary from the workflow no longer applies — send all of it.
          deliveredMessages = 0;
          messages = [
            {
              id: `retry-${actx.info.attempt}`,
              role: 'user',
              text: '(This turn was interrupted mid-run — the connection dropped or the host slept. Continue from where you left off; if the work was already finished, restate the final result.)',
              ts: 0,
            },
          ];
          record(args.taskId, 'turn.resumed', { role: args.role, attempt: actx.info.attempt });
        }
      } catch {
        /* not running inside a Temporal activity (e.g. a direct unit test) */
      }

      // The workflow mints the agent's scoped credential (SPEC §8.3): effective
      // capabilities = intersection(profile ceiling, granting principal).
      const grant = args.task.grant ?? DEFAULT_GRANT;
      const effective = attenuate(profile.capabilities, grant);
      let token: string | undefined;
      if (deps.tokens) {
        const minted = deps.tokens.mint({
          taskId: args.taskId,
          profileId: profile.id,
          principal: args.task.parentTaskId ? `task:${args.task.parentTaskId}` : (args.task.grantPrincipal ?? 'system:legacy-task'),
          projectId: args.task.projectId,
          organizationId: store.getProject(args.task.projectId)?.organizationId,
          audience: 'karmax-platform',
          executionId: args.agentTurnId ?? legacyAgentTurnId,
          worldGeneration: args.worldHandle.generation,
          ceiling: profile.capabilities,
          grantorCaps: grant,
        });
        token = minted.token;
        record(args.taskId, 'token.minted', { tokenId: minted.record.id, profile: profile.id, caps: effective,
          audience: minted.record.audience, executionId: minted.record.executionId, expiresAt: minted.record.expiresAt });
      }

      // JIT-resolve credentials via the broker (never journaled). The account to
      // use comes from the profile's allowedAccounts set (SPEC §7.3/§6.2) — first
      // matching entry — falling back to the legacy single `auth` field.
      let resolvedAuth: { apiKey?: string; configHome?: string; oauthToken?: string } | undefined;
      const effAuth = profile.auth ?? firstAllowedToAuth(profile.allowedAccounts, profile.provider);
      if (effAuth?.kind === 'apiKeyHandle' && effAuth.handle && deps.broker) {
        const apiKey = deps.broker.resolve(effAuth.handle, { taskId: args.taskId, profileId: profile.id, caps: effective });
        resolvedAuth = { apiKey };
      } else if (effAuth?.kind === 'configHome') {
        // Either an explicit path, or an account ref resolved to its minted home.
        // `account` may be "<provider>:<name>" (from the login picker) or just "<name>".
        let home = effAuth.configHome;
        if (!home && effAuth.account && deps.configHomes) {
          const { provider: prov, name } = splitAccountRef(effAuth.account, profile.provider);
          home = deps.configHomes.ensure(prov, name);
        }
        if (home) resolvedAuth = { configHome: home, ...(tokenToInject(home) ? { oauthToken: tokenToInject(home) } : {}) };
      }
      // A coordinator-leased account home wins over the profile default so turns
      // rotate across connected logins (SPEC §6.2 token/account leasing).
      if (args.accountConfigHome) {
        const tok = tokenToInject(args.accountConfigHome);
        resolvedAuth = { ...resolvedAuth, configHome: args.accountConfigHome, ...(tok ? { oauthToken: tok } : {}) };
      }
      // A coordinator-leased broker API-key handle wins over both (SPEC §6.2/§7): a
      // policy that ordered an API key ahead of (or instead of) logins.
      if (args.accountApiKeyHandle && deps.broker) {
        const apiKey = deps.broker.resolve(args.accountApiKeyHandle, { taskId: args.taskId, profileId: profile.id, caps: effective });
        resolvedAuth = { apiKey };
      }
      const apiRail = !!resolvedAuth?.apiKey || (!resolvedAuth && (
        (profile.provider === 'claude' && !!process.env.ANTHROPIC_API_KEY) ||
        (profile.provider === 'codex' && !!process.env.OPENAI_API_KEY)
      ));

      // ── Fork a prior agent (SPEC §10.5) ──────────────────────────────────────
      // Branch a NEW session from the source's REAL conversation — NOT by stuffing its
      // transcript into the prompt. Make the source session visible to THIS turn's
      // (home × world), then let the adapter run a native fork (Claude --fork-session /
      // Codex exec resume). Falls back to transcript replay only if the source session
      // file is gone (worlds get cleaned; the session survives in the home) or it's a
      // cross-provider jump.
      if (!session && spec?.resumeFrom) {
        const srcRole = spec.resumeFrom.role ?? args.role; // a task has many agents; pick the source's role
        // The config home THIS turn runs under — where the source session must be
        // visible for the provider to resolve it. Shared by both resume paths below.
        const forkHome = resolvedAuth?.configHome || path.join(os.homedir(), profile.provider === 'codex' ? '.codex' : '.claude');
        if (spec.resumeFrom.sessionId) {
          // A raw pasted provider session id = "continue THIS exact session" (resume,
          // not fork). Materialize it into this turn's (home × world) so the provider
          // resolves it even when the id was minted under a DIFFERENT config home or
          // world — Claude keys sessions by (home × cwd), Codex by id across homes, so
          // a bare pass-through silently missed both. The copy is non-mutating, so the
          // source is never disturbed; `fork` stays false to keep the same session id.
          session = spec.resumeFrom.sessionId;
          // The mock provider is hermetic — it has no on-disk session, so materialize is
          // meaningless; pass the id straight through. Real providers (claude/codex) key
          // a session to a file; make it visible in this turn's (home × world) or fail.
          const materialized =
            profile.provider === 'mock' || apiRail
              ? true
              : materializeFork({ provider: profile.provider, session, forkHome, worldPath: world.handle.root });
          if (!materialized) {
            // The id resolves in NO config home for this provider. Fail loudly instead
            // of handing an unknown id to the adapter, which would silently start a
            // FRESH conversation — the user asked to continue a specific one, and would
            // otherwise never learn it was lost. Permanent (nonRetryable): retrying can't
            // conjure the session. Covers a typo, a cleaned session, or a cross-provider
            // id (we run under this profile's provider).
            record(args.taskId, 'session.resume-failed', { session, provider: profile.provider });
            throw ApplicationFailure.create({
              message: `Cannot resume session "${session}": no such ${profile.provider} conversation found in any connected config home. Check the id, or that it belongs to a ${profile.provider} login connected to karmax (cross-provider resume is unsupported).`,
              type: 'agent-error',
              nonRetryable: true,
            });
          }
          record(args.taskId, 'session.resumed', { session, materialized });
        } else if (spec.resumeFrom.taskId) {
          const srcSession = store.kvGet(`session:${spec.resumeFrom.taskId}:${srcRole}`) || undefined;
          let srcHome: string | undefined;
          let srcProvider: string | undefined;
          const metaRaw = store.kvGet(`sessionmeta:${spec.resumeFrom.taskId}:${srcRole}`);
          if (metaRaw) { try { const m = JSON.parse(metaRaw); srcHome = m.home || undefined; srcProvider = m.provider || undefined; } catch { /* ignore */ } }
          let forked = false;
          if (srcSession && (!srcProvider || srcProvider === profile.provider)) {
            forked = materializeFork({ provider: profile.provider, session: srcSession, forkHome, worldPath: world.handle.root, srcHome });
            if (forked) {
              session = srcSession;
              fork = true; // adapter branches a NEW session id from it (native fork)
              record(args.taskId, 'session.forked', { from: spec.resumeFrom, session: srcSession, native: true });
            }
          }
          if (!forked) {
            // Degraded fallback (no real source session file — e.g. the mock adapter,
            // a cleaned source, or a cross-provider jump): replay the source transcript
            // as context. NOT a native fork — flagged `native: false`.
            const srcView = store.getTask(spec.resumeFrom.taskId)?.lastView;
            const srcMsgs =
              srcView?.transcripts?.find((t) => t.role === srcRole)?.messages ??
              (srcRole === 'do' ? srcView?.messages : undefined) ??
              [];
            if (srcMsgs.length) {
              messages = [...srcMsgs, ...args.messages];
              record(args.taskId, 'session.forked', { from: spec.resumeFrom, replayed: srcMsgs.length, native: false });
            }
          }
        }
      }

      // Self-healing loop (SPEC §3.4): show the Resolve agent the INDEX of prior saved
      // resolutions (`{{skills}}`) so it reuses a known fix rather than rediscovering
      // one. Read here (an activity) since the workflow can't touch the filesystem.
      let bindings = args.bindings;
      if (args.role === 'resolve') {
        const { listResolveSkills, renderSkillsIndex } = await import('../resolve/skills.js');
        const { paths } = await import('../config/paths.js');
        bindings = { ...(bindings ?? {}), skills: renderSkillsIndex(listResolveSkills(paths().content)) };
      }
      // Wiki context (SPEC §5.4 "global + project instructions"): the built-in
      // working instructions (a virtual unconditional wiki entry), then per
      // scope its unconditional entries in full and the indexed TOC. Read here
      // (an activity) and snapshotted into the journaled turn input — content
      // is free to edit between turns, never mid-turn. If the wiki is ever
      // unreadable, the agent still gets the built-in instructions.
      let projectInstructions: string | undefined;
      let globalInstructions: string | undefined;
      try {
        const { buildWikiPromptContext } = await import('../wiki/wiki.js');
        const { paths } = await import('../config/paths.js');
        projectInstructions = buildWikiPromptContext({
          contentDir: paths().content,
          organizationId: store.getProject(args.task.projectId)?.organizationId,
          projectId: args.task.projectId,
          builtinInstructions: deps.globalInstructions,
        }) || undefined;
      } catch {
        globalInstructions = deps.globalInstructions ?? GLOBAL_INSTRUCTIONS;
      }
      const systemPrompt = assemblePrompt({
        profile,
        role: args.role,
        task: args.task,
        world: args.worldHandle,
        globalInstructions,
        projectInstructions,
        bindings,
      });
      // Snapshot the journaled turn input (SPEC §5.4).
      record(args.taskId, 'turn.prompt', { role: args.role, profile: profile.id, provider: profile.provider });

      // Live follow-up poller (SPEC §5.6): a streaming adapter calls this mid-turn to
      // fetch follow-ups queued in the workflow at/after a `msgs` index and inject them
      // into the running session. Backed by the workflow's `pendingMessages` query;
      // absent when there's no client (unit tests) or the workflow doesn't define it
      // (the query throws → treated as "no new messages").
      const pullFollowUps: ((fromIndex: number) => Promise<Message[]>) | undefined =
        deps.client && liveChannel
          ? async (fromIndex: number) => {
              try {
                const handle = deps.client!.workflow.getHandle(args.taskId);
                const out = (await handle.query('pendingMessages', args.role, fromIndex)) as Message[] | undefined;
                return Array.isArray(out) ? out : [];
              } catch {
                return []; // query not registered / workflow gone / transient — no injection
              }
            }
          : undefined;

      // Confirm turns for sibling attempts share one durable transcript and run
      // serially. Fresh provider sessions replay that canonical transcript, which
      // also works across account/config-home rotation (native sessions are home-bound).
      const releaseConfirm = args.role === 'confirm' ? await acquireConfirmLock(conversationTaskId) : () => {};
      let confirmTranscript: Message[] | undefined;
      if (args.role === 'confirm') {
        let shared: Message[];
        try { shared = JSON.parse(store.kvGet(`confirm-transcript:${conversationTaskId}`) ?? '[]'); }
        catch { shared = []; }
        confirmTranscript = shared;
        const request = [...args.messages].reverse().find((m) => m.role === 'user');
        if (request) {
          const id = `${args.taskId}:${request.id}`;
          if (!shared.some((m) => m.id === id)) shared.push({ ...request, id, ts: shared.length });
        }
        // Sibling task attempts deliberately start a fresh provider session and replay
        // the intent-wide transcript. A retry of THIS SAME Temporal activity is
        // different: it must resume the interrupted provider session checkpointed
        // above, otherwise a worker restart discards the in-flight confirmer turn.
        if (!resumedActivityAttempt) {
          messages = shared;
          session = undefined;
          deliveredMessages = 0;
        }
      }
      /** Compatibility publisher for immutable v1 histories. Those workflows
       * clear their in-memory account wait after a grant but cannot schedule a
       * publish there without becoming nondeterministic. The activity is already
       * a side-effect boundary, so it may keep the SQLite/UI snapshot truthful:
       * account granted → waiting for host slot → running. A matching id prevents
       * a late retry/cancellation from overwriting a newer turn's view. */
      const publishLegacyAgentState = (state: 'waiting-slot' | 'running' | undefined) => {
        if (!legacyAgentTurnId) return;
        const taskRecord = store.getTask(args.taskId);
        // A late retry from a terminated v1 execution must never overwrite the
        // replacement run's v1.1+ snapshot. Workflow version is the stable guard;
        // view shape alone is not (a review wait legitimately has no agentTurn).
        if (taskRecord?.workflowVersion !== '1.0.0') return;
        const prev = taskRecord.lastView;
        if (!prev || prev.status === 'done' || prev.status === 'failed' || prev.status === 'cancelled') return;
        if (state) {
          if (prev.agentTurn && prev.agentTurn.turnId !== legacyAgentTurnId) return;
        } else if (prev.agentTurn?.turnId !== legacyAgentTurnId) {
          return;
        }
        const next: TaskView = state
          ? {
              ...prev,
              status: state === 'running' ? 'active' : 'waiting',
              waitingFor:
                state === 'waiting-slot'
                  ? { kind: 'agentSlot', provider: profile.provider, detail: 'Waiting for host capacity to run the agent' }
                  : undefined,
              agentTurn: { turnId: legacyAgentTurnId, role: args.role, provider: profile.provider, state },
            }
          : { ...prev, status: prev.status === 'waiting' ? 'active' : prev.status, waitingFor: undefined, agentTurn: undefined };
        store.saveView(args.taskId, next);
        record(args.taskId, 'view.updated', {
          stage: next.stage,
          status: next.status,
          waitingFor: next.waitingFor?.kind ?? null,
          agentTurn: next.agentTurn?.state ?? null,
          agentRole: next.agentTurn?.role ?? null,
          compatibility: 'legacy-agent-turn',
        });
      };

      // Host-wide agent-turn admission (SPEC §12): cap concurrent model
      // subprocesses so a burst can't OOM the host. Acquired around the model
      // call ONLY — the setup above is cheap — and released in `finally` below.
      let releaseSlot: () => void | Promise<void> = () => {};
      let lastEmit: string | undefined;
      let result;
      try {
        publishLegacyAgentState('waiting-slot');
        // Current workflows carry a stable turn id, so the activity enrolls that
        // turn in the durable/reorderable coordinator before starting the model.
        // Historical executions lack the id and retain the replay-safe file gate.
        if (args.agentTurnId && deps.client && deps.taskQueue) {
          releaseSlot = await acquireWorkflowAgentSlot({
            client: deps.client,
            taskQueue: deps.taskQueue,
            store,
            taskId: args.taskId,
            turnId: args.agentTurnId,
            role: args.role,
            provider: profile.provider,
            title: args.task.title,
            projectId: args.task.projectId,
            heartbeat,
            signal,
          });
          try {
            await awaitAgentResources(heartbeat, signal);
          } catch (e) {
            await releaseSlot();
            releaseSlot = () => {};
            throw e;
          }
        } else releaseSlot = await acquireAgentSlot(heartbeat, signal);
        // The workflow publishes `waiting-slot` immediately after the account grant;
        // only admission itself can truthfully report that the model is now running.
        if (deps.client && args.agentTurnId) {
          await deps.client.workflow
            .getHandle(args.taskId)
            .signal(SIG_AGENT_TURN_STATE, { turnId: args.agentTurnId, role: args.role, provider: profile.provider, state: 'running' })
            .catch(() => undefined);
        }
        publishLegacyAgentState('running');
        if (isRemote(args.worldHandle.kind) && profile.provider !== 'mock' && !apiRail) {
          throw ApplicationFailure.nonRetryable(
            'Cloud worlds currently require an API-key agent credential. Subscription CLI sessions execute on the karmax host and cannot safely see a remote filesystem; select an API-key profile for this project.',
            'cloud-agent-credential',
          );
        }
        result = await runRuntimeTurn({ version: KARMAX_RUNTIME_PROTOCOL, input: {
          profile,
          world,
          messages,
          session,
          deliveredMessages,
          fork,
          systemPrompt,
          role: args.role,
          maxTurns: profile.maxTurns,
          ...(resolvedAuth ? { resolvedAuth } : {}),
          // Git-profile credentials for the agent subprocess (PLAN-git-config.md
          // §4B): an agent that pushes or runs `gh` acts as the project's account.
          ...(() => {
            const gitEnv = isRemote(args.worldHandle.kind) ? {} : gitEnvFor(args.worldHandle, args.taskId);
            // The platform MCP subprocess inherits this short-lived workflow
            // token. The gateway accepts it directly and enforces its project +
            // capability grant; no full-power browser session is ever acquired.
            const extraEnv = { ...gitEnv, ...(token ? { KARMAX_TOKEN: token } : {}) };
            return Object.keys(extraEnv).length ? { extraEnv } : {};
          })(),
          // MCP servers the workflow gives its agents (SPEC §7.5).
          ...(args.task.workflow ? { agentMcp: manifest(args.task.workflow)?.agentMcp } : {}),
        } },
        {
          adapters: deps.adapters,
          signal,
          heartbeat,
          pullFollowUps,
          // Coalesce the live-output stream: adapters re-emit the growing *cumulative*
          // message text, so consecutive identical/prefix emits carry no new info.
          // Dropping them cuts the single biggest events-table growth driver
          // (one row per chunk) without changing what the UI renders.
          onEmit: (t) => {
            if (t === lastEmit) return;
            lastEmit = t;
            record(args.taskId, 'agent.output', { text: t });
          },
          onActivity: (activity) => {
            record(args.taskId, 'agent.activity', {
              ...activity,
              role: args.role,
              ...(args.agentTurnId ? { turnId: args.agentTurnId } : {}),
            });
          },
          // Publish the session id + its home the moment the adapter knows it (mid-turn),
          // so the drawer's live "fork this agent" command appears WHILE the turn runs,
          // not only at turn-end (RESOLVE-PLAN #3). Fire-once per session in the adapters.
          onSession: (s) => {
            hbSession = s; // heartbeats now carry it → a retry resumes this session
            if (turnSessionKey) store.kvSet(turnSessionKey, s);
            // Do not wait for the 10-second liveness interval: checkpoint the newly
            // minted provider session immediately so a restart on the next instruction
            // still resumes this exact turn.
            heartbeat?.();
            store.kvSet(`session:${conversationTaskId}:${args.role}`, s);
            store.kvSet(
              `sessionmeta:${conversationTaskId}:${args.role}`,
              JSON.stringify({
                home: resolvedAuth?.configHome ?? '',
                provider: profile.provider,
                ...(profile.model ? { model: profile.model } : {}),
                ...(profile.effort ? { effort: profile.effort } : {}),
              }),
            );
            record(args.taskId, 'session.started', { role: args.role });
          },
          ...(deps.payments
            ? {
                budget: new BudgetService(store, deps.payments),
                spendCtx: { projectId: args.task.projectId, taskId: args.taskId },
                onSpend: (req: any, outcome: any) => record(args.taskId, 'spend.requested', { ...req, status: outcome.status, reason: outcome.reason }),
              }
            : {}),
          ...(token
            ? {
                platformRequest: async (method: string, requestPath: string, body?: unknown) => {
                  if (!requestPath.startsWith('/api/')) throw new Error('platform path must start with /api/');
                  const base = process.env.KARMAX_GATEWAY_URL ?? 'http://127.0.0.1:4505';
                  const response = await fetch(`${base}${requestPath}`, {
                    method,
                    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                  });
                  const value = response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text();
                  if (!response.ok) throw new Error((value as any)?.error ?? `HTTP ${response.status}`);
                  return value;
                },
              }
            : {}),
        },
        );
        // Defence in depth around the activity boundary. `runTurn` rejects an
        // adapter return after abort, but cancellation can race the few synchronous
        // instructions between that check and this await continuation. Never report
        // a normal Temporal activity result once shutdown/cancellation is visible.
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('agent turn cancelled');
        }
        if (confirmTranscript) {
          if (result.output?.trim()) confirmTranscript.push({ id: `${args.taskId}:out:${confirmTranscript.length}`, role: 'agent', text: result.output, ts: confirmTranscript.length });
          if (result.confirmDecision) {
            const d = result.confirmDecision;
            confirmTranscript.push({ id: `${args.taskId}:decision:${confirmTranscript.length}`, role: 'system', text: `confirm_decision: ${d.action}${d.text ? ` — ${d.text}` : ''}`, ts: confirmTranscript.length });
          }
          store.kvSet(`confirm-transcript:${conversationTaskId}`, JSON.stringify(confirmTranscript));
        }
      } catch (err) {
        if (token) deps.tokens?.revoke(token);
        if (signal?.aborted) throw err; // cancellation — Temporal must see it untouched
        throw classifyTurnError(err, profile.provider);
      } finally {
        await releaseSlot();
        releaseConfirm();
        publishLegacyAgentState(undefined);
      }
      if (token) deps.tokens?.revoke(token);
      // Persist the session id so other tasks can resume from this one (§10.5), plus
      // which config home + provider minted it — provider sessions are home-bound, so
      // the CLI resume-command needs the right CONFIG_DIR/CODEX_HOME (§2.5, #2/#3).
      if (result.session) {
        store.kvSet(`session:${conversationTaskId}:${args.role}`, result.session);
        store.kvSet(
          `sessionmeta:${conversationTaskId}:${args.role}`,
          JSON.stringify({
            home: resolvedAuth?.configHome ?? '',
            provider: profile.provider,
            ...(profile.model ? { model: profile.model } : {}),
            ...(profile.effort ? { effort: profile.effort } : {}),
          }),
        );
      }

      if (result.skills?.length) {
        for (const s of result.skills) record(args.taskId, 'skill.saved', { name: s.name });
      }
      record(args.taskId, 'turn.result', {
        completed: result.completed,
        providerCompleted: result.providerCompleted,
        providerTermination: result.providerTermination,
        subTasks: result.subTasks?.length ?? 0,
        hasReview: !!result.reviewInfo,
        output: result.output.slice(0, 2000),
      });
      return result;
    },

    /** Auto-derive the changed-files summary so Review always shows what changed
     *  (§5.5). Diffs are intentionally NOT computed — they were removed from the
     *  review packet; reviewers use the changed-files list + the in-world terminal. */
    async buildReview(handle: WorldHandle, base: string): Promise<{ summary: string; changedFiles: string[] }> {
      const world = await openWorld(handle);
      const repos = worldRepos(handle);
      const roots = repos.length ? repos : [{ name: '', root: handle.root }];
      const changedFiles: string[] = [];
      for (const repo of roots) {
        const tracked = await world.exec('git', ['diff', '--name-only', 'base' in repo ? repo.base : base], { cwd: repo.root });
        const untracked = await world.exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd: repo.root });
        const prefix = repos.length > 1 ? `${repo.name}/` : '';
        changedFiles.push(
          ...tracked.stdout.split('\n').map((s) => s.trim()).filter(Boolean).map((file) => `${prefix}${file}`),
          ...untracked.stdout.split('\n').map((s) => s.trim()).filter(Boolean).map((file) => `${prefix}${file} (new)`),
        );
      }
      const summary = changedFiles.length ? `${changedFiles.length} file(s) changed.` : 'No file changes detected.';
      record(handle.id, 'review.built', { files: changedFiles.length });
      return { summary, changedFiles };
    },

    async finalizeMergeActivity(handle: WorldHandle, target: string): Promise<MergeResult> {
      const world = await openWorld(handle);
      // Merge commits carry the world's profile identity too (PLAN-git-config.md
      // §4A) — they land on the target, where worktree-scoped config doesn't reach.
      let identity;
      const profileName = handle.meta?.gitProfile;
      if (typeof profileName === 'string' && profileName) {
        try {
          const profile = gitProfiles.get(profileName);
          identity = profile ? gitProfiles.identity(profile, { taskId: handle.id }) : undefined;
        } catch {
          identity = undefined; // fall back to ensureIdentity inside finalizeMerge
        }
      }
      const result = isRemote(handle.kind)
        ? await brokerFinalizeMerge(world, target, identity, brokerAuthFor(handle, handle.id))
        : await finalizeMerge(world, target, identity);
      record(handle.id, 'merge.result', { merged: result.merged, sha: result.sha, conflict: result.conflict, dirty: result.dirty });
      return result;
    },

    async runScript(args: { taskId: string; worldHandle: WorldHandle; command: string }): Promise<{ code: number; output: string }> {
      const world = await openWorld(args.worldHandle, args.taskId);
      record(args.taskId, 'script.start', { command: args.command });
      const r = await world.exec('bash', ['-lc', args.command], { timeoutMs: 30 * 60_000 });
      const output = `${r.stdout}${r.stderr}`;
      record(args.taskId, 'script.done', { code: r.code, output: output.slice(0, 4000) });
      return { code: r.code, output };
    },

    async runWorkflowChecks(args: { taskId: string; worldHandle: WorldHandle }): Promise<{ passed: boolean; detail?: string }> {
      const world = await openWorld(args.worldHandle, args.taskId);
      const hasPkg = (await world.exec('bash', ['-lc', 'test -f package.json && echo yes || echo no'])).stdout.includes('yes');
      if (!hasPkg) {
        record(args.taskId, 'checks.skip', { reason: 'no package.json' });
        return { passed: true, detail: 'no test suite found' };
      }
      const r = await world.exec('bash', ['-lc', 'npm test --silent 2>&1 | tail -40'], { timeoutMs: 10 * 60_000 });
      record(args.taskId, 'checks.done', { code: r.code });
      if (r.code !== 0) return { passed: false, detail: r.stdout.slice(-600) };

      // SPEC §4.4's replay gate is literal: fetch every currently-running history
      // and compare the candidate bundle with the bundle serving production now.
      // Pre-existing incompatibilities are reported but do not make unrelated edits
      // impossible; any history that regresses from baseline-pass to candidate-fail
      // blocks the merge.
      if (!deps.client) return { passed: false, detail: 'tests passed, but replay compatibility could not run: no Temporal client' };
      const candidatePath = path.join(args.worldHandle.root, 'src', 'workflows', 'index.ts');
      if (!fs.existsSync(candidatePath)) return { passed: false, detail: `tests passed, but candidate workflow bundle is missing: ${candidatePath}` };
      try {
        const histories: Array<{ workflowId: string; history: unknown }> = [];
        for await (const execution of deps.client.workflow.list({ query: "ExecutionStatus='Running'" })) {
          histories.push({ workflowId: execution.workflowId, history: await deps.client.workflow.getHandle(execution.workflowId, execution.runId).fetchHistory() });
        }
        const { Worker } = await import('@temporalio/worker');
        const replay = async (workflowsPath: string) => {
          const failures = new Map<string, string>();
          for await (const result of Worker.runReplayHistories({ workflowsPath }, histories)) {
            if (result.error) failures.set(result.workflowId, result.error.message);
          }
          return failures;
        };
        const baselinePath = fileURLToPath(new URL('../workflows/index.ts', import.meta.url));
        const baselineFailures = await replay(baselinePath);
        const candidateFailures = await replay(candidatePath);
        const regressions = [...candidateFailures.entries()].filter(([id]) => !baselineFailures.has(id));
        const fixed = [...baselineFailures.keys()].filter((id) => !candidateFailures.has(id));
        const existing = [...candidateFailures.keys()].filter((id) => baselineFailures.has(id));
        record(args.taskId, 'checks.replay', {
          histories: histories.length,
          regressions: regressions.map(([id]) => id),
          preExisting: existing,
          fixed,
        });
        if (regressions.length) {
          const detail = regressions.map(([id, error]) => `${id}: ${error}`).join('\n');
          return { passed: false, detail: `tests passed; replay REGRESSED ${regressions.length}/${histories.length} active histories:\n${detail}`.slice(-4000) };
        }
        return {
          passed: true,
          detail: `tests + replay passed (${histories.length} active histories; ${existing.length} pre-existing incompatibilities${fixed.length ? `; ${fixed.length} repaired` : ''})`,
        };
      } catch (e) {
        return { passed: false, detail: `tests passed, but replay compatibility failed to run: ${e instanceof Error ? e.message : String(e)}` };
      }
    },

    async commitWork(handle: WorldHandle, message: string): Promise<{ committed: boolean; sha?: string }> {
      const world = await openWorld(handle);
      const repos = worldRepos(world.handle);
      const roots = repos.length ? repos.map((repo) => repo.root) : [world.handle.root];
      let committed = true;
      let sha: string | undefined;
      for (const root of roots) {
        const add = await world.exec('git', ['add', '-A'], { cwd: root });
        const commit = add.code === 0 ? await world.exec('git', ['commit', '-q', '-m', message], { cwd: root }) : add;
        const head = await world.exec('git', ['rev-parse', 'HEAD'], { cwd: root });
        const nothing = /nothing to commit|no changes added/i.test(`${commit.stdout}${commit.stderr}`);
        committed &&= add.code === 0 && (commit.code === 0 || nothing) && head.code === 0;
        sha = head.stdout.trim() || sha;
      }
      record(handle.id, 'work.committed', { committed, repos: roots.length });
      return { committed, sha };
    },

    /** Persist a cloud task branch before releasing its sandbox. Unlike the
     * best-effort post-merge push policy, this is the only durable copy of a
     * just-do world's result, so any skipped repository is a hard failure. */
    async publishTaskBranch(handle: WorldHandle): Promise<{ pushed: string[] }> {
      if (!isRemote(handle.kind)) return { pushed: [] };
      const world = await openWorld(handle);
      const result = await brokerPublishBranch(world, brokerAuthFor(handle, handle.id));
      if (!result.pushed.length || result.skipped.length) {
        throw new Error(`cloud task branch was not persisted${result.skipped.length ? ` for: ${result.skipped.join(', ')}` : ' because it has no remote repository'}`);
      }
      record(handle.id, 'push.branch', { branch: handle.branch, repos: result.pushed });
      return { pushed: result.pushed };
    },

    async destroyWorld(handle: WorldHandle): Promise<void> {
      const current = (store.currentWorld(handle.id) ?? handle) as WorldHandle;
      const leaseId = typeof current.meta?.worldLeaseId === 'string' ? current.meta.worldLeaseId : undefined;
      try {
        const world = await worlds.open(handle);
        await world.destroy();
        store.setWorldState((store.currentWorld(handle.id) ?? current) as WorldHandle, 'released');
        record(handle.id, 'world.destroyed', {});
      } catch (error) {
        // The provider may be unavailable while its own timeout is evicting the
        // sandbox. Do not retain admission capacity forever; keep the durable
        // world degraded so operations can see/retry the incomplete teardown.
        store.setWorldState((store.currentWorld(handle.id) ?? current) as WorldHandle, 'degraded');
        record(handle.id, 'world.destroy_failed', { error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (leaseId) deps.runners?.release(leaseId, current.kind);
      }
    },

    async openPr(handle: WorldHandle, target: string): Promise<{ url: string; number: number } | null> {
      // GitHub PRs are an optional integration (SPEC §5.2). Use `gh` if present
      // and authorized; otherwise the Review stage IS the conceptual PR. The git
      // profile's credentials (GH_TOKEN / GIT_SSH_COMMAND) select the account per
      // subprocess (PLAN-git-config.md §4B — never `gh auth switch`).
      const world = await openWorld(handle);
      const env = gitEnvFor(handle, handle.id);
      if (isRemote(handle.kind)) {
        const remotePr = await brokerOpenGithubPr(world, target, brokerAuthFor(handle, handle.id));
        record(handle.id, remotePr ? 'pr.opened' : 'pr.skipped', remotePr ?? { reason: 'cloud Git broker could not push/open PR' });
        return remotePr;
      }
      const which = await world.exec('bash', ['-lc', 'command -v gh && gh auth status >/dev/null 2>&1 && echo ok || echo no'], { env });
      if (!which.stdout.includes('ok')) {
        record(handle.id, 'pr.skipped', { reason: 'gh not available/authorized' });
        return null;
      }
      const push = await world.exec('git', ['push', '-u', 'origin', handle.branch], { env });
      if (push.code !== 0) {
        record(handle.id, 'pr.skipped', { reason: 'push failed', detail: push.stderr.slice(0, 300) });
        return null;
      }
      // `gh pr create` prints a URL; only `pr view` supports structured JSON.
      // Query after the create attempt, which also makes this idempotently return
      // an already-existing PR without interpolating branch names into a shell.
      await world.exec('gh', ['pr', 'create', '--base', target, '--head', handle.branch, '--fill'], { env });
      const pr = await world.exec('gh', ['pr', 'view', handle.branch, '--json', 'url,number'], { env });
      try {
        const parsed = JSON.parse(pr.stdout);
        record(handle.id, 'pr.opened', parsed);
        return { url: parsed.url, number: parsed.number };
      } catch {
        return null;
      }
    },

    /**
     * Push the landed target branch to each repo's origin (remote policy
     * 'push'/'pr', PLAN-git-config.md §5). Best-effort by contract: the local
     * merge is the deliverable; every skip/failure is recorded, never thrown.
     */
    async pushTarget(handle: WorldHandle, target: string): Promise<{ pushed: string[]; skipped: string[] }> {
      const env = { GIT_TERMINAL_PROMPT: '0', ...gitEnvFor(handle, handle.id) };
      const world = await openWorld(handle);
      const pushed: string[] = [];
      const skipped: string[] = [];
      if (isRemote(handle.kind)) {
        // brokerFinalizeMerge already performed the authenticated target push;
        // report the policy step as satisfied without re-exporting credentials.
        pushed.push(...worldRepos(handle).map((repo) => repo.name));
        return { pushed, skipped };
      }
      for (const r of worldRepos(handle)) {
        const repoTarget = r.target ?? target;
        const hasOrigin = await world.exec('git', ['remote', 'get-url', 'origin'], { cwd: r.repo, env });
        if (hasOrigin.code !== 0) {
          skipped.push(r.name);
          record(handle.id, 'push.skipped', { repo: r.name, reason: 'no origin remote' });
          continue;
        }
        const push = await world.exec('git', ['push', 'origin', repoTarget], { cwd: r.repo, env });
        if (push.code === 0) {
          pushed.push(r.name);
          record(handle.id, 'push.done', { repo: r.name, target });
        } else {
          skipped.push(r.name);
          record(handle.id, 'push.failed', { repo: r.name, target, detail: (push.stderr || push.stdout).slice(0, 300) });
        }
      }
      return { pushed, skipped };
    },

    async publishView(taskId: string, view: TaskView): Promise<void> {
      store.saveView(taskId, view);
      // Entering Merge is the logical commitment boundary. The SQLite compare-and-
      // set is the winner lease: exactly one attempt may get past this awaited
      // activity and approach the global merge queue.
      if (view.stage === 'merge') {
        const claim = store.claimAttempt(taskId);
        for (const siblingId of claim.cancel) {
          const sibling = store.getTask(siblingId);
          if (sibling?.params.draft) {
            store.markDraftSuperseded(siblingId, taskId);
            continue;
          }
          await deps.client?.workflow.getHandle(siblingId).signal('cancel').catch(() => undefined);
        }
      }
      record(taskId, 'view.updated', {
        stage: view.stage,
        status: view.status,
        waitingFor: view.waitingFor?.kind ?? null,
        agentTurn: view.agentTurn?.state ?? null,
        agentRole: view.agentTurn?.role ?? null,
      });
      // A waiting task owns durable state, not continuously-metered compute.
      // Parking is an implementation detail inside this existing activity (no new
      // workflow command, so old Temporal histories remain replay-compatible).
      // Every later operation goes through worlds.open(), which transparently
      // resumes a paused provider before a terminal, artifact, agent turn, or merge.
      // software-dev also stores the handle in structured recovery state, while
      // newer workflow views expose it directly. Accept both shapes. Crucially,
      // skip providers that cannot really park: even a no-op lifecycle detour on
      // every waiting publish creates avoidable activity contention precisely
      // while parent/child cancellation signals need to settle promptly.
      const waitingWorld = (view.world ?? view.state.recoveryWorld) as WorldHandle | undefined;
      if (view.status === 'waiting' && waitingWorld && worlds.get(waitingWorld.kind).parkable) {
        try {
          const before = await worlds.status(waitingWorld);
          if (before === 'ready') {
            if (deps.checkpoints) {
              try {
                // The branch is the portable checkpoint's committed layer. Push
                // it through the trusted broker before capturing the dirty delta.
                if (isRemote(waitingWorld.kind) && worldRepos(waitingWorld).length) {
                  const remoteWorld = await openWorld(waitingWorld, taskId);
                  const projectId = String(waitingWorld.meta?.projectId ?? '');
                  if (store.listProjectRepositories(projectId).length) {
                    const pushed = await brokerPublishBranch(remoteWorld, brokerAuthFor(waitingWorld, taskId));
                    if (pushed.skipped.length) throw new Error(`could not persist branch for ${pushed.skipped.join(', ')}`);
                    record(taskId, 'push.branch', { branch: waitingWorld.branch, repos: pushed.pushed, reason: 'checkpoint' });
                  }
                }
                const checkpoint = await deps.checkpoints.checkpoint(waitingWorld);
                record(taskId, 'checkpoint.created', { checkpointId: checkpoint.id,
                  generation: checkpoint.generation, bytes: checkpoint.filesystemDelta?.bytes ?? 0 });
              } catch (error) {
                record(taskId, 'checkpoint.warning', { warning: error instanceof Error ? error.message : String(error) });
              }
            }
            await worlds.park(waitingWorld);
            if (await worlds.status(waitingWorld) === 'parked') {
              const current = (store.currentWorld(waitingWorld.id) ?? waitingWorld) as WorldHandle;
              const leaseId = typeof current.meta?.worldLeaseId === 'string' ? current.meta.worldLeaseId : undefined;
              if (leaseId) {
                deps.runners?.release(leaseId, current.kind);
                store.updateWorldMeta(current, { worldLeaseId: null });
              }
              store.setWorldState((store.currentWorld(waitingWorld.id) ?? waitingWorld) as WorldHandle, 'parked');
              record(taskId, 'world.parked', { provider: waitingWorld.kind, reason: view.waitingFor?.kind ?? view.stage });
            }
          }
        } catch (error) {
          // Auto-pause remains the cost backstop; a transient park failure must
          // never roll back or retry the authoritative view update.
          record(taskId, 'world.warning', { warning: `could not park waiting world: ${error instanceof Error ? error.message : String(error)}` });
        }
      }
    },

    async recordEvent(taskId: string, type: string, payload: Record<string, unknown>): Promise<void> {
      record(taskId, type, payload);
    },

    async prepareChildTask(args: PrepareChildArgs): Promise<TaskInput> {
      const parent = store.getTask(args.parentTaskId);
      const child = store.createTask({
        projectId: args.projectId,
        listId: parent?.listId,
        title: args.title,
        workflow: 'software-dev',
        workflowVersion: parent?.workflowVersion ?? '1.0.0',
        params: { prompt: args.prompt, base: args.base, target: args.target },
        parentTaskId: args.parentTaskId,
        createdBy: { kind: 'task-agent', taskId: args.parentTaskId, role: 'do' },
        assignee: { kind: 'task-agent', taskId: args.parentTaskId, role: 'do' },
      });
      record(args.parentTaskId, 'subtask.created', { childTaskId: child.id, title: args.title });
      // Least-privilege grant (SPEC §8.2): the child's delegation caps are attenuated
      // by the parent's own grant, and its merge cap is scoped to EXACTLY the parent's
      // branch (which the parent owns and merges into). If no branch is known,
      // the child gets no merge capability — never a broad fallback.
      const delegation = attenuate(
        ['create-sub-task', 'create-review-info', 'signal-completion', 'save-skill'],
        args.parentGrant ?? DEFAULT_GRANT,
      );
      const mergeBack = args.parentBranch && allows(args.parentGrant ?? DEFAULT_GRANT, `merge-into:${args.parentBranch}`)
        ? [`merge-into:${args.parentBranch}`]
        : [];
      const grant = [...delegation, ...mergeBack];
      store.updateTaskParams(child.id, {
        ...child.params,
        _authorization: { profileId: 'inherited-child', principal: `task:${args.parentTaskId}`, capabilities: grant, attenuated: true },
      });
      return {
        taskId: child.id,
        projectId: args.projectId,
        title: args.title,
        prompt: args.prompt,
        base: args.base,
        target: args.target,
        parentTaskId: args.parentTaskId,
        project: args.project,
        profiles: args.profiles,
        resolveAgentEnabled: args.resolveAgentEnabled,
        grant,
        grantPrincipal: `task:${args.parentTaskId}`,
        authorizationProfile: 'inherited-child',
      };
    },

    async autoResolve(args: {
      taskId: string;
      stage: string;
      error: string;
      limit?: LimitClassification;
    }): Promise<{ resolved: boolean; note?: string; action?: string }> {
      // Workflow-declared resolve rules (SPEC §5.2) take precedence over the defaults.
      const wf = store.getTask(args.taskId)?.workflow;
      const rules = wf ? manifest(wf)?.resolveRules : undefined;
      // A typed provider failure has already been classified at the adapter boundary;
      // do not discard that ground truth and re-interpret provider prose here.
      const r = args.limit?.limited
        ? { resolved: true, action: 'retry' as const, note: 'provider account unavailable — retrying without a Resolve agent' }
        : runAutoResolve(args.stage, args.error, rules);
      record(args.taskId, 'resolve.auto', {
        stage: args.stage,
        resolved: r.resolved,
        action: r.action,
        source: args.limit?.limited ? 'provider-metadata' : 'message-rule',
      });
      return r;
    },

    /** Used by the gateway-side too; generates ids deterministically off the worker. */
    async newTaskId(): Promise<string> {
      return newId('task');
    },
  };
}

export type coreActivities = ReturnType<typeof makeCoreActivities>;

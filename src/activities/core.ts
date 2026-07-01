import type { Client } from '@temporalio/client';
import { Context as activityContext } from '@temporalio/activity';
import { Store } from '../store/db.js';
import { WorldRegistry } from '../world/registry.js';
import { WorldHandle, WorldKind } from '../world/types.js';
import { finalizeMerge, MergeResult } from '../world/merge.js';
import { ProfileResolver } from '../agent/profiles.js';
import { AgentAdapter } from '../agent/types.js';
import { runTurn } from '../agent/runtime.js';
import { assemblePrompt } from '../agent/prompt.js';
import { GLOBAL_INSTRUCTIONS } from '../agent/instructions.js';
import { autoResolve as runAutoResolve } from '../resolve/cases.js';
import { KarmaxBus } from '../contrib/bus.js';
import { TokenAuthority } from '../platform/tokens.js';
import { CredentialBroker } from '../autonomy/broker.js';
import { PaymentProvider, BudgetService } from '../autonomy/payments.js';
import { capturedToken } from '../autonomy/config-homes.js';
import { manifest } from '../contrib/manifests.js';
import { attenuate } from '../platform/capabilities.js';
import { Provider, Message, TaskInput, TaskView, AgentRole, AuthSource } from '../domain/types.js';
import { newId } from '../util/id.js';

const DEFAULT_GRANT = ['*'];

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
  bus?: KarmaxBus;
  globalInstructions?: string;
  tokens?: TokenAuthority;
  broker?: CredentialBroker;
  payments?: PaymentProvider;
  configHomes?: import('../autonomy/config-homes.js').ConfigHomeManager;
}

export interface CreateWorldArgs {
  taskId: string;
  repo?: string;
  base: string;
  target?: string;
  branch?: string;
  copyGlobs?: string[];
  kind: WorldKind;
}

export interface RunAgentTurnArgs {
  taskId: string;
  role: AgentRole;
  worldHandle: WorldHandle;
  messages: Message[];
  session?: string;
  task: TaskInput;
  bindings?: Record<string, string>;
  explicitProfileId?: string;
  /** Config home leased by the account coordinator for this turn (SPEC §6.2);
   * overrides the profile's own auth home so turns rotate across logins. */
  accountConfigHome?: string;
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
}

/** Side-effecting activities the workflows drive (SPEC §3.1). */
export function makeCoreActivities(deps: CoreActivityDeps) {
  const { store, worlds, profiles } = deps;

  function record(taskId: string, type: string, payload: Record<string, unknown>) {
    const ev = { type, taskId, ts: Date.now(), payload };
    const seq = store.appendEvent(ev);
    deps.bus?.emit({ ...ev, seq });
  }

  return {
    async createWorld(args: CreateWorldArgs): Promise<WorldHandle> {
      const world = await worlds.create(args.kind, {
        taskId: args.taskId,
        repo: args.repo,
        base: args.base,
        target: args.target,
        branch: args.branch,
        copyGlobs: args.copyGlobs,
      });
      record(args.taskId, 'world.created', { handle: world.handle });
      return world.handle;
    },

    async runAgentTurn(args: RunAgentTurnArgs) {
      const baseProfile = profiles.resolve(args.role, args.task.profiles, args.explicitProfileId, args.task.projectId);
      // Apply the per-role agent override from the task form (SPEC §10.5).
      const spec = args.task.agents?.[args.role];
      const profile = spec
        ? {
            ...baseProfile,
            provider: spec.provider ?? baseProfile.provider,
            ...(spec.model ? { model: spec.model } : {}),
            ...(spec.effort ? { effort: spec.effort } : {}),
          }
        : baseProfile;
      const world = await worlds.open(args.worldHandle);

      // Resume a prior agent session if requested (SPEC §10.5): explicit session
      // id, or the stored session of a referenced task for this role.
      let session = args.session;
      if (!session && spec?.resumeFrom) {
        const srcRole = spec.resumeFrom.role ?? args.role; // a task has many agents; pick the source role
        session = spec.resumeFrom.sessionId
          ?? (spec.resumeFrom.taskId ? store.kvGet(`session:${spec.resumeFrom.taskId}:${srcRole}`) : undefined);
        if (session) record(args.taskId, 'session.resumed', { from: spec.resumeFrom, session });
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
          principal: args.task.parentTaskId ? `task:${args.task.parentTaskId}` : 'user',
          projectId: args.task.projectId,
          ceiling: profile.capabilities,
          grantorCaps: grant,
        });
        token = minted.token;
        record(args.taskId, 'token.minted', { profile: profile.id, caps: effective });
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
        if (home) resolvedAuth = { configHome: home, ...(capturedToken(home) ? { oauthToken: capturedToken(home) } : {}) };
      }
      // A coordinator-leased account home wins over the profile default so turns
      // rotate across connected logins (SPEC §6.2 token/account leasing).
      if (args.accountConfigHome) {
        const tok = capturedToken(args.accountConfigHome);
        resolvedAuth = { ...resolvedAuth, configHome: args.accountConfigHome, ...(tok ? { oauthToken: tok } : {}) };
      }

      const systemPrompt = assemblePrompt({
        profile,
        role: args.role,
        task: args.task,
        world: args.worldHandle,
        globalInstructions: deps.globalInstructions ?? GLOBAL_INSTRUCTIONS,
        bindings: args.bindings,
      });
      // Snapshot the journaled turn input (SPEC §5.4).
      record(args.taskId, 'turn.prompt', { role: args.role, profile: profile.id, provider: profile.provider });

      // Temporal cancellation → abort the in-flight turn mid-flight (SPEC §5.6).
      let signal: AbortSignal | undefined;
      let heartbeat: (() => void) | undefined;
      try {
        const actx = activityContext.current();
        signal = actx.cancellationSignal;
        heartbeat = () => actx.heartbeat();
      } catch {
        /* not running inside a Temporal activity (e.g. a direct unit test) */
      }

      const result = await runTurn(
        {
          profile,
          world,
          messages: args.messages,
          session,
          systemPrompt,
          role: args.role,
          maxTurns: profile.maxTurns,
          ...(resolvedAuth ? { resolvedAuth } : {}),
          // MCP servers the workflow gives its agents (SPEC §7.5).
          ...(args.task.workflow ? { agentMcp: manifest(args.task.workflow)?.agentMcp } : {}),
        },
        {
          adapters: deps.adapters,
          signal,
          heartbeat,
          onEmit: (t) => record(args.taskId, 'agent.output', { text: t }),
          ...(deps.payments
            ? {
                budget: new BudgetService(store, deps.payments),
                spendCtx: { projectId: args.task.projectId, taskId: args.taskId },
                onSpend: (req: any, outcome: any) => record(args.taskId, 'spend.requested', { ...req, status: outcome.status, reason: outcome.reason }),
              }
            : {}),
        },
      );
      if (token) deps.tokens?.revoke(token);
      // Persist the session id so other tasks can resume from this one (§10.5).
      if (result.session) store.kvSet(`session:${args.taskId}:${args.role}`, result.session);

      if (result.skills?.length) {
        for (const s of result.skills) record(args.taskId, 'skill.saved', { name: s.name });
      }
      record(args.taskId, 'turn.result', {
        completed: result.completed,
        subTasks: result.subTasks?.length ?? 0,
        hasReview: !!result.reviewInfo,
        output: result.output.slice(0, 2000),
      });
      return result;
    },

    /** Auto-derive review info from git so Review always shows what changed (§5.5). */
    async buildReview(handle: WorldHandle, base: string): Promise<{ summary: string; diff: string; changedFiles: string[] }> {
      const world = await worlds.open(handle);
      const root = handle.root;
      const { git } = await import('../world/git.js');
      const tracked = await git(root, ['diff', '--name-only', base]);
      const untracked = await git(root, ['ls-files', '--others', '--exclude-standard']);
      const changedFiles = [
        ...tracked.stdout.split('\n').map((s) => s.trim()).filter(Boolean),
        ...untracked.stdout.split('\n').map((s) => s.trim()).filter(Boolean).map((f) => `${f} (new)`),
      ];
      // intent-to-add so new files appear in the diff, then diff vs base (non-destructive).
      await git(root, ['add', '-AN']);
      const diffR = await git(root, ['diff', base]);
      const diff = diffR.stdout.slice(0, 20000);
      void world;
      const summary = changedFiles.length ? `${changedFiles.length} file(s) changed.` : 'No file changes detected.';
      record(handle.id, 'review.built', { files: changedFiles.length });
      return { summary, diff, changedFiles };
    },

    async finalizeMergeActivity(handle: WorldHandle, target: string): Promise<MergeResult> {
      const world = await worlds.open(handle);
      const result = await finalizeMerge(world, target);
      record(handle.id, 'merge.result', { merged: result.merged, sha: result.sha, conflict: result.conflict });
      return result;
    },

    async runScript(args: { taskId: string; worldHandle: WorldHandle; command: string }): Promise<{ code: number; output: string }> {
      const world = await worlds.open(args.worldHandle);
      record(args.taskId, 'script.start', { command: args.command });
      const r = await world.exec('bash', ['-lc', args.command], { timeoutMs: 30 * 60_000 });
      const output = `${r.stdout}${r.stderr}`;
      record(args.taskId, 'script.done', { code: r.code, output: output.slice(0, 4000) });
      return { code: r.code, output };
    },

    async runWorkflowChecks(args: { taskId: string; worldHandle: WorldHandle }): Promise<{ passed: boolean; detail?: string }> {
      const world = await worlds.open(args.worldHandle);
      const hasPkg = (await world.exec('bash', ['-lc', 'test -f package.json && echo yes || echo no'])).stdout.includes('yes');
      if (!hasPkg) {
        record(args.taskId, 'checks.skip', { reason: 'no package.json' });
        return { passed: true, detail: 'no test suite found' };
      }
      const r = await world.exec('bash', ['-lc', 'npm test --silent 2>&1 | tail -40'], { timeoutMs: 10 * 60_000 });
      record(args.taskId, 'checks.done', { code: r.code });
      return { passed: r.code === 0, detail: r.stdout.slice(-600) };
    },

    async commitWork(handle: WorldHandle, message: string): Promise<{ committed: boolean; sha?: string }> {
      const world = await worlds.open(handle);
      const r = await world.exec('bash', ['-lc', `git add -A && git commit -q -m ${JSON.stringify(message)} || true`]);
      const sha = await world.exec('git', ['rev-parse', 'HEAD']);
      record(handle.id, 'work.committed', { code: r.code });
      return { committed: r.code === 0, sha: sha.stdout.trim() || undefined };
    },

    async destroyWorld(handle: WorldHandle): Promise<void> {
      try {
        const world = await worlds.open(handle);
        await world.destroy();
        record(handle.id, 'world.destroyed', {});
      } catch {
        /* best effort */
      }
    },

    async openPr(handle: WorldHandle, target: string): Promise<{ url: string; number: number } | null> {
      // GitHub PRs are an optional integration (SPEC §5.2). Use `gh` if present
      // and authorized; otherwise the Review stage IS the conceptual PR.
      const world = await worlds.open(handle);
      const which = await world.exec('bash', ['-lc', 'command -v gh && gh auth status >/dev/null 2>&1 && echo ok || echo no']);
      if (!which.stdout.includes('ok')) {
        record(handle.id, 'pr.skipped', { reason: 'gh not available/authorized' });
        return null;
      }
      const push = await world.exec('git', ['push', '-u', 'origin', handle.branch]);
      if (push.code !== 0) {
        record(handle.id, 'pr.skipped', { reason: 'push failed', detail: push.stderr.slice(0, 300) });
        return null;
      }
      const pr = await world.exec('bash', [
        '-lc',
        `gh pr create --base ${target} --head ${handle.branch} --fill --json url,number 2>/dev/null || gh pr view --json url,number`,
      ]);
      try {
        const parsed = JSON.parse(pr.stdout);
        record(handle.id, 'pr.opened', parsed);
        return { url: parsed.url, number: parsed.number };
      } catch {
        return null;
      }
    },

    async publishView(taskId: string, view: TaskView): Promise<void> {
      store.saveView(taskId, view);
      record(taskId, 'view.updated', { stage: view.stage, status: view.status });
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
      });
      record(args.parentTaskId, 'subtask.created', { childTaskId: child.id, title: args.title });
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
      };
    },

    async autoResolve(args: { taskId: string; stage: string; error: string }): Promise<{ resolved: boolean; note?: string; action?: string }> {
      // Workflow-declared resolve rules (SPEC §5.2) take precedence over the defaults.
      const wf = store.getTask(args.taskId)?.workflow;
      const rules = wf ? manifest(wf)?.resolveRules : undefined;
      const r = runAutoResolve(args.stage, args.error, rules);
      record(args.taskId, 'resolve.auto', { stage: args.stage, resolved: r.resolved, action: r.action });
      return r;
    },

    /** Used by the gateway-side too; generates ids deterministically off the worker. */
    async newTaskId(): Promise<string> {
      return newId('task');
    },
  };
}

export type coreActivities = ReturnType<typeof makeCoreActivities>;

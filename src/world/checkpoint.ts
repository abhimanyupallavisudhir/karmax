import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { Context as activityContext } from '@temporalio/activity';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { WorldCheckpoint, WorldHandleRef } from '../domain/types.js';
import type { ObjectStore } from '../store/objects.js';
import type { Store } from '../store/db.js';
import type { World, WorldHandle, WorldKind, WorldRepo } from './types.js';
import { worldRepos, worldRepoSource } from './types.js';
import type { WorldRegistry } from './registry.js';
import { newId } from '../util/id.js';
import { activateProjectRuntime, selectProjectEnvironment, snapshotProjectRuntime } from './project-runtime.js';
import { destroyWorldServices } from './services.js';
import { RunnerPoolService } from './runners.js';
import { sameRepository } from './repository-identity.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
export const CHECKPOINT_KEY_HANDLE = 'checkpoint:encryption-key';

interface DeltaFile { repo: string; path: string; deleted?: boolean; data?: string }
interface PortableDelta { version: 1; files: DeltaFile[] }

/** How a restoring activity keeps its runner-lease wait alive and cancellable. */
export interface RestoreOptions { signal?: AbortSignal; heartbeat?: () => void }

/**
 * `restore` is only ever reached from inside an activity (the openWorld recovery
 * path, the registry recovery handler installed in main.ts, the hibernation wake),
 * so it resolves the runner-lease wait's signal/heartbeat from the **ambient**
 * activity context it already runs in. Outside an activity (tests, CLI)
 * `Context.current()` throws and we simply get no hooks — as before.
 *
 * Callers may override via `RestoreOptions`, but `recoverVanishedWorld`
 * deliberately does NOT thread its activity's signal in explicitly. Doing that
 * made `tests/pipeline.test.ts`'s parent/child cancellation test fail ~2 runs in
 * 3: the child was terminated "by parent close policy" instead of winding down as
 * `cancelled`. Recovery runs on teardown paths where that signal is *already
 * aborted*, and feeding an aborted signal into cleanup changes shutdown ordering.
 * The ambient lookup reaches the same context without that hazard — prefer it.
 * The parameter exists for tests and for any caller with a genuinely different
 * lifetime; measure before adding another explicit call site.
 */
function ambientActivityHooks(): RestoreOptions {
  try {
    const ctx = activityContext.current();
    return { signal: ctx.cancellationSignal, heartbeat: () => ctx.heartbeat({ waitingFor: 'world-capacity' }) };
  } catch {
    return {};
  }
}

/** Provider-independent disaster-recovery layer. Provider snapshots remain the
 * fast path; this encrypted delta plus the broker-pushed branch is portable. */
export class WorldCheckpointService {
  /** Restoring re-provisions a real (billable) sandbox, so it must pass through
   * the same durable admission as `createWorld`. `RunnerPoolService` is a thin
   * facade over the store — the lease queue in SQLite is the source of truth —
   * so it is constructed here by default rather than threaded through every
   * caller; tests may inject one. */
  private runners: RunnerPoolService;

  constructor(private store: Store, private worlds: WorldRegistry, private objects: ObjectStore,
    private broker: CredentialBroker, private githubApp?: import('../integrations/github-app.js').GitHubAppService,
    private resources?: import('./resources.js').ProjectResourceService, runners?: RunnerPoolService) {
    if (!broker.hasHandle(CHECKPOINT_KEY_HANDLE))
      broker.registerHandle(CHECKPOINT_KEY_HANDLE, crypto.randomBytes(32).toString('base64'));
    this.runners = runners ?? new RunnerPoolService(store);
  }

  async checkpoint(handleInput: WorldHandleRef): Promise<WorldCheckpoint> {
    const handle = (this.store.currentWorld(handleInput.id) ?? handleInput) as WorldHandle;
    this.store.assertCurrentWorld(handle);
    const projectId = String(handle.meta?.projectId ?? '');
    const project = this.store.getProject(projectId);
    if (!project?.organizationId) throw new Error('world checkpoint has no owning project');
    const world = await this.worlds.open(handle);
    const linked = this.store.listProjectRepositories(projectId);
    const files: DeltaFile[] = [];
    const repos: WorldCheckpoint['repos'] = [];
    const resourceRefs = await this.resources?.checkpoint(handle) ?? [];
    const ignored = await this.resources?.ignoredInventory(handle.id).catch(() => undefined);
    const resourcePaths = Object.values((handle.meta?.resourceProjections ?? {}) as Record<string, { target?: string }>)
      .map((projection) => projection.target).filter((value): value is string => Boolean(value));
    const ephemeralPaths = new Set(Array.isArray(handle.meta?.ephemeralPaths)
      ? handle.meta.ephemeralPaths.filter((value): value is string => typeof value === 'string')
      : []);
    for (const repo of worldRepos(world.handle)) {
      const status = await world.exec('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root });
      if (status.code !== 0) throw new Error(`could not inspect ${repo.name}: ${status.stderr || status.stdout}`);
      for (const change of parseStatus(status.stdout)) {
        const relative = worldRepos(world.handle).length > 1 ? `${repo.name}/${change.path}` : change.path;
        // Legacy copyGlobs and broker materializations are inputs, never project
        // data. Do not make them portable merely because they are untracked.
        if (change.path === '.env' || change.path.startsWith('.karmax-injection/') || ephemeralPaths.has(relative)
          || resourcePaths.some((target) => relative === target || relative.startsWith(`${target}/`))) continue;
        if (change.deleted) files.push({ repo: repo.name, path: change.path, deleted: true });
        else {
          const data = await world.readFileBuffer(relative);
          files.push({ repo: repo.name, path: change.path, data: data.toString('base64') });
        }
      }
      const head = await world.exec('git', ['rev-parse', 'HEAD'], { cwd: repo.root });
      const source = worldRepoSource(repo);
      const repository = linked.find((candidate) => sameRepository(candidate.repository.sshUrl, source))?.repository;
      repos.push({ repositoryId: repository?.id ?? `local:${sha256(Buffer.from(source)).slice(0, 24)}`,
        checkoutPath: worldRepos(world.handle).length > 1 ? repo.name : '.', baseSha: repo.baseSha ?? handle.base,
        branch: repo.branch, headSha: head.code === 0 ? head.stdout.trim() : undefined });
    }
    const delta: PortableDelta = { version: 1, files };
    const compressed = await gzip(Buffer.from(JSON.stringify(delta)));
    const encrypted = this.encrypt(compressed);
    const checkpointId = newId('checkpoint');
    const objectKey = `checkpoints/${project.organizationId}/${projectId}/${handle.id}/${checkpointId}.bin`;
    await this.objects.put(objectKey, encrypted);
    const checkpoint: WorldCheckpoint = {
      id: checkpointId, worldId: handle.id, generation: handle.generation ?? 1, projectId,
      runnerPoolId: handle.runnerPoolId ?? 'local', environmentDigest: handle.environmentDigest ?? 'karmax-local',
      repos, filesystemDelta: { objectKey, sha256: sha256(encrypted), bytes: encrypted.length },
      ...(resourceRefs.length ? { resources: resourceRefs } : {}),
      ...(ignored?.entries.length || ignored?.truncated ? { ignored } : {}),
      ...snapshotProjectRuntime(this.store, projectId),
      createdAt: Date.now(),
    };
    this.store.saveWorldCheckpoint(checkpoint);
    this.store.attachWorldCheckpoint(handle, checkpoint.id);
    this.store.recordUsage({ organizationId: project.organizationId, projectId, taskId: handle.id, worldId: handle.id,
      provider: handle.kind, kind: 'checkpoint.storage', quantity: encrypted.length, unit: 'byte-second', costMicros: 0,
      startedAt: checkpoint.createdAt, endedAt: checkpoint.createdAt,
      metadata: { checkpointId, generation: checkpoint.generation } });
    await this.resources?.scrubSecrets(handle);
    return checkpoint;
  }

  async restore(checkpointId: string, provider?: WorldKind, options?: RestoreOptions): Promise<WorldHandle> {
    const checkpoint = this.store.getWorldCheckpoint(checkpointId);
    if (!checkpoint?.filesystemDelta) throw new Error('checkpoint has no portable filesystem delta');
    const project = this.store.getProject(checkpoint.projectId);
    if (!project?.organizationId) throw new Error('checkpoint project no longer exists');
    const executionConfig = this.store.effectiveProjectConfig(project);
    const encrypted = await this.objects.get(checkpoint.filesystemDelta.objectKey);
    if (sha256(encrypted) !== checkpoint.filesystemDelta.sha256) throw new Error('checkpoint object hash mismatch');
    const delta = JSON.parse((await gunzip(this.decrypt(encrypted))).toString('utf8')) as PortableDelta;
    if (delta.version !== 1) throw new Error('unsupported checkpoint delta version');
    const repositories = checkpoint.repos.map((repo) => this.store.getRepository(repo.repositoryId));
    const sources = checkpoint.repos.map((repo, index) => repositories[index]?.sshUrl ?? project.config.repos?.[index]);
    if (sources.some((source) => !source)) throw new Error('checkpoint repository enrollment is missing');
    const selected = provider ?? executionConfig.worldProvider ?? 'worktree';
    const environment = selectProjectEnvironment(this.store, checkpoint.projectId, selected,
      executionConfig.environment, checkpoint.environment);
    const primary = checkpoint.repos[0];
    const linked = this.store.listProjectRepositories(checkpoint.projectId);
    const repositoryBranches = Object.fromEntries(linked.map((candidate) => {
      const base = candidate.baseBranch ?? candidate.repository.defaultBranch;
      return [candidate.repository.sshUrl, { base, target: candidate.targetBranch ?? base }];
    }));
    const cloneCredentials = this.githubApp && repositories.every(Boolean) ? Object.fromEntries(await Promise.all(
      repositories.map(async (repository) => [repository!.sshUrl, await this.githubApp!.repositoryCloneToken(repository!)]),
    )) : undefined;
    // Restoring PROVISIONS A REAL SANDBOX, so it must pass through the same
    // durable admission as createWorld (activities/core.ts): the runner lease is
    // what enforces the organization/project `monthlyBudgetMicros`, what produces
    // the `world.active` usage row cost attribution reads, and — via
    // `meta.worldLeaseId` — what `destroyWorld` later releases. Restore is reached
    // from the registry recovery handler (main.ts) and the hibernation wake, i.e.
    // exactly when a world is silently re-provisioned, so without this a
    // provider-billed sandbox was invisible to karmax and its capacity was never
    // returned. Local providers are unmetered and take no lease, matching
    // createWorld's `remote &&` guard.
    //
    // The lease acquisition polls until the pool has room, so it MUST carry the
    // caller's cancellation signal and heartbeat, exactly as the two call sites in
    // activities/core.ts do. Without the heartbeat a saturated pool blocks past the
    // activity heartbeat timeout; without the signal the killed activity strands a
    // `queued` lease row that nothing ever releases, permanently eating capacity.
    const remote = this.worlds.get(selected).capabilities?.remote === true;
    const hooks = options ?? ambientActivityHooks();
    const acquired = remote
      ? await this.runners.acquire({ project, taskId: checkpoint.worldId, worldId: checkpoint.worldId,
        provider: selected, priority: Number(this.store.getTask(checkpoint.worldId)?.params.priority ?? 0),
        signal: hooks.signal, heartbeat: hooks.heartbeat })
      : undefined;
    let world: World;
    try {
      world = await this.worlds.create(selected, { taskId: checkpoint.worldId,
        repos: sources as string[], base: project.config.defaultBase ?? 'main', target: project.config.defaultTarget,
        branch: primary?.branch, ...(cloneCredentials ? { gitCredentials: { httpsTokens: cloneCredentials } } : {}),
        ...(Object.keys(repositoryBranches).length ? { repositoryBranches } : {}),
        network: executionConfig.network, environment: environment.environment, resources: executionConfig.resources });
    } catch (error) {
      if (acquired) this.runners.release(acquired.leaseId, selected);
      throw error;
    }
    try {
      if (this.resources) {
        const revisions = Object.fromEntries((checkpoint.resources ?? []).map((resource) => [resource.attachmentId, resource.revisionId]));
        world.handle = await this.resources.materialize(checkpoint.projectId, checkpoint.worldId, world,
          checkpoint.generation + 1, revisions);
      }
      for (const file of delta.files) {
        const relative = checkpoint.repos.length > 1 ? `${file.repo}/${file.path}` : file.path;
        if (file.deleted) await world.exec('rm', ['-f', file.path], { cwd: worldRepos(world.handle).find((repo) => repo.name === file.repo)?.root });
        else {
          const content = Buffer.from(file.data ?? '', 'base64');
          if (world.writeFileBuffer) await world.writeFileBuffer(relative, content);
          else await world.writeFile(relative, content.toString('utf8'));
        }
      }
      const runtime = await activateProjectRuntime({ world, store: this.store, projectId: checkpoint.projectId,
        taskId: checkpoint.worldId, selection: environment, resources: this.resources,
        services: checkpoint.services, runSetupIfUnbuilt: true });
      world.handle = runtime.handle;
      if (runtime.warnings.length)
        world.handle.warnings = [...(world.handle.warnings ?? []), ...runtime.warnings];
      // Stamped exactly as createWorld does, so `destroyWorld` finds the lease to
      // release and the world's cost is attributed to the right pool.
      if (acquired) world.handle.meta = { ...world.handle.meta, worldLeaseId: acquired.leaseId };
      const registered = this.store.registerWorld({ ...world.handle, checkpointId }, checkpoint.projectId,
        { runnerPoolId: acquired?.runnerPoolId ?? checkpoint.runnerPoolId,
          environmentDigest: environment.digest ?? checkpoint.environmentDigest }) as WorldHandle;
      world.handle = registered;
      return registered;
    } catch (error) {
      await this.resources?.release(world.handle).catch(() => undefined);
      await destroyWorldServices(checkpoint.worldId).catch(() => undefined);
      await world.destroy().catch(() => undefined);
      if (acquired) this.runners.release(acquired.leaseId, selected);
      throw error;
    }
  }

  private key(): Buffer {
    return Buffer.from(this.broker.resolve(CHECKPOINT_KEY_HANDLE, { caps: [`use-credential:${CHECKPOINT_KEY_HANDLE}`] }), 'base64');
  }

  private encrypt(plain: Buffer): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(), iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from('KMX1'), iv, cipher.getAuthTag(), body]);
  }

  private decrypt(blob: Buffer): Buffer {
    if (blob.subarray(0, 4).toString() !== 'KMX1') throw new Error('invalid checkpoint envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(), blob.subarray(4, 16));
    decipher.setAuthTag(blob.subarray(16, 32));
    return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
  }
}

function parseStatus(value: string): Array<{ path: string; deleted: boolean }> {
  const parts = value.split('\0').filter(Boolean);
  const out: Array<{ path: string; deleted: boolean }> = [];
  for (let i = 0; i < parts.length; i++) {
    const row = parts[i]!;
    const status = row.slice(0, 2);
    const path = row.slice(3);
    const original = status.includes('R') || status.includes('C') ? parts[++i] : undefined;
    if (status.includes('R') && safeDeltaPath(original)) out.push({ path: original!, deleted: true });
    if (safeDeltaPath(path)) out.push({ path, deleted: status.includes('D') });
  }
  return out;
}

function safeDeltaPath(value: string | undefined): value is string {
  return Boolean(value && !value.split('/').includes('..') && !value.startsWith('/'));
}

function sha256(value: Buffer): string { return crypto.createHash('sha256').update(value).digest('hex'); }

import { readCheckpointFiles } from './checkpoint-read.js';
import * as __asyncCollections from '../util/async-collections.js';
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

import type { PortableDelta } from './checkpoint-encoding.js';
import { encodeEncryptedCheckpoint, type CheckpointFile } from './checkpoint-executor.js';
const gunzip = promisify(zlib.gunzip);
const MAX_CHECKPOINT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 128 * 1024 * 1024;
const MAX_CHECKPOINT_JSON_BYTES = 192 * 1024 * 1024;
export const CHECKPOINT_KEY_HANDLE = 'checkpoint:encryption-key';


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
    this.runners = runners ?? new RunnerPoolService(store);
  }

  async checkpoint(handleInput: WorldHandleRef, options: { scrubSecrets?: boolean; checkContinue?: () => Promise<void> } = {}): Promise<WorldCheckpoint> {
    return this.worlds.withOperation(handleInput.id, async () => {
    await this.store.pruneWorldCheckpoints(handleInput.id);
    await options.checkContinue?.();
    const handle = ((await this.store.currentWorld(handleInput.id)) ?? handleInput) as WorldHandle;
    (await this.store.assertCurrentWorld(handle));
    const projectId = String(handle.meta?.projectId ?? '');
    const project = (await this.store.getProject(projectId));
    if (!project?.organizationId) throw new Error('world checkpoint has no owning project');
    const world = await this.worlds.open(handle);
    const linked = (await this.store.listProjectRepositories(projectId));
    const organizationRepositories = (await this.store.listRepositories(project.organizationId));
    const files: Array<{ repo: string; path: string; deleted?: boolean; readPath?: string }> = [];
    const repos: WorldCheckpoint['repos'] = [];
    const resourceRefs = await this.resources?.checkpoint(handle, options.checkContinue) ?? [];
    await options.checkContinue?.();
    const ignored = await this.resources?.ignoredInventory(handle.id, 100, options.checkContinue).catch(async () => {
      await options.checkContinue?.();
      return undefined;
    });
    const resourcePaths = Object.values((handle.meta?.resourceProjections ?? {}) as Record<string, { target?: string }>)
      .map((projection) => projection.target).filter((value): value is string => Boolean(value));
    const ephemeralPaths = new Set(Array.isArray(handle.meta?.ephemeralPaths)
      ? handle.meta.ephemeralPaths.filter((value): value is string => typeof value === 'string')
      : []);
    for (const repo of worldRepos(world.handle)) {
      await options.checkContinue?.();
      const status = await world.exec('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: repo.root });
      if (status.code !== 0) throw new Error(`could not inspect ${repo.name}: ${status.stderr || status.stdout}`);
      for (const change of parseStatus(status.stdout)) {
        const relative = repo.root === world.handle.root ? change.path : `${repo.name}/${change.path}`;
        // Legacy copyGlobs and broker materializations are inputs, never project
        // data. Do not make them portable merely because they are untracked.
        if (change.path === '.env' || change.path.startsWith('.karmax-injection/') || ephemeralPaths.has(relative)
          || resourcePaths.some((target) => relative === target || relative.startsWith(`${target}/`))) continue;
        if (change.deleted) files.push({ repo: repo.name, path: change.path, deleted: true });
        else {
          files.push({ repo: repo.name, path: change.path, readPath: relative });
        }
      }
      const head = await world.exec('git', ['rev-parse', 'HEAD'], { cwd: repo.root });
      const source = worldRepoSource(repo);
      const name = await world.exec('git', ['config', 'user.name'], { cwd: repo.root });
      const email = await world.exec('git', ['config', 'user.email'], { cwd: repo.root });
      const repository = linked.find((candidate) => sameRepository(candidate.repository.sshUrl, source))?.repository
        ?? organizationRepositories.find((candidate) => sameRepository(candidate.sshUrl, source));
      repos.push({ repositoryId: repository?.id ?? `local:${sha256(Buffer.from(source)).slice(0, 24)}`, source,
        checkoutPath: repo.root === world.handle.root ? '.' : repo.name,
        ...(repo.localPath ? { localPath: repo.localPath } : {}),
        ...(repo.sourceAuthority ? { sourceAuthority: repo.sourceAuthority } : {}),
        ...(name.code === 0 && email.code === 0 ? { gitIdentity: { name: name.stdout.trim(), email: email.stdout.trim() } } : {}), baseSha: repo.baseSha ?? handle.base,
        branch: repo.branch, headSha: head.code === 0 ? head.stdout.trim() : undefined,
        base: repo.base, ...(repo.target ? { target: repo.target } : {}),
        ...(repo.targetPinned !== undefined ? { targetPinned: repo.targetPinned } : {}),
        ...(repo.role ? { role: repo.role } : {}) });
    }
    // A repositoryless task still owns ordinary output files. Resource-backed
    // paths have their own revisions; injected credentials are never outputs.
    if (!worldRepos(world.handle).length) {
      for (const file of await world.listFiles()) {
        if (!safeDeltaPath(file) || file === '.env' || file.startsWith('.karmax-injection/')
          || ephemeralPaths.has(file)
          || resourcePaths.some((target) => target === '.' || file === target || file.startsWith(`${target}/`))) continue;
        files.push({ repo: '', path: file, readPath: file });
      }
    }
    if (files.length > 100_000) throw new Error('checkpoint file count limit exceeded');
    const paths = files.flatMap(file => file.readPath === undefined ? [] : [file.readPath]);
    let expectedBytes = 0;
    const fileSizes = new Map<string, number>();
    for (let offset = 0; offset < paths.length; offset += 128) {
      const batch = paths.slice(offset, offset + 128);
      const stat = await world.exec('stat', ['-c', '%s', '--', ...batch], { cwd: world.handle.root });
      const sizes = stat.stdout.trim().split('\n').map(Number);
      if (stat.code !== 0 || sizes.length !== batch.length || sizes.some(size => !Number.isSafeInteger(size) || size < 0))
        throw new Error('could not size checkpoint files');
      if (sizes.some(size => size > MAX_CHECKPOINT_FILE_BYTES)) throw new Error('checkpoint file limit exceeded');
      batch.forEach((file, index) => fileSizes.set(file, sizes[index]!));
      expectedBytes += sizes.reduce((sum, size) => sum + size, 0);
      if (expectedBytes > MAX_CHECKPOINT_BYTES) throw new Error('checkpoint total size limit exceeded');
    }
    const metadataBytes = files.reduce((sum, file) => sum + Buffer.byteLength(JSON.stringify(file)), 0);
    if (metadataBytes + Math.ceil(expectedBytes / 3) * 4 + files.length * 8 > MAX_CHECKPOINT_JSON_BYTES)
      throw new Error('checkpoint JSON size limit exceeded');
    async function* contents(): AsyncGenerator<CheckpointFile> {
      for (const { readPath, ...file } of files) if (readPath === undefined) yield file;
      const byPath = new Map(files.flatMap(file => file.readPath === undefined ? [] : [[file.readPath, file] as const]));
      for await (const { path, data } of readCheckpointFiles(world, fileSizes, options.checkContinue)) {
        const { readPath, ...file } = byPath.get(path)!;
        yield { ...file, data };
      }
    }
    const { encrypted, sha256: digest } = await encodeEncryptedCheckpoint(contents(), await this.key());
    await options.checkContinue?.();
    const checkpointId = newId('checkpoint');
    const objectKey = `checkpoints/${project.organizationId}/${projectId}/${handle.id}/${checkpointId}.bin`;
    const managedStorage = (await this.store.listStorageLocations(project.organizationId))
      .find((location) => location.kind === 'managed');
    if (managedStorage) (await this.store.reserveStorageUpload(`checkpoint:${checkpointId}`, project.organizationId,
      managedStorage.id, encrypted.length, Date.now() + 60 * 60_000));
    try { await this.objects.put(objectKey, encrypted); }
    catch (error) {
      if (managedStorage) (await this.store.releaseStorageUpload(`checkpoint:${checkpointId}`));
      throw error;
    }
    const checkpoint: WorldCheckpoint = {
      id: checkpointId, worldId: handle.id, generation: handle.generation ?? 1, projectId,
      runnerPoolId: handle.runnerPoolId ?? 'local', environmentDigest: handle.environmentDigest ?? 'karmax-local',
      repos, filesystemDelta: { objectKey, sha256: digest, bytes: encrypted.length },
      ...(resourceRefs.length ? { resources: resourceRefs } : {}),
      ...(ignored?.entries.length || ignored?.truncated ? { ignored } : {}),
      ...(await snapshotProjectRuntime(this.store, projectId)),
      createdAt: Date.now(),
    };
    try { (await this.store.saveWorldCheckpoint(checkpoint)); }
    catch (error) { await this.objects.delete(objectKey).catch(() => undefined); throw error; }
    finally { if (managedStorage) (await this.store.releaseStorageUpload(`checkpoint:${checkpointId}`)); }
    (await this.store.attachWorldCheckpoint(handle, checkpoint.id));
    (await this.store.recordUsage({ organizationId: project.organizationId, projectId, taskId: handle.id, worldId: handle.id,
      provider: handle.kind, kind: 'checkpoint.storage', quantity: encrypted.length, unit: 'byte', costMicros: 0,
      fundingSource: 'managed',
      startedAt: checkpoint.createdAt, endedAt: checkpoint.createdAt,
      metadata: { checkpointId, generation: checkpoint.generation } }));
    await options.checkContinue?.();
    if (options.scrubSecrets !== false) await this.resources?.scrubSecrets(handle);
    await this.store.pruneWorldCheckpoints(handle.id);
    await this.collectGarbage(handle.id);
    return checkpoint;
    });
  }

  async collectGarbage(onlyWorldId?: string): Promise<void> {
    for (const pending of (await this.store.kvEntries('checkpoint-gc:')).slice(0, 100)) {
      try {
        const { worldId, objectKey } = JSON.parse(pending.value);
        if (onlyWorldId && worldId !== onlyWorldId) continue;
        await this.worlds.withOperation(worldId, async () => {
          await this.objects.delete(objectKey);
          await this.store.completeCheckpointDeletion(pending.key.slice('checkpoint-gc:'.length));
        });
      } catch { /* retry from the lifecycle sweep */ }
    }
  }

  async restore(checkpointId: string, provider?: WorldKind, options?: RestoreOptions): Promise<WorldHandle> {
    const checkpoint = (await this.store.getWorldCheckpoint(checkpointId));
    if (!checkpoint?.filesystemDelta) throw new Error('checkpoint has no portable filesystem delta');
    const filesystemDelta = checkpoint.filesystemDelta;
    return this.worlds.withOperation(checkpoint.worldId, async () => {
    const project = (await this.store.getProject(checkpoint.projectId));
    if (!project?.organizationId) throw new Error('checkpoint project no longer exists');
    const executionConfig = (await this.store.effectiveProjectConfig(project));
    if (filesystemDelta.bytes > MAX_CHECKPOINT_JSON_BYTES) throw new Error('checkpoint object size limit exceeded');
    const encrypted = await this.objects.get(filesystemDelta.objectKey);
    if (sha256(encrypted) !== filesystemDelta.sha256) throw new Error('checkpoint object hash mismatch');
    const delta = JSON.parse((await gunzip(await this.decrypt(encrypted), { maxOutputLength: MAX_CHECKPOINT_JSON_BYTES })).toString('utf8')) as PortableDelta;
    if (delta.version !== 1) throw new Error('unsupported checkpoint delta version');
    // A checkpoint must be restorable after its sandbox disappears even when a
    // checkout is not a normal project enrollment (the project wiki is the
    // important example), or when project repository settings change later.
    // New manifests pin their source directly. For manifests written before
    // that field existed, the durable handle still contains the exact checkout
    // list used to create the vanished generation; project config is the final
    // compatibility fallback for still older single-repo handles.
    const previousHandle = (await this.store.currentWorld(checkpoint.worldId)) as WorldHandle | undefined;
    const previousRepos = previousHandle ? worldRepos(previousHandle) : [];
    const previousFor = (repo: WorldCheckpoint['repos'][number], index: number) =>
      repo.checkoutPath === '.' ? previousRepos[index]
        : previousRepos.find((candidate) => candidate.name === repo.checkoutPath) ?? previousRepos[index];
    const sources = (await __asyncCollections.map(checkpoint.repos, async (repo, index) => repo.source ?? (await this.store.getRepository(repo.repositoryId))?.sshUrl ?? (previousFor(repo, index) ? worldRepoSource(previousFor(repo, index)!) : undefined)
      ?? project.config.repos?.[index]));
    if (sources.some((source) => !source)) throw new Error('checkpoint repository enrollment is missing');
    const organizationRepositories = (await this.store.listRepositories(project.organizationId));
    const repositories = (await __asyncCollections.map(checkpoint.repos, async (repo, index) => (await this.store.getRepository(repo.repositoryId))
      ?? organizationRepositories.find((candidate) => sameRepository(candidate.sshUrl, sources[index]!))));
    const selected = provider ?? executionConfig.worldProvider ?? 'worktree';
    const environment = (await selectProjectEnvironment(this.store, checkpoint.projectId, selected,
      executionConfig.environment, checkpoint.environment));
    const primary = checkpoint.repos[0];
    const linked = (await this.store.listProjectRepositories(checkpoint.projectId));
    const repositoryBranches = Object.fromEntries(checkpoint.repos.map((repo, index) => {
      const source = sources[index]!;
      const previous = previousFor(repo, index);
      const enrolled = linked.find((candidate) => sameRepository(candidate.repository.sshUrl, source));
      const base = repo.base ?? previous?.base ?? enrolled?.baseBranch
        ?? enrolled?.repository.defaultBranch ?? project.config.defaultBase ?? 'main';
      return [source, { base, target: repo.target ?? previous?.target ?? enrolled?.targetBranch ?? base }];
    }));
    const credentialEntries = this.githubApp ? await Promise.all(repositories.flatMap((repository, index) => repository
      ? [this.githubApp!.repositoryCloneToken(repository).then((token) => [sources[index]!, token] as const)]
      : [])) : [];
    const cloneCredentials = credentialEntries.length ? Object.fromEntries(credentialEntries) : undefined;
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
    const previousLeaseId = previousHandle?.meta?.worldLeaseId;
    if (remote && typeof previousLeaseId === 'string') {
      const previousLease = await this.store.worldLease(previousLeaseId);
      if (previousLease?.worldId === checkpoint.worldId && previousLease.taskId === checkpoint.worldId)
        await this.runners.release(previousLeaseId, previousHandle!.provider ?? previousHandle!.kind);
    }
    const acquired = remote
      ? await this.runners.acquire({ project, taskId: checkpoint.worldId, worldId: checkpoint.worldId,
        provider: selected, priority: Number((await this.store.getTask(checkpoint.worldId))?.params.priority ?? 0),
        signal: hooks.signal, heartbeat: hooks.heartbeat })
      : undefined;
    let world: World;
    try {
      // Recovery is a new provider allocation, just like createWorld: tenant
      // identity selects the organization-owned credential, while generation
      // keeps the provider's idempotency lookup away from the vanished sandbox.
      world = await this.worlds.create(selected, { taskId: checkpoint.worldId,
        generation: checkpoint.generation + 1, organizationId: project.organizationId,
        repos: sources as string[],
        ...(checkpoint.repos.some(repo => repo.checkoutPath !== '.') ? { layout: 'nested' } : {}),
        copySources: checkpoint.repos.map((repo, index) => repo.localPath ?? previousFor(repo, index)?.localPath),
        checkouts: checkpoint.repos.map((repo, index) => ({
          name: repo.checkoutPath === '.' ? previousFor(repo, index)?.name ?? 'repo' : repo.checkoutPath,
          branch: repo.branch, base: repo.base ?? previousFor(repo, index)?.base ?? project.config.defaultBase ?? 'main',
          target: repo.target ?? previousFor(repo, index)?.target,
          sourceAuthority: repo.sourceAuthority ?? previousFor(repo, index)?.sourceAuthority,
          gitIdentity: repo.gitIdentity,
        })), base: project.config.defaultBase ?? 'main', target: project.config.defaultTarget,
        branch: primary?.branch, ...(cloneCredentials ? { gitCredentials: { httpsTokens: cloneCredentials } } : {}),
        ...(Object.keys(repositoryBranches).length ? { repositoryBranches } : {}),
        network: executionConfig.network, environment: environment.environment, resources: executionConfig.resources });
    } catch (error) {
      if (acquired) (await this.runners.release(acquired.leaseId, selected));
      throw error;
    }
    try {
      for (const [index, restoredRepo] of worldRepos(world.handle).entries()) {
        const manifestRepo = checkpoint.repos[index];
        const previous = manifestRepo ? previousFor(manifestRepo, index) : undefined;
        const role = manifestRepo?.role ?? previous?.role;
        if (role) restoredRepo.role = role;
        const targetPinned = manifestRepo?.targetPinned ?? previous?.targetPinned;
        if (targetPinned !== undefined) restoredRepo.targetPinned = targetPinned;
      }
      const developmentRepos = worldRepos(world.handle).filter((repo) => repo.role !== 'project-wiki');
      world.handle.workdir = developmentRepos.length === 1 ? developmentRepos[0]!.root : world.handle.root;
      if (this.resources) {
        const revisions = Object.fromEntries((checkpoint.resources ?? []).map((resource) => [resource.attachmentId, resource.revisionId]));
        world.handle = await this.resources.materialize(checkpoint.projectId, checkpoint.worldId, world,
          checkpoint.generation + 1, revisions);
      }
      for (const file of delta.files) {
        const checkout = checkpoint.repos.find(repo => repo.checkoutPath === file.repo) ?? checkpoint.repos[0];
        const relative = checkout && checkout.checkoutPath !== '.' ? `${checkout.checkoutPath}/${file.path}` : file.path;
        if (file.deleted) {
          const removed = await world.exec('rm', ['-f', '--', file.path], { cwd: worldRepos(world.handle).find((repo) => repo.name === file.repo)?.root });
          if (removed.code !== 0) throw new Error(`could not restore deletion: ${file.path}`);
        }
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
      const registered = (await this.store.registerWorld({ ...world.handle, checkpointId }, checkpoint.projectId,
        { runnerPoolId: acquired?.runnerPoolId ?? checkpoint.runnerPoolId,
          environmentDigest: environment.digest ?? checkpoint.environmentDigest })) as WorldHandle;
      world.handle = registered;
      return registered;
    } catch (error) {
      await this.resources?.release(world.handle).catch(() => undefined);
      await destroyWorldServices(checkpoint.worldId).catch(() => undefined);
      await world.destroy().catch(() => undefined);
      if (acquired) (await this.runners.release(acquired.leaseId, selected));
      throw error;
    }
    });
  }

  /** Apply saved work to a freshly provisioned, independent task. Never registers
   * a new generation of the source world or reuses its branches/resource leases. */
  async applyFork(checkpointId: string, world: World, projectId: string,
    options: { signal?: AbortSignal } = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const checkpoint = (await this.store.getWorldCheckpoint(checkpointId));
    if (!checkpoint?.filesystemDelta || checkpoint.projectId !== projectId)
      throw new Error('fork checkpoint is unavailable in this project');
    if (checkpoint.worldId === world.handle.id) throw new Error('fork requires an independent world');
    if (checkpoint.filesystemDelta.bytes > MAX_CHECKPOINT_JSON_BYTES) throw new Error('checkpoint object size limit exceeded');
    const encrypted = await this.objects.get(checkpoint.filesystemDelta.objectKey);
    if (sha256(encrypted) !== checkpoint.filesystemDelta.sha256) throw new Error('checkpoint object hash mismatch');
    const delta = JSON.parse((await gunzip(await this.decrypt(encrypted), { maxOutputLength: MAX_CHECKPOINT_JSON_BYTES })).toString('utf8')) as PortableDelta;
    if (delta.version !== 1) throw new Error('unsupported checkpoint delta version');
    const destinations = new Map<string, WorldRepo>();
    for (const repo of checkpoint.repos) {
      options.signal?.throwIfAborted();
      let destination = worldRepos(world.handle).find((candidate) =>
        repo.source && sameRepository(worldRepoSource(candidate), repo.source)
        && (repo.checkoutPath === '.' || candidate.name === repo.checkoutPath));
      if (!destination && repo.headSha && repo.checkoutPath !== '.' && world.addCheckout) {
        const from = worldRepos(world.handle).find(candidate => repo.source && sameRepository(worldRepoSource(candidate), repo.source));
        if (from) {
          world.handle = await world.addCheckout({ name: repo.checkoutPath, from: from.name,
            base: repo.headSha, target: repo.target });
          destination = worldRepos(world.handle).find(candidate => candidate.name === repo.checkoutPath);
          if (destination) {
            destination.base = repo.branch;
            destination.role = repo.role;
            destination.targetPinned = repo.targetPinned;
            destination.sourceAuthority = repo.sourceAuthority ?? from.sourceAuthority;
          }
        }
      }
      if (!destination || !repo.headSha) throw new Error(`fork checkout is unavailable: ${repo.checkoutPath}`);
      if (destination.branch === repo.branch) throw new Error('fork cannot reuse a source branch');
      const reset = await world.exec('git', ['reset', '--hard', repo.headSha], { cwd: destination.root });
      if (reset.code !== 0) throw new Error(`fork commit ${repo.headSha} is unavailable: ${reset.stderr}`);
      destination.baseSha = repo.headSha;
      destinations.set(repo.checkoutPath === '.' ? worldRepos(world.handle)[0]!.name : repo.checkoutPath, destination);
      // Single-repo legacy deltas store the checkout name even though the manifest says '.'.
      if (checkpoint.repos.length === 1) for (const file of delta.files) destinations.set(file.repo, destination);
    }
    for (const file of delta.files) {
      options.signal?.throwIfAborted();
      const repo = destinations.get(file.repo);
      const plain = checkpoint.repos.length === 0 && file.repo === '' && worldRepos(world.handle).length === 0;
      if ((!repo && !plain) || !safeDeltaPath(file.path)) throw new Error('invalid fork delta path');
      const relative = repo && repo.root !== world.handle.root ? `${repo.name}/${file.path}` : file.path;
      if (file.deleted) {
        const removed = await world.exec('rm', ['-f', '--', file.path], { cwd: repo?.root ?? world.handle.root });
        if (removed.code !== 0) throw new Error(`could not restore deletion: ${file.path}`);
      } else {
        const content = Buffer.from(file.data ?? '', 'base64');
        if (world.writeFileBuffer) await world.writeFileBuffer(relative, content);
        else await world.writeFile(relative, content.toString('utf8'));
      }
    }
    options.signal?.throwIfAborted();
  }

  private async key(): Promise<Buffer> {
    if (!this.broker.hasHandle(CHECKPOINT_KEY_HANDLE))
      await this.broker.ensureHandle(CHECKPOINT_KEY_HANDLE, crypto.randomBytes(32).toString('base64'));
    return Buffer.from(this.broker.resolve(CHECKPOINT_KEY_HANDLE, { caps: [`use-credential:${CHECKPOINT_KEY_HANDLE}`] }), 'base64');
  }

  private async decrypt(blob: Buffer): Promise<Buffer> {
    if (blob.subarray(0, 4).toString() !== 'KMX1') throw new Error('invalid checkpoint envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', await this.key(), blob.subarray(4, 16));
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

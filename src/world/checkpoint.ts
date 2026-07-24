import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { WorldCheckpoint, WorldHandleRef } from '../domain/types.js';
import type { ObjectStore } from '../store/objects.js';
import type { Store } from '../store/db.js';
import type { World, WorldHandle, WorldKind, WorldRepo } from './types.js';
import { worldRepos, worldRepoSource } from './types.js';
import type { WorldRegistry } from './registry.js';
import { newId } from '../util/id.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
export const CHECKPOINT_KEY_HANDLE = 'checkpoint:encryption-key';

interface DeltaFile { repo: string; path: string; deleted?: boolean; data?: string }
interface PortableDelta { version: 1; files: DeltaFile[] }

/** Provider-independent disaster-recovery layer. Provider snapshots remain the
 * fast path; this encrypted delta plus the broker-pushed branch is portable. */
export class WorldCheckpointService {
  constructor(private store: Store, private worlds: WorldRegistry, private objects: ObjectStore,
    private broker: CredentialBroker, private githubApp?: import('../integrations/github-app.js').GitHubAppService,
    private resources?: import('./resources.js').ProjectResourceService) {
    if (!broker.hasHandle(CHECKPOINT_KEY_HANDLE))
      broker.registerHandle(CHECKPOINT_KEY_HANDLE, crypto.randomBytes(32).toString('base64'));
  }

  async checkpoint(handleInput: WorldHandleRef): Promise<WorldCheckpoint> {
    const handle = (this.store.currentWorld(handleInput.id) ?? handleInput) as WorldHandle;
    this.store.assertCurrentWorld(handle);
    const projectId = String(handle.meta?.projectId ?? '');
    const project = this.store.getProject(projectId);
    if (!project?.organizationId) throw new Error('world checkpoint has no owning project');
    const world = await this.worlds.open(handle);
    const linked = this.store.listProjectRepositories(projectId);
    const fileMap = new Map<string, DeltaFile>();
    const repos: WorldCheckpoint['repos'] = [];
    const secretPaths = new Set((this.resources?.secretPaths(handle.id, world) ?? [])
      .map((entry) => `${entry.repo}:${entry.path}`));
    for (const repo of worldRepos(world.handle)) {
      const status = await world.exec('git', ['status', '--porcelain=v1', '-z'], { cwd: repo.root });
      if (status.code !== 0) throw new Error(`could not inspect ${repo.name}: ${status.stderr || status.stdout}`);
      for (const change of parseStatus(status.stdout)) {
        if (change.path === '.env' || change.path.startsWith('.karmax-injection/')
          || secretPaths.has(`${repo.name}:${change.path}`)) continue;
        const relative = worldRepos(world.handle).length > 1 ? `${repo.name}/${change.path}` : change.path;
        if (change.deleted) fileMap.set(`${repo.name}:${change.path}`, { repo: repo.name, path: change.path, deleted: true });
        else {
          const data = await world.readFileBuffer(relative);
          fileMap.set(`${repo.name}:${change.path}`, { repo: repo.name, path: change.path, data: data.toString('base64') });
        }
      }
      const head = await world.exec('git', ['rev-parse', 'HEAD'], { cwd: repo.root });
      const source = worldRepoSource(repo);
      const repository = linked.find((candidate) => candidate.repository.sshUrl === source)?.repository;
      repos.push({ repositoryId: repository?.id ?? `local:${sha256(Buffer.from(source)).slice(0, 24)}`,
        checkoutPath: worldRepos(world.handle).length > 1 ? repo.name : '.', baseSha: repo.baseSha ?? handle.base,
        branch: repo.branch, headSha: head.code === 0 ? head.stdout.trim() : undefined });
    }
    // Git intentionally hides ignored files. Explicitly mutable project inputs
    // (including task-local SQLite databases) are part of task state anyway.
    for (const entry of this.resources?.mutablePaths(handle.id, world) ?? []) {
      const data = await this.resources!.snapshotMutable(handle.id, world, entry);
      if (data) {
        fileMap.set(`${entry.repo}:${entry.path}`, {
          repo: entry.repo, path: entry.path, data: data.toString('base64'),
        });
      } else {
        fileMap.set(`${entry.repo}:${entry.path}`, { repo: entry.repo, path: entry.path, deleted: true });
      }
    }
    const delta: PortableDelta = { version: 1, files: [...fileMap.values()] };
    const compressed = await gzip(Buffer.from(JSON.stringify(delta)));
    const encrypted = this.encrypt(compressed);
    const checkpointId = newId('checkpoint');
    const objectKey = `checkpoints/${project.organizationId}/${projectId}/${handle.id}/${checkpointId}.bin`;
    await this.objects.put(objectKey, encrypted);
    const checkpoint: WorldCheckpoint = {
      id: checkpointId, worldId: handle.id, generation: handle.generation ?? 1, projectId,
      runnerPoolId: handle.runnerPoolId ?? 'local', environmentDigest: handle.environmentDigest ?? 'karmax-local',
      repos, filesystemDelta: { objectKey, sha256: sha256(encrypted), bytes: encrypted.length }, createdAt: Date.now(),
    };
    this.store.saveWorldCheckpoint(checkpoint);
    this.store.attachWorldCheckpoint(handle, checkpoint.id);
    this.store.recordUsage({ organizationId: project.organizationId, projectId, taskId: handle.id, worldId: handle.id,
      provider: handle.kind, kind: 'checkpoint.storage', quantity: encrypted.length, unit: 'byte-second', costMicros: 0,
      startedAt: checkpoint.createdAt, endedAt: checkpoint.createdAt,
      metadata: { checkpointId, generation: checkpoint.generation } });
    return checkpoint;
  }

  async restore(checkpointId: string, provider?: WorldKind): Promise<WorldHandle> {
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
    const primary = checkpoint.repos[0];
    const linked = this.store.listProjectRepositories(checkpoint.projectId);
    const repositoryBranches = Object.fromEntries(linked.map((candidate) => {
      const base = candidate.baseBranch ?? candidate.repository.defaultBranch;
      return [candidate.repository.sshUrl, { base, target: candidate.targetBranch ?? base }];
    }));
    const cloneCredentials = this.githubApp && repositories.every(Boolean) ? Object.fromEntries(repositories.map((repository) =>
      [repository!.sshUrl, this.githubApp!.repositorySshKey(repository!.id, 'clone')])) : undefined;
    const world = await this.worlds.create(selected, { taskId: checkpoint.worldId,
      repos: sources as string[], base: project.config.defaultBase ?? 'main', target: project.config.defaultTarget,
      branch: primary?.branch, ...(cloneCredentials ? { gitCredentials: { repositories: cloneCredentials } } : {}),
      ...(Object.keys(repositoryBranches).length ? { repositoryBranches } : {}),
      network: executionConfig.network, environment: executionConfig.environment, resources: executionConfig.resources });
    try {
      if (this.resources) await this.resources.materialize(checkpoint.worldId, checkpoint.projectId, world);
      for (const file of delta.files) {
        const relative = checkpoint.repos.length > 1 ? `${file.repo}/${file.path}` : file.path;
        if (file.deleted) await world.exec('rm', ['-f', file.path], { cwd: worldRepos(world.handle).find((repo) => repo.name === file.repo)?.root });
        else {
          const content = Buffer.from(file.data ?? '', 'base64');
          if (world.writeFileBuffer) await world.writeFileBuffer(relative, content);
          else await world.writeFile(relative, content.toString('utf8'));
        }
      }
      if (this.resources) await this.resources.runSetup(checkpoint.worldId, checkpoint.projectId, world);
      const registered = this.store.registerWorld({ ...world.handle, checkpointId }, checkpoint.projectId,
        { runnerPoolId: checkpoint.runnerPoolId, environmentDigest: checkpoint.environmentDigest }) as WorldHandle;
      world.handle = registered;
      return registered;
    } catch (error) {
      await world.destroy().catch(() => undefined);
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

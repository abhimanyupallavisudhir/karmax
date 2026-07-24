import crypto from 'node:crypto';
import path from 'node:path';
import type {
  ProjectResource,
  ProjectResourceRevision,
  ProjectResourceSpec,
  TaskResourcePin,
} from '../domain/types.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { Store } from '../store/db.js';
import type { ObjectStore } from '../store/objects.js';
import { worldRelativePath, type World } from './types.js';
import { worldRepos } from './types.js';

const RESOURCE_ENVELOPE = Buffer.from('KXR1');
const MAX_RESOURCE_BYTES = envInt('KARMAX_MAX_RESOURCE_BYTES', 512 * 1024 * 1024);

export interface ResourcePath {
  resourceId: string;
  repo: string;
  path: string;
  relative: string;
}

/**
 * Durable non-Git project inputs. Metadata is in SQLite, file bytes are
 * envelope-encrypted in ObjectStore, and secret values live only in the
 * CredentialBroker. Task pins make world provisioning reproducible.
 */
export class ProjectResourceService {
  constructor(private store: Store, private objects: ObjectStore, private broker: CredentialBroker) {}

  list(projectId: string): Array<ProjectResource & { revisions: ProjectResourceRevision[] }> {
    return this.store.listProjectResources(projectId).map((resource) => ({
      ...resource,
      revisions: resource.kind === 'file' ? this.store.listProjectResourceRevisions(resource.id) : [],
    }));
  }

  create(projectId: string, input: { name: string; spec: ProjectResourceSpec; value?: string }): ProjectResource {
    const spec = validateSpec(input.spec);
    this.validateReferences(projectId, spec);
    validateSuppliedSecret(spec, input.value);
    const resource = this.store.createProjectResource(projectId, input.name, spec);
    if (input.value !== undefined) this.setSecret(resource, input.value);
    return this.store.getProjectResource(resource.id)!;
  }

  update(resourceId: string, input: { name?: string; spec?: ProjectResourceSpec; value?: string }): ProjectResource {
    const current = this.requireResource(resourceId);
    const spec = input.spec ? validateSpec(input.spec) : undefined;
    if (spec) {
      this.validateReferences(current.projectId, spec);
      if (current.spec.kind === 'database' && spec.kind === 'database' && current.spec.driver !== spec.driver)
        throw new Error('database driver is immutable; create a replacement resource');
    }
    validateSuppliedSecret(spec ?? current.spec, input.value);
    const updated = this.store.updateProjectResource(resourceId, { name: input.name, spec });
    if (input.value !== undefined) this.setSecret(updated, input.value);
    return this.store.getProjectResource(resourceId)!;
  }

  async upload(resourceId: string, data: Buffer, mediaType?: string): Promise<ProjectResourceRevision> {
    const resource = this.requireResource(resourceId);
    if (resource.kind !== 'file') throw new Error('only file resources accept uploads');
    if (!data.length) throw new Error('resource file is empty');
    if (data.length > MAX_RESOURCE_BYTES)
      throw new Error(`resource exceeds ${MAX_RESOURCE_BYTES} byte upload limit`);
    const sha256 = hash(data);
    const encrypted = this.encrypt(resource.projectId, data);
    const organizationId = this.store.getProject(resource.projectId)?.organizationId;
    if (!organizationId) throw new Error('resource project has no owning organization');
    const objectKey = `resources/${safe(organizationId)}/${safe(resource.projectId)}/${safe(resource.id)}/${sha256}-${crypto.randomBytes(8).toString('hex')}.bin`;
    await this.objects.put(objectKey, encrypted, 'application/octet-stream');
    try {
      return this.store.addProjectResourceRevision({
        resourceId, objectKey, sha256, bytes: data.length,
        mediaType: mediaType?.slice(0, 200) || undefined,
      });
    } catch (error) {
      await this.objects.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async readRevision(resourceId: string, revisionId?: string): Promise<Buffer> {
    // Deleted bindings remain readable by tasks that pinned them before the
    // deletion. They are physically removed only with the owning project.
    const resource = this.store.getProjectResource(resourceId);
    if (!resource) throw new Error('resource not found');
    const selected = revisionId ?? resource.currentRevisionId;
    if (!selected) throw new Error(`file resource "${resource.name}" has no uploaded revision`);
    const revision = this.store.getProjectResourceRevision(selected);
    if (!revision || revision.resourceId !== resourceId) throw new Error('resource revision not found');
    const plain = this.decrypt(resource.projectId, await this.objects.get(revision.objectKey));
    if (plain.length !== revision.bytes || hash(plain) !== revision.sha256)
      throw new Error(`resource "${resource.name}" failed integrity verification`);
    return plain;
  }

  /** Soft-delete metadata from new tasks. Pinned tasks retain their immutable
   * specs/revisions and secret handle until project deletion. */
  delete(resourceId: string): ProjectResource {
    return this.store.deleteProjectResource(resourceId).resource;
  }

  /** Permanently release all project resource objects and vault material. Called
   * only after task worlds/checkpoints have been torn down for project deletion. */
  async purgeProject(projectId: string): Promise<void> {
    for (const resource of this.store.listProjectResources(projectId, true)) {
      for (const revision of this.store.listProjectResourceRevisions(resource.id))
        await this.objects.delete(revision.objectKey);
      this.broker.deleteHandle(secretHandle(resource));
    }
    this.broker.deleteHandle(projectKeyHandle(projectId));
  }

  pins(taskId: string, projectId?: string): TaskResourcePin[] {
    const current = this.store.taskResourcePins(taskId);
    if (current.length || !projectId || this.store.hasTaskResourceSnapshot(taskId)) return current;
    for (const resource of this.store.listProjectResources(projectId)) {
      if (resource.kind === 'file' && !resource.currentRevisionId)
        throw new Error(`file resource "${resource.name}" has no uploaded revision`);
      if ((resource.kind === 'secret'
        || resource.kind === 'database' && resource.spec.kind === 'database' && resource.spec.driver === 'external')
        && !resource.secretConfigured)
        throw new Error(`resource "${resource.name}" has no secret value`);
      if (resource.spec.kind === 'external' && resource.spec.credentialResourceId) {
        const credential = this.store.getProjectResource(resource.spec.credentialResourceId);
        if (!credential?.secretConfigured)
          throw new Error(`external resource "${resource.name}" has no configured bearer credential`);
      }
    }
    return this.store.pinTaskResources(taskId, projectId);
  }

  async materialize(taskId: string, projectId: string, world: World): Promise<{ pins: number; warnings: string[] }> {
    const pins = this.pins(taskId, projectId);
    const warnings: string[] = [];
    for (const pin of pins) {
      const resource = this.store.getProjectResource(pin.resourceId);
      const display = resource?.name ?? pin.resourceId;
      const spec = pin.spec;
      if (spec.kind === 'secret') {
        const value = this.secret(pin.resourceId, resource, taskId);
        if (spec.inject.path) {
          await this.assertSecretPathIgnored(world, pin, spec.inject.path, display);
          await this.write(world, pin, spec.inject.path, Buffer.from(value), spec.inject.mode ?? 0o600);
        }
        continue;
      }
      if (spec.kind === 'file') {
        if (!pin.revisionId) throw new Error(`file resource "${display}" has no uploaded revision`);
        const data = await this.readRevision(pin.resourceId, pin.revisionId);
        await this.write(world, pin, spec.inject.path, data,
          spec.inject.mode ?? (spec.readOnly ? 0o444 : 0o644));
        continue;
      }
      if (spec.kind === 'external') {
        await this.downloadExternal(world, pin, resource);
        continue;
      }
      if (spec.driver === 'sqlite') {
        const target = spec.path ?? '.karmax-data/development.sqlite';
        const relative = resourcePath(world, pin, target).relative;
        const made = await world.exec('bash', ['-lc', `mkdir -p ${quote(path.posix.dirname(relative))} && touch ${quote(relative)} && chmod 600 ${quote(relative)}`]);
        if (made.code !== 0) throw new Error(`could not provision SQLite resource "${display}": ${made.stderr || made.stdout}`);
      } else {
        // Validate the handle while provisioning, before publishing the world as
        // ready. The value is discarded here and resolved again only at spawn.
        this.secret(pin.resourceId, resource, taskId);
      }
    }
    return { pins: pins.length, warnings };
  }

  async runSetup(taskId: string, projectId: string, world: World): Promise<void> {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error('resource setup project not found');
    const commands = project.config.setupCommands ?? [];
    if (!commands.length) return;
    const env = this.environment(taskId, world, projectId);
    for (const command of commands) {
      if (!command.trim()) continue;
      const result = await world.exec('bash', ['-lc', command], {
        cwd: world.handle.root, env, timeoutMs: 30 * 60_000,
      });
      if (result.code !== 0)
        throw new Error(`project setup failed (${command}): ${result.stderr || result.stdout}`);
    }
  }

  /** Values are resolved just-in-time and must never be journaled or stamped on
   * WorldHandle. Consumers pass this map directly to a single process/PTY. */
  environment(taskId: string, world: World, projectId?: string): Record<string, string> {
    // Provisioning is the sole pinning boundary. A process launch consumes the
    // snapshot already attached to its world; it must never make a project's
    // later resource edits appear in an existing or legacy task.
    const pins = this.store.taskResourcePins(taskId);
    const env: Record<string, string> = {};
    for (const pin of pins) {
      const resource = this.store.getProjectResource(pin.resourceId);
      const spec = pin.spec;
      if (spec.kind === 'secret' && spec.inject.env)
        env[spec.inject.env] = this.secret(pin.resourceId, resource, taskId);
      if (spec.kind === 'database') {
        const name = spec.env ?? 'DATABASE_URL';
        if (spec.driver === 'external') env[name] = this.secret(pin.resourceId, resource, taskId);
        else {
          const target = resourcePath(world, pin, spec.path ?? '.karmax-data/development.sqlite');
          env[name] = `sqlite:${target.absolute}`;
        }
      }
    }
    return env;
  }

  secretPaths(taskId: string, world: World): ResourcePath[] {
    return this.pathSet(taskId, world, (spec) => spec.kind === 'secret' && Boolean(spec.inject.path));
  }

  mutablePaths(taskId: string, world: World): ResourcePath[] {
    return this.pathSet(taskId, world, (spec) =>
      (spec.kind === 'file' || spec.kind === 'external') && Boolean(spec.mutable)
      || spec.kind === 'database' && spec.driver === 'sqlite' && spec.mutable !== false);
  }

  /** Read a mutable resource for a portable checkpoint. SQLite uses its online
   * backup API so a running app's WAL and concurrent transactions cannot
   * produce a torn database image. */
  async snapshotMutable(taskId: string, world: World, entry: ResourcePath): Promise<Buffer | undefined> {
    const pin = this.store.taskResourcePins(taskId).find((candidate) => candidate.resourceId === entry.resourceId);
    if (pin?.spec.kind !== 'database' || pin.spec.driver !== 'sqlite') {
      try { return await world.readFileBuffer(entry.relative); }
      catch { return undefined; }
    }
    const exists = await world.exec('test', ['-f', entry.relative], { cwd: world.handle.root });
    if (exists.code !== 0) return undefined;
    const tmp = `.karmax-injection/checkpoints/${safe(entry.resourceId)}-${crypto.randomBytes(6).toString('hex')}.sqlite`;
    const prepared = await world.exec('mkdir', ['-p', path.posix.dirname(tmp)], { cwd: world.handle.root });
    if (prepared.code !== 0) throw new Error(`could not prepare SQLite checkpoint: ${prepared.stderr || prepared.stdout}`);
    const script = [
      "const {DatabaseSync,backup}=require('node:sqlite');",
      'const source=new DatabaseSync(process.argv[1],{readOnly:true});',
      'backup(source,process.argv[2]).then(()=>source.close());',
    ].join('');
    try {
      const result = await world.exec('node', ['-e', script, entry.relative, tmp], {
        cwd: world.handle.root, timeoutMs: 5 * 60_000,
      });
      if (result.code !== 0)
        throw new Error(`SQLite online backup failed: ${result.stderr || result.stdout || 'node:sqlite is unavailable'}`);
      return await world.readFileBuffer(tmp);
    } finally {
      await world.exec('rm', ['-f', tmp], { cwd: world.handle.root }).catch(() => undefined);
    }
  }

  private pathSet(taskId: string, world: World, include: (spec: ProjectResourceSpec) => boolean): ResourcePath[] {
    const out: ResourcePath[] = [];
    for (const pin of this.store.taskResourcePins(taskId)) {
      if (!include(pin.spec)) continue;
      const target = pin.spec.kind === 'database'
        ? pin.spec.path ?? '.karmax-data/development.sqlite'
        : pin.spec.inject.path;
      if (!target) continue;
      const resolved = resourcePath(world, pin, target);
      out.push({ resourceId: pin.resourceId, repo: resolved.repo, path: target, relative: resolved.relative });
    }
    return out;
  }

  private async downloadExternal(world: World, pin: TaskResourcePin, resource?: ProjectResource): Promise<void> {
    const spec = pin.spec;
    if (spec.kind !== 'external') return;
    const target = resourcePath(world, pin, spec.inject.path);
    const tmp = `.karmax-injection/downloads/${pin.resourceId}.tmp`;
    const env: Record<string, string> = {};
    const auth = spec.credentialResourceId
      ? this.store.getProjectResource(spec.credentialResourceId)
      : undefined;
    if (auth) env.KARMAX_RESOURCE_BEARER = this.secret(auth.id, auth, pin.taskId);
    const header = auth ? `-H "Authorization: Bearer $KARMAX_RESOURCE_BEARER"` : '';
    const command = [
      `mkdir -p ${quote(path.posix.dirname(tmp))} ${quote(path.posix.dirname(target.relative))}`,
      `curl --fail --location --silent --show-error ${header} --output ${quote(tmp)} ${quote(spec.uri)}`,
      `printf '%s  %s\\n' ${quote(spec.sha256)} ${quote(tmp)} | sha256sum -c -`,
      `mv ${quote(tmp)} ${quote(target.relative)}`,
      `chmod ${(spec.inject.mode ?? (spec.readOnly ? 0o444 : 0o644)).toString(8)} ${quote(target.relative)}`,
    ].join(' && ');
    const result = await world.exec('bash', ['-lc', command], { env, timeoutMs: 30 * 60_000 });
    if (result.code !== 0)
      throw new Error(`external resource "${resource?.name ?? pin.resourceId}" failed: ${result.stderr || result.stdout}`);
  }

  private async write(world: World, pin: TaskResourcePin, target: string, data: Buffer, mode: number): Promise<void> {
    const resolved = resourcePath(world, pin, target);
    if (!world.writeFileBuffer) throw new Error('world cannot receive binary project resources');
    await world.writeFileBuffer(resolved.relative, data);
    const chmod = await world.exec('chmod', [mode.toString(8), resolved.absolute]);
    if (chmod.code !== 0) throw new Error(`could not protect project resource ${target}: ${chmod.stderr || chmod.stdout}`);
  }

  private async assertSecretPathIgnored(world: World, pin: TaskResourcePin, target: string, display: string): Promise<void> {
    const resolved = resourcePath(world, pin, target);
    const repo = worldRepos(world.handle).find((candidate) => candidate.name === resolved.repo);
    if (!repo) return; // scratch/non-Git worlds have no commit path
    const tracked = await world.exec('git', ['ls-files', '--error-unmatch', '--', target], { cwd: repo.root });
    if (tracked.code === 0)
      throw new Error(`secret resource "${display}" targets a Git-tracked path (${target})`);
    const ignored = await world.exec('git', ['check-ignore', '-q', '--', target], { cwd: repo.root });
    if (ignored.code !== 0)
      throw new Error(`secret resource "${display}" file path must be covered by .gitignore (${target})`);
  }

  private setSecret(resource: ProjectResource, value: string): void {
    if (resource.kind !== 'secret' && !(resource.kind === 'database' && resource.spec.kind === 'database'
      && resource.spec.driver === 'external'))
      throw new Error('this resource does not accept a secret value');
    if (!value) throw new Error('secret value is required');
    this.broker.registerHandle(secretHandle(resource), value);
    this.store.updateProjectResource(resource.id, { secretConfigured: true });
  }

  private secret(resourceId: string, resource?: ProjectResource, taskId?: string): string {
    const target = resource ?? this.store.getProjectResource(resourceId);
    if (!target?.secretConfigured) throw new Error(`resource "${target?.name ?? resourceId}" has no secret value`);
    return this.broker.resolve(secretHandle(target), {
      caps: [`use-credential:${secretHandle(target)}`],
      taskId,
    });
  }

  private requireResource(id: string): ProjectResource {
    const resource = this.store.getProjectResource(id);
    if (!resource || resource.deletedAt) throw new Error('resource not found');
    return resource;
  }

  private validateReferences(projectId: string, spec: ProjectResourceSpec): void {
    if (spec.kind !== 'external' || !spec.credentialResourceId) return;
    const credential = this.store.getProjectResource(spec.credentialResourceId);
    if (!credential || credential.deletedAt || credential.projectId !== projectId || credential.kind !== 'secret')
      throw new Error('external resource credential must be an active secret in the same project');
  }

  private key(projectId: string, create = false): Buffer {
    const handle = projectKeyHandle(projectId);
    if (!this.broker.hasHandle(handle) && create)
      this.broker.registerHandle(handle, crypto.randomBytes(32).toString('base64'));
    if (!this.broker.hasHandle(handle))
      throw new Error('project resource encryption key is unavailable');
    return Buffer.from(this.broker.resolve(handle, { caps: [`use-credential:${handle}`] }), 'base64');
  }

  private encrypt(projectId: string, plain: Buffer): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key(projectId, true), iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([RESOURCE_ENVELOPE, iv, cipher.getAuthTag(), body]);
  }

  private decrypt(projectId: string, blob: Buffer): Buffer {
    if (!blob.subarray(0, 4).equals(RESOURCE_ENVELOPE)) throw new Error('invalid resource envelope');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key(projectId), blob.subarray(4, 16));
    decipher.setAuthTag(blob.subarray(16, 32));
    return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]);
  }
}

function validateSpec(input: ProjectResourceSpec): ProjectResourceSpec {
  if (!input || typeof input !== 'object') throw new Error('resource spec is required');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 2_000))
    throw new Error('resource description is too long');
  if (input.kind === 'secret') {
    validateInjection(input.inject);
    if (!input.inject.env && !input.inject.path) throw new Error('secret needs an environment variable or file path');
  } else if (input.kind === 'file') {
    validateInjection(input.inject);
    if (input.mutable && input.readOnly) throw new Error('a mutable file cannot be read-only');
  } else if (input.kind === 'external') {
    validateInjection(input.inject);
    let uri: URL;
    try { uri = new URL(input.uri); } catch { throw new Error('external resources require a valid HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(uri.protocol) || input.uri.length > 4_096)
      throw new Error('external resources currently require an HTTP(S) URL');
    if (uri.username || uri.password)
      throw new Error('external resource URLs cannot contain credentials; select a secret bearer token instead');
    if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error('external resource needs a SHA-256 digest');
    if (input.mutable && input.readOnly) throw new Error('a mutable file cannot be read-only');
  } else if (input.kind === 'database') {
    validateEnv(input.env ?? 'DATABASE_URL');
    if (input.driver === 'sqlite') {
      validatePath(input.path ?? '.karmax-data/development.sqlite');
      if (input.repository !== undefined && !input.repository.trim()) throw new Error('repository name is empty');
    }
  } else throw new Error('unsupported resource kind');
  return structuredClone(input);
}

function validateSuppliedSecret(spec: ProjectResourceSpec, value: string | undefined): void {
  if (value === undefined) return;
  const accepts = spec.kind === 'secret' || spec.kind === 'database' && spec.driver === 'external';
  if (!accepts) throw new Error('this resource does not accept a secret value');
  if (!value) throw new Error('secret value is required');
}

function validateInjection(inject: { env?: string; path?: string; repository?: string; mode?: number }): void {
  if (!inject || typeof inject !== 'object') throw new Error('resource injection is required');
  if (inject.env) validateEnv(inject.env);
  if (inject.path) validatePath(inject.path);
  if (inject.repository !== undefined && !inject.repository.trim()) throw new Error('repository name is empty');
  if (inject.mode !== undefined && (!Number.isInteger(inject.mode) || inject.mode < 0 || inject.mode > 0o777))
    throw new Error('file mode must be between 000 and 777');
}

function validatePath(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('resource path contains a control character');
  const safePath = worldRelativePath(value);
  if (safePath === '.' || safePath === '.git' || safePath.startsWith('.git/'))
    throw new Error('resource path cannot target Git internals');
  return safePath;
}

function validateEnv(value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid environment variable: ${value}`);
}

function resourcePath(world: World, pin: TaskResourcePin, target: string):
  { repo: string; relative: string; absolute: string } {
  const safeTarget = validatePath(target);
  const requested = pin.spec.kind === 'database' ? pin.spec.repository : pin.spec.inject.repository;
  const repos = worldRepos(world.handle);
  const selected = requested
    ? repos.find((repo) => repo.name === requested)
    : repos.length === 1 ? repos[0] : undefined;
  if (requested && !selected) throw new Error(`resource targets unknown repository "${requested}"`);
  if (!selected && repos.length > 1)
    throw new Error('multi-repository resource must select a repository');
  const relative = repos.length > 1 && selected ? `${selected.name}/${safeTarget}` : safeTarget;
  const absolute = selected ? path.posix.join(selected.root, safeTarget) : path.posix.join(world.handle.root, safeTarget);
  return { repo: selected?.name ?? repos[0]?.name ?? 'repo', relative, absolute };
}

function secretHandle(resource: Pick<ProjectResource, 'projectId' | 'id'>): string {
  return `project-resource:${resource.projectId}:${resource.id}`;
}
function projectKeyHandle(projectId: string): string { return `project-resource-key:${projectId}`; }
function hash(data: Buffer): string { return crypto.createHash('sha256').update(data).digest('hex'); }
function safe(value: string): string { return value.replace(/[^A-Za-z0-9_.-]/g, '_'); }
function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

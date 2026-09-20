import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store/db.js';
import { beginEnvironmentBuild, environmentBuildRevision, finishEnvironmentBuild, ProjectEnvironment,
  recoverEnvironmentBuild, recordEnvironmentBuilder } from '../src/store/project-environment.js';
import { ProjectTransfers } from '../src/platform/project-transfer.js';
import { selectProjectEnvironment } from '../src/world/project-runtime.js';
import { buildEnvironment, environmentArtifactName } from '../src/world/environment-build.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function persistent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-recovery-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.db');
  const initial = await Store.create(file);
  const source = (await initial.createOrganization({ name: 'Source', ownerUserId: 'alice' }));
  const destination = (await initial.createOrganization({ name: 'Destination', ownerUserId: 'alice' }));
  const project = (await initial.createProject('Project', {}, source.id));
  const spec = (await new ProjectEnvironment(initial).setSpec(project.id, { setup: ['echo hello'] }));
  const digest = new ProjectEnvironment(initial).digest(spec);
  const scope = { organizationId: source.id, transferGeneration: '' };
  const attempt = (await beginEnvironmentBuild(initial, project.id, scope, 'e2b', digest));
  (await recordEnvironmentBuilder(initial, attempt, 'provider-builder-1'));
  (await initial.close()); // No callback survives a process restart.
  const store = await Store.create(file), peer = await Store.create(file);
  cleanup.push(async () => (await store.close()), async () => (await peer.close()));
  const environments = new ProjectEnvironment(store);
  const record = (await environments.builds(project.id))[0]!;
  const request = { provider: 'e2b', digest, revision: environmentBuildRevision(record),
    cleanupConfirmed: true, cleanupNote: 'Stopped provider-builder-1 and removed its snapshot in the source provider account.' };
  const transfers = new ProjectTransfers(store, { principal: 'user:alice', authorize: () => {}, workflowClosed: async () => true });
  return { store, peer, project, source, destination, digest, scope, attempt, environments, request, transfers };
}

describe('durable environment build recovery', () => {
  it.each(['ready', 'failed'] as const)('recovers a restarted build and fences late %s callbacks from another gateway', async status => {
    const f = (await persistent());
    await expect(beginEnvironmentBuild(f.store, f.project.id, f.scope, 'e2b', f.digest)).rejects.toThrow(/already building/);
    expect((await f.transfers.preview(f.project.id, f.destination.id)).blockers).toContainEqual(expect.objectContaining({ code: 'environment-builds' }));
    await expect(recoverEnvironmentBuild(f.store, f.project.id, f.scope, { ...f.request, cleanupConfirmed: false }, 'user:alice')).rejects.toThrow(/cleanup/);
    (await recoverEnvironmentBuild(f.peer, f.project.id, f.scope, f.request, 'user:alice'));
    (await recoverEnvironmentBuild(f.store, f.project.id, f.scope, f.request, 'user:alice')); // Lost response is retryable.
    expect((await f.transfers.preview(f.project.id, f.destination.id)).blockers).toEqual([]);
    const replacement = (await beginEnvironmentBuild(f.store, f.project.id, f.scope, 'e2b', f.digest));
    expect(environmentArtifactName(f.project.id, f.digest, replacement.buildId)).not.toBe(environmentArtifactName(f.project.id, f.digest, f.attempt.buildId));
    await expect(recoverEnvironmentBuild(f.peer, f.project.id, f.scope, f.request, 'user:alice')).rejects.toThrow(/changed/);
    expect((await finishEnvironmentBuild(f.peer, f.attempt, status === 'ready' ? { status, ref: 'stale-source' } : { status, error: 'late failure' }))).toBe(false);
    expect((await f.environments.builds(f.project.id))[0]?.buildId).toBe(replacement.buildId);
    expect((await finishEnvironmentBuild(f.store, replacement, { status: 'ready', ref: 'replacement-snapshot' }))).toBe(true);
    expect((await selectProjectEnvironment(f.store, f.project.id, 'e2b', undefined)).environment?.snapshot).toBe('replacement-snapshot');
    const preview = (await f.transfers.preview(f.project.id, f.destination.id));
    await f.transfers.move(f.project.id, f.destination.id, preview.id);
    expect((await finishEnvironmentBuild(f.peer, f.attempt, { status: 'ready', ref: 'stale-source' }))).toBe(false);
    expect((await selectProjectEnvironment(f.store, f.project.id, 'e2b', undefined)).built).toBe(false);
    expect((await f.store.auditSince()).filter(row => row.action === 'project.environment-build.recovered')).toHaveLength(1);
  });

  it('recovers legacy building records and rejects their unscoped callbacks without overwriting replacements', async () => {
    const f = (await persistent());
    (await f.environments.recordBuild(f.project.id, { provider: 'e2b', digest: f.digest, status: 'building' }));
    const revision = environmentBuildRevision((await f.environments.builds(f.project.id))[0]!);
    (await recoverEnvironmentBuild(f.store, f.project.id, f.scope, { ...f.request, revision }, 'user:alice'));
    const replacement = (await beginEnvironmentBuild(f.peer, f.project.id, f.scope, 'e2b', f.digest));
    (await f.environments.recordBuild(f.project.id, { provider: 'e2b', digest: f.digest, status: 'ready', ref: 'legacy-source' }));
    (await f.environments.recordBuild(f.project.id, { provider: 'e2b', digest: f.digest, status: 'failed', error: 'late error' }));
    expect((await f.environments.builds(f.project.id))[0]?.buildId).toBe(replacement.buildId);
    expect((await finishEnvironmentBuild(f.peer, replacement, { status: 'ready', ref: 'replacement' }))).toBe(true);
    expect((await f.environments.readyBuild(f.project.id, 'e2b', f.digest))?.ref).toBe('replacement');
  });

  it('rolls back invalidation if the recovery audit fails', async () => {
    const f = (await persistent());
    const original = (await f.environments.builds(f.project.id));
    f.store.appendAudit = () => { throw new Error('audit unavailable'); };
    await expect(recoverEnvironmentBuild(f.store, f.project.id, f.scope, f.request, 'user:alice')).rejects.toThrow('audit unavailable');
    expect((await f.environments.builds(f.project.id))).toEqual(original);
    expect((await f.store.kvEntries(`environment-build-recovery:${f.project.id}:`))).toEqual([]);
  });

  it('records remote builder identity and stops before snapshotting an invalidated attempt', async () => {
    const f = (await persistent());
    let killed = false, snapshotted = false;
    await expect(buildEnvironment({ provider: 'e2b', projectId: f.project.id, digest: f.digest, buildId: f.attempt.buildId,
      spec: { setup: ['setup'] },
      assertActive: async () => { if ((await f.environments.builds(f.project.id))[0]?.status !== 'building') throw new Error('invalidated'); },
      onBuilderCreated: async id => (await recordEnvironmentBuilder(f.store, f.attempt, id)),
      createBuilderSandbox: async () => ({ id: 'new-builder-id',
        run: async () => {
          expect((await f.environments.builds(f.project.id))[0]?.builderId).toBe('new-builder-id');
          const revision = environmentBuildRevision((await f.environments.builds(f.project.id))[0]!);
          (await recoverEnvironmentBuild(f.peer, f.project.id, f.scope, { ...f.request, revision }, 'user:alice'));
          return { exitCode: 0, stderr: '', stdout: '' };
        },
        createSnapshot: async () => { snapshotted = true; return { snapshotId: 'unexpected' }; },
        kill: async () => { killed = true; },
      }),
    })).rejects.toThrow('invalidated');
    expect(killed).toBe(true);
    expect(snapshotted).toBe(false);
  });
});

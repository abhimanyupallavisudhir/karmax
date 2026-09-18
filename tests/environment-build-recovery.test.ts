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

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function persistent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-recovery-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'store.db');
  const initial = new Store(file);
  const source = initial.createOrganization({ name: 'Source', ownerUserId: 'alice' });
  const destination = initial.createOrganization({ name: 'Destination', ownerUserId: 'alice' });
  const project = initial.createProject('Project', {}, source.id);
  const spec = new ProjectEnvironment(initial).setSpec(project.id, { setup: ['echo hello'] });
  const digest = new ProjectEnvironment(initial).digest(spec);
  const scope = { organizationId: source.id, transferGeneration: '' };
  const attempt = beginEnvironmentBuild(initial, project.id, scope, 'e2b', digest);
  recordEnvironmentBuilder(initial, attempt, 'provider-builder-1');
  initial.close(); // No callback survives a process restart.
  const store = new Store(file), peer = new Store(file);
  cleanup.push(() => store.close(), () => peer.close());
  const environments = new ProjectEnvironment(store);
  const record = environments.builds(project.id)[0]!;
  const request = { provider: 'e2b', digest, revision: environmentBuildRevision(record),
    cleanupConfirmed: true, cleanupNote: 'Stopped provider-builder-1 and removed its snapshot in the source provider account.' };
  const transfers = new ProjectTransfers(store, { principal: 'user:alice', authorize: () => {}, workflowClosed: async () => true });
  return { store, peer, project, source, destination, digest, scope, attempt, environments, request, transfers };
}

describe('durable environment build recovery', () => {
  it.each(['ready', 'failed'] as const)('recovers a restarted build and fences late %s callbacks from another gateway', async status => {
    const f = persistent();
    expect(() => beginEnvironmentBuild(f.store, f.project.id, f.scope, 'e2b', f.digest)).toThrow(/already building/);
    expect(f.transfers.preview(f.project.id, f.destination.id).blockers).toContainEqual(expect.objectContaining({ code: 'environment-builds' }));
    expect(() => recoverEnvironmentBuild(f.store, f.project.id, f.scope, { ...f.request, cleanupConfirmed: false }, 'user:alice')).toThrow(/cleanup/);
    recoverEnvironmentBuild(f.peer, f.project.id, f.scope, f.request, 'user:alice');
    recoverEnvironmentBuild(f.store, f.project.id, f.scope, f.request, 'user:alice'); // Lost response is retryable.
    expect(f.transfers.preview(f.project.id, f.destination.id).blockers).toEqual([]);
    const replacement = beginEnvironmentBuild(f.store, f.project.id, f.scope, 'e2b', f.digest);
    expect(environmentArtifactName(f.project.id, f.digest, replacement.buildId)).not.toBe(environmentArtifactName(f.project.id, f.digest, f.attempt.buildId));
    expect(() => recoverEnvironmentBuild(f.peer, f.project.id, f.scope, f.request, 'user:alice')).toThrow(/changed/);
    expect(finishEnvironmentBuild(f.peer, f.attempt, status === 'ready' ? { status, ref: 'stale-source' } : { status, error: 'late failure' })).toBe(false);
    expect(f.environments.builds(f.project.id)[0]?.buildId).toBe(replacement.buildId);
    expect(finishEnvironmentBuild(f.store, replacement, { status: 'ready', ref: 'replacement-snapshot' })).toBe(true);
    expect(selectProjectEnvironment(f.store, f.project.id, 'e2b', undefined).environment?.snapshot).toBe('replacement-snapshot');
    const preview = f.transfers.preview(f.project.id, f.destination.id);
    await f.transfers.move(f.project.id, f.destination.id, preview.id);
    expect(finishEnvironmentBuild(f.peer, f.attempt, { status: 'ready', ref: 'stale-source' })).toBe(false);
    expect(selectProjectEnvironment(f.store, f.project.id, 'e2b', undefined).built).toBe(false);
    expect(f.store.auditSince().filter(row => row.action === 'project.environment-build.recovered')).toHaveLength(1);
  });

  it('recovers legacy building records and rejects their unscoped callbacks without overwriting replacements', () => {
    const f = persistent();
    f.environments.recordBuild(f.project.id, { provider: 'e2b', digest: f.digest, status: 'building' });
    const revision = environmentBuildRevision(f.environments.builds(f.project.id)[0]!);
    recoverEnvironmentBuild(f.store, f.project.id, f.scope, { ...f.request, revision }, 'user:alice');
    const replacement = beginEnvironmentBuild(f.peer, f.project.id, f.scope, 'e2b', f.digest);
    f.environments.recordBuild(f.project.id, { provider: 'e2b', digest: f.digest, status: 'ready', ref: 'legacy-source' });
    f.environments.recordBuild(f.project.id, { provider: 'e2b', digest: f.digest, status: 'failed', error: 'late error' });
    expect(f.environments.builds(f.project.id)[0]?.buildId).toBe(replacement.buildId);
    expect(finishEnvironmentBuild(f.peer, replacement, { status: 'ready', ref: 'replacement' })).toBe(true);
    expect(f.environments.readyBuild(f.project.id, 'e2b', f.digest)?.ref).toBe('replacement');
  });

  it('rolls back invalidation if the recovery audit fails', () => {
    const f = persistent();
    const original = f.environments.builds(f.project.id);
    f.store.appendAudit = () => { throw new Error('audit unavailable'); };
    expect(() => recoverEnvironmentBuild(f.store, f.project.id, f.scope, f.request, 'user:alice')).toThrow('audit unavailable');
    expect(f.environments.builds(f.project.id)).toEqual(original);
    expect(f.store.kvEntries(`environment-build-recovery:${f.project.id}:`)).toEqual([]);
  });

  it('records remote builder identity and stops before snapshotting an invalidated attempt', async () => {
    const f = persistent();
    let killed = false, snapshotted = false;
    await expect(buildEnvironment({ provider: 'e2b', projectId: f.project.id, digest: f.digest, buildId: f.attempt.buildId,
      spec: { setup: ['setup'] },
      assertActive: () => { if (f.environments.builds(f.project.id)[0]?.status !== 'building') throw new Error('invalidated'); },
      onBuilderCreated: id => recordEnvironmentBuilder(f.store, f.attempt, id),
      createBuilderSandbox: async () => ({ id: 'new-builder-id',
        run: async () => {
          expect(f.environments.builds(f.project.id)[0]?.builderId).toBe('new-builder-id');
          const revision = environmentBuildRevision(f.environments.builds(f.project.id)[0]!);
          recoverEnvironmentBuild(f.peer, f.project.id, f.scope, { ...f.request, revision }, 'user:alice');
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

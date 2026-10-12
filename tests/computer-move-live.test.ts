import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { WorldRegistry } from '../src/world/registry.js';
import { WorldCheckpointService } from '../src/world/checkpoint.js';
import { E2BWorldProvider } from '../src/world/e2b.js';
import { HetznerDriver } from '../src/world/hetzner.js';
import { VmWorldProvider } from '../src/world/vm/provider.js';
import { activateProjectRuntime, selectProjectEnvironment } from '../src/world/project-runtime.js';
import { ProjectEnvironment } from '../src/store/project-environment.js';
import type { ResolvedWorldProviderConnection } from '../src/world/connections.js';
import type { World, WorldHandle } from '../src/world/types.js';
import { TimingTrace, withTiming } from '../src/timing/index.js';
import { cleanHetzner, hetznerInventory, type HetznerInventory } from './helpers/hetzner-live.js';
import { liveEnabled } from './helpers/live-gate.js';

/**
 * Moving a running task from E2B to Hetzner on the real control planes (wiki
 * features/computers, "Moving to another cloud provider"; pramana#22). An E2B
 * world with a tracked edit, an untracked file, a Git-ignored file and the
 * project's setup log is checkpointed and destroyed, as the lifecycle sweep
 * hibernates it; `restoreWhereTaskRuns` then restores it where the task's own
 * Computer now says:
 *
 * 1. Hetzner with a refused key: the task comes back on E2B with every file and
 *    its Computer set back (`world.move_failed`).
 * 2. Hetzner for real: a 100 GB volume holding the tracked and untracked
 *    files, not the ignored one, and setup has run again (`world.moved`).
 *
 * Unpushed commits and project data resources are not covered here: production
 * publishes the task branch when a world parks and restores resources through
 * its repository server (the 2026-10-12 canary, wiki features/computers).
 * The repository is a public fixture, cloned anonymously.
 *
 * Opt in with KARMAX_RUN_LIVE=1, E2B_API_KEY and HCLOUD_TOKEN (optional
 * KARMAX_HETZNER_LOCATION, KARMAX_LIVE_MOVE_REPOSITORY). It builds no Hetzner
 * snapshot: the world boots from the project's provisioned snapshot if there
 * is one, else provisions from stock Debian as an organization's first move
 * does. Prints one `MOVE-LIVE {…}` line with every latency; deletes the
 * servers and volumes it creates, and the firewall and key if it made them.
 * About $0.05.
 */
const repository = process.env.KARMAX_LIVE_MOVE_REPOSITORY ?? 'git@github.com:abhimanyupallavisudhir/fork-fixture.git';
const live = liveEnabled() && Boolean(process.env.E2B_API_KEY) && Boolean(process.env.HCLOUD_TOKEN);
const hetzner: ResolvedWorldProviderConnection = { provider: 'hetzner', apiKey: process.env.HCLOUD_TOKEN ?? '',
  config: { region: process.env.KARMAX_HETZNER_LOCATION } };

describe.skipIf(!live)('moving a live task from E2B to Hetzner', () => {
  const report: Record<string, unknown> = { repository };
  const marker = `MOVE-${Date.now().toString(36)}`;
  let home: string;
  let previousHome: string | undefined;
  let before: HetznerInventory | undefined;
  let store: Store;
  let service: WorldCheckpointService;
  let worlds: WorldRegistry;
  let projectId: string;
  let taskId: string;
  let handle: WorldHandle;
  // The Hetzner connection the task's organization has: refused first, then real.
  let hetznerKey = 'refused-token';
  const created: WorldHandle[] = [];

  const timed = async <T>(label: string, work: () => Promise<T>): Promise<T> => {
    const started = Date.now();
    try { return await work(); } finally { report[label] = Math.round((Date.now() - started) / 100) / 10; }
  };
  const run = async (world: World, command: string) => {
    const result = await world.exec('bash', ['-lc', command], { cwd: world.handle.root, timeoutMs: 10 * 60_000 });
    if (result.code !== 0) throw new Error(`${command}: ${result.stderr || result.stdout}`);
    return result.stdout.trimEnd();
  };

  const destroy = async (world: WorldHandle) => {
    const provider = worlds.get(world.kind);
    await (provider.destroy ? provider.destroy(world) : (await provider.open(world)).destroy());
  };

  /** What the sweep does to a parked world whose task asks for another provider. */
  async function hibernate(label: string): Promise<string> {
    const checkpoint = await timed(`${label}CheckpointS`, () => service.checkpoint(handle));
    await timed(`${label}DestroyS`, () => destroy(handle));
    await store.setWorldState(handle, 'hibernated');
    return checkpoint.id;
  }

  async function expectWork(world: World) {
    expect(await run(world, 'tail -1 README.md')).toBe(`tracked edit ${marker}`);
    expect(await run(world, 'cat notes/untracked.txt')).toBe(`untracked ${marker}`);
    expect(await run(world, 'git status --porcelain')).toBe(' M README.md\n?? notes/');
  }

  beforeAll(async () => {
    previousHome = process.env.KARMAX_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-live-move-'));
    process.env.KARMAX_HOME = home; // a home label no production sweep owns
    process.env.KARMAX_HETZNER_SNAPSHOTS = '0'; // never leave a snapshot build running
    before = await hetznerInventory(hetzner);
    store = await Store.create(':memory:');
    const project = await store.createProject('Move', { repos: [repository], defaultBase: 'main', defaultTarget: 'main' });
    projectId = project.id;
    const stored = await store.upsertRepository({ organizationId: project.organizationId!, provider: 'github', owner: 'fixture',
      name: path.basename(repository, '.git'), sshUrl: repository, defaultBranch: 'main', private: false });
    await store.attachProjectRepository({ projectId, repositoryId: stored.id, baseBranch: 'main', targetBranch: 'main' });
    await new ProjectEnvironment(store).setSpec(projectId, {
      setup: ['echo "setup $(hostname)" >> "$HOME/move-setup.log"'], boot: ['echo "boot $(hostname)" >> "$HOME/move-boot.log"'] });
    const task = await store.createTask({ projectId, title: 'Move', workflow: 'software-dev', workflowVersion: '1.27.0',
      params: { prompt: 'x', computer: { provider: 'hetzner', diskGb: 100 } } });
    taskId = task.id;
    worlds = new WorldRegistry();
    worlds.register(new E2BWorldProvider());
    worlds.register(new VmWorldProvider(new HetznerDriver(), async () => ({ ...hetzner, apiKey: hetznerKey })));
    const objects = path.join(home, 'objects');
    // A public repository: GitHub never asks for the clone token, but its
    // presence routes the SSH URL through HTTPS as production's App token does.
    const githubApp = { repositoryCloneToken: async () => 'anonymous' } as any;
    service = new WorldCheckpointService(store, worlds, new LocalObjectStore(objects), new CredentialBroker(new Vault(path.join(home, 'vault'))), githubApp);
    (service as any).addNotice = async (_taskId: string, notice: string) => { report.notices = [...(report.notices as string[] ?? []), notice]; };

    // The task's world on E2B, made as createWorld makes it.
    const world = await timed('e2bCreateS', () => worlds.create('e2b', { taskId, generation: 1, organizationId: project.organizationId!,
      repos: [repository], base: 'main', target: 'main', gitCredentials: { httpsTokens: { [repository]: 'anonymous' } },
      resources: { cpu: 2, memoryMb: 2048 } }));
    world.handle.meta = { ...world.handle.meta, projectId };
    const runtime = await activateProjectRuntime({ world, store, projectId, taskId,
      selection: await selectProjectEnvironment(store, projectId, 'e2b', undefined), runSetupIfUnbuilt: true });
    handle = (await store.registerWorld(runtime.handle, projectId)) as WorldHandle;
    created.push(handle);
    await run(world, `echo "tracked edit ${marker}" >> README.md && mkdir -p notes && echo "untracked ${marker}" > notes/untracked.txt`
      + ` && echo cache/ >> .git/info/exclude && mkdir -p cache && echo "ignored ${marker}" > cache/ignored.txt`);
    report.e2bHost = await run(world, 'hostname');
    expect(await run(world, 'cat "$HOME/move-setup.log"')).toBe(`setup ${report.e2bHost}`);
  }, 20 * 60_000);

  afterAll(async () => {
    try {
      if (worlds) for (const world of created) await destroy(world).catch(() => undefined);
      for (const provider of [worlds?.get('e2b'), worlds?.get('hetzner')])
        for (const leftover of await provider?.listSandboxes?.().catch(() => []) ?? []) await leftover.destroy().catch(() => undefined);
      await cleanHetzner(hetzner, before).catch((error) => { report.cleanupError = String(error); });
      console.log(`MOVE-LIVE ${JSON.stringify(report)}`);
    } finally {
      if (previousHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = previousHome;
      delete process.env.KARMAX_HETZNER_SNAPSHOTS;
      await store?.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 30 * 60_000);

  it('stays on E2B with every file when Hetzner refuses, and the task goes back to E2B', async () => {
    const checkpointId = await hibernate('fallback');
    const restored = await timed('fallbackRestoreS', () => service.restoreWhereTaskRuns(checkpointId, handle));
    created.push(restored);
    expect(restored.kind).toBe('e2b');
    expect((await store.eventsOfType(taskId, 'world.move_failed')).at(-1)?.payload).toMatchObject({ from: 'e2b', to: 'hetzner' });
    expect((await store.getTask(taskId))!.params.computer).toEqual({ provider: 'e2b', diskGb: 100 });
    expect(report.notices).toEqual([expect.stringMatching(/could not move to Hetzner/)]);
    handle = restored;
    await expectWork(await worlds.open(handle));
  }, 30 * 60_000);

  it('moves to a 100 GB Hetzner volume with its tracked and untracked files, not its ignored ones, and runs setup again', async () => {
    hetznerKey = hetzner.apiKey;
    await store.patchTaskParams(taskId, { computer: { provider: 'hetzner', diskGb: 100 } });
    const checkpointId = await hibernate('move');
    // Where the restore's time goes: provider allocation, SSH, provisioning, clone, resources.
    const phases: Record<string, number> = {};
    const trace = new TimingTrace({ taskId, turnId: 'move', attempt: 1, role: 'do' }, (row) => {
      if (row.phase === 'end') phases[row.name] = Math.round(((phases[row.name] ?? 0) + (row.durationMs ?? 0) / 1000) * 10) / 10;
    });
    const restored = await timed('moveRestoreS', () => withTiming(trace, () => service.restoreWhereTaskRuns(checkpointId, handle)));
    report.movePhasesS = phases;
    created.push(restored);
    expect(restored.kind).toBe('hetzner');
    expect((await store.eventsOfType(taskId, 'world.moved')).at(-1)?.payload).toMatchObject({ from: 'e2b', to: 'hetzner' });
    expect((report.notices as string[]).at(-1)).toMatch(/moved to Hetzner/);
    const world = await worlds.open(restored);
    await expectWork(world);
    expect(await run(world, 'test -e cache/ignored.txt && echo present || echo absent')).toBe('absent');
    const host = await run(world, 'hostname');
    report.hetznerHost = host;
    // Setup ran on the new machine (its home is a new volume), and boot too.
    expect(await run(world, 'cat "$HOME/move-setup.log"')).toBe(`setup ${host}`);
    expect(await run(world, 'cat "$HOME/move-boot.log"')).toBe(`boot ${host}`);
    const size = Number.parseInt(await run(world, 'df -BG --output=size "$HOME" | tail -1'), 10);
    report.homeGb = size;
    expect(size).toBeGreaterThanOrEqual(90);
    report.machine = restored.meta?.machine;
  }, 30 * 60_000);
});

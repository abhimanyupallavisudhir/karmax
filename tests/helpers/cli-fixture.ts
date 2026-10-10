import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findFreePortFrom } from '../../src/util/ports.js';
import { Gateway } from '../../src/gateway/server.js';
import { KarmaxApi } from '../../src/platform/api.js';
import { TokenAuthority } from '../../src/platform/tokens.js';
import { KarmaxBus } from '../../src/contrib/bus.js';
import { ContributionRegistry } from '../../src/contrib/registry.js';
import { Overlays } from '../../src/store/overlays.js';
import { Store } from '../../src/store/db.js';
import { LocalObjectStore } from '../../src/store/objects.js';
import { ProjectEnvironment } from '../../src/store/project-environment.js';
import { Vault } from '../../src/autonomy/vault.js';
import { CredentialBroker } from '../../src/autonomy/broker.js';
import { WorldRegistry } from '../../src/world/registry.js';
import { WorktreeProvider } from '../../src/world/worktree.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../../src/world/resources.js';
import { WorldHandoffService } from '../../src/world/handoff.js';
import { hostResticBinary } from '../../src/world/restic.js';
import { gitOrThrow } from '../../src/world/git.js';
import { DEFAULT_AUTHORIZATION_PROFILES } from '../../src/platform/authorization.js';
import type { GatewayDeps } from '../../src/gateway/server.js';
import type { World, WorldHandle } from '../../src/world/types.js';

export const capsOf = (level: string) => DEFAULT_AUTHORIZATION_PROFILES.find((profile) => profile.id === level)!.capabilities;

export const files = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name))).sort();

/**
 * A real tavya (gateway, store, vault, repository server) and two bare Git
 * remotes that stand in for GitHub (through `url.insteadOf`), driven through
 * the real `tavya` binary. Worlds are worktrees; `cloudWorld` presents one as
 * a remote sandbox, so restic runs in it as a job, as it does in E2B.
 */
export async function cliFixture(cleanups: Array<() => Promise<void> | void>, options: { githubApp?: GatewayDeps['githubApp'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-cli-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remotes = path.join(dir, 'github');
  const commit = (cwd: string, args: string[]) => gitOrThrow(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args]);
  for (const name of ['site', 'site-wiki']) {
    const seed = path.join(dir, `seed-${name}`);
    fs.mkdirSync(seed, { recursive: true });
    await gitOrThrow(seed, ['init', '-q', '-b', 'main']);
    await commit(seed, ['commit', '-q', '--allow-empty', '-m', 'base']);
    if (name === 'site') {
      fs.writeFileSync(path.join(seed, '.gitignore'), 'data/\n.env\nsecrets/\n');
      fs.writeFileSync(path.join(seed, 'README.md'), '# site\n');
      await gitOrThrow(seed, ['add', '-A']);
      await commit(seed, ['commit', '-q', '-m', 'readme']);
    }
    fs.mkdirSync(path.join(remotes, 'acme'), { recursive: true });
    await gitOrThrow(dir, ['clone', '-q', '--bare', seed, path.join(remotes, 'acme', `${name}.git`)]);
  }
  const gitconfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitconfig, `[url "${remotes}/"]\n\tinsteadOf = git@github.com:\n\tinsteadOf = https://github.com/\n[user]\n\tname = Laptop\n\temail = laptop@example.com\n[init]\n\tdefaultBranch = main\n`);

  const store = await Store.create(':memory:');
  cleanups.push(() => store.close());
  const project = await store.createProject('Site Builder');
  const repository = await store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
    providerId: '1', owner: 'acme', name: 'site', sshUrl: 'git@github.com:acme/site.git', defaultBranch: 'main', private: true });
  await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
  const wiki = await store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
    providerId: '2', owner: 'acme', name: 'site-wiki', sshUrl: 'git@github.com:acme/site-wiki.git', defaultBranch: 'main', private: true });
  await store.setProjectWikiRepository(project.id, wiki.id);
  await new ProjectEnvironment(store).setSpec(project.id, { install: { site: ['echo installed > installed.txt'] } });
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  // Worktrees presented as E2B sandboxes (see cloudTask).
  const cloudWorlds = new Map<string, { world: World; parked: boolean }>();
  worlds.register({ kind: 'e2b', capabilities: { remote: true },
    open: async (handle: WorldHandle) => { const entry = cloudWorlds.get(handle.id)!; entry.parked = false; return entry.world; },
    park: async (handle: WorldHandle) => { cloudWorlds.get(handle.id)!.parked = true; return handle; },
    status: async (handle: WorldHandle) => cloudWorlds.get(handle.id)?.parked ? 'parked' : 'ready' } as any);
  let gatewayUrl = '';
  const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker,
    undefined, undefined, { world: () => gatewayUrl });
  const tokens = new TokenAuthority(store);
  const client = { workflow: { getHandle: () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test', resources });
  const handoffs = new WorldHandoffService(store, worlds, (options.githubApp ?? {}) as any, undefined, undefined, path.join(dir, 'checkouts'), resources);
  const gateway = await Gateway.create({ api, store, tokens, client, worlds, taskQueue: 'test', resources, broker, handoffs,
    ...(options.githubApp ? { githubApp: options.githubApp } : {}),
    bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(), staticDir: 'web',
    agentInfo: { provider: 'mock', reason: 'cli test' } });
  const server = await gateway.listen(await findFreePortFrom(49_600));
  cleanups.push(() => server.close());
  gatewayUrl = server.url;
  const data = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'raw_data', driver: 'volume@1', target: { kind: 'path', path: 'data' }, access: 'write', isolation: 'fork',
    source: {}, credentialHandles: [], publish: 'review' });
  const corpus = Array.from({ length: 12 }, (_, i) => ({ path: `pages/${i}.txt`, data: crypto.randomBytes(300 + i) }));
  const first = await resources.importFiles(data.id, [...corpus, { path: 'big.bin', data: crypto.randomBytes(2 * 1024 * 1024) }]);
  const tokenFor = async (level: string, user = 'alice') => (await tokens.mintPrincipal(`user:${user}`, capsOf(level), project.id)).token;
  const maintainer = await tokenFor('maintainer');
  const viewer = await tokenFor('viewer', 'bob');
  const post = (pathname: string, body: unknown, token = maintainer) => fetch(`${server.url}${pathname}`, { method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await post(`/api/projects/${project.id}/secrets`, { env: 'API_KEY=s3cret\n' });
  await post(`/api/projects/${project.id}/secrets`, { name: 'sa.json', value: '{"key":"x"}', file: 'config/sa.json' });

  const tavya = (cwd: string, args: string[], run: { token?: string; input?: string; env?: NodeJS.ProcessEnv } = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.resolve('bin/tavya.js'), ...args], { cwd,
        env: { ...process.env, TAVYA_URL: server.url, TAVYA_TOKEN: run.token ?? maintainer, KARMAX_TOKEN: '', KARMAX_GATEWAY_URL: '',
          TAVYA_CONFIG_DIR: path.join(dir, 'config'), TAVYA_CACHE_DIR: path.join(dir, 'cache'), TAVYA_RESTIC: hostResticBinary(),
          GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', TAVYA_NO_KEYCHAIN: '1', ...run.env }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.stdin.end(run.input ?? '');
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });

  /** A task whose world is a worktree presented as an E2B sandbox, on a
   * branch published to the (fake) GitHub remote, waiting for review. */
  const cloudTask = async (title: string) => {
    const task = await store.createTask({ projectId: project.id, title, workflow: 'software-dev', workflowVersion: '1.26.0', params: { prompt: title } });
    const local = path.join(dir, `local-${task.id}`);
    await gitOrThrow(dir, ['clone', '-q', path.join(remotes, 'acme', 'site.git'), local]);
    const world: World = await worlds.create('worktree', { taskId: task.id, repo: local, base: 'main' });
    cleanups.push(() => world.destroy());
    await gitOrThrow(world.handle.root, ['push', '-q', path.join(remotes, 'acme', 'site.git'), `HEAD:refs/heads/${world.handle.branch}`]);
    world.handle = { ...world.handle, kind: 'e2b' } as WorldHandle;
    cloudWorlds.set(world.handle.id, { world, parked: false });
    await store.registerWorld(world.handle, project.id);
    world.handle = await resources.materialize(project.id, task.id, world, 1);
    await store.updateWorldMeta(world.handle as WorldHandle, world.handle.meta ?? {});
    await store.appendEvent({ taskId: task.id, type: 'push.branch', ts: Date.now(), payload: { branch: world.handle.branch, repos: ['site'] } });
    const num = (await store.getTask(task.id))?.num;
    await store.saveView(task.id, { taskId: task.id, title, workflow: 'software-dev', stage: 'review', status: 'waiting',
      waitingFor: { kind: 'human' }, actions: [], messages: [], state: {}, updatedAt: Date.now(), branch: world.handle.branch,
      world: world.handle } as any);
    return { task, world, num };
  };

  const laptop = path.join(dir, 'laptop'); fs.mkdirSync(laptop);
  return { dir, store, tokens, project, data, first, corpus, server, tavya, laptop, remotes, maintainer, viewer, tokenFor, gitconfig,
    resources, worlds, cloudTask, post, commit };
}

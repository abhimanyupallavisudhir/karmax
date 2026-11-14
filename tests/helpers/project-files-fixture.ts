import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
import { Vault } from '../../src/autonomy/vault.js';
import { CredentialBroker } from '../../src/autonomy/broker.js';
import { WorldRegistry } from '../../src/world/registry.js';
import { WorktreeProvider } from '../../src/world/worktree.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../../src/world/resources.js';
import { DEFAULT_AUTHORIZATION_PROFILES } from '../../src/platform/authorization.js';

// A project for the Files page (wiki features/project-files): two "GitHub"
// repositories that are bare repositories on disk (through url.insteadOf),
// data in a real restic resource repository mounted inside one of them, and a
// real gateway serving the console and the API.

export const capsOf = (level: string) => DEFAULT_AUTHORIZATION_PROFILES.find((profile) => profile.id === level)!.capabilities;

export function sh(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
}

/** A bare "GitHub" remote at remotes/<owner>/<name>.git holding `files` on `branch`. */
function remote(cleanups: Array<() => Promise<void> | void>, remotes: string, owner: string, name: string, branch: string, files: Record<string, string | Buffer>, symlinks: Record<string, string> = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-files-src-'));
  cleanups.push(() => fs.rmSync(work, { recursive: true, force: true }));
  sh(work, 'init', '-q', '-b', branch);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), content);
  }
  for (const [file, target] of Object.entries(symlinks)) fs.symlinkSync(target, path.join(work, file));
  sh(work, 'add', '-A');
  sh(work, 'commit', '-qm', 'initial');
  const bare = path.join(remotes, owner, `${name}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  sh(path.dirname(bare), 'clone', '-q', '--bare', work, bare);
  return { work, bare };
}

export async function projectFilesFixture(cleanups: Array<() => Promise<void> | void>, extra: { files?: Record<string, string | Buffer> } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-project-files-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  // `git@github.com:acme/x.git` is the bare repository under `remotes/`.
  const remotes = path.join(dir, 'remotes');
  const gitconfig = path.join(dir, 'gitconfig');
  fs.writeFileSync(gitconfig, `[url "file://${remotes}/"]\n\tinsteadOf = git@github.com:\n`);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = gitconfig;
  cleanups.push(() => { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; });
  // Host mirrors are shared by URL, so each fixture's "GitHub" owner is its own.
  const owner = `acme-${crypto.randomBytes(4).toString('hex')}`;
  const binary = crypto.randomBytes(4096);
  binary[10] = 0;
  const site = remote(cleanups, remotes, owner, 'site', 'main', {
    'README.md': '# Site\n\nSee [the guide](docs/guide.md).\n',
    'src/app.ts': 'export const answer = 42;\n',
    'src/weird name #1.txt': 'spaces and a hash\n',
    'docs/guide.md': '## Guide\n',
    'logo.bin': binary,
    ...extra.files,
  }, { 'link-to-app': 'src/app.ts' });
  remote(cleanups, remotes, owner, 'site-wiki', 'main', { 'SPEC.md': '# Spec\n' });

  const store = await Store.create(':memory:');
  cleanups.push(() => store.close());
  const project = await store.createProject('Site Builder');
  const repository = await store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
    providerId: '1', owner, name: 'site', sshUrl: `git@github.com:${owner}/site.git`, defaultBranch: 'main', private: true });
  await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id });
  const wiki = await store.upsertRepository({ organizationId: project.organizationId!, provider: 'github',
    providerId: '2', owner, name: 'site-wiki', sshUrl: `git@github.com:${owner}/site-wiki.git`, defaultBranch: 'main', private: true });
  await store.setProjectWikiRepository(project.id, wiki.id);
  const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
  const objects = new LocalObjectStore(path.join(dir, 'objects'));
  const worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(path.join(dir, 'worlds')));
  const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
  const tokens = new TokenAuthority(store);
  const client = { workflow: { getHandle: () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test', resources });
  const gateway = await Gateway.create({ api, store, tokens, client, worlds, taskQueue: 'test', resources, broker, objects,
    bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(), staticDir: 'web',
    agentInfo: { provider: 'mock', reason: 'project files test' } });
  const server = await gateway.listen(await findFreePortFrom(49_800));
  cleanups.push(() => server.close());
  // Data mounted inside the repository, at site/data/raw (no data/ in Git).
  const data = await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
    name: 'raw_data', driver: 'volume@1', target: { kind: 'path', path: 'data/raw' }, access: 'write', isolation: 'fork',
    source: {}, credentialHandles: [], publish: 'review' });
  const corpus = [
    { path: 'pages/a.txt', data: Buffer.from('alpha\n') },
    { path: 'pages/b.csv', data: Buffer.from('x,y\n1,2\n') },
    { path: 'big.bin', data: crypto.randomBytes(300_000) },
  ];
  await resources.importFiles(data.id, corpus);
  const tokenFor = async (capabilities: string[]) => (await tokens.mintPrincipal('user:alice', capabilities, project.id)).token;
  const get = (query: string, token: string, raw = false, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers;
    json(): Promise<any>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }> =>
    fetch(`${server.url}/api/projects/${project.id}/files${raw ? '/raw' : ''}?path=${encodeURIComponent(query)}`,
      { headers: { authorization: `Bearer ${token}`, ...headers } });
  return { owner, objects, remotes, resources, dir, store, project, gateway, data, corpus, site, binary, server, get, tokenFor, viewer: await tokenFor(capsOf('viewer') as string[]) };
}


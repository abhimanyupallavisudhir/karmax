import fs from 'node:fs';
import path from 'node:path';
import type { Api } from '../api.js';
import { parseDotenv } from '../../domain/dotenv.js';
import { dataFolder, DATA_FOLDER_BYTES, exampleEnvironmentFile, likelySecret, regenerated, sqliteDatabase } from '../../domain/ignored-files.js';
import { aheadBehind, currentBranch, dirty, excludeFromGit, git, gitOk, isRepository } from '../git.js';
import { accessOf, createDataResource, kindOf, placeOf, projectSecrets, sizeOf, storeEnvironmentFile, storeSecretFile, type Kind } from '../onboard.js';
import { namesOrganization, slug, type Organization, type Project } from '../refs.js';
import { pushProjectResource } from '../resources.js';
import { bytes, CliError, confirm, EXIT, interactive, table, type Output } from '../util.js';
import { digest } from '../secrets.js';
import { Workspace } from '../workspace.js';
import { fetchManifest } from './sync.js';

interface Repository { id: string; owner: string; name: string; sshUrl: string; defaultBranch?: string }
interface GitConnection { id: string; accountLogin: string }

interface Plan {
  environmentFiles: string[];
  secretFiles: string[];
  data: Array<{ path: string; shape: 'file' | 'directory'; bytes: number; access: 'read' | 'write' }>;
  /** Ignored files nothing above keeps, by top-level folder (`name/`) or file. */
  leftOut: Array<{ path: string; bytes: number }>;
}

/** GitHub `owner/name` of a remote URL (ssh or https). */
export function githubRepository(remote: string): { owner: string; name: string } | undefined {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

/** What `import` proposes for a checkout's ignored files (names and sizes; contents are read only to upload). */
export function planImport(root: string, ignored: string[]): Plan {
  const plan: Plan = { environmentFiles: [], secretFiles: [], data: [], leftOut: [] };
  const claimed = new Set<string>();
  const size = (relative: string) => { try { return fs.statSync(path.join(root, relative)).size; } catch { return 0; } };
  const files = ignored.filter((relative) => relative && !relative.split('/').includes('..') && !regenerated(relative.split('/')[0]!));
  for (const relative of files) {
    const base = path.posix.basename(relative).toLowerCase();
    if (!likelySecret(base) || exampleEnvironmentFile(base)) continue;
    claimed.add(relative);
    (/^\.env(?:\.|$)/.test(base) ? plan.environmentFiles : plan.secretFiles).push(relative);
  }
  for (const relative of files) {
    if (claimed.has(relative) || !sqliteDatabase(relative)) continue;
    claimed.add(relative);
    plan.data.push({ path: relative, shape: 'file', bytes: size(relative), access: 'write' });
  }
  const groups = new Map<string, number>();
  for (const relative of files) {
    if (claimed.has(relative)) continue;
    const top = relative.includes('/') ? `${relative.split('/')[0]!}/` : relative;
    groups.set(top, (groups.get(top) ?? 0) + size(relative));
  }
  for (const [top, total] of groups) {
    const folder = top.endsWith('/') ? top.slice(0, -1) : undefined;
    if (folder && (total >= DATA_FOLDER_BYTES || dataFolder(folder))) plan.data.push({ path: folder, shape: 'directory', bytes: total, access: 'read' });
    else plan.leftOut.push({ path: top, bytes: total });
  }
  return plan;
}

/** A Git checkout being imported. `local` is its folder relative to the import root (`.` = the root). */
interface Checkout {
  dir: string; local: string; branch?: string; remote?: string; github?: { owner: string; name: string };
  repository?: Repository; createAs?: string; push?: string; uncommitted: number;
  /** Its folder in the project's worlds (the repository's name), once linked. */
  world?: string;
}

/** An ignored file or folder to keep. `inner` is relative to its checkout, or to the root when it has none. */
interface Item { local: string; checkout?: Checkout; inner: string; kind: Kind; shape: 'file' | 'directory'; bytes: number; access: 'read' | 'write' }

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const posix = (value: string) => value.split(path.sep).join('/');
const within = (child: string, parent: string) => parent === '.' || child === parent || child.startsWith(`${parent}/`);
const joinLocal = (dir: string, inner: string) => dir === '.' ? inner : `${dir}/${inner}`;

/** Every file under `dir`, relative to it, leaving out checkouts and what builds regenerate. */
function looseFiles(dir: string, skip: Set<string>, prefix = ''): string[] {
  const result: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!prefix && (skip.has(entry.name) || entry.name === '.git' || entry.name === '.tavya' || regenerated(entry.name))) continue;
    if (entry.isDirectory()) result.push(...looseFiles(dir, skip, relative));
    else if (entry.isFile()) result.push(relative);
  }
  return result;
}

async function describeCheckout(dir: string, local: string): Promise<Checkout> {
  const checkout: Checkout = { dir, local, uncommitted: (await dirty(dir)).length };
  checkout.branch = await currentBranch(dir);
  // The configured URL: `remote get-url` would apply the user's insteadOf rewrites.
  const remote = (await git(dir, ['config', '--get', 'remote.origin.url'])).stdout.trim();
  if (remote) {
    checkout.remote = remote;
    checkout.github = githubRepository(remote);
    if (!checkout.github) throw new CliError(`${local}: origin (${remote}) is not on GitHub, which tavya projects use. `
      + 'Make a GitHub repository its origin, or remove origin and tavya creates one', EXIT.usage);
  }
  if ((await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0)
    throw new CliError(`${local}: no commits yet; commit your files first`, EXIT.usage);
  if (!checkout.branch) throw new CliError(`${local}: not on a branch (detached HEAD); check one out first`, EXIT.usage);
  const counts = remote ? await aheadBehind(dir, `origin/${checkout.branch}`) : undefined;
  checkout.push = !counts ? `push ${checkout.branch}` : counts.ahead ? `push ${counts.ahead} commit${counts.ahead === 1 ? '' : 's'} on ${checkout.branch}` : undefined;
  return checkout;
}

/**
 * Make a local folder a tavya project: one Git checkout, or a folder of them
 * (each becomes a repository of the project). Repositories with no origin get
 * a private GitHub repository; unpushed commits are pushed; the files Git
 * ignores become secrets (a .env's variables, secret files) and data, as
 * proposed or as `--data`/`--secret`/`--skip` say. The folder then is the
 * project's workspace, so `tavya push`/`pull`/`status`/`add` work in it.
 */
export async function importProject(api: Api, dir: string, out: Output, flags: Record<string, any>) {
  const requested = path.resolve(dir);
  if (!fs.existsSync(requested)) throw new CliError(`${requested} does not exist`, EXIT.usage);
  const toplevel = await gitOk(requested, ['rev-parse', '--show-toplevel'], 'not a checkout').catch(() => undefined);
  const root = toplevel ? path.resolve(toplevel) : requested;
  const workspace = Workspace.find(root);
  if (workspace && workspace.root !== root) throw new CliError(`${root} is inside the workspace ${workspace.root}: `
    + 'import from there, or keep files with `tavya add <path>`', EXIT.usage);
  if (workspace?.manifest.task) throw new CliError('this is a task workspace; import into a project from a project folder', EXIT.usage);
  // A workspace's wiki checkout is the project's wiki, not one of its repositories.
  const wikis = new Set(workspace?.manifest.repositories.filter((repository) => repository.role === 'project-wiki')
    .map((repository) => workspace.checkout(repository.name)));

  // The checkouts: the folder itself, or each folder in it that is one.
  const checkouts: Checkout[] = [];
  if (toplevel) checkouts.push(await describeCheckout(root, '.'));
  else for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)))
    if (entry.isDirectory() && !entry.name.startsWith('.') && isRepository(path.join(root, entry.name)) && !wikis.has(path.join(root, entry.name)))
      checkouts.push(await describeCheckout(path.join(root, entry.name), entry.name));
  if (!checkouts.length) throw new CliError(`${root} has no Git repositories. Import a checkout, or a folder of checkouts `
    + '(run `git init` and commit in each project folder first)', EXIT.usage);

  // The organization and its repositories.
  const organizations = await api.get<Organization[]>('/api/organizations');
  const organization = workspace ? organizations.find((entry) => entry.id === workspace.manifest.organization.id)
    : flags.organization
      ? organizations.find((entry) => namesOrganization(entry, flags.organization!))
      : organizations.length === 1 ? organizations[0] : undefined;
  if (!organization) throw new CliError(flags.organization ? `no organization "${flags.organization}" that you can access`
    : `choose an organization with --organization (${organizations.map((entry) => entry.slug ?? slug(entry.name)).join(', ')})`, EXIT.usage);
  const orgSlug = organization.slug ?? slug(organization.name);
  const orgBase = `/api/organizations/${encodeURIComponent(organization.id)}`;
  let repositories = await api.get<Repository[]>(`${orgBase}/repositories`);
  const known = (github: { owner: string; name: string }) => repositories.find((entry) =>
    entry.owner.toLowerCase() === github.owner.toLowerCase() && entry.name.toLowerCase() === github.name.toLowerCase());
  if (checkouts.some((checkout) => checkout.github && !known(checkout.github))) {
    // A repository given to the GitHub App moments ago is not listed until tavya hears of it.
    await api.post(`${orgBase}/github/refresh`).catch(() => undefined);
    repositories = await api.get<Repository[]>(`${orgBase}/repositories`);
  }
  const missing = checkouts.filter((checkout) => checkout.github && !known(checkout.github));
  if (missing.length) throw new CliError(`${missing.map((checkout) => `github.com/${checkout.github!.owner}/${checkout.github!.name}`).join(', ')} `
    + `${missing.length === 1 ? 'is' : 'are'} not connected to ${organization.name}. Give the tavya GitHub App access `
    + `(${api.server}/${orgSlug}/settings), then import again.`, EXIT.notFound);
  for (const checkout of checkouts) if (checkout.github) checkout.repository = known(checkout.github);

  // Repositories with no origin get one on the organization's GitHub account.
  let connection: GitConnection | undefined;
  const creating = checkouts.filter((checkout) => !checkout.github);
  if (creating.length) {
    const connections = await api.get<GitConnection[]>(`${orgBase}/git-connections`);
    connection = flags.github ? connections.find((entry) => entry.accountLogin.toLowerCase() === String(flags.github).toLowerCase())
      : connections.length === 1 ? connections[0] : undefined;
    if (!connection) throw new CliError(!connections.length
      ? `${creating.map((checkout) => checkout.local).join(', ')} ${creating.length === 1 ? 'has' : 'have'} no GitHub repository, and ${organization.name} has no GitHub connection to create one in. Connect GitHub (${api.server}/${orgSlug}/settings) or push to GitHub first`
      : `choose the GitHub account for new repositories with --github (${connections.map((entry) => entry.accountLogin).join(', ')})`, EXIT.usage);
    for (const checkout of creating) {
      checkout.createAs = path.basename(checkout.dir).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repository';
      const taken = known({ owner: connection.accountLogin, name: checkout.createAs });
      if (taken) throw new CliError(`${checkout.local}: github.com/${connection.accountLogin}/${checkout.createAs} already exists. If it is this `
        + `repository, run \`git remote add origin ${taken.sshUrl}\` in it; otherwise rename the folder`, EXIT.conflict);
    }
  }

  // What to keep of the files Git ignores (and, in a folder of checkouts, of the files beside them).
  const items: Item[] = [];
  const leftOut: Array<{ path: string; bytes: number; note?: string }> = [];
  const propose = (checkout: Checkout | undefined, plan: Plan) => {
    const local = (inner: string) => checkout ? joinLocal(checkout.local, inner) : inner;
    const add = (inner: string, kind: Kind, shape: 'file' | 'directory', size: number, access: 'read' | 'write') => {
      if (!checkout && checkouts.length === 1) { leftOut.push({ path: local(inner), bytes: size, note: 'outside the repository' }); return; }
      items.push({ local: local(inner), ...(checkout ? { checkout } : {}), inner, kind, shape, bytes: size, access });
    };
    for (const file of plan.environmentFiles) add(file, 'env', 'file', 0, 'read');
    for (const file of plan.secretFiles) add(file, 'secret', 'file', 0, 'read');
    for (const entry of plan.data) add(entry.path, 'data', entry.shape, entry.bytes, entry.access);
    for (const entry of plan.leftOut) leftOut.push({ path: local(entry.path), bytes: entry.bytes });
  };
  for (const checkout of checkouts) {
    const ignored = (await git(checkout.dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
    propose(checkout, planImport(checkout.dir, ignored.filter((file) => !file.startsWith('.tavya/'))));
  }
  if (!toplevel) propose(undefined, planImport(root, looseFiles(root, new Set([...checkouts.map((checkout) => checkout.local),
    ...[...wikis].map((dir) => path.basename(dir))]))));
  // Importing a workspace again proposes only what the project does not keep yet.
  if (workspace) for (let index = items.length - 1; index >= 0; index--) {
    const world = workspace.worldPath(path.join(root, items[index]!.local));
    if (workspace.manifest.resources.some((resource) => resource.path === world) || workspace.manifest.secrets.some((secret) => secret.file === world || secret.dotenv === world))
      items.splice(index, 1);
  }

  // --skip, --data and --secret adjust the proposal (paths as the shell sees them).
  const localOf = (value: string) => {
    const absolute = path.resolve(value);
    const relative = posix(path.relative(root, absolute));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new CliError(`${value} is outside ${root}`, EXIT.usage);
    return { absolute, relative: relative || '.' };
  };
  const drop = (where: string, keep: (item: Item) => boolean = () => false) => {
    for (let index = items.length - 1; index >= 0; index--)
      if (within(items[index]!.local, where) && !keep(items[index]!)) items.splice(index, 1);
    for (let index = leftOut.length - 1; index >= 0; index--)
      if (within(leftOut[index]!.path.replace(/\/$/, ''), where)) leftOut.splice(index, 1);
  };
  for (const value of [flags.skip ?? []].flat() as string[]) {
    const { relative } = localOf(value);
    drop(relative);
    leftOut.push({ path: relative, bytes: 0, note: 'skipped' });
  }
  for (const [wanted, values] of [['data', flags.data], ['secret', flags.secret]] as const) for (const value of [values ?? []].flat() as string[]) {
    const { absolute, relative } = localOf(value);
    const stat = fs.statSync(absolute, { throwIfNoEntry: false });
    if (!stat) throw new CliError(`${value} does not exist`, EXIT.usage);
    if (wanted === 'secret' && !stat.isFile()) throw new CliError(`${value}: only a file can be a secret`, EXIT.usage);
    const checkout = checkouts.filter((candidate) => within(relative, candidate.local)).sort((a, b) => b.local.length - a.local.length)[0];
    const inner = checkout ? (checkout.local === '.' ? relative : relative.slice(checkout.local.length + 1)) : relative;
    if (checkout && (!inner || inner === '.')) throw new CliError(`${value} is a whole repository`, EXIT.usage);
    if (checkout && (await git(checkout.dir, ['ls-files', '-z', '--', inner])).stdout)
      throw new CliError(`${value} is tracked by Git; tavya keeps what Git does not`, EXIT.usage);
    const parent = items.find((item) => item.kind === 'data' && item.local !== relative && within(relative, item.local));
    if (parent && wanted === 'data') throw new CliError(`${value} is already part of ${parent.local}`, EXIT.usage);
    // A secret file inside a folder added as data stays a secret too.
    drop(relative, (item) => wanted === 'data' && item.kind !== 'data' && item.local !== relative);
    if (!checkout && checkouts.length === 1) throw new CliError(`${value} is outside the repository; a one-repository project keeps data inside it`, EXIT.usage);
    items.push({ local: relative, ...(checkout ? { checkout } : {}), inner, kind: kindOf(relative, stat.isDirectory(), wanted),
      shape: stat.isDirectory() ? 'directory' : 'file', bytes: sizeOf(absolute), access: accessOf(relative) });
  }

  // The plan.
  const name: string = workspace?.manifest.project.name ?? flags.name ?? (toplevel
    ? checkouts[0]!.repository?.name ?? checkouts[0]!.createAs! : path.basename(root));
  let project: Project | undefined = workspace ? { id: workspace.manifest.project.id, name: workspace.manifest.project.name }
    : (await api.get<Project[]>(`${orgBase}/projects`)).find((entry) => slug(entry.name) === slug(name));
  const newProject = !project;
  const describe = (item: Item) => item.kind === 'env' ? `.env, ${count(parseDotenv(fs.readFileSync(path.join(root, item.local), 'utf8')).length, 'variable')}`
    : item.kind === 'secret' ? 'secret file'
    : `data, ${bytes(item.bytes)}${item.access === 'write' ? ', tasks may change it through review' : ''}`;
  const rows = [
    ...checkouts.map((checkout) => [checkout.local === '.' ? path.basename(root) : checkout.local,
      [checkout.repository ? `github.com/${checkout.repository.owner}/${checkout.repository.name}` : `new private github.com/${connection!.accountLogin}/${checkout.createAs}`,
        checkout.push, checkout.uncommitted ? `${checkout.uncommitted} uncommitted change${checkout.uncommitted === 1 ? '' : 's'} not included` : '']
        .filter(Boolean).join(', ')]),
    ...items.map((item) => [`${item.local}${item.shape === 'directory' ? '/' : ''}`, describe(item)]),
  ];
  const plan = { organization: orgSlug, project: name, newProject,
    repositories: checkouts.map((checkout) => ({ folder: checkout.local, repository: checkout.repository
      ? `${checkout.repository.owner}/${checkout.repository.name}` : `${connection!.accountLogin}/${checkout.createAs}`,
    create: !checkout.repository, ...(checkout.push ? { push: checkout.push } : {}), uncommitted: checkout.uncommitted })),
    secrets: items.filter((item) => item.kind !== 'data').map((item) => ({ path: item.local, as: item.kind === 'env' ? '.env' : 'file' })),
    data: items.filter((item) => item.kind === 'data').map((item) => ({ path: item.local, bytes: item.bytes, access: item.access })),
    leftOut };
  out.info(`Import ${path.relative(process.cwd(), root) || '.'} into ${newProject ? 'a new project ' : ''}${orgSlug}/${slug(name)}:`);
  out.info(table(rows));
  if (leftOut.length) out.info(`Left out (add with --data or --secret): ${leftOut.map((entry) => `${entry.path}${entry.note ? ` (${entry.note})` : ''}`).join(', ')}`);
  if (flags['dry-run']) return out.result(plan, '');
  if (!flags.yes && !(interactive() && await confirm('Continue?'))) {
    if (!interactive()) throw new CliError('re-run with --yes to import without a prompt (--dry-run shows the plan)', EXIT.usage);
    return out.result({ imported: false }, 'Nothing imported.');
  }

  // 1. GitHub: create missing repositories, then push what GitHub lacks.
  // New origins use the protocol the other checkouts use (SSH unless they use HTTPS).
  const https = checkouts.some((checkout) => checkout.remote?.startsWith('https:'));
  const done: Record<string, string> = {};
  for (const checkout of creating) {
    out.info(`Creating github.com/${connection!.accountLogin}/${checkout.createAs}…`);
    checkout.repository = await api.post<Repository>(`${orgBase}/repositories/create`, { gitConnectionId: connection!.id,
      name: checkout.createAs, private: true, autoInit: false, defaultBranch: checkout.branch });
    const url = https ? `https://github.com/${checkout.repository.owner}/${checkout.repository.name}.git` : checkout.repository.sshUrl;
    await gitOk(checkout.dir, ['remote', 'add', 'origin', url], `${checkout.local}: adding origin`);
    done[checkout.local] = 'created';
  }
  for (const checkout of checkouts.filter((candidate) => candidate.push)) {
    out.info(`Pushing ${checkout.local === '.' ? path.basename(root) : checkout.local} (${checkout.branch})…`);
    const upstream = (await git(checkout.dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).code === 0;
    const pushed = await git(checkout.dir, ['push', '--quiet', ...(upstream ? [] : ['-u']), 'origin', `${checkout.branch}:${checkout.branch}`]);
    if (pushed.code !== 0) throw new CliError(`pushing ${checkout.local} failed: ${(pushed.stderr || pushed.stdout).trim().split('\n').slice(-2).join(' ')}\n`
      + 'Fix that and run `tavya import` again; what is done stays done.');
    done[checkout.local] = done[checkout.local] ? `${done[checkout.local]}, pushed` : 'pushed';
  }

  // 2. The project and its repositories.
  project ??= await api.post<Project>(`${orgBase}/projects`, { name });
  const projectBase = `/api/projects/${encodeURIComponent(project.id)}`;
  const linked = await api.get<Array<{ repository: { id: string } }>>(`${projectBase}/repositories`);
  for (const checkout of checkouts) if (!linked.some((entry) => entry.repository.id === checkout.repository!.id)) {
    await api.post(`${projectBase}/repositories`, { repositoryId: checkout.repository!.id });
    done[checkout.local] = done[checkout.local] ? `${done[checkout.local]}, linked` : 'linked';
  }
  let manifest = await fetchManifest(api, { projectId: project.id });
  for (const checkout of checkouts) checkout.world = manifest.repositories.find((entry) => {
    const github = githubRepository(entry.sshUrl);
    return entry.role === 'development' && github?.owner.toLowerCase() === checkout.repository!.owner.toLowerCase()
      && github.name.toLowerCase() === checkout.repository!.name.toLowerCase();
  })?.name ?? checkout.repository!.name;
  const worldOf = (item: Item) => item.checkout ? `${item.checkout.world}/${item.inner}` : item.inner;
  const placed = (item: Item) => {
    const place = placeOf(worldOf(item), manifest);
    if (!place) out.warn(`${item.local}: outside the project's repositories; not kept`);
    return place;
  };

  // 3. Secrets: each .env stays a file in its repository; secret files too. What the project has, it keeps.
  const secrets = await projectSecrets(api, project.id);
  const stored: string[] = []; const kept: string[] = []; const secretFiles: Array<{ world: string; file: string }> = [];
  for (const item of items.filter((candidate) => candidate.kind !== 'data')) {
    const file = path.join(root, item.local);
    const place = placed(item);
    if (!place) continue;
    if (item.kind === 'env') {
      const result = await storeEnvironmentFile(api, project.id, fs.readFileSync(file, 'utf8'), place, secrets, false);
      stored.push(...result.stored.map((variable) => `${worldOf(item)}:${variable}`));
      kept.push(...result.kept.map((variable) => `${worldOf(item)}:${variable}`));
    } else {
      const result = await storeSecretFile(api, project.id, file, place, secrets, false);
      if (result === 'binary') out.warn(`${item.local}: binary; store it in the vault instead`);
      else if (result === 'kept') kept.push(worldOf(item));
      else { stored.push(worldOf(item)); secretFiles.push({ world: worldOf(item), file }); }
    }
    if (item.checkout) excludeFromGit(item.checkout.dir, item.inner);
  }

  // 4. Data: a resource per path, then the folder becomes the workspace and pushes it.
  const data: Array<{ item: Item; id: string }> = [];
  for (const item of items.filter((candidate) => candidate.kind === 'data')) {
    const place = placed(item);
    if (!place) continue;
    const resource = manifest.resources.find((candidate) => candidate.path === worldOf(item));
    data.push({ item, id: resource?.id ?? (await createDataResource(api, project.id, place, manifest.workdir, item.shape, item.access)).id });
    if (item.checkout) excludeFromGit(item.checkout.dir, item.inner);
  }
  manifest = await fetchManifest(api, { projectId: project.id });
  const mapping = Object.fromEntries(checkouts.map((checkout) => [checkout.world!, checkout.local]));
  const adopted = workspace ?? Workspace.create(root, api.server, manifest, mapping);
  adopted.manifest = manifest;
  adopted.checkouts = { ...adopted.checkouts, ...mapping };
  for (const { world, file } of secretFiles) adopted.setSecretFile(world, digest(fs.readFileSync(file, 'utf8')));
  const uploaded: string[] = [];
  for (const { item, id } of data) {
    const resource = manifest.resources.find((candidate) => candidate.id === id);
    if (!resource) continue;
    await pushProjectResource(api, adopted, resource, out, true);
    uploaded.push(item.local);
  }

  const ref = `${orgSlug}/${slug(project.name)}`;
  out.result({ project, organization: { id: organization.id, slug: orgSlug }, root, repositories: done, secrets: stored, kept, data: uploaded,
    leftOut: leftOut.map((entry) => entry.path) },
  [`Imported into ${ref}: ${checkouts.length} repositor${checkouts.length === 1 ? 'y' : 'ies'}, ${stored.length} secret${stored.length === 1 ? '' : 's'}, `
    + `${uploaded.length} data item${uploaded.length === 1 ? '' : 's'}.`,
  ...(kept.length ? [`Kept the project's own values for ${kept.join(', ')} (\`tavya add <file>\` replaces them).`] : []),
  `This folder is now its workspace: tavya status | push | pull | add <path>. Elsewhere: tavya clone ${ref}`].join('\n'));
}

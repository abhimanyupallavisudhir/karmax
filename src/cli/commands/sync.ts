import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Api } from '../api.js';
import { HttpError } from '../api.js';
import { aheadBehind, currentBranch, dirty, git, isRepository } from '../git.js';
import { resolveTarget } from '../refs.js';
import { changed, localChanges, pullResource, pushProjectResource, saveResource } from '../resources.js';
import { writeSecretFiles } from '../secrets.js';
import { CliError, EXIT, shellQuote, table, type Output } from '../util.js';
import { fingerprint, Workspace, type Manifest } from '../workspace.js';

export async function fetchManifest(api: Api, target: { projectId: string; taskId?: string }): Promise<Manifest> {
  return api.get<Manifest>(target.taskId ? `/api/tasks/${encodeURIComponent(target.taskId)}/workspace`
    : `/api/projects/${encodeURIComponent(target.projectId)}/workspace`);
}

/** Git configuration that sends github.com credentials through `tavya git-credential`. */
export function tavyaCredentialConfig(): string[] {
  const self = [process.execPath, ...(process.argv[1] ? [process.argv[1]] : [])].map(shellQuote).join(' ');
  return ['credential.https://github.com.helper=', `credential.https://github.com.helper=!${self} git-credential`,
    'credential.https://github.com.useHttpPath=true'];
}

function httpsUrl(sshUrl: string): string {
  const match = /^git@github\.com:(.+)$/.exec(sshUrl);
  return match ? `https://github.com/${match[1]}` : sshUrl;
}

async function cloneRepository(root: string, repository: Manifest['repositories'][number], out: Output, viaTavya = false): Promise<boolean> {
  const destination = path.join(root, repository.name);
  out.info(`Cloning ${repository.name} (${repository.branch})…`);
  // `--config` is written into the new repository before it fetches, so the clone itself uses it.
  const config = viaTavya ? tavyaCredentialConfig().flatMap((entry) => ['--config', entry]) : [];
  const url = viaTavya ? httpsUrl(repository.sshUrl) : repository.sshUrl;
  let result = await git(root, ['clone', '--quiet', ...config, '--branch', repository.branch, url, destination]);
  if (result.code !== 0 && repository.base && repository.base !== repository.branch) {
    // A task's wiki branch exists only once the task changed its wiki.
    result = await git(root, ['clone', '--quiet', ...config, '--branch', repository.base, url, destination]);
  }
  if (result.code === 0) return true;
  const output = (result.stderr || result.stdout).trim();
  const reason = output.split('\n').slice(-2).join(' ');
  if (repository.role === 'project-wiki') { out.warn(`project wiki not cloned: ${reason}`); return false; }
  throw new CliError(`cloning ${repository.sshUrl} failed: ${reason}\n${!viaTavya && /access rights|Repository not found|Permission denied/i.test(output)
    ? aliasHint(repository.sshUrl) ?? GENERIC_HINT : GENERIC_HINT}`);
}

const GENERIC_HINT = 'Git uses your own GitHub credentials: check that you can access this repository.';

/** Host aliases in an OpenSSH config that reach github.com (`Host work` + `HostName github.com`). */
export function githubSshAliases(config: string): string[] {
  const aliases: string[] = [];
  let hosts: string[] = [];
  for (const line of config.split(/\r?\n/)) {
    const match = /^\s*(\w+)(?:\s*=\s*|\s+)(.*?)\s*$/.exec(line);
    if (!match) continue;
    const keyword = match[1]!.toLowerCase();
    const value = match[2]!.replace(/"/g, '');
    if (keyword === 'host') hosts = value.split(/\s+/).filter((host) => !/[*?!]/.test(host) && host.toLowerCase() !== 'github.com');
    else if (keyword === 'match') hosts = [];
    else if (keyword === 'hostname' && value.toLowerCase() === 'github.com') aliases.push(...hosts);
  }
  return [...new Set(aliases)];
}

/** GitHub refused the default key: the user may reach the repository's account through an alias in ~/.ssh/config. */
function aliasHint(sshUrl: string): string | undefined {
  const owner = /^git@github\.com:([^/]+)\//.exec(sshUrl)?.[1];
  let config = '';
  try { config = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8'); } catch { return undefined; }
  const aliases = githubSshAliases(config);
  if (!owner || !aliases.length) return undefined;
  const alias = aliases.find((entry) => entry.toLowerCase().includes(owner.toLowerCase())) ?? (aliases.length === 1 ? aliases[0] : '<alias>');
  return `Your github.com SSH key may belong to another GitHub account. To reach ${owner}'s repositories through `
    + `${alias === '<alias>' ? `one of your ~/.ssh/config aliases (${aliases.join(', ')})` : `${alias} from ~/.ssh/config`}, run once:\n`
    + `  git config --global url."git@${alias}:${owner}/".insteadOf "git@github.com:${owner}/"`;
}

export async function clone(api: Api, ref: string, directory: string | undefined, out: Output,
  options: { resources: boolean; secrets: boolean; gitViaTavya?: boolean }) {
  const target = await resolveTarget(api, ref);
  const manifest = await fetchManifest(api, { projectId: target.project.id, ...(target.taskId ? { taskId: target.taskId } : {}) });
  const root = path.resolve(directory ?? manifest.directory);
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new CliError(`${root} already exists and is not empty`, EXIT.usage);
  fs.mkdirSync(root, { recursive: true });
  const workspace = Workspace.create(root, api.server, manifest);
  if (options.gitViaTavya) workspace.gitViaTavya = true;
  for (const repository of manifest.repositories) await cloneRepository(root, repository, out, options.gitViaTavya);
  const report = await syncData(api, workspace, out, { resources: options.resources, secrets: options.secrets, force: false });
  const where = path.relative(process.cwd(), workspace.workdir) || '.';
  out.result({ root, workdir: workspace.workdir, manifest, ...report },
    `Cloned ${manifest.organization.slug ?? manifest.organization.name}/${manifest.project.name}${manifest.task ? ` #${manifest.task.number ?? manifest.task.id}` : ''} into ${path.relative(process.cwd(), root) || '.'}\n`
    + `  cd ${shellQuote(where)}${manifest.install.length ? '\n  tavya setup     # install dependencies' : ''}`);
}

async function syncData(api: Api, workspace: Workspace, out: Output, options: { resources: boolean; secrets: boolean; force: boolean }) {
  const resources: Record<string, string> = {};
  if (options.resources) for (const resource of workspace.manifest.resources)
    resources[resource.name] = await pullResource(api, workspace, resource, out, options.force);
  const secrets = options.secrets ? await writeSecretFiles(api, workspace, out, options.force) : false;
  return { resources, secretFiles: secrets };
}

export async function pull(api: Api, workspace: Workspace, out: Output, options: { force: boolean; resources: boolean; secrets: boolean }) {
  const manifest = await fetchManifest(api, { projectId: workspace.manifest.project.id,
    ...(workspace.manifest.task ? { taskId: workspace.manifest.task.id } : {}) });
  workspace.manifest = manifest;
  workspace.save();
  const repositories: Record<string, string> = {};
  for (const repository of manifest.repositories) {
    const dir = path.join(workspace.root, repository.name);
    if (!isRepository(dir)) { repositories[repository.name] = await cloneRepository(workspace.root, repository, out, workspace.gitViaTavya) ? 'cloned' : 'skipped'; continue; }
    let fetched = await git(dir, ['fetch', '--quiet', 'origin', repository.branch]);
    let branch = repository.branch;
    if (fetched.code !== 0 && repository.base) { branch = repository.base; fetched = await git(dir, ['fetch', '--quiet', 'origin', branch]); }
    if (fetched.code !== 0) { out.warn(`${repository.name}: fetch failed: ${fetched.stderr.trim()}`); repositories[repository.name] = 'failed'; continue; }
    const current = await currentBranch(dir);
    if (current !== branch) {
      repositories[repository.name] = `fetched (on ${current ?? 'a detached HEAD'}, not ${branch})`;
      if (current) out.info(`${repository.name}: on ${current}; fetched ${branch} without changing your checkout`);
      continue;
    }
    const merged = await git(dir, ['merge', '--ff-only', '--quiet', `origin/${branch}`]);
    if (merged.code !== 0) {
      out.warn(`${repository.name}: ${branch} has diverged from origin/${branch}; merge or rebase it yourself`);
      repositories[repository.name] = 'diverged';
    } else repositories[repository.name] = 'updated';
  }
  const data = await syncData(api, workspace, out, options);
  out.result({ repositories, ...data }, summarize(repositories, data.resources));
}

function summarize(repositories: Record<string, string>, resources: Record<string, string>): string {
  return table([...Object.entries(repositories), ...Object.entries(resources)].map(([name, state]) => [name, state]));
}

export async function push(api: Api, workspace: Workspace, out: Output, options: { overwrite: boolean; git: boolean; resources: boolean }) {
  const manifest = workspace.manifest;
  const task = manifest.task;
  const repositories: Record<string, string> = {};
  let pushedGit = false;
  if (options.git) for (const repository of manifest.repositories) {
    const dir = path.join(workspace.root, repository.name);
    if (!isRepository(dir)) continue;
    const uncommitted = (await dirty(dir)).length;
    if (uncommitted) out.warn(`${repository.name}: ${uncommitted} uncommitted change${uncommitted === 1 ? '' : 's'} not pushed; commit them first`);
    const branch = await currentBranch(dir);
    if (!branch) { repositories[repository.name] = 'detached HEAD'; continue; }
    if (task && branch !== repository.branch) {
      out.warn(`${repository.name}: on ${branch}; a task workspace pushes ${repository.branch}`);
      repositories[repository.name] = 'skipped';
      continue;
    }
    const counts = await aheadBehind(dir, `origin/${branch}`);
    if (counts && counts.ahead === 0) { repositories[repository.name] = 'up to date'; continue; }
    out.info(`Pushing ${repository.name} (${branch})…`);
    const pushed = await git(dir, ['push', '--quiet', ...(counts ? [] : ['-u']), 'origin', `${branch}:${branch}`]);
    if (pushed.code !== 0) throw new CliError(`pushing ${repository.name} failed: ${(pushed.stderr || pushed.stdout).trim().split('\n').slice(-2).join(' ')}`);
    repositories[repository.name] = 'pushed';
    pushedGit = true;
  }
  const resources: Record<string, string> = {};
  const snapshots: Array<{ id: string; snapshot: string }> = [];
  if (options.resources) for (const resource of manifest.resources) {
    if (!changed(localChanges(workspace, resource))) continue;
    if (resource.access !== 'write' && task) { out.warn(`${resource.name}: read-only in tasks; local changes are not pushed`); continue; }
    if (task) {
      const snapshot = await saveResource(api, workspace, resource, out);
      if (snapshot) { snapshots.push({ id: resource.id, snapshot }); resources[resource.name] = 'saved'; }
    } else resources[resource.name] = await pushProjectResource(api, workspace, resource, out, options.overwrite);
  }
  let imported: unknown;
  if (task && (pushedGit || snapshots.length)) {
    out.info('Bringing it into the task\'s cloud world…');
    try {
      imported = await api.post(`/api/tasks/${encodeURIComponent(task.id)}/import-local`, { git: pushedGit, resources: snapshots });
      for (const entry of snapshots) {
        const resource = manifest.resources.find((candidate) => candidate.id === entry.id)!;
        workspace.setResource(resource.id, { ...workspace.resource(resource.id), snapshot: entry.snapshot,
          fingerprint: fingerprint(workspace.path(resource.path)) });
        resources[resource.name] = 'pushed';
      }
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      out.warn(`${pushedGit ? 'pushed to GitHub, but ' : ''}not brought into the cloud world: ${error.message}. Run \`tavya push\` again when the task waits for review.`);
    }
  }
  out.result({ repositories, resources, ...(imported ? { imported } : {}) },
    summarize(repositories, resources) || 'Nothing to push.');
}

export async function status(api: Api | undefined, workspace: Workspace, out: Output) {
  let manifest = workspace.manifest;
  if (api) try { manifest = await fetchManifest(api, { projectId: manifest.project.id, ...(manifest.task ? { taskId: manifest.task.id } : {}) }); }
  catch (error) { out.warn(`could not reach ${workspace.server}: ${(error as Error).message}`); }
  const rows: string[][] = [];
  const result: Record<string, unknown> = { project: manifest.project, ...(manifest.task ? { task: manifest.task } : {}), repositories: {}, resources: {} };
  for (const repository of manifest.repositories) {
    const dir = path.join(workspace.root, repository.name);
    if (!isRepository(dir)) { rows.push([repository.name, 'not cloned (tavya pull)']); continue; }
    const branch = await currentBranch(dir);
    const counts = branch ? await aheadBehind(dir, `origin/${branch}`) : undefined;
    const uncommitted = (await dirty(dir)).length;
    const parts = [branch ?? 'detached', counts ? (counts.ahead || counts.behind ? `↑${counts.ahead} ↓${counts.behind}` : 'up to date') : 'not pushed',
      ...(uncommitted ? [`${uncommitted} uncommitted`] : [])];
    (result.repositories as Record<string, unknown>)[repository.name] = { branch, ...counts, uncommitted };
    rows.push([repository.name, parts.join('  ')]);
  }
  for (const resource of manifest.resources) {
    const state = workspace.resource(resource.id);
    const local = changed(localChanges(workspace, resource));
    const behind = Boolean(resource.revisionId && state.revisionId !== resource.revisionId);
    (result.resources as Record<string, unknown>)[resource.name] = { localChanges: local, newerOnServer: behind };
    rows.push([resource.name, [local ? `${local} file${local === 1 ? '' : 's'} changed locally` : '',
      behind ? 'newer version on the server' : '', !local && !behind ? 'up to date' : ''].filter(Boolean).join(', ')]);
  }
  if (manifest.secrets.length) rows.push(['secrets', manifest.secrets.map((secret) => secret.variable ?? secret.file ?? secret.name).join(', ')]);
  out.result(result, table(rows));
}

export async function diff(workspace: Workspace, out: Output, name?: string) {
  const resources = workspace.manifest.resources.filter((resource) => !name || resource.name === name || resource.id === name);
  if (name && !resources.length) throw new CliError(`no resource "${name}" in this workspace`, EXIT.notFound);
  const result: Record<string, unknown> = {};
  const lines: string[] = [];
  for (const resource of resources) {
    const changes = localChanges(workspace, resource);
    result[resource.name] = changes;
    if (!changed(changes)) continue;
    lines.push(`${resource.name} (${resource.path})`);
    for (const file of changes.added) lines.push(`  + ${file}`);
    for (const file of changes.modified) lines.push(`  M ${file}`);
    for (const file of changes.deleted) lines.push(`  - ${file}`);
  }
  out.result(result, lines.join('\n') || 'No local changes to resources.');
}

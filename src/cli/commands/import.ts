import fs from 'node:fs';
import path from 'node:path';
import type { Api } from '../api.js';
import { dataFolder, DATA_FOLDER_BYTES, exampleEnvironmentFile, likelySecret, regenerated, sqliteDatabase } from '../../domain/ignored-files.js';
import { git, gitOk } from '../git.js';
import { namesOrganization, slug, type Organization, type Project } from '../refs.js';
import { backupArgs, restic, resticError, summaryOf } from '../restic.js';
import { bytes, CliError, confirm, EXIT, interactive, table, type Output } from '../util.js';

interface Repository { id: string; owner: string; name: string; sshUrl: string }

interface Plan {
  environmentFiles: string[];
  secretFiles: string[];
  data: Array<{ path: string; shape: 'file' | 'directory'; bytes: number; access: 'read' | 'write' }>;
}

/** GitHub `owner/name` of a remote URL (ssh or https). */
export function githubRepository(remote: string): { owner: string; name: string } | undefined {
  const match = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

/** What `import` proposes for a checkout's ignored files (names and sizes; contents are read only to upload). */
export function planImport(root: string, ignored: string[]): Plan {
  const plan: Plan = { environmentFiles: [], secretFiles: [], data: [] };
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
    if (claimed.has(relative) || !relative.includes('/')) continue;
    const top = relative.split('/')[0]!;
    groups.set(top, (groups.get(top) ?? 0) + size(relative));
  }
  for (const [top, total] of groups) if (total >= DATA_FOLDER_BYTES || dataFolder(top))
    plan.data.push({ path: top, shape: 'directory', bytes: total, access: 'read' });
  return plan;
}

export async function importProject(api: Api, dir: string, out: Output, flags: Record<string, any>) {
  const requested = path.resolve(dir);
  const root = await gitOk(requested, ['rev-parse', '--show-toplevel'], `${requested} is not a Git checkout`).catch(() => {
    throw new CliError(`${requested} is not a Git checkout; import one repository at a time`, EXIT.usage);
  });
  // The configured URL: `remote get-url` would apply the user's insteadOf rewrites.
  const remote = await gitOk(root, ['config', '--get', 'remote.origin.url'], 'this checkout has no origin remote');
  const github = githubRepository(remote);
  if (!github) throw new CliError(`origin (${remote}) is not a GitHub repository; tavya projects use GitHub repositories`, EXIT.usage);

  const organizations = await api.get<Organization[]>('/api/organizations');
  const organization = flags.organization
    ? organizations.find((entry) => namesOrganization(entry, flags.organization!))
    : organizations.length === 1 ? organizations[0] : undefined;
  if (!organization) throw new CliError(flags.organization ? `no organization "${flags.organization}" that you can access`
    : `choose an organization with --organization (${organizations.map((entry) => entry.slug ?? slug(entry.name)).join(', ')})`, EXIT.usage);
  const repositories = await api.get<Repository[]>(`/api/organizations/${encodeURIComponent(organization.id)}/repositories`);
  const repository = repositories.find((entry) => entry.owner.toLowerCase() === github.owner.toLowerCase() && entry.name.toLowerCase() === github.name.toLowerCase());
  if (!repository) throw new CliError(`github.com/${github.owner}/${github.name} is not connected to ${organization.name}. `
    + `Give the tavya GitHub App access to it (${api.server}/${organization.slug ?? slug(organization.name)}/settings), then import again.`, EXIT.notFound);

  const ignored = (await git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
  const plan = planImport(root, ignored);
  const name = flags.name ?? repository.name;
  const rows = [
    ...plan.environmentFiles.map((file) => [file, 'secrets (each variable)']),
    ...plan.secretFiles.map((file) => [file, 'secret file']),
    ...plan.data.map((entry) => [entry.path, `data, ${bytes(entry.bytes)}${entry.access === 'write' ? ', tasks may change it through review' : ''}`]),
  ];
  out.info(`Import ${github.owner}/${github.name} as ${organization.slug ?? slug(organization.name)}/${slug(name)}${rows.length ? ', with:' : ''}`);
  if (rows.length) out.info(table(rows));
  if (!flags.yes && !(interactive() && await confirm('Continue?'))) {
    if (!interactive()) throw new CliError('re-run with --yes to import without a prompt', EXIT.usage);
    return out.result({ imported: false }, 'Nothing imported.');
  }

  const projects = await api.get<Project[]>(`/api/organizations/${encodeURIComponent(organization.id)}/projects`);
  let project = projects.find((entry) => slug(entry.name) === slug(name));
  if (!project) project = await api.post<Project>(`/api/organizations/${encodeURIComponent(organization.id)}/projects`, { name });
  const linked = await api.get<Array<{ repository: { id: string } }>>(`/api/projects/${encodeURIComponent(project.id)}/repositories`);
  if (!linked.some((entry) => entry.repository.id === repository.id))
    await api.post(`/api/projects/${encodeURIComponent(project.id)}/repositories`, { repositoryId: repository.id });

  const secretsBase = `/api/projects/${encodeURIComponent(project.id)}/secrets`;
  const secrets: string[] = [];
  for (const file of plan.environmentFiles) {
    const result = await api.post<{ imported: Array<{ name: string }> }>(secretsBase, { env: fs.readFileSync(path.join(root, file), 'utf8') });
    secrets.push(...result.imported.map((entry) => entry.name));
  }
  for (const file of plan.secretFiles) {
    const content = fs.readFileSync(path.join(root, file));
    if (content.includes(0) || content.toString('utf8').includes('�')) { out.warn(`${file}: binary; store it in the vault instead`); continue; }
    await api.post(secretsBase, { name: path.posix.basename(file), value: content.toString('utf8'), file });
    secrets.push(path.posix.basename(file));
  }
  const data: string[] = [];
  const existing = await api.get<Array<{ id: string; name: string; target?: { path?: string } }>>(`/api/projects/${encodeURIComponent(project.id)}/resources`);
  for (const entry of plan.data) {
    const resourceName = slug(entry.path).replace(/-/g, '_');
    const resource = existing.find((candidate) => candidate.target?.path === entry.path)
      ?? await api.post<{ id: string }>(`/api/projects/${encodeURIComponent(project.id)}/resources`, { name: resourceName, driver: 'volume@1',
        target: { kind: 'path', path: entry.path }, access: entry.access, publish: entry.access === 'write' ? 'review' : 'discard',
        source: { shape: entry.shape, imported: true } });
    const grant = await api.post<{ env: Record<string, string>; parent?: string }>(`/api/projects/${encodeURIComponent(project.id)}/resources/${encodeURIComponent(resource.id)}/append-grant`);
    const full = path.join(root, entry.path);
    out.info(`Uploading ${entry.path} (${bytes(entry.bytes)})…`);
    const run = await restic([...backupArgs(grant.parent), entry.shape === 'file' ? path.basename(full) : '.'], grant.env,
      { cwd: entry.shape === 'file' ? path.dirname(full) : full });
    if (run.code !== 0) throw resticError(run, `uploading ${entry.path}`);
    const snapshot = String(summaryOf(run.stdout).snapshot_id);
    const current = (await api.get<Array<{ id: string; currentRevisionId?: string }>>(`/api/projects/${encodeURIComponent(project.id)}/resources`))
      .find((candidate) => candidate.id === resource.id)?.currentRevisionId ?? null;
    await api.post(`/api/projects/${encodeURIComponent(project.id)}/resources/${encodeURIComponent(resource.id)}/revisions`, { snapshot, baseRevisionId: current });
    data.push(entry.path);
  }
  const ref = `${organization.slug ?? slug(organization.name)}/${slug(project.name)}`;
  out.result({ project, secrets, data }, `Imported into ${ref}: ${secrets.length} secret${secrets.length === 1 ? '' : 's'}, ${data.length} data item${data.length === 1 ? '' : 's'}.\n`
    + `Clone a workspace anywhere with: tavya clone ${ref}`);
}

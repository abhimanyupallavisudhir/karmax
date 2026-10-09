import fs from 'node:fs';
import path from 'node:path';
import type { Api } from '../api.js';
import { excludeFromGit, git } from '../git.js';
import { accessOf, createDataResource, kindOf, placeOf, projectSecrets, sizeOf, storeEnvironmentFile, storeSecretFile, type Kind, type Place } from '../onboard.js';
import { pushProjectResource } from '../resources.js';
import { digest } from '../secrets.js';
import { bytes, CliError, confirm, EXIT, interactive, table, type Output } from '../util.js';
import type { Workspace } from '../workspace.js';
import { fetchManifest } from './sync.js';

interface Located { value: string; absolute: string; world: string; place: Place; repository?: { name: string; dir: string; inner: string } }

/** A path given on the command line, as the project names it. */
async function locate(workspace: Workspace, value: string): Promise<Located> {
  const absolute = path.resolve(value);
  const world = workspace.worldPath(absolute);
  if (!world || world === '.' || world === '.tavya' || world.startsWith('.tavya/')) throw new CliError(`${value} is not inside this workspace`, EXIT.usage);
  const name = workspace.repositoryOf(world)?.name;
  const repository = name ? { name, dir: workspace.checkout(name), inner: world.slice(name.length + 1) } : undefined;
  if (repository && !repository.inner) throw new CliError(`${value} is a whole repository`, EXIT.usage);
  const place = placeOf(world, workspace.manifest);
  if (!place) throw new CliError(`${value} is outside the project's repositories`, EXIT.usage);
  return { value, absolute, world, place, ...(repository ? { repository } : {}) };
}

function projectWorkspace(workspace: Workspace): void {
  if (workspace.manifest.task) throw new CliError('tasks change a project\'s data through review; add it in a project workspace '
    + `(tavya clone ${workspace.manifest.organization.slug ?? workspace.manifest.organization.name}/${workspace.manifest.project.name})`, EXIT.usage);
}

/**
 * Keep more of what Git ignores in the project: a folder or file as data (a
 * new resource, pushed now), a secret file, or a .env's variables, as its
 * name suggests unless given with `--data` or `--secret`.
 */
export async function add(api: Api, workspace: Workspace, paths: Array<{ value: string; as?: 'data' | 'secret' }>, out: Output) {
  projectWorkspace(workspace);
  if (!paths.length) throw new CliError('usage: tavya add <path>… [--data <path>] [--secret <path>]', EXIT.usage);
  const projectId = workspace.manifest.project.id;
  const located: Array<Located & { directory: boolean; kind: Kind }> = [];
  for (const { value, as } of paths) {
    const stat = fs.statSync(path.resolve(value), { throwIfNoEntry: false });
    if (!stat) throw new CliError(`${value} does not exist`, EXIT.usage);
    const entry = await locate(workspace, value);
    if (entry.repository && (await git(entry.repository.dir, ['ls-files', '-z', '--', entry.repository.inner])).stdout)
      throw new CliError(`${value} is tracked by Git; tavya keeps what Git does not (git rm --cached it first)`, EXIT.usage);
    if (as === 'secret' && !stat.isFile()) throw new CliError(`${value}: only a file can be a secret`, EXIT.usage);
    const kind = kindOf(entry.world, stat.isDirectory(), as);
    const covering = workspace.manifest.resources.find((resource) => resource.path !== entry.world && entry.world.startsWith(`${resource.path}/`));
    if (covering && kind === 'data') throw new CliError(`${value} is already part of ${covering.path} (tavya push sends its changes)`, EXIT.usage);
    located.push({ ...entry, directory: stat.isDirectory(), kind });
  }

  const secrets = await projectSecrets(api, projectId);
  const rows: string[][] = [];
  const created: string[] = [];
  for (const entry of located) {
    if (entry.kind === 'env') {
      const { stored } = await storeEnvironmentFile(api, projectId, fs.readFileSync(entry.absolute, 'utf8'), entry.place, secrets, true);
      rows.push([entry.value, `.env: ${stored.join(', ') || 'no variables'}`]);
    } else if (entry.kind === 'secret') {
      const result = await storeSecretFile(api, projectId, entry.absolute, entry.place, secrets, true);
      if (result === 'binary') throw new CliError(`${entry.value} is binary; store it in the vault instead`, EXIT.usage);
      if (result !== 'kept') workspace.setSecretFile(entry.world, digest(fs.readFileSync(entry.absolute, 'utf8')));
      rows.push([entry.value, 'secret file']);
    } else {
      const existing = workspace.manifest.resources.find((resource) => resource.path === entry.world);
      if (existing) { rows.push([entry.value, 'already data (tavya push sends its changes)']); continue; }
      created.push((await createDataResource(api, projectId, entry.place, workspace.manifest.workdir, entry.directory ? 'directory' : 'file', accessOf(entry.world))).id);
      rows.push([entry.value, `data, ${bytes(sizeOf(entry.absolute))}`]);
    }
    if (entry.repository) excludeFromGit(entry.repository.dir, entry.repository.inner);
  }
  workspace.manifest = await fetchManifest(api, { projectId });
  workspace.save();
  for (const id of created) await pushProjectResource(api, workspace, workspace.manifest.resources.find((resource) => resource.id === id)!, out, false);
  out.result({ added: located.map((entry) => entry.world) }, table(rows));
}

/** Stop keeping a path in the project (its data's versions or its secret). Local files stay. */
export async function untrack(api: Api, workspace: Workspace, values: string[], out: Output, flags: { yes?: boolean }) {
  projectWorkspace(workspace);
  if (!values.length) throw new CliError('usage: tavya untrack <path>…', EXIT.usage);
  const projectId = workspace.manifest.project.id;
  const gone: Array<{ value: string; kind: 'data' | 'secret'; ids: string[]; world: string }> = [];
  for (const value of values) {
    const { world } = await locate(workspace, value);
    const resource = workspace.manifest.resources.find((candidate) => candidate.path === world);
    // A .env is its variables' lines: untracking it removes every one.
    const secrets = workspace.manifest.secrets.filter((candidate) => candidate.file === world || candidate.dotenv === world);
    if (!resource && !secrets.length) throw new CliError(`${value} is not kept in the project (tavya status lists what is)`, EXIT.notFound);
    gone.push({ value, kind: resource ? 'data' : 'secret', ids: resource ? [resource.id] : secrets.map((secret) => secret.id), world });
  }
  out.info(table(gone.map((entry) => [entry.value, entry.kind === 'data' ? 'data: its stored versions are deleted'
    : entry.ids.length > 1 ? `.env: its ${entry.ids.length} values are deleted` : 'secret: its value is deleted'])));
  if (!flags.yes && !(interactive() && await confirm('Stop keeping these in the project? Your local files stay.'))) {
    if (!interactive()) throw new CliError('re-run with --yes to untrack without a prompt', EXIT.usage);
    return out.result({ untracked: [] }, 'Nothing changed.');
  }
  for (const entry of gone) {
    for (const id of entry.ids) await api.request('DELETE', entry.kind === 'data'
      ? `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(id)}`
      : `/api/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(id)}`);
    if (entry.kind === 'secret') workspace.setSecretFile(entry.world, undefined);
  }
  workspace.manifest = await fetchManifest(api, { projectId });
  workspace.save();
  out.result({ untracked: gone.map((entry) => entry.world) }, `No longer kept: ${gone.map((entry) => entry.value).join(', ')}`);
}

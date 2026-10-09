import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { Api } from './api.js';
import { HttpError } from './api.js';
import { backupArgs, restic, resticError, summaryOf } from './restic.js';
import { excludeFromGit } from './git.js';
import { bytes, CliError, EXIT, type Output } from './util.js';
import { compareFingerprints, fingerprint, type Manifest, type Workspace } from './workspace.js';

type Resource = Manifest['resources'][number];
interface Grant { env: Record<string, string>; snapshot?: string; revisionId?: string; parent?: string }

export interface ResourceChanges { added: string[]; modified: string[]; deleted: string[] }

/** Local edits since the last pull or push (size or mtime changed, as restic sees it). */
export function localChanges(workspace: Workspace, resource: Resource): ResourceChanges {
  const state = workspace.resource(resource.id);
  return compareFingerprints(state.fingerprint ?? {}, fingerprint(workspace.path(resource.path)));
}

export function changed(changes: ResourceChanges): number {
  return changes.added.length + changes.modified.length + changes.deleted.length;
}

function progress(out: Output, label: string) {
  if (out.json || !process.stderr.isTTY) return undefined;
  let last = -1;
  return ({ percent, bytesDone, totalBytes }: { percent: number; bytesDone: number; totalBytes: number }) => {
    const shown = Math.floor(percent * 100);
    if (shown === last) return;
    last = shown;
    process.stderr.write(`\r${label} ${bytes(bytesDone)} of ${bytes(totalBytes)} (${shown}%)\x1b[K`);
  };
}

function done(out: Output) { if (!out.json && process.stderr.isTTY) process.stderr.write('\r\x1b[K'); }

/** Make the resource's files the version the workspace's project or task is on. */
export async function pullResource(api: Api, workspace: Workspace, resource: Resource, out: Output, force: boolean):
  Promise<'pulled' | 'current' | 'empty' | 'skipped'> {
  const target = workspace.path(resource.path);
  const state = workspace.resource(resource.id);
  const repository = workspace.repositoryOf(resource.path);
  if (repository && fs.existsSync(path.join(workspace.checkout(repository.name), '.git')))
    excludeFromGit(workspace.checkout(repository.name), path.posix.relative(repository.name, resource.path));
  if (!resource.revisionId) {
    if (resource.shape === 'directory') fs.mkdirSync(target, { recursive: true });
    workspace.setResource(resource.id, { fingerprint: fingerprint(target) });
    return 'empty';
  }
  const present = fs.existsSync(target);
  if (state.revisionId === resource.revisionId && present && !changed(localChanges(workspace, resource))) return 'current';
  if (!force && present) {
    const edits = state.fingerprint ? changed(localChanges(workspace, resource)) : Object.keys(fingerprint(target)).length;
    if (edits) {
      out.warn(`${resource.name}: ${edits} local change${edits === 1 ? '' : 's'} not pulled over; push them, or pull with --force to discard them`);
      return 'skipped';
    }
  }
  if (!resource.transferable) {
    out.warn(`${resource.name}: still being converted to the current storage format; pull again in an hour`);
    return 'skipped';
  }
  const grant = await api.post<Grant>(`${workspace.apiBase}/resources/${encodeURIComponent(resource.id)}/read-grant`, { revisionId: resource.revisionId });
  const label = `Pulling ${resource.name}`;
  out.info(`${label} (${bytes(resource.bytes)}, ${resource.files ?? 0} files)…`);
  if (resource.shape === 'file') {
    const scratch = workspace.scratch('restore');
    try {
      const run = await restic(['restore', grant.snapshot!, '--target', scratch, '--no-lock', '--json'], grant.env, { progress: progress(out, label) });
      done(out);
      if (run.code !== 0) throw resticError(run, `pulling ${resource.name}`);
      const entries = fs.readdirSync(scratch);
      if (entries.length !== 1) throw new CliError(`pulling ${resource.name}: expected one file`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(path.join(scratch, entries[0]!), target);
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  } else {
    fs.mkdirSync(target, { recursive: true });
    // --delete makes the folder exactly the version, but never inside a checkout's own .git.
    const mirror = !fs.existsSync(path.join(target, '.git'));
    const run = await restic(['restore', grant.snapshot!, '--target', target, '--no-lock', '--json', ...(mirror ? ['--delete'] : [])],
      grant.env, { progress: progress(out, label) });
    done(out);
    if (run.code !== 0) throw resticError(run, `pulling ${resource.name}`);
  }
  workspace.setResource(resource.id, { revisionId: grant.revisionId ?? resource.revisionId, snapshot: grant.snapshot, fingerprint: fingerprint(target) });
  return 'pulled';
}

/** Save the resource's files as a snapshot in its repository (an append grant
 * for the project, or for the task's own copy). Undefined when nothing changed. */
export async function saveResource(api: Api, workspace: Workspace, resource: Resource, out: Output): Promise<string | undefined> {
  const target = workspace.path(resource.path);
  if (!fs.existsSync(target)) throw new CliError(`${resource.name}: ${resource.path} does not exist`);
  const state = workspace.resource(resource.id);
  const grant = await api.post<Grant>(`${workspace.apiBase}/resources/${encodeURIComponent(resource.id)}/append-grant`,
    state.revisionId ? { baseRevisionId: state.revisionId } : {});
  const file = resource.shape === 'file' ? fs.realpathSync(target) : undefined;
  const label = `Pushing ${resource.name}`;
  out.info(`${label}…`);
  const run = await restic([...backupArgs(grant.parent), file ? path.basename(file) : '.'], grant.env,
    { cwd: file ? path.dirname(file) : target, progress: progress(out, label) });
  done(out);
  if (run.code !== 0) throw resticError(run, `pushing ${resource.name}`);
  return String(summaryOf(run.stdout).snapshot_id);
}

/** Push a project resource: a new current version, unless someone else's
 * version came first (then `overwrite` replaces it, else pull first). */
export async function pushProjectResource(api: Api, workspace: Workspace, resource: Resource, out: Output, overwrite: boolean):
  Promise<'pushed' | 'unchanged'> {
  const snapshot = await saveResource(api, workspace, resource, out);
  const state = workspace.resource(resource.id);
  const adopt = (baseRevisionId: string | null) => api.post<{ unchanged: boolean; revision?: { id: string } }>(
    `/api/projects/${encodeURIComponent(workspace.manifest.project.id)}/resources/${encodeURIComponent(resource.id)}/revisions`,
    { snapshot, baseRevisionId });
  let adopted;
  try { adopted = await adopt(state.revisionId ?? null); }
  catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409 || error.body.code !== 'resource_changed') throw error;
    if (!overwrite) throw new CliError(`${resource.name} changed on the server since you pulled it. Pull it first (your edits block that; `
      + 'move them aside), or push with --overwrite to replace the newer version', EXIT.conflict);
    adopted = await adopt((error.body.currentRevisionId as string | null) ?? null);
  }
  const target = workspace.path(resource.path);
  workspace.setResource(resource.id, { revisionId: adopted.revision?.id, snapshot, fingerprint: fingerprint(target) });
  return adopted.unchanged ? 'unchanged' : 'pushed';
}

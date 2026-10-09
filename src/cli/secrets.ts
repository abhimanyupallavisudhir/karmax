import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Api } from './api.js';
import { HttpError } from './api.js';
import { excludeFromGit } from './git.js';
import type { Output } from './util.js';
import type { Workspace } from './workspace.js';

export interface SecretValue { id: string; name: string; variable?: string; file?: string; value: string }

/** The project's secret values (audited by name on the server). */
export async function secretValues(api: Api, projectId: string, names?: string[]): Promise<SecretValue[]> {
  return (await api.post<{ secrets: SecretValue[] }>(`/api/projects/${encodeURIComponent(projectId)}/secrets/values`,
    names?.length ? { names } : {})).secrets;
}

export function environmentOf(secrets: SecretValue[]): Record<string, string> {
  return Object.fromEntries(secrets.filter((secret) => secret.variable).map((secret) => [secret.variable!, secret.value]));
}

export const digest = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Write file-shaped secrets where a world gets them (mode 0600, kept out of
 * Git). A file someone edited since tavya wrote it is left alone. Returns
 * false when the caller may not read secret values (it then pulls without them).
 */
export async function writeSecretFiles(api: Api, workspace: Workspace, out: Output, force = false): Promise<boolean> {
  const declared = workspace.manifest.secrets.filter((secret) => secret.file && secret.configured);
  if (!declared.length) return true;
  let secrets: SecretValue[];
  try { secrets = await secretValues(api, workspace.manifest.project.id, declared.map((secret) => secret.name)); }
  catch (error) {
    if (error instanceof HttpError && error.status === 403) {
      out.warn('secret files not written: reading project secrets needs Developer access (project:secret:use)');
      return false;
    }
    throw error;
  }
  const workdir = workspace.manifest.workdir;
  for (const secret of secrets) {
    if (!secret.file) continue;
    const relative = path.posix.normalize(path.posix.join(workdir, secret.file)).replace(/^\.\//, '');
    const target = workspace.path(relative);
    const written = workspace.secretFiles()[relative];
    if (fs.existsSync(target)) {
      const current = digest(fs.readFileSync(target, 'utf8'));
      if (current === digest(secret.value)) { workspace.setSecretFile(relative, current); continue; }
      if (!force && current !== written) { out.warn(`${relative}: changed locally; not overwritten (pull --force replaces it)`); continue; }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, secret.value, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    const repository = workspace.repositoryOf(relative);
    if (repository) excludeFromGit(workspace.path(repository.name), path.posix.relative(repository.name, relative));
    workspace.setSecretFile(relative, digest(secret.value));
  }
  return true;
}

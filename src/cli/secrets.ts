import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Api } from './api.js';
import { HttpError } from './api.js';
import { parseDotenv, renderDotenv } from '../domain/dotenv.js';
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
 * Git): each whole-file secret, and each `.env` from its variables. A file
 * someone edited since tavya wrote it is left alone. Returns false when the
 * caller may not read secret values (it then pulls without them).
 */
export async function writeSecretFiles(api: Api, workspace: Workspace, out: Output, force = false): Promise<boolean> {
  const declared = workspace.manifest.secrets.filter((secret) => (secret.file || secret.dotenv) && secret.configured);
  if (!declared.length) return true;
  let secrets: SecretValue[];
  try { secrets = await secretValues(api, workspace.manifest.project.id, [...new Set(declared.map((secret) => secret.name))]); }
  catch (error) {
    if (error instanceof HttpError && error.status === 403) {
      out.warn('secret files not written: reading project secrets needs Developer access (project:secret:use)');
      return false;
    }
    throw error;
  }
  const values = new Map(secrets.map((secret) => [secret.id, secret.value]));
  const files = new Map<string, { contents: string[]; variables: Array<{ name: string; value: string }> }>();
  for (const secret of declared) {
    const value = values.get(secret.id);
    if (value === undefined) continue;
    const relative = path.posix.normalize(secret.dotenv ?? secret.file!).replace(/^\.\//, '');
    const file = files.get(relative) ?? { contents: [], variables: [] };
    files.set(relative, file);
    if (secret.dotenv) file.variables.push({ name: secret.variable ?? secret.name, value });
    else file.contents.push(value);
  }
  for (const [relative, file] of files) {
    const content = [...file.contents, renderDotenv(file.variables.sort((a, b) => a.name.localeCompare(b.name)))].join('');
    const target = workspace.path(relative);
    const written = workspace.secretFiles()[relative];
    const repository = workspace.repositoryOf(relative);
    const exclude = () => { if (repository) excludeFromGit(workspace.path(repository.name), path.posix.relative(repository.name, relative)); };
    if (fs.existsSync(target)) {
      const text = fs.readFileSync(target, 'utf8');
      const current = digest(text);
      // A .env with these very variables is current however it is laid out (comments, order, quoting).
      if (current === digest(content) || (!file.contents.length && sameVariables(parseDotenv(text), file.variables))) {
        exclude(); workspace.setSecretFile(relative, current); continue;
      }
      if (!force && current !== written) { out.warn(`${relative}: changed locally; not overwritten (pull --force replaces it)`); continue; }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    exclude();
    workspace.setSecretFile(relative, digest(content));
  }
  return true;
}

function sameVariables(a: Array<{ name: string; value: string }>, b: Array<{ name: string; value: string }>): boolean {
  const map = new Map(a.map(({ name, value }) => [name, value]));
  return map.size === b.length && b.every(({ name, value }) => map.get(name) === value);
}

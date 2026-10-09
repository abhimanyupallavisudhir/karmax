import fs from 'node:fs';
import path from 'node:path';
import type { Api } from './api.js';
import { dotenvFile, parseDotenv } from '../domain/dotenv.js';
import { exampleEnvironmentFile, likelySecret, sqliteDatabase } from '../domain/ignored-files.js';
import { slug } from './refs.js';

/** What `import` and `add` make of a local file or folder: a .env's variables, a secret file, or data. */
export type Kind = 'env' | 'secret' | 'data';

export interface ProjectSecret { name: string; variable?: string; file?: string; dotenv?: { path: string; repository?: string } }

const isEnvironmentFile = (relative: string) => /^\.env(?:\.|$)/i.test(path.posix.basename(relative));

/** The kind a path is kept as: `--secret`/`--data` decide, else its name (directories are always data). */
export function kindOf(relative: string, directory: boolean, wanted?: 'secret' | 'data'): Kind {
  if (wanted === 'data' || directory) return 'data';
  const base = path.posix.basename(relative).toLowerCase();
  if (wanted === 'secret' || (likelySecret(base) && !exampleEnvironmentFile(base))) return isEnvironmentFile(relative) ? 'env' : 'secret';
  return 'data';
}

/** Data tasks may change through review (databases), or only read (everything else). */
export const accessOf = (relative: string): 'read' | 'write' => sqliteDatabase(relative) ? 'write' : 'read';

/** A world path (`<repository>/…`) as the project stores it: relative to the
 * working folder (the only development repository), else to the root. */
export function targetOf(worldPath: string, workdir: string): string | undefined {
  if (workdir === '.') return worldPath;
  const relative = path.posix.relative(workdir, worldPath);
  return relative && !relative.startsWith('..') ? relative : undefined;
}

export async function projectSecrets(api: Api, projectId: string): Promise<ProjectSecret[]> {
  return (await api.get<{ secrets: ProjectSecret[] }>(`/api/projects/${encodeURIComponent(projectId)}/secrets`)).secrets;
}

/** Variables a .env file sets. Ones the project already has keep their value
 * unless `overwrite`: a stored secret has no older version to go back to. */
export async function storeVariables(api: Api, projectId: string, text: string, existing: ProjectSecret[], overwrite: boolean):
  Promise<{ stored: string[]; kept: string[] }> {
  const stored: string[] = []; const kept: string[] = [];
  for (const { name, value } of parseDotenv(text)) {
    // A repository's own .env line is not the project's variable.
    if (!overwrite && existing.some((secret) => !secret.dotenv && (secret.variable === name || secret.name === name))) { kept.push(name); continue; }
    await api.post(`/api/projects/${encodeURIComponent(projectId)}/secrets`, { name, value });
    existing.push({ name, variable: name });
    stored.push(name);
  }
  return { stored, kept };
}

/** A file kept as a secret and written at `target` in every world and workspace.
 * Named after the file, or after its path when another secret has that name.
 * A .env keeps its variables as lines of that repository's file (named by
 * place), so they can differ from the project's and other repositories'. */
export async function storeSecretFile(api: Api, projectId: string, file: string, target: string, existing: ProjectSecret[],
  overwrite: boolean): Promise<{ name: string } | 'kept' | 'binary'> {
  const content = fs.readFileSync(file);
  if (content.includes(0) || content.toString('utf8').includes('�')) return 'binary';
  if (dotenvFile(target)) {
    const result = await api.post<{ imported: unknown[]; kept?: unknown[] }>(`/api/projects/${encodeURIComponent(projectId)}/secrets`,
      { env: content.toString('utf8'), file: target, overwrite });
    return result.imported.length || !result.kept?.length ? { name: target } : 'kept';
  }
  const same = existing.find((secret) => secret.file === target);
  if (same && !overwrite) return 'kept';
  const base = path.posix.basename(target);
  const name = same?.name ?? (existing.some((secret) => secret.name === base) ? target : base);
  await api.post(`/api/projects/${encodeURIComponent(projectId)}/secrets`, { name, value: content.toString('utf8'), file: target });
  if (!same) existing.push({ name, file: target });
  return { name };
}

/** A project resource for data at `target` (no version yet: pushing it makes one). */
export async function createDataResource(api: Api, projectId: string, target: string, shape: 'file' | 'directory',
  access: 'read' | 'write'): Promise<{ id: string }> {
  return api.post<{ id: string }>(`/api/projects/${encodeURIComponent(projectId)}/resources`, {
    name: slug(target).replace(/-/g, '_'), driver: 'volume@1', target: { kind: 'path', path: target }, access,
    publish: access === 'write' ? 'review' : 'discard', source: { shape, imported: true } });
}

/** Total size of a file or folder (symbolic links not followed). */
export function sizeOf(target: string): number {
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of fs.readdirSync(target)) total += sizeOf(path.join(target, entry));
  return total;
}

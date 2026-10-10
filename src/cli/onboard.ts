import fs from 'node:fs';
import path from 'node:path';
import type { Api } from './api.js';
import { dotenvFile, parseDotenv } from '../domain/dotenv.js';
import { exampleEnvironmentFile, likelySecret, sqliteDatabase } from '../domain/ignored-files.js';
import { slug } from './refs.js';

/** What `import` and `add` make of a local file or folder: a .env's variables, a secret file, or data. */
export type Kind = 'env' | 'secret' | 'data';

export interface Place { path: string; repository?: string }

export interface ProjectSecret { id?: string; name: string; variable?: string; file?: string; repository?: string; dotenv?: Place }

/** The kind a path is kept as: `--secret`/`--data` decide, else its name (directories are always data). */
export function kindOf(relative: string, directory: boolean, wanted?: 'secret' | 'data'): Kind {
  if (wanted === 'data' || directory) return 'data';
  const base = path.posix.basename(relative).toLowerCase();
  if (wanted === 'secret' || (likelySecret(base) && !exampleEnvironmentFile(base))) return dotenvFile(relative) ? 'env' : 'secret';
  return 'data';
}

/** Data tasks may change through review (databases), or only read (everything else). */
export const accessOf = (relative: string): 'read' | 'write' => sqliteDatabase(relative) ? 'write' : 'read';

/** Where the project keeps a world path (`<repository>/…`, or a root-level name):
 * pinned to its repository, so it stays put when the project gains or loses one.
 * Undefined for a root-level path in a one-repository project (it has no root folder). */
export function placeOf(worldPath: string, manifest: { workdir: string; repositories: Array<{ name: string; role: string }> }): Place | undefined {
  const repository = manifest.repositories.find((entry) => entry.role === 'development' && worldPath.startsWith(`${entry.name}/`));
  if (repository) return { repository: repository.name, path: worldPath.slice(repository.name.length + 1) };
  return manifest.workdir === '.' && !manifest.repositories.some((entry) => entry.name === worldPath) ? { path: worldPath } : undefined;
}

const samePlace = (a: Place | undefined, b: Place) => Boolean(a) && (a!.repository ?? '') === (b.repository ?? '')
  && a!.path.replace(/^\.\//, '') === b.path.replace(/^\.\//, '');

export async function projectSecrets(api: Api, projectId: string): Promise<ProjectSecret[]> {
  return (await api.get<{ secrets: ProjectSecret[] }>(`/api/projects/${encodeURIComponent(projectId)}/secrets`)).secrets;
}

/** A .env file's variables, as lines of that file in every world and workspace
 * (each repository keeps its own). Ones it already has keep their value unless
 * `overwrite`: a stored secret has no older version to go back to. */
export async function storeEnvironmentFile(api: Api, projectId: string, text: string, place: Place, existing: ProjectSecret[],
  overwrite: boolean): Promise<{ stored: string[]; kept: string[] }> {
  const stored: string[] = []; const kept: string[] = [];
  for (const { name, value } of parseDotenv(text)) {
    if (!overwrite && existing.some((secret) => secret.variable === name && samePlace(secret.dotenv, place))) { kept.push(name); continue; }
    await api.post(`/api/projects/${encodeURIComponent(projectId)}/secrets`, { name, value, file: place.path,
      ...(place.repository !== undefined ? { repository: place.repository } : {}) });
    existing.push({ name, variable: name, dotenv: place });
    stored.push(name);
  }
  return { stored, kept };
}

/** A file kept as a secret and written at its place in every world and workspace,
 * named by that place (two repositories may each have a credentials.json). */
export async function storeSecretFile(api: Api, projectId: string, file: string, place: Place, existing: ProjectSecret[],
  overwrite: boolean): Promise<{ name: string } | 'kept' | 'binary'> {
  const content = fs.readFileSync(file);
  if (content.includes(0) || content.toString('utf8').includes('\uFFFD')) return 'binary';
  const same = existing.find((secret) => secret.file !== undefined && samePlace({ path: secret.file, repository: secret.repository }, place));
  if (same && !overwrite) return 'kept';
  const name = same?.name ?? (place.repository !== undefined ? `${place.repository}/${place.path}` : place.path);
  await api.post(`/api/projects/${encodeURIComponent(projectId)}/secrets`, { name, value: content.toString('utf8'), file: place.path,
    ...(place.repository !== undefined ? { repository: place.repository } : {}) });
  if (!same) existing.push({ name, file: place.path, ...(place.repository !== undefined ? { repository: place.repository } : {}) });
  return { name };
}

/** A project resource for data at `place` (no version yet: pushing it makes one),
 * named after its path in the working folder (`data`; `api_data` among several repositories). */
export async function createDataResource(api: Api, projectId: string, place: Place, workdir: string, shape: 'file' | 'directory',
  access: 'read' | 'write'): Promise<{ id: string }> {
  const label = place.repository !== undefined && place.repository !== workdir ? `${place.repository}/${place.path}` : place.path;
  return api.post<{ id: string }>(`/api/projects/${encodeURIComponent(projectId)}/resources`, {
    name: slug(label).replace(/-/g, '_'), driver: 'volume@1',
    target: { kind: 'path', path: place.path, ...(place.repository !== undefined ? { repository: place.repository } : {}) }, access,
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

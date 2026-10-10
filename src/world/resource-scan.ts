import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../domain/types.js';
import { git } from './git.js';
import { remoteName } from './provision-git.js';
import { dotenvFile } from '../domain/dotenv.js';
import { dataFolder, DATA_FOLDER_BYTES, likelySecret, sqliteDatabase, variableName } from '../domain/ignored-files.js';

export interface ResourceProposal {
  id: string;
  repository: string;
  path: string;
  kind: 'secret' | 'sqlite' | 'files' | 'legacy-copy';
  bytes?: number;
  reason: string;
  suggested: {
    driver: 'secret@1' | 'volume@1';
    target: { kind: 'environment'; name: string } | { kind: 'path'; path: string; repository?: string };
    access: 'read' | 'write';
    isolation: 'fork';
    publish: 'discard' | 'review';
  };
}

/** Read-only, local onboarding scan. It inspects names and sizes of ignored
 * paths but never reads file contents and never uploads or creates a resource. */
export async function scanProjectResources(project: Project): Promise<{ proposals: ResourceProposal[]; unavailable: string[] }> {
  const proposals: ResourceProposal[] = [];
  const unavailable: string[] = [];
  for (const source of project.config.repos ?? []) {
    const repo = path.resolve(source);
    if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) { unavailable.push(source); continue; }
    const ignored = await git(repo, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']);
    if (ignored.code !== 0) { unavailable.push(source); continue; }
    const files = ignored.stdout.split('\0').filter(Boolean).filter(safeRelative);
    const claimed = new Set<string>();
    for (const relative of files) {
      const base = path.posix.basename(relative).toLowerCase();
      if (!likelySecret(base)) continue;
      claimed.add(relative);
      // A .env holds many variables: they stay lines of this repository's file.
      const dotenv = dotenvFile(base);
      proposals.push({ id: proposalId(source, relative), repository: source, path: relative, kind: 'secret',
        reason: dotenv ? 'Ignored .env file; its variables belong in this repository\'s copy of it. Contents were not read.'
          : 'Ignored filename commonly contains credentials; contents were not read.',
        suggested: { driver: 'secret@1', target: dotenv ? { kind: 'path', path: relative, repository: remoteName(source) }
          : { kind: 'environment', name: variableName(base) }, access: 'read', isolation: 'fork', publish: 'discard' } });
    }
    for (const relative of files) {
      if (claimed.has(relative) || !sqliteDatabase(relative)) continue;
      claimed.add(relative);
      proposals.push({ id: proposalId(source, relative), repository: source, path: relative, kind: 'sqlite',
        bytes: safeSize(repo, relative), reason: 'Ignored SQLite database; fork it transactionally per task.',
        suggested: { driver: 'volume@1', target: { kind: 'path', path: `resources/${safeSlug(relative)}` },
          access: 'write', isolation: 'fork', publish: 'review' } });
    }
    const groups = new Map<string, string[]>();
    for (const relative of files) {
      if (claimed.has(relative)) continue;
      const top = relative.split('/')[0]!;
      const values = groups.get(top) ?? [];
      values.push(relative); groups.set(top, values);
    }
    for (const [top, grouped] of groups) {
      const bytes = grouped.reduce((sum, relative) => sum + safeSize(repo, relative), 0);
      if (bytes < DATA_FOLDER_BYTES && !dataFolder(top)) continue;
      proposals.push({ id: proposalId(source, top), repository: source, path: top, kind: 'files', bytes,
        reason: `${grouped.length} ignored file${grouped.length === 1 ? '' : 's'} outside Git.`,
        suggested: { driver: 'volume@1', target: { kind: 'path', path: `resources/${safeSlug(top)}` },
          access: 'read', isolation: 'fork', publish: 'discard' } });
    }
    for (const glob of project.config.copyGlobs ?? []) proposals.push({ id: proposalId(source, `legacy:${glob}`),
      repository: source, path: glob, kind: 'legacy-copy', reason: 'Deprecated copyGlobs entry; verify and import it as a typed resource.',
      suggested: { driver: 'volume@1', target: { kind: 'path', path: `resources/${safeSlug(glob)}` },
        access: 'read', isolation: 'fork', publish: 'discard' } });
  }
  return { proposals: dedupe(proposals), unavailable };
}

function safeSlug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'data'; }
function safeRelative(value: string): boolean { return Boolean(value && !path.posix.isAbsolute(value) && !value.split('/').includes('..')); }
function safeSize(root: string, relative: string): number {
  try { const file = path.resolve(root, relative); return file.startsWith(`${root}${path.sep}`) ? fs.statSync(file).size : 0; }
  catch { return 0; }
}
function proposalId(repo: string, value: string): string { return Buffer.from(`${repo}\0${value}`).toString('base64url').slice(0, 80); }
function dedupe(values: ResourceProposal[]): ResourceProposal[] {
  return [...new Map(values.map((value) => [`${value.repository}\0${value.kind}\0${value.path}`, value])).values()];
}

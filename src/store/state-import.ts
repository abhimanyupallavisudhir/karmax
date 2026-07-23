import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../domain/types.js';
import { ProjectSecrets, parseEnv } from '../autonomy/project-secrets.js';
import { ProjectObjects } from './project-objects.js';
import { managedRepoPath } from '../world/worktree.js';
import { expandPath } from '../util/expand.js';

/**
 * The copyGlobs exit ramp (PLAN-state §5): classify the gitignored files the
 * project has been copying into each world and import them as first-class
 * state — after which the project no longer depends on the host checkout:
 * - `.env`-shaped files parse into individual env secrets;
 * - other small text files become file-shaped secrets at the same path;
 * - large or binary files become seed data objects.
 * The caller clears `copyGlobs` on success.
 */

const SMALL_TEXT_LIMIT = 64 * 1024;

export interface CopyGlobsImportResult {
  envSecrets: string[];
  fileSecrets: string[];
  objects: string[];
  skipped: string[];
}

export async function importCopyGlobs(args: {
  project: Project;
  secrets: ProjectSecrets;
  objects?: ProjectObjects;
}): Promise<CopyGlobsImportResult> {
  const result: CopyGlobsImportResult = { envSecrets: [], fileSecrets: [], objects: [], skipped: [] };
  const globs = args.project.config.copyGlobs ?? [];
  if (!globs.length) return result;
  const seen = new Set<string>();
  for (const source of args.project.config.repos ?? []) {
    const local = expandPath(source);
    const dir = fs.existsSync(local) ? local : fs.existsSync(managedRepoPath(source)) ? managedRepoPath(source) : undefined;
    if (!dir) continue;
    const entries = fs.readdirSync(dir);
    for (const glob of globs) {
      const re = globToRegExp(glob);
      for (const entry of entries) {
        if (!re.test(entry) || seen.has(entry)) continue;
        seen.add(entry);
        const file = path.join(dir, entry);
        let data: Buffer;
        try {
          if (!fs.statSync(file).isFile()) continue;
          data = fs.readFileSync(file);
        } catch {
          result.skipped.push(entry);
          continue;
        }
        if (!data.length) {
          result.skipped.push(entry);
          continue;
        }
        const isText = !data.includes(0);
        if (isText && /^\.env(\..*)?$/.test(entry) && parseEnv(data.toString('utf8')).length) {
          result.envSecrets.push(...args.secrets.importEnv(args.project.id, data.toString('utf8')));
        } else if (isText && data.length <= SMALL_TEXT_LIMIT) {
          const name = secretNameForFile(entry);
          args.secrets.save(args.project.id, { name, value: data.toString('utf8'), file: entry });
          result.fileSecrets.push(entry);
        } else if (args.objects) {
          await args.objects.put(args.project.id, { path: entry, mode: 'seed', data });
          result.objects.push(entry);
        } else {
          result.skipped.push(entry);
        }
      }
    }
  }
  return result;
}

/** service-account.json → SERVICE_ACCOUNT_JSON; names must be env-var-shaped. */
function secretNameForFile(file: string): string {
  const base = file.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase() || 'FILE';
  return /^[A-Za-z_]/.test(base) ? base : `FILE_${base}`;
}

function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

import fs from 'node:fs';
import path from 'node:path';
import type { Project } from '../domain/types.js';
import type { Store } from './db.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { ProjectResourceService } from '../world/resources.js';
import { parseEnv } from '../autonomy/project-secrets.js';
import { managedRepoPath } from '../world/worktree.js';
import { expandPath } from '../util/expand.js';

/**
 * The copyGlobs exit ramp (PLAN-state §5): classify the gitignored files the
 * project has been copying into each world and import them as TYPED RESOURCE
 * ATTACHMENTS — after which the project no longer depends on the host checkout:
 * - `.env`-shaped files parse into individual env-target secret@1 attachments;
 * - other small text files become path-target secret@1 attachments;
 * - large or binary files become volume@1 attachments with an initial revision.
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
  store: Store;
  broker: CredentialBroker;
  resources?: ProjectResourceService;
}): Promise<CopyGlobsImportResult> {
  const result: CopyGlobsImportResult = { envSecrets: [], fileSecrets: [], objects: [], skipped: [] };
  const { project, store, broker, resources } = args;
  const globs = project.config.copyGlobs ?? [];
  if (!globs.length) return result;
  const existing = () => new Set(store.listResourceAttachments(project.id).map((a) => a.name));
  const secretAttachment = (name: string, value: string, target: { kind: 'environment'; name: string } | { kind: 'path'; path: string }) => {
    const credential = `secret:${project.id}:${name}`;
    broker.registerHandle(credential, value);
    if (!existing().has(name)) {
      store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
        name, driver: 'secret@1', target, access: 'read', isolation: 'fork',
        source: {}, credentialHandles: [credential], publish: 'discard' });
    }
  };
  const seen = new Set<string>();
  for (const source of project.config.repos ?? []) {
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
          for (const parsed of parseEnv(data.toString('utf8'))) {
            secretAttachment(parsed.name, parsed.value, { kind: 'environment', name: parsed.name });
            result.envSecrets.push(parsed.name);
          }
        } else if (isText && data.length <= SMALL_TEXT_LIMIT) {
          secretAttachment(secretNameForFile(entry), data.toString('utf8'), { kind: 'path', path: entry });
          result.fileSecrets.push(entry);
        } else if (resources) {
          const attachment = store.createResourceAttachment({ organizationId: project.organizationId!,
            projectId: project.id, name: secretNameForFile(entry).toLowerCase(), driver: 'volume@1',
            target: { kind: 'path', path: entry }, access: 'read', isolation: 'fork',
            source: {}, credentialHandles: [], publish: 'discard' });
          await resources.importFiles(attachment.id, [{ path: entry, data }]);
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

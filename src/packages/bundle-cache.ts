import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { WorkflowBundle } from '@temporalio/worker';

type Inputs = { files: string[]; missing: string[]; contexts: string[] };
type Entry = Inputs & { digest: string; codeHash: string; bundle: WorkflowBundle };
export const bundleHash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

async function fingerprint(inputs: Inputs): Promise<string> {
  const hash = createHash('sha256');
  const visited = new Set<string>();
  const visit = async (file: string, recursive: boolean) => {
    try {
      const stat = await fs.stat(file);
      const real = await fs.realpath(file);
      if (stat.isFile()) hash.update(JSON.stringify([file, real, 'file', bundleHash(await fs.readFile(file))]));
      else if (stat.isDirectory()) {
        hash.update(JSON.stringify([file, real, 'directory']));
        if (recursive && !visited.has(real)) {
          visited.add(real);
          for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name), true);
        }
      } else throw new Error(`unsupported bundle input: ${file}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update(JSON.stringify([file, 'missing']));
    }
  };
  for (const file of [...new Set([...inputs.files, ...inputs.missing])].sort()) await visit(file, false);
  for (const dir of [...new Set(inputs.contexts)].sort()) await visit(dir, true);
  return hash.digest('hex');
}

/** Cache only complete, content-validated bundles. A broken/unwritable cache is
 * a build miss; it must never prevent startup or supply unverified code. */
export async function cachedWorkflowBundle(
  directory: string, identity: string,
  build: () => Promise<Inputs & { bundle: WorkflowBundle; reads?: Map<string, string> }>,
): Promise<WorkflowBundle> {
  const index = path.join(directory, `${bundleHash(identity)}.json`);
  try {
    const entry: Entry = JSON.parse(await fs.readFile(index, 'utf8'));
    if (bundleHash(entry.bundle.code) === entry.codeHash && await fingerprint(entry) === entry.digest)
      return entry.bundle;
  } catch { /* missing, obsolete, corrupt, or unreadable cache */ }
  const result = await build();
  try {
    // Compare the bytes webpack actually read, not just post-build mtimes. A
    // source changed during compilation must not be cached under its new bytes.
    for (const [file, digest] of result.reads ?? []) {
      if (bundleHash(await fs.readFile(file)) !== digest) return result.bundle;
    }
    const entry: Entry = { files: result.files, missing: result.missing, contexts: result.contexts,
      digest: await fingerprint(result), codeHash: bundleHash(result.bundle.code), bundle: result.bundle };
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${index}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(entry)); await fs.rename(temporary, index); }
    finally { await fs.rm(temporary, { force: true }); }
  } catch { /* best-effort cache; the freshly compiled bundle remains usable */ }
  return result.bundle;
}

import process from 'node:process';
import type { Api } from '../api.js';
import { readStdin } from '../util.js';
import { Workspace } from '../workspace.js';

/**
 * Git's credential helper protocol (`git help credential`), for organizations
 * that let members without GitHub access work through tavya. Configured by
 * `tavya clone --git-via-tavya`; answers only for this workspace's repositories,
 * with a short-lived token scoped to that one repository. Anything else is
 * left to the next helper (no output, exit 0).
 */
export async function gitCredential(api: () => Api, action: string): Promise<number> {
  if (action !== 'get') return 0; // store/erase: tokens are minted per request
  const fields = Object.fromEntries((await readStdin()).split('\n').filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  if (fields.protocol !== 'https' || fields.host !== 'github.com' || !fields.path) return 0;
  const workspace = Workspace.find();
  if (!workspace) return 0;
  const wanted = fields.path.replace(/\.git$/, '').toLowerCase();
  const repository = workspace.manifest.repositories.find((entry) => {
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(entry.sshUrl);
    return match?.[1]?.toLowerCase() === wanted;
  });
  if (!repository) return 0;
  try {
    // Git does not say whether it fetches or pushes: the token can write when you may write to the repository.
    const credential = await api().post<{ username: string; password: string; expiresAt: number }>(
      `/api/projects/${encodeURIComponent(workspace.manifest.project.id)}/git-credential`, { repository: repository.sshUrl });
    process.stdout.write(`username=${credential.username}\npassword=${credential.password}\npassword_expiry_utc=${Math.floor(credential.expiresAt / 1000)}\n`);
  } catch (error) {
    process.stderr.write(`tavya: ${(error as Error).message}\n`);
  }
  return 0;
}

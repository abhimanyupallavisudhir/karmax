import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './git.js';

/**
 * The first commit a repository with no commits gets: empty, with fixed
 * author, committer, date and message, so every world makes the same commit.
 *
 * Setup never writes to a remote. A cloud world clones with a read-only
 * token, so a push from there is always refused (tavya-error 40d814688b2054c8:
 * "Write access to repository not granted"). The world starts from this commit
 * as its own `origin/<base>`, and the trusted Git broker publishes it, with its
 * write credential, just before it first writes to that repository: the base
 * reaches GitHub before any task branch, so it becomes the default branch.
 * Because the commit is the same everywhere, concurrent tasks on one empty
 * repository, a restored world and a later enrollment all agree on their base.
 *
 * Never change these values: tasks record this commit as their base, and the
 * broker publishes only a base it recognizes as this commit.
 */
export const INITIAL_BASE_IDENTITY = { name: 'tavya', email: 'tavya@localhost' } as const;
export const INITIAL_BASE_DATE = '@0 +0000';
export const INITIAL_BASE_MESSAGE = 'tavya: initialize repository';

export const INITIAL_BASE_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: INITIAL_BASE_IDENTITY.name,
  GIT_AUTHOR_EMAIL: INITIAL_BASE_IDENTITY.email,
  GIT_AUTHOR_DATE: INITIAL_BASE_DATE,
  GIT_COMMITTER_NAME: INITIAL_BASE_IDENTITY.name,
  GIT_COMMITTER_EMAIL: INITIAL_BASE_IDENTITY.email,
  GIT_COMMITTER_DATE: INITIAL_BASE_DATE,
};

/** A shell command that writes the initial commit into the repository at
 * `repoRoot` and prints its id (for a provisioning target). */
export function initialBaseCommand(repoRoot: string): string {
  const repo = `git -C ${quote(repoRoot)}`;
  const env = Object.entries(INITIAL_BASE_ENV).map(([key, value]) => `${key}=${quote(value)}`).join(' ');
  return `tree=$(${repo} hash-object -w -t tree /dev/null) && ${env} ${repo} commit-tree --no-gpg-sign -m ${quote(INITIAL_BASE_MESSAGE)} "$tree"`;
}

/** Write the initial commit into the local repository `repo`; its id. */
export async function makeInitialBase(repo: string): Promise<string> {
  const tree = await git(repo, ['hash-object', '-w', '-t', 'tree', '/dev/null']);
  if (tree.code !== 0) throw new Error(`could not write an empty tree: ${tree.stderr || tree.stdout}`);
  const commit = await git(repo, ['commit-tree', '--no-gpg-sign', '-m', INITIAL_BASE_MESSAGE, tree.stdout.trim()],
    { env: { ...INITIAL_BASE_ENV } });
  if (commit.code !== 0) throw new Error(`could not write the initial commit: ${commit.stderr || commit.stdout}`);
  return commit.stdout.trim();
}

let initialBaseSha: Promise<string> | undefined;

/** The initial commit's id in a SHA-1 repository (what GitHub hosts). */
export function initialBaseId(): Promise<string> {
  initialBaseSha ??= (async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-initial-base-'));
    try {
      const init = await git(temp, ['init', '-q', '--bare']);
      if (init.code !== 0) throw new Error(init.stderr || init.stdout);
      return await makeInitialBase(temp);
    } finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }); }
  })();
  initialBaseSha.catch(() => { initialBaseSha = undefined; });
  return initialBaseSha;
}

/** Whether `sha` is the initial commit (a task started on an empty repository). */
export async function isInitialBase(sha: string | undefined): Promise<boolean> {
  return Boolean(sha) && sha === await initialBaseId();
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

import { expandPath } from '../util/expand.js';
import { git, gitOrThrow, isGitRepo } from './git.js';

export interface CloudGitSource {
  source: string;
  localPath?: string;
}

/** Resolve anything a local project can reasonably call a repository into the
 * SSH URL a cloud sandbox can clone. Local paths inherit their existing git
 * remote; ordinary HTTPS remotes are normalized to the provider's SSH form. */
export async function cloudGitSource(input: string): Promise<CloudGitSource> {
  const value = input.trim();
  const direct = sshSource(value);
  if (direct) return { source: direct };

  const localPath = expandPath(value);
  if (await isGitRepo(localPath)) {
    const root = await gitOrThrow(localPath, ['rev-parse', '--show-toplevel']);
    let remote = await git(root, ['remote', 'get-url', 'origin']);
    if (remote.code !== 0 || !remote.stdout.trim()) {
      const names = await git(root, ['remote']);
      const first = names.stdout.split(/\r?\n/).map((name) => name.trim()).find(Boolean);
      if (first) remote = await git(root, ['remote', 'get-url', first]);
    }
    if (remote.code !== 0 || !remote.stdout.trim())
      throw new Error(`Local repository "${input}" has no git remote. Add an SSH remote before running it in a cloud world.`);
    const source = sshSource(remote.stdout.trim());
    if (!source) throw new Error(
      `Local repository "${input}" has a host-local remote (${remote.stdout.trim()}). ` +
      'Cloud worlds need a network-reachable SSH remote such as git@github.com:org/repo.git.',
    );
    return { source, localPath: root };
  }

  throw new Error(
    `Repository "${input}" is neither a local git repository nor a network-reachable SSH git URL. ` +
    'Configure an SSH remote such as git@github.com:org/repo.git.',
  );
}

/** Accept SSH URLs and convert conventional HTTP(S) git URLs to SSH. File and
 * relative URLs intentionally return undefined: they cannot cross machines. */
export function sshSource(value: string): string | undefined {
  const source = value.trim();
  if (/^(?:ssh:\/\/|git@)[^\s]+$/i.test(source)) return source;
  if (!/^https?:\/\//i.test(source)) return undefined;
  try {
    const url = new URL(source);
    if (!url.hostname || url.username || url.password) return undefined;
    const pathname = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!pathname) return undefined;
    return `git@${url.hostname}:${pathname}${pathname.endsWith('.git') ? '' : '.git'}`;
  } catch { return undefined; }
}

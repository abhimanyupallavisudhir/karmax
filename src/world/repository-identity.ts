import path from 'node:path';

/** Stable repository identity for enrollment checks across equivalent Git URL spellings. */
export function canonicalRepositoryIdentity(input: string): string {
  const raw = input.trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return `file:${path.resolve(raw)}`;

  try {
    if (!raw.includes('://')) throw new Error('not a URL');
    const url = new URL(raw);
    if (url.protocol === 'file:') return `file:${path.resolve(decodeURIComponent(url.pathname))}`;
    return networkIdentity(`${url.hostname}${url.port ? `:${url.port}` : ''}`, decodeURIComponent(url.pathname));
  } catch {
    const scp = raw.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
    if (scp && !/^[A-Za-z]:[\\/]/.test(raw)) return networkIdentity(scp[1]!, scp[2]!);
    return raw.replace(/[\\/]+$/, '').replace(/\.git$/i, '');
  }
}

export function sameRepository(left: string, right: string): boolean {
  const identity = canonicalRepositoryIdentity(left);
  return identity.length > 0 && identity === canonicalRepositoryIdentity(right);
}

function networkIdentity(rawHost: string, rawPath: string): string {
  let host = rawHost.toLowerCase();
  if (host === 'ssh.github.com:443' || host === 'ssh.github.com') host = 'github.com';
  let repositoryPath = rawPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (host === 'github.com') repositoryPath = repositoryPath.toLowerCase();
  return `${host}/${repositoryPath}`;
}

/** `owner/name` of the GitHub repository a person pasted or typed: `owner/name`,
 * a clone URL (https, ssh, `git@`), or the address of any page in it
 * (`github.com/owner/name/tree/main`, `…/pull/3?tab=files`); else undefined. */
export function githubRepositoryOf(text: string): string | undefined {
  const raw = text.trim();
  const address = raw.match(/^(?:(?:https?|ssh|git):\/\/)?(?:[\w.-]+@)?(?:www\.|ssh\.)?github\.com(?::\d+)?[/:]([^?#]*)/i);
  const match = address
    ? address[1]!.match(/^\/*([A-Za-z0-9][A-Za-z0-9-]*)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/)
    : raw.match(/^([A-Za-z0-9][A-Za-z0-9-]*)\/([\w.-]+?)(?:\.git)?\/?$/);
  return match && !/^\.+$/.test(match[2]!) ? `${match[1]}/${match[2]}` : undefined;
}

const githubCloneUrl = /^(?:git@github\.com:|(?:ssh:\/\/git@|https?:\/\/)(?:ssh\.)?github\.com(?::\d+)?\/)[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/i;

/** The source a project keeps for a repository someone named: the catalog
 * repository it names (by any spelling), else a GitHub page or `owner/name` as
 * its https clone URL, else what was given (a clone URL, another host, a path). */
export function projectRepositorySource(text: string, catalog: ReadonlyArray<{ owner: string; name: string; sshUrl: string }> = []): string {
  const raw = text.trim();
  const slug = githubRepositoryOf(raw);
  const known = catalog.find((repository) => sameRepository(repository.sshUrl, raw)
    || (slug !== undefined && `${repository.owner}/${repository.name}`.toLowerCase() === slug.toLowerCase()));
  if (known) return known.sshUrl;
  return slug && !githubCloneUrl.test(raw) ? `https://github.com/${slug}.git` : raw;
}

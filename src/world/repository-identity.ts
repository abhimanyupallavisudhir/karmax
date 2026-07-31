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

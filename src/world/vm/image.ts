import { vmProvisionVersion } from './provision.js';

/**
 * karmax's VM image (environments/vm, wiki features/vm-worlds): stock Debian
 * plus the provisioning script, published by `.github/workflows/vm-image.yml`
 * on every merge whose provisioning version is new. Its tag *is* that version,
 * so a world booted from it finds its stamp and skips provisioning.
 */
export const VM_IMAGE_REPOSITORY = 'ghcr.io/abhimanyupallavisudhir/karmax-vm';
export const STOCK_VM_IMAGE = 'debian:bookworm';
const MISS_TTL_MS = 10 * 60_000;
const REQUEST_MS = 10_000;

export function vmImageRef(repository = process.env.KARMAX_VM_IMAGE_REPOSITORY || VM_IMAGE_REPOSITORY): string {
  return `${repository}:${vmProvisionVersion()}`;
}

const MANIFEST_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ');

/** Whether anyone can pull `ref` (`host/repository:tag`): the registry's
 * anonymous token flow, as a Fly machine pulling it would see it. Any failure
 * (private, missing, unreachable) is no. */
export async function imagePullable(ref: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const match = /^([^/]+)\/(.+):([^:/]+)$/.exec(ref);
  if (!match) return false;
  const [, host, repository, tag] = match;
  const manifest = `https://${host}/v2/${repository}/manifests/${tag}`;
  const ask = (headers: Record<string, string>) => fetchImpl(manifest, { method: 'HEAD',
    headers: { accept: MANIFEST_TYPES, ...headers }, signal: AbortSignal.timeout(REQUEST_MS) });
  try {
    let response = await ask({});
    if (response.status === 401) {
      const challenge = response.headers.get('www-authenticate') ?? '';
      const field = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(challenge)?.[1];
      const realm = field('realm');
      if (!realm) return false;
      const url = new URL(realm);
      for (const name of ['service', 'scope']) { const value = field(name); if (value) url.searchParams.set(name, value); }
      if (!url.searchParams.has('scope')) url.searchParams.set('scope', `repository:${repository}:pull`);
      const issued = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_MS) });
      if (!issued.ok) return false;
      const { token, access_token } = await issued.json() as { token?: string; access_token?: string };
      if (!token && !access_token) return false;
      response = await ask({ authorization: `Bearer ${token ?? access_token}` });
    }
    return response.ok;
  } catch {
    return false;
  }
}

/** The image a new VM world boots: the published one for this provisioning
 * version once anyone can pull it, stock Debian (which provisions itself)
 * until then. A hit is kept for good; a miss is asked again after 10 minutes. */
export class PublishedVmImage {
  private found = false;
  private missedAt?: number;

  constructor(private fetchImpl: typeof fetch = fetch, private ref = vmImageRef(), private now = () => Date.now()) {}

  async image(): Promise<string> {
    if (this.found) return this.ref;
    if (this.missedAt !== undefined && this.now() - this.missedAt < MISS_TTL_MS) return STOCK_VM_IMAGE;
    this.found = await imagePullable(this.ref, this.fetchImpl);
    if (this.found) return this.ref;
    this.missedAt = this.now();
    return STOCK_VM_IMAGE;
  }
}

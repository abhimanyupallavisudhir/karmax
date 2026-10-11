import { describe, expect, it } from 'vitest';
import { imagePullable, PublishedVmImage, vmImageRef } from '../src/world/vm/image.js';
import { vmProvisionVersion } from '../src/world/vm/provision.js';

/** A registry that answers like ghcr.io: an anonymous manifest request gets a
 * 401 naming its token service; a pull token then reads a public image. */
function registry(state: { public: boolean; tags: string[] }) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.startsWith('https://ghcr.io/token')) {
      return state.public ? new Response(JSON.stringify({ token: 'pull' }), { status: 200 }) : new Response('{}', { status: 403 });
    }
    const tag = /\/manifests\/([^/]+)$/.exec(url)?.[1];
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== 'Bearer pull') return new Response('', { status: 401, headers: {
      'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:owner/karmax-vm:pull"' } });
    return new Response('', { status: tag && state.tags.includes(tag) ? 200 : 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('the published VM image', () => {
  it('is tagged with the provisioning version, so a world booted from it skips provisioning', () => {
    expect(vmImageRef('ghcr.io/owner/karmax-vm')).toBe(`ghcr.io/owner/karmax-vm:${vmProvisionVersion()}`);
  });

  it('counts as available only when anyone can pull it', async () => {
    const state = { public: true, tags: ['v1'] };
    const { fetchImpl } = registry(state);
    expect(await imagePullable('ghcr.io/owner/karmax-vm:v1', fetchImpl)).toBe(true);
    expect(await imagePullable('ghcr.io/owner/karmax-vm:v2', fetchImpl)).toBe(false);
    state.public = false;
    expect(await imagePullable('ghcr.io/owner/karmax-vm:v1', fetchImpl)).toBe(false);
    const broken = (async () => { throw new Error('offline'); }) as typeof fetch;
    expect(await imagePullable('ghcr.io/owner/karmax-vm:v1', broken)).toBe(false);
  });

  // Merging publishes the image (vm-image.yml); a running tavya picks it up by
  // itself, and boots stock Debian (provisioning itself) until it exists.
  it('selects the published image once it exists, and stock Debian until then', async () => {
    const state = { public: false, tags: [] as string[] };
    const { fetchImpl, calls } = registry(state);
    let now = 0;
    const images = new PublishedVmImage(fetchImpl, 'ghcr.io/owner/karmax-vm:v1', () => now);
    expect(await images.image()).toBe('debian:bookworm');
    const asked = calls.length;
    now += 60_000;
    expect(await images.image()).toBe('debian:bookworm');
    expect(calls.length).toBe(asked); // a miss is remembered for a while
    state.public = true; state.tags.push('v1');
    now += 10 * 60_000;
    expect(await images.image()).toBe('ghcr.io/owner/karmax-vm:v1');
    const known = calls.length;
    now += 24 * 3_600_000;
    expect(await images.image()).toBe('ghcr.io/owner/karmax-vm:v1');
    expect(calls.length).toBe(known); // a published tag never goes away
  });
});

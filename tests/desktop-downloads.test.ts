// /download/desktop/* (wiki features/desktop-apps): the desktop app's update
// feed and stable download links, redirecting to the newest desktop-v* GitHub
// release of the public repository, cached, never confused by the CLI's
// cli-v* releases, drafts or pre-releases.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DESKTOP_ALIASES, DesktopReleases, serveDesktopDownload } from '../src/gateway/desktop-downloads.js';

const asset = (tag: string, name: string, size = 100) => ({ name, size, browser_download_url: `https://github.com/o/r/releases/download/${tag}/${name}` });
const release = (tag: string, names: string[], extra: Record<string, unknown> = {}) =>
  ({ tag_name: tag, draft: false, prerelease: false, published_at: '2026-11-28T10:00:00Z', assets: names.map((name) => asset(tag, name)), ...extra });
const files = (version: string) => [`tavya-${version}-universal.dmg`, `tavya-${version}-universal-mac.zip`, `tavya-${version}-universal-mac.zip.blockmap`,
  `tavya-${version}-x86_64.AppImage`, `tavya-${version}-arm64.AppImage`, `tavya_${version}_amd64.deb`, `tavya_${version}_arm64.deb`,
  'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml'];
const LIST = [
  release('cli-v1.9.0', ['tavya-linux-x64']),
  release('desktop-v1.3.0-beta.1', files('1.3.0-beta.1'), { prerelease: true }),
  release('desktop-v1.2.0', files('1.2.0'), { draft: true }),
  release('desktop-v1.0.0', files('1.0.0')),
  release('desktop-v1.1.0', files('1.1.0')),
];

function fakeGitHub(answers: Array<() => Response>) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL) => {
    calls.push(String(url));
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    return next();
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe('DesktopReleases', () => {
  it('picks the newest published desktop-v* release by version, not by list order', async () => {
    const { calls, fetcher } = fakeGitHub([() => Response.json(LIST)]);
    const releases = new DesktopReleases({ repo: 'o/r', fetch: fetcher });
    const latest = await releases.latest();
    expect(latest?.version).toBe('1.1.0');
    expect(latest?.tag).toBe('desktop-v1.1.0');
    expect(calls).toEqual(['https://api.github.com/repos/o/r/releases?per_page=50']);
    expect(releases.resolve('tavya-mac.dmg')).toBe('https://github.com/o/r/releases/download/desktop-v1.1.0/tavya-1.1.0-universal.dmg');
    expect(releases.resolve('tavya-linux-x64.AppImage')).toMatch(/desktop-v1\.1\.0\/tavya-1\.1\.0-x86_64\.AppImage$/);
    expect(releases.resolve('tavya-linux-arm64.AppImage')).toMatch(/tavya-1\.1\.0-arm64\.AppImage$/);
    expect(releases.resolve('tavya-linux-x64.deb')).toMatch(/tavya_1\.1\.0_amd64\.deb$/);
    expect(releases.resolve('tavya-linux-arm64.deb')).toMatch(/tavya_1\.1\.0_arm64\.deb$/);
    expect(releases.resolve('latest-mac.yml')).toBe('https://github.com/o/r/releases/download/desktop-v1.1.0/latest-mac.yml');
    // An older version's file (electron-updater's differential download reads the old blockmap).
    expect(releases.resolve('tavya-1.0.0-universal-mac.zip.blockmap')).toMatch(/desktop-v1\.0\.0\/tavya-1\.0\.0-universal-mac\.zip\.blockmap$/);
    expect(releases.resolve('tavya-1.2.0-universal.dmg')).toBeNull();
    expect(releases.resolve('tavya-linux-x64')).toBeNull();
    expect(Object.keys(DESKTOP_ALIASES).sort()).toEqual(['tavya-linux-arm64.AppImage', 'tavya-linux-arm64.deb', 'tavya-linux-x64.AppImage', 'tavya-linux-x64.deb', 'tavya-mac.dmg']);
  });

  it('caches, asks GitHub once for concurrent requests, and keeps the last answer when GitHub fails', async () => {
    let now = 0;
    const { calls, fetcher } = fakeGitHub([() => Response.json(LIST), () => new Response('rate limited', { status: 403 })]);
    const releases = new DesktopReleases({ repo: 'o/r', fetch: fetcher, now: () => now, ttlMs: 1000 });
    await Promise.all([releases.latest(), releases.latest(), releases.latest()]);
    expect(calls).toHaveLength(1);
    now = 500;
    await releases.latest();
    expect(calls).toHaveLength(1);
    now = 2000;
    expect((await releases.latest())?.version).toBe('1.1.0');
    expect(calls).toHaveLength(2);
  });

  it('has no release before the first one is published', async () => {
    const { fetcher } = fakeGitHub([() => Response.json([release('cli-v1.0.0', ['x'])])]);
    const releases = new DesktopReleases({ repo: 'o/r', fetch: fetcher });
    expect(await releases.latest()).toBeNull();
    expect(releases.resolve('latest-linux.yml')).toBeNull();
  });
});

describe('serveDesktopDownload', () => {
  let server: http.Server;
  let base: string;
  let available = true;
  beforeAll(async () => {
    const { fetcher } = fakeGitHub([() => available ? Response.json(LIST) : Response.json([])]);
    const releases = new DesktopReleases({ repo: 'o/r', fetch: fetcher, ttlMs: 0 });
    server = http.createServer((req, res) => {
      const p = new URL(req.url!, 'http://x').pathname;
      void serveDesktopDownload(req, res, p, releases).then((handled) => { if (!handled) { res.writeHead(418); res.end(); } });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('redirects feed files, stable names and versioned files to the release asset', async () => {
    for (const [path, target] of [
      ['/download/desktop/latest-linux.yml', /desktop-v1\.1\.0\/latest-linux\.yml$/],
      ['/download/desktop/latest-mac.yml', /desktop-v1\.1\.0\/latest-mac\.yml$/],
      ['/download/desktop/tavya-mac.dmg', /tavya-1\.1\.0-universal\.dmg$/],
      ['/download/desktop/tavya-1.1.0-x86_64.AppImage', /desktop-v1\.1\.0\/tavya-1\.1\.0-x86_64\.AppImage$/],
    ] as const) {
      const response = await fetch(`${base}${path}`, { redirect: 'manual' });
      expect(response.status, path).toBe(302);
      expect(response.headers.get('location'), path).toMatch(target);
      expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    }
    const head = await fetch(`${base}/download/desktop/tavya-linux-x64.deb`, { method: 'HEAD', redirect: 'manual' });
    expect(head.status).toBe(302);
  });

  it('describes the newest release as JSON for the download page', async () => {
    const response = await fetch(`${base}/download/desktop/latest.json`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: '1.1.0', publishedAt: '2026-11-28T10:00:00Z',
      files: {
        'tavya-mac.dmg': { name: 'tavya-1.1.0-universal.dmg', size: 100 },
        'tavya-linux-x64.AppImage': { name: 'tavya-1.1.0-x86_64.AppImage', size: 100 },
        'tavya-linux-arm64.AppImage': { name: 'tavya-1.1.0-arm64.AppImage', size: 100 },
        'tavya-linux-x64.deb': { name: 'tavya_1.1.0_amd64.deb', size: 100 },
        'tavya-linux-arm64.deb': { name: 'tavya_1.1.0_arm64.deb', size: 100 },
      },
    });
  });

  it('sends the bare folder to the download page and refuses what is not a file of a release', async () => {
    const folder = await fetch(`${base}/download/desktop/`, { redirect: 'manual' });
    expect(folder.status).toBe(302);
    expect(folder.headers.get('location')).toBe('/download');
    expect((await fetch(`${base}/download/desktop/..%2f..%2fetc%2fpasswd`)).status).toBe(404);
    expect((await fetch(`${base}/download/desktop/nothing.yml`)).status).toBe(404);
    expect((await fetch(`${base}/download/desktop/latest-linux.yml`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/download/other`)).status).toBe(418);
  });

  it('answers 404 before the first release, so an app reads it as up to date', async () => {
    available = false;
    try {
      expect((await fetch(`${base}/download/desktop/latest-linux.yml`, { redirect: 'manual' })).status).toBe(404);
      expect(await (await fetch(`${base}/download/desktop/latest.json`)).json()).toEqual({ version: null, files: {} });
    } finally { available = true; }
  });
});

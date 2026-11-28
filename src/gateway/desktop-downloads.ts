// The desktop apps' downloads and update feed (wiki features/desktop-apps):
// /download/desktop/<file> redirects to that file of the newest desktop-v*
// GitHub release of the public repository (KARMAX_DESKTOP_RELEASES_REPO,
// default abhimanyupallavisudhir/karmax). electron-updater's generic provider
// reads latest-mac.yml / latest-linux.yml / latest-linux-arm64.yml here and
// then the files they name (relative to this folder); the /download page links
// the stable names in DESKTOP_ALIASES and reads latest.json. Only published,
// non-prerelease desktop-v<semver> releases count, so the CLI's cli-v*
// releases never confuse it. GitHub's answer is cached (10 min; the last good
// one is kept while GitHub fails) and one request is in flight at a time, well
// inside the 60 unauthenticated API calls an hour GitHub allows.
import type http from 'node:http';

export const DESKTOP_DOWNLOADS_PREFIX = '/download/desktop';
export const DEFAULT_DESKTOP_RELEASES_REPO = 'abhimanyupallavisudhir/karmax';

/** Stable names → the release file they stand for (electron-builder's artifact names, desktop/electron-builder.config.cjs). */
export const DESKTOP_ALIASES: Record<string, RegExp> = {
  'tavya-mac.dmg': /^tavya-[^/]+-universal\.dmg$/,
  'tavya-linux-x64.AppImage': /^tavya-[^/]+-x86_64\.AppImage$/,
  'tavya-linux-arm64.AppImage': /^tavya-[^/]+-arm64\.AppImage$/,
  'tavya-linux-x64.deb': /^tavya_[^/]+_amd64\.deb$/,
  'tavya-linux-arm64.deb': /^tavya_[^/]+_arm64\.deb$/,
};

const TAG = /^desktop-v(\d+)\.(\d+)\.(\d+)$/;
const FILE_NAME = /^[A-Za-z0-9._-]+$/;

interface GitHubRelease {
  tag_name?: string; draft?: boolean; prerelease?: boolean; published_at?: string | null;
  assets?: Array<{ name?: string; size?: number; browser_download_url?: string }>;
}
export interface DesktopRelease {
  version: string; tag: string; publishedAt: string | null;
  assets: Array<{ name: string; size: number; url: string }>;
}

function versionKey(tag: string): number[] {
  return TAG.exec(tag)!.slice(1).map(Number);
}
function newer(a: string, b: string): number {
  const [x, y] = [versionKey(a), versionKey(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

export class DesktopReleases {
  private readonly repo: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private releases: DesktopRelease[] | null = null;
  private fetchedAt = -Infinity;
  private inFlight: Promise<void> | null = null;

  constructor(options: { repo?: string; fetch?: typeof fetch; now?: () => number; ttlMs?: number } = {}) {
    this.repo = options.repo || DEFAULT_DESKTOP_RELEASES_REPO;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
  }

  /** Published desktop releases, newest first (cached). */
  async list(): Promise<DesktopRelease[]> {
    if (this.now() - this.fetchedAt >= this.ttlMs || !this.releases) {
      this.inFlight ??= this.refresh().finally(() => { this.inFlight = null; });
      await this.inFlight;
    }
    return this.releases ?? [];
  }

  async latest(): Promise<DesktopRelease | null> {
    return (await this.list())[0] ?? null;
  }

  /** Where a file of the cached releases is: a stable name, or a file of the newest release that has it. */
  resolve(file: string): string | null {
    const releases = this.releases ?? [];
    const alias = DESKTOP_ALIASES[file];
    if (alias) return releases[0]?.assets.find((entry) => alias.test(entry.name))?.url ?? null;
    for (const release of releases) {
      const found = release.assets.find((entry) => entry.name === file);
      if (found) return found.url;
    }
    return null;
  }

  private async refresh(): Promise<void> {
    try {
      const response = await this.fetcher(`https://api.github.com/repos/${this.repo}/releases?per_page=50`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'tavya-desktop-downloads', 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      const body = await response.json() as GitHubRelease[];
      this.releases = (Array.isArray(body) ? body : [])
        .filter((release) => !release.draft && !release.prerelease && TAG.test(release.tag_name ?? ''))
        .sort((a, b) => newer(b.tag_name!, a.tag_name!))
        .map((release) => ({
          version: TAG.exec(release.tag_name!)!.slice(1).join('.'), tag: release.tag_name!, publishedAt: release.published_at ?? null,
          assets: (release.assets ?? []).filter((entry) => entry.name && entry.browser_download_url?.startsWith('https://'))
            .map((entry) => ({ name: entry.name!, size: entry.size ?? 0, url: entry.browser_download_url! })),
        }));
      this.fetchedAt = this.now();
    } catch (error) {
      console.warn(`[downloads] desktop releases: ${(error as Error).message}`);
      // Keep what we had; try again in a minute rather than on every request.
      this.fetchedAt = this.now() - this.ttlMs + Math.min(this.ttlMs, 60_000);
    }
  }
}

/** Answers /download/desktop[/…]; false for any other path. */
export async function serveDesktopDownload(req: http.IncomingMessage, res: http.ServerResponse, path: string, releases: DesktopReleases): Promise<boolean> {
  if (path !== DESKTOP_DOWNLOADS_PREFIX && !path.startsWith(`${DESKTOP_DOWNLOADS_PREFIX}/`)) return false;
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return true;
  }
  const file = path.slice(DESKTOP_DOWNLOADS_PREFIX.length).replace(/^\//, '');
  if (!file) {
    res.writeHead(302, { location: '/download', 'cache-control': 'public, max-age=3600' });
    res.end();
    return true;
  }
  const latest = FILE_NAME.test(file) ? await releases.latest() : null;
  if (file === 'latest.json') {
    const files: Record<string, { name: string; size: number }> = {};
    for (const [alias, pattern] of Object.entries(DESKTOP_ALIASES)) {
      const found = latest?.assets.find((entry) => pattern.test(entry.name));
      if (found) files[alias] = { name: found.name, size: found.size };
    }
    const body = JSON.stringify(latest ? { version: latest.version, publishedAt: latest.publishedAt, files } : { version: null, files: {} });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
    res.end(method === 'HEAD' ? undefined : body);
    return true;
  }
  const target = latest ? releases.resolve(file) : null;
  if (!target) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=60' });
    res.end(method === 'HEAD' ? undefined : 'Not found');
    return true;
  }
  res.writeHead(302, { location: target, 'cache-control': 'public, max-age=300' });
  res.end();
  return true;
}

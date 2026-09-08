import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emailHtml } from '../src/auth/identity.js';
import { BRAND_ICONS, BRAND_FILES, DEFAULT_BRAND_ICON, brandIconOf, isBrandIcon } from '../src/domain/brand.js';

const webDir = fileURLToPath(new URL('../web', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('brand icon selection', () => {
  it('defaults to the diamond when unset, and survives a bad stored value', () => {
    expect(brandIconOf(undefined)).toBe('diamond');
    expect(brandIconOf({})).toBe(DEFAULT_BRAND_ICON);
    // A variant removed by a downgrade (or a hand-edited row) must not break the UI.
    expect(brandIconOf({ icon: 'no-such-icon' })).toBe('diamond');
    expect(brandIconOf({ icon: 42 })).toBe('diamond');
  });

  it('accepts exactly the known icons', () => {
    expect(BRAND_ICONS).toEqual(['diamond', 'knot', 'check', 'check-arrow', 'check-knot', 'check-knot-tilted', 'check-knot-purple', 'check-knot-purple-arrow', 'clover']);
    for (const icon of BRAND_ICONS) expect(isBrandIcon(icon)).toBe(true);
    expect(isBrandIcon('Diamond')).toBe(false);
    expect(isBrandIcon('../../etc/passwd')).toBe(false);
    expect(brandIconOf({ icon: 'knot' })).toBe('knot');
  });

  it('ships raster assets for every icon, so a switch never leaves a hole', () => {
    for (const icon of BRAND_ICONS) {
      for (const file of BRAND_FILES) {
        if (file === 'icon.svg') continue; // Vector art is optional per variant.
        const asset = path.join(webDir, 'brand', icon, file);
        expect(fs.existsSync(asset), `${icon}/${file}`).toBe(true);
        expect(fs.statSync(asset).size).toBeGreaterThan(0);
      }
    }
  });

  it('ships the check-arrow vector source used to render its raster sizes', () => {
    const svg = fs.readFileSync(path.join(webDir, 'brand', 'check-arrow', 'icon.svg'), 'utf8');
    expect(svg).toContain('viewBox="0 0 512 512"');
    expect(svg).toContain('aria-label="Checkmark ending in an arrow"');
  });

  it('points the static shell at the setting-resolved /brand path, not a variant', () => {
    const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(webDir, 'app.webmanifest'), 'utf8'));
    expect(html).toContain('href="/brand/icon.svg"');
    expect(html).toContain('href="/brand/apple-touch-icon.png"');
    for (const entry of manifest.icons) {
      expect(entry.src).toMatch(/^\/brand\/[^/]+$/);
    }
  });

  it('keeps the web picker in step with the server vocabulary', () => {
    const app = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
    const choices = app.match(/const BRAND_ICON_CHOICES = \[([\s\S]*?)\n\];/)?.[1] ?? '';
    const ids = [...choices.matchAll(/\{ id: '([a-z-]+)', label: '[A-Za-z ]+' \}/g)].map((m) => m[1]);
    expect(ids).toEqual([...BRAND_ICONS]);
  });
});

/**
 * The product's display name is `krmax`.
 *
 * Technical identifiers deliberately keep the original `karmax` spelling: env
 * vars (`KARMAX_*`), the state home (`~/.karmax`), the SQLite file, task
 * branches (`karmax/<taskId>`), localStorage keys, the npm package and its
 * `karmax` CLI, and the platform MCP namespace are wiring rather than branding —
 * renaming them would break existing installations, sessions, and in-flight
 * tasks. This suite guards the surfaces a human actually reads.
 */
const BRAND = 'Krmax';
const brand = 'krmax';

describe('branding — installable app shell', () => {
  it('names the app in the PWA manifest', () => {
    const manifest = JSON.parse(read('web/app.webmanifest'));
    expect(manifest.name).toBe(BRAND);
    expect(manifest.short_name).toBe(BRAND);
  });

  it('names the app in the document and home-screen titles', () => {
    const html = read('web/index.html');
    expect(html).toContain(`<title>${brand}</title>`);
    expect(html).toContain(`content="${BRAND}"`);
  });
});

describe('branding — web console', () => {
  it('renders the display name beside the brand mark in the shell and login', () => {
    const app = read('web/app.js');
    // The topbar, the login card, and the first-run setup card are the three
    // places the name is shown next to the mark.
    expect(app).toContain(`\${brandMark()} ${brand}`);
    expect(app).toContain(`Set up ${brand}`);
  });

  it('leaves no stale product name anywhere in the console assets', () => {
    // Nothing in web/ is an identifier or a path, so the capitalized product
    // name can only ever be display copy (or a comment about it) here.
    for (const file of ['app.js', 'index.html', 'app.webmanifest', 'styles.css', 'service-worker.js']) {
      expect(read(`web/${file}`), `web/${file}`).not.toMatch(/Karmax/);
    }
  });
});

describe('branding — transactional email', () => {
  it('brands the shared email chrome', () => {
    const html = emailHtml('Heading', 'Body', 'Do it', 'https://example.test/a', 'Footer');
    expect(html).toContain(`◇ ${brand}`);
    expect(html).not.toMatch(/karmax/i);
  });

  it('brands the account emails a signed-up human receives', () => {
    const identity = read('src/auth/identity.ts');
    expect(identity).toContain(`Reset your ${brand} password`);
    expect(identity).toContain(`Confirm your ${brand} email`);
    expect(identity).toContain(`appName: '${brand}'`);
    expect(identity).not.toMatch(/your karmax (password|email|account)/i);
  });

  it('brands the organization invitation email', () => {
    const gateway = read('src/gateway/server.ts');
    expect(gateway).toContain(`on ${brand}`);
    expect(gateway).not.toMatch(/on karmax/);
    expect(gateway).not.toMatch(/a karmax organization/);
  });
});

describe('branding — pages and notices outside the console', () => {
  it('brands the OAuth callback pages served to the browser', () => {
    const gateway = read('src/gateway/server.ts');
    expect(gateway).toContain(`<title>${BRAND} · GitHub</title>`);
    expect(gateway).toContain(`<title>${BRAND} · Stripe</title>`);
    expect(gateway).toContain(`Return to ${BRAND}`);
    expect(gateway).not.toMatch(/Karmax ·|Return to Karmax/);
  });

  it('brands Phone Access status copy', () => {
    const access = read('src/remote/access.ts');
    expect(access).toContain(`${BRAND} stays on localhost`);
    expect(access).not.toMatch(/Karmax (could not|left that)/);
  });

  it('brands the notices the platform posts into a task conversation', () => {
    expect(read('src/platform/api.ts')).toContain(`${BRAND} recovered this task`);
    expect(read('src/gateway/server.ts')).toContain(`[${BRAND} credential decision]`);
  });

  it('keeps Prometheus metric names stable while branding their help text', () => {
    const gateway = read('src/gateway/server.ts');
    expect(gateway).toContain('karmax_info 1');
    expect(gateway).toContain(`karmax_info ${BRAND} control-plane information.`);
  });
});

describe('branding — operator-facing output', () => {
  it('brands the boot banner', () => {
    const main = read('src/main.ts');
    expect(main).toContain(`✓ ${brand} is running`);
    expect(main).toContain(`'\\n  ${brand} ' + VERSION`);
    expect(main).not.toMatch(/karmax (is running|failed to start)/);
  });

  it('brands the process-manager and runner labels', () => {
    expect(read('src/util/processes.ts')).toContain(`${brand} (gateway + worker)`);
    expect(read('src/world/runners.ts')).toContain('organization BYOK');
    expect(read('src/world/runners.ts')).not.toContain(`${BRAND} managed`);
  });

  it('brands the backup/restore command output', () => {
    const backup = read('src/ops/backup.ts');
    expect(backup).toContain(`stop ${BRAND} before restore`);
    expect(backup).not.toMatch(/Karmax backup manifest/);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emailHtml } from '../src/auth/identity.js';
import { policyDocument, publicLaunchInfo } from '../src/launch/legal.js';
import { BRAND_ICONS, BRAND_FILES, DEFAULT_BRAND_ICON, DEFAULT_SITE_NAME, MAX_SITE_NAME_LENGTH,
  brandIconOf, isBrandIcon, siteNameError, siteNameOf } from '../src/domain/brand.js';

const webDir = fileURLToPath(new URL('../web', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('installation identity', () => {
  it('defaults safely and accepts a trimmed human-facing site name', () => {
    expect(siteNameOf(undefined)).toBe(DEFAULT_SITE_NAME);
    expect(siteNameOf({})).toBe('krmax');
    expect(siteNameOf({ siteName: '  tavya  ' })).toBe('tavya');
    expect(siteNameOf({ siteName: '' })).toBe('krmax');
    expect(siteNameOf({ siteName: 'x'.repeat(MAX_SITE_NAME_LENGTH + 1) })).toBe('krmax');
  });

  it('rejects empty, overlong, and control-character names', () => {
    expect(siteNameError('')).toMatch(/required/);
    expect(siteNameError('x'.repeat(MAX_SITE_NAME_LENGTH + 1))).toMatch(/fewer/);
    expect(siteNameError('bad\nname')).toMatch(/control/);
    expect(siteNameError('Tavya')).toBeUndefined();
    expect(siteNameError('研究室')).toBeUndefined();
  });

  it('brands transactional email and public policy copy at request time', () => {
    const html = emailHtml('Heading', 'Body', 'Do it', 'https://example.test/a', 'Footer', 'tavya');
    expect(html).toContain('◇ tavya');
    expect(html).not.toMatch(/◇ krmax/i);
    expect(publicLaunchInfo({}, undefined, 'tavya').policies.find((p) => p.slug === 'terms')?.summary)
      .toContain('using tavya');
    expect(JSON.stringify(policyDocument('privacy', {}, undefined, 'tavya'))).not.toMatch(/krmax/i);
  });

  it('uses one dynamic name source throughout public and authenticated UI', () => {
    const app = read('web/app.js');
    expect(app).toContain("function siteName() { return S.meta?.siteName || 'krmax'; }");
    expect(app).toContain('Site name<input id="site-name"');
    expect(app).toContain("api('/api/settings/installation'");
    expect(app).toContain('${siteNameMarkup()}');
  });
});

describe('brand icon selection', () => {
  it('defaults to the diamond when unset, and survives a bad stored value', () => {
    expect(brandIconOf(undefined)).toBe('diamond');
    expect(brandIconOf({})).toBe(DEFAULT_BRAND_ICON);
    expect(brandIconOf({ icon: 'no-such-icon' })).toBe('diamond');
    expect(brandIconOf({ icon: 42 })).toBe('diamond');
  });

  it('accepts exactly the known icons', () => {
    expect(BRAND_ICONS).toEqual(['diamond', 'knot', 'check', 'clover']);
    for (const icon of BRAND_ICONS) expect(isBrandIcon(icon)).toBe(true);
    expect(isBrandIcon('Diamond')).toBe(false);
    expect(isBrandIcon('../../etc/passwd')).toBe(false);
    expect(brandIconOf({ icon: 'knot' })).toBe('knot');
  });

  it('ships raster assets for every icon, so a switch never leaves a hole', () => {
    for (const icon of BRAND_ICONS) {
      for (const file of BRAND_FILES) {
        if (file === 'icon.svg') continue;
        const asset = path.join(webDir, 'brand', icon, file);
        expect(fs.existsSync(asset), `${icon}/${file}`).toBe(true);
        expect(fs.statSync(asset).size).toBeGreaterThan(0);
      }
    }
  });

  it('points the static shell at setting-resolved asset paths', () => {
    const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(webDir, 'app.webmanifest'), 'utf8'));
    expect(html).toContain('href="/brand/icon.svg"');
    expect(html).toContain('href="/brand/apple-touch-icon.png"');
    for (const entry of manifest.icons) expect(entry.src).toMatch(/^\/brand\/[^/]+$/);
  });

  it('keeps the web picker in step with the server vocabulary', () => {
    const app = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
    const ids = [...app.matchAll(/\{ id: '([a-z]+)', label: '[A-Za-z]+' \}/g)].map((m) => m[1]);
    expect(ids).toEqual([...BRAND_ICONS]);
  });
});

/**
 * Technical identifiers deliberately keep the original `karmax` spelling: env
 * vars (`KARMAX_*`), the state home (`~/.karmax`), task branches and the CLI are
 * compatibility wiring rather than installation identity. The checked-in web
 * shell likewise retains `krmax` as the safe default; the gateway replaces it
 * in the response with the configured name.
 */
describe('branding — portable defaults and dynamic surfaces', () => {
  it('keeps a usable default in the static PWA files', () => {
    const manifest = JSON.parse(read('web/app.webmanifest'));
    expect(manifest.name).toBe('Krmax');
    expect(manifest.short_name).toBe('Krmax');
    expect(read('web/index.html')).toContain('<title>krmax</title>');
  });

  it('uses the configured name for account email and invitations', () => {
    const identity = read('src/auth/identity.ts');
    const gateway = read('src/gateway/server.ts');
    expect(identity).toContain('`Reset your ${brand} password`');
    expect(identity).toContain('`Confirm your ${brand} email`');
    expect(identity).toContain('appName: siteName()');
    expect(gateway).toContain('on ${this.siteName}');
    expect(gateway).toContain('this.siteName)');
  });

  it('uses the configured name in browser OAuth results and credential notices', () => {
    const gateway = read('src/gateway/server.ts');
    expect(gateway).toContain('const name = escapeHtml(this.siteName);');
    expect(gateway).toContain('<title>${name} · GitHub</title>');
    expect(gateway).toContain('<title>${name} · Stripe</title>');
    expect(gateway).toContain('Return to ${name}');
    expect(gateway).toContain('[${this.siteName} credential decision]');
  });
});

describe('branding — stable technical and operator identifiers', () => {
  it('keeps Phone Access and platform recovery diagnostics recognizable', () => {
    expect(read('src/remote/access.ts')).toContain('Krmax stays on localhost');
    expect(read('src/platform/api.ts')).toContain('Krmax recovered this task');
  });

  it('keeps Prometheus metric names stable', () => {
    const gateway = read('src/gateway/server.ts');
    expect(gateway).toContain('karmax_info 1');
    expect(gateway).toContain('karmax_info Krmax control-plane information.');
  });

  it('keeps the technical boot and process labels stable', () => {
    const main = read('src/main.ts');
    expect(main).toContain('✓ krmax is running');
    expect(main).toContain("'\\n  krmax ' + VERSION");
    expect(read('src/util/processes.ts')).toContain('krmax (gateway + worker)');
    expect(read('src/world/runners.ts')).toContain('organization BYOK');
  });

  it('keeps backup format diagnostics compatible', () => {
    const backup = read('src/ops/backup.ts');
    expect(backup).toContain('stop Krmax before restore');
    expect(backup).toContain('unsupported or invalid Krmax backup manifest');
  });
});

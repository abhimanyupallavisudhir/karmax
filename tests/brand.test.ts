import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emailHtml } from '../src/auth/identity.js';
import { policyDocument, publicLaunchInfo } from '../src/launch/legal.js';
import { BRAND, BRAND_ICONS, BRAND_FILES, DEFAULT_BRAND_ICON, DEFAULT_SITE_NAME, MAX_SITE_NAME_LENGTH,
  brandIconOf, isBrandIcon, siteNameError, siteNameOf, taskBranch, taskIdOfBranch } from '../src/domain/brand.js';
import { taskIdOfBranch as githubTaskIdOfBranch } from '../src/integrations/github-pr.js';
import { MemoryWorldProvider } from '../src/world/memory.js';

const webDir = fileURLToPath(new URL('../web', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('installation identity', () => {
  it('defaults safely and accepts a trimmed human-facing site name', () => {
    expect(siteNameOf(undefined)).toBe(DEFAULT_SITE_NAME);
    expect(BRAND).toBe('tavya');
    expect(siteNameOf({})).toBe('tavya');
    expect(siteNameOf({ siteName: '  Acme  ' })).toBe('Acme');
    expect(siteNameOf({ siteName: '' })).toBe('tavya');
    expect(siteNameOf({ siteName: 'x'.repeat(MAX_SITE_NAME_LENGTH + 1) })).toBe('tavya');
  });

  it('rejects empty, overlong, and control-character names', () => {
    expect(siteNameError('')).toMatch(/required/);
    expect(siteNameError('x'.repeat(MAX_SITE_NAME_LENGTH + 1))).toMatch(/fewer/);
    expect(siteNameError('bad\nname')).toMatch(/control/);
    expect(siteNameError('Tavya')).toBeUndefined();
    expect(siteNameError('研究室')).toBeUndefined();
  });

  it('brands transactional email and public policy copy at request time', () => {
    const html = emailHtml('Heading', 'Body', 'Do it', 'https://example.test/a', 'Footer', 'Acme');
    expect(html).toContain('◇ Acme');
    expect(html).not.toMatch(/◇ tavya/i);
    expect(emailHtml('Heading', 'Body', 'Do it', 'https://example.test/a', 'Footer')).toContain('◇ tavya');
    expect(publicLaunchInfo({}, undefined, 'Acme').policies.find((p) => p.slug === 'terms')?.summary)
      .toContain('using Acme');
    expect(JSON.stringify(policyDocument('privacy', {}, undefined, 'Acme'))).not.toMatch(/krmax|karmax|tavya/i);
  });

  it('uses one dynamic name source throughout public and authenticated UI', () => {
    const app = read('web/app.js');
    expect(app).toContain("function siteName() { return S.meta?.siteName || 'tavya'; }");
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
    expect(BRAND_ICONS).toEqual(['diamond', 'knot', 'check', 'check-arrow', 'check-knot', 'check-knot-tilted', 'check-knot-purple', 'check-knot-purple-arrow', 'gold-check', 'gold-arrow', 'bold-gold-check', 'bold-gold-arrow', 'royal-gold-check', 'royal-gold-arrow', 'clover']);
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

  it('ships each gold option exactly as reviewed, at every installed icon size', () => {
    for (const icon of ['gold-check', 'gold-arrow', 'bold-gold-check', 'bold-gold-arrow', 'royal-gold-check', 'royal-gold-arrow']) {
      expect(isBrandIcon(icon)).toBe(true);
      expect(brandIconOf({ icon })).toBe(icon);
      expect(read(`web/brand/${icon}/icon.svg`)).toBe(read(`design/gold-logo-options/${icon}.svg`));
      for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]] as const) {
        const png = fs.readFileSync(path.join(webDir, 'brand', icon, file));
        expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
        expect(png.readUInt32BE(16)).toBe(size);
        expect(png.readUInt32BE(20)).toBe(size);
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
    for (const entry of manifest.icons) expect(entry.src).toMatch(/^\/brand\/[^/]+$/);
  });

  it('keeps the web picker in step with the server vocabulary', () => {
    const app = fs.readFileSync(path.join(webDir, 'app.js'), 'utf8');
    const choices = app.match(/const BRAND_ICON_CHOICES = \[([\s\S]*?)\n\];/)?.[1] ?? '';
    const ids = [...choices.matchAll(/\{ id: '([a-z-]+)', label: '[A-Za-z ]+' \}/g)].map((m) => m[1]);
    expect(ids).toEqual([...BRAND_ICONS]);
  });
});

/**
 * Everything people or other services see says `tavya`: task branches, commits,
 * PR text, local checkout commands and the CLI. Internal identifiers keep the
 * original `karmax` spelling for compatibility: env vars (`KARMAX_*`), the state
 * home (`~/.karmax`), metric names, storage/lookup keys and MCP server ids. The
 * checked-in web shell carries `tavya` as the default; the gateway replaces it in
 * the response with the configured name.
 */
describe('branding — portable defaults and dynamic surfaces', () => {
  it('keeps a usable default in the static PWA files', () => {
    const manifest = JSON.parse(read('web/app.webmanifest'));
    expect(manifest.name).toBe('tavya');
    expect(manifest.short_name).toBe('tavya');
    expect(read('web/index.html')).toContain('<title>tavya</title>');
  });

  it('uses the configured name for account email and invitations', () => {
    const identity = read('src/auth/identity.ts');
    const gateway = read('src/gateway/server.ts');
    expect(identity).toContain('`Reset your ${brand} password`');
    expect(identity).toContain('`Confirm your ${brand} email`');
    expect(identity).toContain('appName: (await siteName())');
    expect(gateway).toContain('on ${(await this.siteName)}');
    expect(gateway).toContain('(await this.siteName))');
  });

  it('uses the configured name in browser OAuth results and credential notices', () => {
    const gateway = read('src/gateway/server.ts');
    expect(gateway).toContain('const name = escapeHtml((await this.siteName));');
    expect(gateway).toContain('<title>${name} · GitHub</title>');
    expect(gateway).toContain('<title>${name} · Stripe</title>');
    expect(gateway).toContain('Return to ${name}');
    expect(gateway).toContain('[${(await this.siteName)} credential decision]');
  });
});

describe('branding — stable technical and operator identifiers', () => {
  it('keeps Phone Access and platform recovery diagnostics recognizable', () => {
    expect(read('src/remote/access.ts')).toContain('${BRAND} stays on localhost');
    expect(read('src/platform/api.ts')).toContain('${BRAND} recovered this task');
  });

  it('keeps Prometheus metric names stable', () => {
    const gateway = read('src/gateway/server.ts');
    expect(gateway).toContain('karmax_info 1');
    expect(gateway).toContain('# HELP karmax_info ${BRAND} control-plane information.');
  });

  it('keeps the technical boot and process labels stable', () => {
    const main = read('src/main.ts');
    expect(main).toContain('✓ ${BRAND} is running');
    expect(main).toContain('`\\n  ${BRAND} ` + VERSION');
    expect(read('src/util/processes.ts')).toContain('`${BRAND} (gateway + worker)`');
    expect(read('src/world/runners.ts')).toContain('organization BYOK');
  });

  it('keeps backup format diagnostics compatible', () => {
    const backup = read('src/ops/backup.ts');
    expect(backup).toContain('stop ${BRAND} before restore');
    expect(backup).toContain('unsupported or invalid ${BRAND} backup manifest');
    expect(backup).toContain("format: 'karmax-backup'");
  });
});

describe('outward-facing brand', () => {
  it('puts new task branches under tavya/ and still recognizes pre-rename karmax/ branches', async () => {
    expect(taskBranch('task_abc')).toBe('tavya/task_abc');
    expect(taskIdOfBranch('tavya/task_abc')).toBe('task_abc');
    expect(taskIdOfBranch('karmax/task_old')).toBe('task_old');
    expect(taskIdOfBranch('feature/tavya/task_abc')).toBeUndefined();
    expect(taskIdOfBranch('main')).toBeUndefined();
    expect(githubTaskIdOfBranch('karmax/task_old')).toBe('task_old');
    const world = await new MemoryWorldProvider().create({ taskId: 'task_abc', base: 'main' } as any);
    expect(world.handle.branch).toBe('tavya/task_abc');
  });

  it('shows the brand for the persisted karmax landing-authority value', () => {
    expect(read('src/contrib/manifests.ts')).toContain("options: ['auto', 'external', 'karmax'],\n  // The stored value predates the product name.\n  optionLabels: { karmax: BRAND },");
    expect(read('web/app.js')).toContain("esc(f.optionLabels?.[o] ?? o)");
  });

  // Guard against reintroducing the internal platform name in places people see:
  // GitHub branches, commits and PR text, local commands, third-party clients.
  it('keeps the old name out of branch, commit and client identities', () => {
    const offenders: string[] = [];
    const patterns = [
      /`karmax\/\$\{/, // task branch names
      /['"`]karmax: /, // commit messages and PR titles
      /user\.name=karmax|'karmax@localhost'|`karmax\+/, // git author identity
      /'user-agent': 'karmax/, /clientInfo: \{ name: 'karmax/,
      /\bkrmax\b(?!-issues)/, // retired display name
      /\b(Karmax|Krmax)\b(?![\w-]|’s? [a-z]*[A-Z])/, // the old name in prose
    ];
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(file) : /\.(ts|mjs|js)$/.test(entry.name) ? [file] : [];
    });
    for (const file of [...walk('src'), 'web/app.js']) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (line.includes('`tavya/${')) return; // recognizes the legacy branch name next to the current one
        if (patterns.some((pattern) => pattern.test(line))) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

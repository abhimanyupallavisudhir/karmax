import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_ICONS, BRAND_FILES, DEFAULT_BRAND_ICON, brandIconOf, isBrandIcon } from '../src/domain/brand.js';

const webDir = fileURLToPath(new URL('../web', import.meta.url));

describe('brand icon selection', () => {
  it('defaults to the diamond when unset, and survives a bad stored value', () => {
    expect(brandIconOf(undefined)).toBe('diamond');
    expect(brandIconOf({})).toBe(DEFAULT_BRAND_ICON);
    // A variant removed by a downgrade (or a hand-edited row) must not break the UI.
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
        if (file === 'icon.svg') continue; // vector art exists only for the diamond
        const asset = path.join(webDir, 'brand', icon, file);
        expect(fs.existsSync(asset), `${icon}/${file}`).toBe(true);
        expect(fs.statSync(asset).size).toBeGreaterThan(0);
      }
    }
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
    const ids = [...app.matchAll(/\{ id: '([a-z]+)', label: '[A-Za-z]+' \}/g)].map((m) => m[1]);
    expect(ids).toEqual([...BRAND_ICONS]);
  });
});

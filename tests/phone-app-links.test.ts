import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { APP_LINK_EXCLUDED_PATHS } from '../src/platform/app-links.js';

/**
 * Verified links on Android (wiki features/phone-apps § Verified links) leave
 * the same paths to the browser as the iOS apple-app-site-association does:
 * the app's AppLinks.EXCLUDED_PATHS (older Android, LinkActivity) and the
 * manifest's uri-relative-filter-groups (Android 15+) are APP_LINK_EXCLUDED_PATHS.
 */
const java = fs.readFileSync('mobile/android/app/src/main/java/io/tavya/app/AppLinks.java', 'utf8');
const manifest = fs.readFileSync('mobile/android/app/src/main/AndroidManifest.xml', 'utf8');

describe('Android App Links exclusions', () => {
  it('AppLinks.EXCLUDED_PATHS is the server\'s list', () => {
    const list = java.match(/EXCLUDED_PATHS = \{([^}]*)\}/)![1]!;
    expect([...list.matchAll(/"([^"]*)"/g)].map((m) => m[1])).toEqual(APP_LINK_EXCLUDED_PATHS);
  });

  it('the manifest excludes each of them (a path, or a prefix for a trailing *)', () => {
    const link = manifest.slice(manifest.indexOf('android:name=".LinkActivity"'));
    const filter = link.slice(0, link.indexOf('</activity>'));
    expect(filter).toContain('android:autoVerify="true"');
    const excluded = [...filter.matchAll(/<uri-relative-filter-group android:allow="false">\s*<data android:(path|pathPrefix)="([^"]*)" \/>/g)]
      .map(([, kind, value]) => kind === 'pathPrefix' ? `${value}*` : value);
    expect(excluded).toEqual(APP_LINK_EXCLUDED_PATHS);
  });
});

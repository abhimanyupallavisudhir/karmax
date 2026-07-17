import { describe, expect, it } from 'vitest';
import { routeCapability } from '../src/gateway/server.js';
import { PLATFORM_API_CATALOG } from '../src/platform/catalog.js';

/** Expand a catalog entry like `GET|POST /api/tasks/:taskId/params|notes` into
 * concrete (method, path, url) probes. WS entries have no HTTP capability. */
function expandEntry(entry: string): Array<{ method: string; path: string; url: URL }> {
  const [methods, spec] = entry.split(' ');
  if (!methods || !spec || methods === 'WS') return [];
  const [rawPath, rawQuery] = spec.split('?');
  return methods.split('|').flatMap((method) => expandAlternatives(rawPath!).map((path) => {
    const concrete = path.replace(/:[A-Za-z]+/g, 'x');
    const url = new URL(`http://gateway.invalid${concrete}`);
    for (const key of (rawQuery ?? '').split(/[&|]/).map((value) => value.split('=')[0]).filter(Boolean))
      url.searchParams.set(key!, 'x');
    return { method, path: concrete, url };
  }));
}

/** `/api/a/b|c/d` alternates the suffix after the last `/` before the first `|`. */
function expandAlternatives(path: string): string[] {
  const pipe = path.indexOf('|');
  if (pipe < 0) return [path];
  const cut = path.lastIndexOf('/', pipe) + 1;
  return path.slice(cut).split('|').map((alternative) => `${path.slice(0, cut)}${alternative}`);
}

describe('gateway route capability catalog', () => {
  it('binds every documented platform route to an explicit capability rule', () => {
    // The fallback in capabilityForRequest exists for safety, not coverage: a
    // documented route that only matches the fallback means the catalog and the
    // capability map have drifted apart.
    for (const entries of Object.values(PLATFORM_API_CATALOG)) {
      if (!Array.isArray(entries)) continue; // the `note` field
      for (const entry of entries) {
        for (const { method, path, url } of expandEntry(entry)) {
          expect(routeCapability(method, path, url), `${method} ${path} has no explicit capability rule`).toBeDefined();
        }
      }
    }
  });
});

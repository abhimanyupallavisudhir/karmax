import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { KarmaxApi } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { WorldRegistry } from '../src/world/registry.js';

/**
 * An ORGANIZATION wiki has no git history — `organization_wiki_versions` is its
 * only undo (a project wiki survives through its own repository).
 *
 * `readWikiPage` returns undefined for a *section*, so a section delete recorded
 * no baseline and a `delete` row carrying `content: undefined`, while the
 * filesystem removal is a recursive `rmSync`. One
 * `DELETE …/wiki/page?path=guides` therefore destroyed the whole subtree with
 * nothing left to restore it from.
 */
describe('organization wiki section delete', () => {
  let store: Store;
  let tokens: TokenAuthority;
  let api: KarmaxApi;
  let contentDir: string;
  let organizationId: string;
  let token: string;

  beforeEach(async () => {
    store = new Store(':memory:');
    tokens = new TokenAuthority();
    contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-wiki-'));
    organizationId = store.createOrganization({ name: 'Acme', ownerUserId: 'a' }).id;
    api = new KarmaxApi({ store, client: {} as any, taskQueue: 'karmax', tokens, contentDir, worlds: new WorldRegistry() });
    token = tokens.mintPrincipal('user:a', ['skill:write', 'organization:read'], undefined, 60_000, organizationId).token;
    for (const page of ['guides/deploy', 'guides/rollback', 'guides/nested/oncall']) {
      api.saveWikiPage(token, 'organization', organizationId,
        { path: page, content: `# ${page}\n\nirreplaceable`, kind: 'skill', create: true });
    }
  });
  afterEach(() => { fs.rmSync(contentDir, { recursive: true, force: true }); });

  const contentFor = (wikiPath: string) => store.organizationWikiHistory(organizationId, wikiPath)
    .filter((version) => version.operation === 'delete' || version.operation === 'baseline')
    .map((version) => version.content);

  it('refuses to delete a section without explicit confirmation', () => {
    expect(() => api.deleteWikiPage(token, 'organization', organizationId, 'guides'))
      .toThrow(/section, not a page/i);
    expect((api.readWiki(token, 'organization', organizationId, 'guides/deploy') as any).page).toBeTruthy();
  });

  it('baselines every page in the subtree before removing it', () => {
    const result = api.deleteWikiPage(token, 'organization', organizationId, 'guides', { recursive: true });
    expect(result.deleted).toBe(true);
    expect(result.removed.sort()).toEqual(['guides/deploy', 'guides/nested/oncall', 'guides/rollback']);

    // The pages are gone from disk…
    expect((api.readWiki(token, 'organization', organizationId, 'guides/deploy') as any).page).toBeUndefined();
    // …but every one of them is recoverable from the version history, with its
    // real content — not an `undefined` placeholder.
    for (const page of ['guides/deploy', 'guides/rollback', 'guides/nested/oncall']) {
      const recorded = contentFor(page);
      expect(recorded.length, page).toBeGreaterThan(0);
      expect(recorded.every((content) => typeof content === 'string' && content.includes('irreplaceable')), page).toBe(true);
    }
  });

  it('still records a single page delete the way it always did', () => {
    expect(api.deleteWikiPage(token, 'organization', organizationId, 'guides/deploy').removed)
      .toEqual(['guides/deploy']);
    expect(contentFor('guides/deploy').every((content) => String(content).includes('irreplaceable'))).toBe(true);
    // Its siblings are untouched.
    expect((api.readWiki(token, 'organization', organizationId, 'guides/rollback') as any).page).toBeTruthy();
  });
});

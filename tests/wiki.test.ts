import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listWiki,
  readWikiPage,
  writeWikiPage,
  moveWikiPage,
  deleteWikiPage,
  collectDefaultPages,
  searchWiki,
  suggestWiki,
  renderWikiToc,
  buildWikiPromptContext,
  parseFrontmatter,
  parseWikiRefs,
  resolveWikiRefs,
  safeWikiPath,
  wikiRoot,
  BUILTIN_WIKI_ENTRIES,
  resolveBuiltins,
} from '../src/wiki/wiki.js';
import { GLOBAL_INSTRUCTIONS } from '../src/agent/instructions.js';
import { KarmaxApi } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';

/**
 * The org/project wiki (skills, memories, prompts — one content system). Cheap
 * unit file (no Temporal): the tree walk + Agent Skills frontmatter (incl.
 * delivery/importance), importance ordering, the 20k-token [more…] folding,
 * unconditional delivery (what replaced the separate "general prompt"), the
 * built-in instructions entry, host-side search (what makes grep work from
 * cloud worlds), the per-turn prompt context, and the capability-checked
 * KarmaxApi surface the gateway/MCP tools call.
 */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-wiki-'));

function seedWiki(root: string) {
  const put = (rel: string, file: string, content: string) => {
    fs.mkdirSync(path.join(root, rel), { recursive: true });
    fs.writeFileSync(path.join(root, rel, file), content);
  };
  put('deploy-checklist', 'SKILL.md', '---\nname: Deploy checklist\ndescription: Steps before shipping\n---\nAlways run migrations first.\n');
  put('flaky-ci', 'MEMORY.md', '---\ndescription: The e2e suite is flaky on Fridays\n---\nRetry twice.\n');
  put('guides/e2e-runbook', 'SKILL.md', '---\nname: E2E runbook\ndescription: How to run e2e\n---\nUse the staging cluster.\n');
  // Extra files inside a skill folder must NOT become more entries — even md files.
  put('deploy-checklist', 'NOTES.md', 'scratch notes');
  fs.mkdirSync(path.join(root, 'deploy-checklist', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'deploy-checklist', 'scripts', 'ship.sh'), 'echo ship');
  // An empty section (no skills anywhere below) disappears from the tree.
  fs.mkdirSync(path.join(root, 'empty-section'), { recursive: true });
}

describe('listWiki / readWikiPage', () => {
  it('walks skill folders (SKILL.md/MEMORY.md) and sections, ignoring extra files', () => {
    const root = tmp();
    try {
      seedWiki(root);
      const tree = listWiki(root);
      expect(tree.kind).toBe('section');
      const names = tree.children!.map((e) => `${e.kind}:${e.path}`);
      expect(names).toEqual(['skill:deploy-checklist', 'memory:flaky-ci', 'section:guides']);
      const guides = tree.children!.find((e) => e.path === 'guides')!;
      expect(guides.children!.map((e) => e.path)).toEqual(['guides/e2e-runbook']);
      // Frontmatter name overrides the folder name; description is surfaced.
      const deploy = tree.children![0]!;
      expect(deploy.name).toBe('Deploy checklist');
      expect(deploy.description).toBe('Steps before shipping');
      // Folder name is the title when frontmatter has no name.
      expect(tree.children![1]!.name).toBe('flaky-ci');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reads a page with its attached files; narrows to a subtree for [more…] expansion', () => {
    const root = tmp();
    try {
      seedWiki(root);
      const page = readWikiPage(root, 'deploy-checklist')!;
      expect(page.kind).toBe('skill');
      expect(page.content).toContain('Always run migrations first.');
      expect(page.files).toEqual(['NOTES.md', 'scripts/ship.sh']);
      const sub = listWiki(root, 'guides');
      expect(sub.children!.map((e) => e.path)).toEqual(['guides/e2e-runbook']);
      expect(readWikiPage(root, 'guides')).toBeUndefined(); // a section is not a page
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects traversal in wiki paths', () => {
    expect(() => safeWikiPath('../../etc/passwd')).toThrow();
    expect(() => listWiki('/nowhere', '../escape')).toThrow();
    expect(safeWikiPath('a//b/')).toBe('a/b');
  });
});

describe('labels / importance frontmatter', () => {
  it('parses labels and importance; importance orders siblings (desc, then name)', () => {
    const root = tmp();
    try {
      writeWikiPage(root, 'low', '---\ndescription: l\n---\nx'); // importance defaults to 0
      writeWikiPage(root, 'high', '---\ndescription: h\nimportance: 5\n---\nx');
      writeWikiPage(root, 'mid', '---\ndescription: m\nimportance: 2\n---\nx');
      writeWikiPage(root, 'always', '---\ndescription: a\nlabels: default, style\nimportance: 9\n---\nSent every turn.');
      const tree = listWiki(root);
      expect(tree.children!.map((e) => e.path)).toEqual(['always', 'high', 'mid', 'low']);
      expect(tree.children![0]!.labels).toEqual(['default', 'style']);
      expect(tree.children![1]!.importance).toBe(5);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('inlines `default`-labelled entries in full (importance order) but STILL lists every entry in the TOC', () => {
    const root = tmp();
    try {
      writeWikiPage(root, 'style', '---\nlabels: default\nimportance: 1\n---\nPrefer small diffs.');
      writeWikiPage(root, 'tone', '---\nlabels: default\nimportance: 9\n---\nBe direct.');
      writeWikiPage(root, 'indexed-skill', '---\ndescription: findable\n---\nBody.');
      const tree = listWiki(root);
      const defaults = collectDefaultPages(root, tree);
      expect(defaults.map((u) => u.body)).toEqual(['Be direct.', 'Prefer small diffs.']);
      // Every entry is always indexed — the `default` ones included, tagged {default}.
      const toc = renderWikiToc(tree, { scope: 'project', id: 'p1' });
      expect(toc).toContain('indexed-skill');
      expect(toc).toContain('tone] {default}');
      expect(toc).toContain('style] {default}');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reads a legacy `delivery: unconditional` forward as the `default` label', () => {
    const root = tmp();
    try {
      writeWikiPage(root, 'legacy', '---\ndelivery: unconditional\n---\nOld style.');
      expect(listWiki(root).children![0]!.labels).toEqual(['default']);
      expect(collectDefaultPages(root, listWiki(root)).map((u) => u.body)).toEqual(['Old style.']);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('wiki refs (@proj:… / @org:… tags) and suggestions', () => {
  it('parses page / label / folder tags, ignoring surrounding punctuation', () => {
    const refs = parseWikiRefs('See @proj:guides/e2e-runbook and @org:tag:security, plus @proj:guides/* — done. a@b.com untouched');
    expect(refs).toEqual([
      { scope: 'project', kind: 'page', value: 'guides/e2e-runbook' },
      { scope: 'organization', kind: 'label', value: 'security' },
      { scope: 'project', kind: 'folder', value: 'guides' },
    ]);
  });

  it('ignores @ that is mid-word, escaped, or inside code spans', () => {
    // Only a tag at the start or right after whitespace counts.
    expect(parseWikiRefs('email a@proj:x, path b/@proj:y, escaped \\@proj:z, paren (@proj:w')).toEqual([]);
    // Inline `code` and fenced ```blocks``` are stripped before scanning.
    expect(parseWikiRefs('use `@proj:in-code` here')).toEqual([]);
    expect(parseWikiRefs('```\n@proj:in-fence\n```\nbut @proj:live counts')).toEqual([
      { scope: 'project', kind: 'page', value: 'live' },
    ]);
    // Start-of-string and newline-led tags still count.
    expect(parseWikiRefs('@proj:first\n@org:tag:second')).toEqual([
      { scope: 'project', kind: 'page', value: 'first' },
      { scope: 'organization', kind: 'label', value: 'second' },
    ]);
  });

  it('resolves a page, a folder subtree, and a label into the pages they name', () => {
    const root = tmp();
    try {
      writeWikiPage(root, 'guides/a', '---\nlabels: security\n---\nx');
      writeWikiPage(root, 'guides/sub/b', '---\ndescription: d\n---\nx');
      writeWikiPage(root, 'loose', '---\nlabels: security\n---\nx');
      const tree = listWiki(root);
      const page = resolveWikiRefs(parseWikiRefs('@proj:guides/a'), 'project', root, tree);
      expect(page).toEqual(['guides/a']);
      const folder = resolveWikiRefs(parseWikiRefs('@proj:guides/*'), 'project', root, tree).sort();
      expect(folder).toEqual(['guides/a', 'guides/sub/b']);
      const label = resolveWikiRefs(parseWikiRefs('@proj:tag:security'), 'project', root, tree).sort();
      expect(label).toEqual(['guides/a', 'loose']);
      // Scope-mismatched refs and non-existent pages resolve to nothing.
      expect(resolveWikiRefs(parseWikiRefs('@org:guides/a @proj:nope'), 'project', root, tree)).toEqual([]);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('suggests pages, folders, and labels ranked by relevance (tag: → labels, * → folders)', () => {
    const root = tmp();
    try {
      writeWikiPage(root, 'guides/e2e-runbook', '---\ndescription: how to run e2e\nlabels: testing\n---\nx');
      writeWikiPage(root, 'deploy-checklist', '---\nlabels: ops\n---\nx');
      const kinds = (q: string) => suggestWiki(root, q).map((s) => `${s.kind}:${s.ref}`);
      // A page-ish query surfaces the page and its containing folder.
      const runbook = kinds('runbook');
      expect(runbook).toContain('page:guides/e2e-runbook');
      // `tag:` restricts to labels; the query filters them.
      expect(kinds('tag:test')).toEqual(['label:tag:testing']);
      // A trailing `*` biases folders to the top.
      expect(suggestWiki(root, 'guides/*')[0]).toMatchObject({ kind: 'folder', ref: 'guides/*', count: 1 });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('write / move / delete round-trip', () => {
  it('creates, keeps kind on overwrite, guards create against overwriting, and deletes', () => {
    const root = tmp();
    try {
      const made = writeWikiPage(root, 'guides/new-skill', '---\ndescription: d\n---\nbody', 'skill', { create: true });
      expect(made.kind).toBe('skill');
      expect(() => writeWikiPage(root, 'guides/new-skill', 'other', 'skill', { create: true })).toThrow(/already exists/);
      writeWikiPage(root, 'a-memory', 'remember this', 'memory');
      expect(readWikiPage(root, 'a-memory')!.kind).toBe('memory');
      // Overwriting an existing memory without restating kind must not fork a SKILL.md next to it.
      writeWikiPage(root, 'a-memory', 'remember more');
      expect(readWikiPage(root, 'a-memory')!.kind).toBe('memory');
      expect(deleteWikiPage(root, 'a-memory')).toBe(true);
      expect(readWikiPage(root, 'a-memory')).toBeUndefined();
      expect(deleteWikiPage(root, 'a-memory')).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('renames an entry folder with its attached files; refuses to clobber the target', () => {
    const root = tmp();
    try {
      writeWikiPage(root, 'old-name', '---\ndescription: d\n---\nbody');
      fs.writeFileSync(path.join(root, 'old-name', 'extra.txt'), 'rides along');
      moveWikiPage(root, 'old-name', 'guides/new-name');
      expect(readWikiPage(root, 'old-name')).toBeUndefined();
      expect(readWikiPage(root, 'guides/new-name')!.files).toEqual(['extra.txt']);
      writeWikiPage(root, 'other', 'x');
      expect(() => moveWikiPage(root, 'other', 'guides/new-name')).toThrow(/already exists/);
      expect(() => moveWikiPage(root, 'missing', 'anywhere')).toThrow(/no entry/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('reserves @… paths — except a built-in\'s exact path, whose write is its editable override', () => {
    const root = tmp();
    try {
      const builtinPath = BUILTIN_WIKI_ENTRIES[0]!.path;
      // The default applies until an override exists; editing writes the override.
      expect(resolveBuiltins(root)[0]).toMatchObject({ content: GLOBAL_INSTRUCTIONS, builtin: true });
      writeWikiPage(root, builtinPath, '---\ndelivery: unconditional\n---\nCustom instructions.');
      expect(resolveBuiltins(root)[0]).toMatchObject({ overridden: true, builtin: true, name: BUILTIN_WIKI_ENTRIES[0]!.name });
      expect(resolveBuiltins(root)[0]!.content).toContain('Custom instructions.');
      // The override never lists as an ordinary tree section (it would double the entry).
      expect(JSON.stringify(listWiki(root))).not.toContain('@builtin');
      // `create` must not silently become the override; deleting it restores the default.
      expect(() => writeWikiPage(root, builtinPath, 'x', 'skill', { create: true })).toThrow(/already exists/);
      expect(deleteWikiPage(root, builtinPath)).toBe(true);
      expect(resolveBuiltins(root)[0]!.content).toBe(GLOBAL_INSTRUCTIONS);
      // Everything else under @… stays reserved, and built-in identities never move.
      expect(() => writeWikiPage(root, '@builtin/nope', 'x')).toThrow(/reserved/);
      writeWikiPage(root, 'mine', 'x');
      expect(() => moveWikiPage(root, 'mine', builtinPath)).toThrow(/renamed|already exists/);
      expect(() => moveWikiPage(root, 'mine', '@evil/mine')).toThrow(/reserved/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('parseFrontmatter', () => {
  it('reads the known scalar fields and returns the body; tolerates missing frontmatter', () => {
    const fm = parseFrontmatter('---\nname: X\ndescription: "quoted"\nlabels: default, security\nimportance: 3.5\nextra: [ignored]\n---\nbody line\n');
    expect(fm.name).toBe('X');
    expect(fm.description).toBe('quoted');
    expect(fm.labels).toEqual(['default', 'security']);
    expect(fm.importance).toBe(3.5);
    expect(fm.body).toBe('body line\n');
    expect(parseFrontmatter('no fences').body).toBe('no fences');
    expect(parseFrontmatter('no fences').labels).toEqual([]);
    // `[a, b]` flow form parses too; a legacy delivery folds into `default`.
    expect(parseFrontmatter('---\nlabels: [a, b]\n---\nx').labels).toEqual(['a', 'b']);
    expect(parseFrontmatter('---\ndelivery: unconditional\nlabels: x\n---\nx').labels).toEqual(['default', 'x']);
  });
});

describe('renderWikiToc', () => {
  it('expands every level to the leaves with descriptions', () => {
    const root = tmp();
    try {
      seedWiki(root);
      const toc = renderWikiToc(listWiki(root), { scope: 'project', id: 'p1' });
      expect(toc).toContain('- Deploy checklist [deploy-checklist] — Steps before shipping');
      expect(toc).toContain('- flaky-ci (memory) [flaky-ci] — The e2e suite is flaky on Fridays');
      expect(toc).toContain('- guides/');
      expect(toc).toContain('  - E2E runbook [guides/e2e-runbook] — How to run e2e');
      expect(toc).not.toContain('[more…]');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('over budget, folds every penultimate list of ≥10 entries keeping the most important', () => {
    const root = tmp();
    try {
      for (let i = 0; i < 12; i++) writeWikiPage(root, `big/skill-${String(i).padStart(2, '0')}`, `---\ndescription: d${i}\n---\nx`);
      writeWikiPage(root, 'big/vital', '---\ndescription: keep me\nimportance: 10\n---\nx');
      for (let i = 0; i < 3; i++) writeWikiPage(root, `small/skill-${i}`, `---\ndescription: s${i}\n---\nx`);
      const tree = listWiki(root);
      // Under budget: nothing folds even with 13 entries in one section.
      expect(renderWikiToc(tree, { scope: 'project', id: 'p1' })).not.toContain('[more…]');
      // Over budget (forced tiny): the big list keeps its 9 most important + [more…]; the small list is untouched.
      const folded = renderWikiToc(tree, { scope: 'organization', id: 'org1', budget: 1 });
      expect(folded).toContain('vital'); // importance 10 survives the fold at the top
      expect(folded.indexOf('vital')).toBeLessThan(folded.indexOf('skill-00'));
      expect(folded).toContain('skill-07');
      expect(folded).not.toContain('skill-08'); // 9 kept: vital + skill-00…07
      expect(folded).toContain('[more…] 4 more entries — read_wiki(scope: "organization", id: "org1", path: "big")');
      expect(folded).toContain('skill-2'); // small section fully listed
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('searchWiki (host-side grep — the cloud-world-safe path)', () => {
  it('matches case-insensitive regex with file:line, and falls back to literal on bad regex', () => {
    const root = tmp();
    try {
      seedWiki(root);
      const hits = searchWiki(root, 'MIGRATIONS');
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ file: 'deploy-checklist/SKILL.md', line: 5 });
      expect(searchWiki(root, 'flaky|staging').map((h) => h.file)).toEqual(
        expect.arrayContaining(['flaky-ci/MEMORY.md', 'guides/e2e-runbook/SKILL.md']),
      );
      expect(searchWiki(root, '(((')).toEqual([]); // literal fallback, no crash
      // A dotfile is skipped, not a walk-stopper for its siblings.
      fs.writeFileSync(path.join(root, '.DS_Store'), 'x');
      expect(searchWiki(root, 'migrations')).toHaveLength(1);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('buildWikiPromptContext', () => {
  it('inlines built-ins first, then per scope its `default` bodies and the full TOC', () => {
    const contentDir = tmp();
    try {
      const orgRoot = wikiRoot(contentDir, 'organization', 'org1');
      const projRoot = wikiRoot(contentDir, 'project', 'p1');
      writeWikiPage(orgRoot, 'org-rules', '---\nlabels: default\n---\nOrg-wide rule.');
      writeWikiPage(orgRoot, 'org-skill', '---\ndescription: org one\n---\nx');
      writeWikiPage(projRoot, 'proj-rules', '---\nlabels: default\n---\nProject rule.');
      writeWikiPage(projRoot, 'proj-skill', '---\ndescription: proj one\n---\nx');
      const ctx = buildWikiPromptContext({ contentDir, organizationId: 'org1', projectId: 'p1' });
      const builtinAt = ctx.indexOf('# How to work'); // GLOBAL_INSTRUCTIONS, unified into the wiki
      const orgAt = ctx.indexOf('Org-wide rule.');
      const projAt = ctx.indexOf('Project rule.');
      expect(builtinAt).toBe(0);
      expect(orgAt).toBeGreaterThan(builtinAt);
      expect(projAt).toBeGreaterThan(orgAt);
      expect(ctx).toContain('org-skill] — org one');
      expect(ctx).toContain('proj-skill] — proj one');
      // A `default` entry is inlined in full, so it is NOT also listed in the TOC.
      expect(ctx).not.toContain('org-rules]');
      expect(ctx).toContain('read_wiki(scope, id, path?)');
      expect(ctx).toContain('project id "p1"');
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });

  it('inlines the pages a task tags in its prompt (`@proj:…`/`@org:…`) in full', () => {
    const contentDir = tmp();
    try {
      const orgRoot = wikiRoot(contentDir, 'organization', 'org1');
      const projRoot = wikiRoot(contentDir, 'project', 'p1');
      writeWikiPage(orgRoot, 'security/threat-model', '---\ndescription: org sec\nlabels: security\n---\nThreat model body.');
      writeWikiPage(projRoot, 'runbooks/deploy', '---\ndescription: how to deploy\n---\nDeploy body.');
      writeWikiPage(projRoot, 'runbooks/rollback', '---\ndescription: how to roll back\n---\nRollback body.');
      const base = { contentDir, organizationId: 'org1', projectId: 'p1' };
      // Untagged: bodies stay out of the prompt (only the TOC lists them).
      const plain = buildWikiPromptContext(base);
      expect(plain).not.toContain('Deploy body.');
      expect(plain).not.toContain('Threat model body.');
      // Tagged: a project folder + an org label are both inlined in full.
      const tagged = buildWikiPromptContext({ ...base, taggedText: 'Do the deploy @proj:runbooks/* using @org:tag:security' });
      expect(tagged).toContain('Deploy body.');
      expect(tagged).toContain('Rollback body.');
      expect(tagged).toContain('Threat model body.');
      // The wiki-context field inlines the same way, independent of the prompt.
      const viaField = buildWikiPromptContext({ ...base, contextTokens: ['@proj:runbooks/deploy'] });
      expect(viaField).toContain('Deploy body.');
      expect(viaField).not.toContain('Rollback body.');
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });

  it('inlines `default` pages via the default context tokens, and lets a task opt out', () => {
    const contentDir = tmp();
    try {
      const projRoot = wikiRoot(contentDir, 'project', 'p1');
      writeWikiPage(projRoot, 'house-rules', '---\ndescription: the rules\nlabels: default\n---\nAlways rule.');
      const base = { contentDir, organizationId: 'org1', projectId: 'p1' };
      // No context field ⇒ default tokens ⇒ the `default` page is inlined (not in the TOC).
      const dflt = buildWikiPromptContext(base);
      expect(dflt).toContain('Always rule.');
      expect(dflt).not.toContain('house-rules]');
      // Cleared context field ([]) ⇒ opt out: the body leaves the prompt, back into the TOC.
      const optOut = buildWikiPromptContext({ ...base, contextTokens: [] });
      expect(optOut).not.toContain('Always rule.');
      expect(optOut).toContain('house-rules] {default}');
      // The built-in working instructions are delivered regardless of the field.
      expect(optOut).toContain('# How to work');
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });

  it('is exactly the built-in instructions when the wikis are empty (and honors the override)', () => {
    const contentDir = tmp();
    try {
      expect(buildWikiPromptContext({ contentDir, organizationId: 'org1', projectId: 'p1' })).toBe(GLOBAL_INSTRUCTIONS);
      expect(buildWikiPromptContext({ contentDir, projectId: 'p1', builtinInstructions: 'OVERRIDE' })).toBe('OVERRIDE');
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });

  it('an edited built-in shadows the bundled default in every prompt', () => {
    const contentDir = tmp();
    try {
      const orgRoot = wikiRoot(contentDir, 'organization', 'org1');
      writeWikiPage(orgRoot, BUILTIN_WIKI_ENTRIES[0]!.path, '---\nlabels: default\n---\nHouse variant of the instructions.');
      const ctx = buildWikiPromptContext({ contentDir, organizationId: 'org1', projectId: 'p1' });
      expect(ctx).toContain('House variant of the instructions.');
      expect(ctx).not.toContain('Do the task completely and correctly.');
      // Drop the `default` label → its body leaves the standing prompt (still in the org TOC).
      writeWikiPage(orgRoot, BUILTIN_WIKI_ENTRIES[0]!.path, '---\nname: How to work\ndescription: house rules\n---\nHouse variant.');
      const indexed = buildWikiPromptContext({ contentDir, organizationId: 'org1', projectId: 'p1' });
      expect(indexed).not.toContain('House variant.');
      expect(indexed).toContain('How to work [@builtin/how-to-work] — house rules');
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });
});

describe('KarmaxApi wiki surface (what the gateway routes and MCP tools call)', () => {
  const harness = () => {
    const contentDir = tmp();
    const tokens = new TokenAuthority();
    const store = new Store(':memory:');
    const organization = store.createOrganization({ name: 'Acme' });
    const project = store.createProject('web', {}, organization.id);
    const k = new KarmaxApi({ store, client: {} as any, taskQueue: 'tq', tokens, contentDir } as any);
    const mint = (caps: string[]) =>
      tokens.mint({ taskId: 't', profileId: 'do', principal: 'user:a', projectId: project.id, organizationId: organization.id, ceiling: caps, grantorCaps: caps }).token;
    return { k, contentDir, organization, project, mint };
  };

  it('round-trips pages, exposes the read-only built-in, and enforces create/rename guards', () => {
    const { k, contentDir, organization, project, mint } = harness();
    try {
      const rw = mint(['project:read', 'organization:read', 'skill:write']);
      k.saveWikiPage(rw, 'project', project.id, { path: 'guides/deploys', content: '---\ndescription: how\n---\nShip it.', kind: 'skill', create: true });
      // Creating again at the same path is refused; a plain update is fine.
      expect(() => k.saveWikiPage(rw, 'project', project.id, { path: 'guides/deploys', content: 'x', create: true })).toThrow(/already exists/);
      k.saveWikiPage(rw, 'project', project.id, { path: 'guides/deploys', content: '---\ndescription: how\n---\nShip it now.' });
      // Rename via prevPath moves the folder.
      k.saveWikiPage(rw, 'project', project.id, { path: 'guides/shipping', content: '---\ndescription: how\n---\nShip it now.', prevPath: 'guides/deploys' });
      const page = k.readWiki(rw, 'project', project.id, 'guides/shipping') as any;
      expect(page.page.content).toContain('Ship it now.');
      expect((k.readWiki(rw, 'project', project.id, 'guides/deploys') as any).page).toBeUndefined();
      // The organization tree carries the built-in (delivered unconditionally),
      // and the Index response carries the agent-exact TOC text.
      const org = k.readWiki(rw, 'organization', organization.id) as any;
      expect(org.toc.children[0]).toMatchObject({ path: BUILTIN_WIKI_ENTRIES[0]!.path, builtin: true, labels: ['default'] });
      expect(org.unconditional[0].body).toBe(GLOBAL_INSTRUCTIONS);
      expect(org.tocText).toBeDefined();
      const proj = k.readWiki(rw, 'project', project.id) as any;
      expect(proj.tocText).toContain('how'); // the same rendering agents receive
      const builtinPage = k.readWiki(rw, 'organization', organization.id, BUILTIN_WIKI_ENTRIES[0]!.path) as any;
      expect(builtinPage.page.builtin).toBe(true);
      // Editing a built-in writes its override; deleting the override restores the default.
      k.saveWikiPage(rw, 'organization', organization.id, { path: BUILTIN_WIKI_ENTRIES[0]!.path, content: '---\nlabels: default\n---\nOur own rules.' });
      const edited = k.readWiki(rw, 'organization', organization.id, BUILTIN_WIKI_ENTRIES[0]!.path) as any;
      expect(edited.page).toMatchObject({ builtin: true, overridden: true });
      expect(edited.page.content).toContain('Our own rules.');
      expect(k.deleteWikiPage(rw, 'organization', organization.id, BUILTIN_WIKI_ENTRIES[0]!.path).deleted).toBe(true);
      expect((k.readWiki(rw, 'organization', organization.id, BUILTIN_WIKI_ENTRIES[0]!.path) as any).page.overridden).toBeUndefined();
      expect(k.searchWiki(rw, 'project', project.id, 'ship').hits.length).toBeGreaterThan(0);
      expect(k.deleteWikiPage(rw, 'project', project.id, 'guides/shipping').deleted).toBe(true);
      // Read-only token: reads fine, writes denied.
      const ro = mint(['project:read', 'organization:read']);
      expect(() => k.readWiki(ro, 'project', project.id)).not.toThrow();
      expect(() => k.saveWikiPage(ro, 'project', project.id, { path: 'x', content: 'y' })).toThrow(/skill:write/);
      // Unknown project refuses rather than minting a stray directory.
      expect(() => k.readWiki(rw, 'project', 'nope')).toThrow(/no project/);
      expect(fs.existsSync(path.join(contentDir, 'wiki', 'project', project.id))).toBe(true);
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });
});

import { describe, it, expect, vi } from 'vitest';
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
  isSafeSearchPattern,
  suggestWiki,
  renderWikiToc,
  buildWikiPromptContext,
  parseFrontmatter,
  parseWikiRefs,
  scanWikiRefs,
  resolveWikiRefs,
  safeWikiPath,
  wikiRoot,
  BUILTIN_WIKI_ENTRIES,
  resolveBuiltins,
  estimateTokens,
  WIKI_TOC_TOKEN_BUDGET,
} from '../src/wiki/wiki.js';
import { ensureProjectWikiRepository, commitProjectWiki, projectWikiBranches, projectWikiBranchView } from '../src/wiki/repository.js';
import { execFileSync } from 'node:child_process';
import { WorldRegistry } from '../src/world/registry.js';
import { GLOBAL_INSTRUCTIONS } from '../src/agent/instructions.js';
import { KarmaxApi } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxBus } from '../src/contrib/bus.js';

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

  it('converts an entry between skill and memory in place, keeping attached files', () => {
    const root = tmp();
    try {
      writeWikiPage(root, 'notes', '---\ndescription: d\n---\nBody.', 'skill');
      fs.writeFileSync(path.join(root, 'notes', 'extra.txt'), 'attached');
      expect(fs.existsSync(path.join(root, 'notes', 'SKILL.md'))).toBe(true);
      // Passing the other kind swaps the file (SKILL.md → MEMORY.md) in place.
      const asMemory = writeWikiPage(root, 'notes', '---\ndescription: d\n---\nBody.', 'memory');
      expect(asMemory.kind).toBe('memory');
      expect(fs.existsSync(path.join(root, 'notes', 'MEMORY.md'))).toBe(true);
      expect(fs.existsSync(path.join(root, 'notes', 'SKILL.md'))).toBe(false);
      expect(fs.existsSync(path.join(root, 'notes', 'extra.txt'))).toBe(true); // attached files stay
      // Omitting the kind on a later write keeps the current file (no accidental flip).
      expect(writeWikiPage(root, 'notes', '---\ndescription: d2\n---\nBody2.').kind).toBe('memory');
      // And converting back to a skill removes the MEMORY.md.
      expect(writeWikiPage(root, 'notes', 'Body3.', 'skill').kind).toBe('skill');
      expect(fs.existsSync(path.join(root, 'notes', 'MEMORY.md'))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
      expect(toc).toContain('[tone](tone) {default}');
      expect(toc).toContain('[style](style) {default}');
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

describe('wiki refs ([[proj:…]] / [[org:…]]) and suggestions', () => {
  it('parses page / label / folder references next to ordinary punctuation', () => {
    const refs = parseWikiRefs('See ([[proj:guides/e2e-runbook]]) and [[org:tag:security]], plus [[proj:guides/*]] — done.');
    expect(refs).toEqual([
      { scope: 'project', kind: 'page', value: 'guides/e2e-runbook' },
      { scope: 'organization', kind: 'label', value: 'security' },
      { scope: 'project', kind: 'folder', value: 'guides' },
    ]);
  });

  it('ignores escaped references and every Markdown code form', () => {
    expect(parseWikiRefs('escaped \\[[proj:no]] but \\\\[[proj:yes]]')).toEqual([
      { scope: 'project', kind: 'page', value: 'yes' },
    ]);
    expect(parseWikiRefs('use `[[proj:inline]]` and `` code ` [[org:long]] `` here')).toEqual([]);
    expect(parseWikiRefs('```ts\n[[proj:fenced]]\n````\nstill fenced\n```\n[[proj:also-fenced]]')).toEqual([]);
    expect(parseWikiRefs('   ~~~~ name\n[[org:tilde-fence]]\n~~~~\nbut [[proj:live]] counts')).toEqual([
      { scope: 'project', kind: 'page', value: 'live' },
    ]);
    expect(parseWikiRefs('    [[proj:indented-code]]\n\t[[org:tab-code]]\n[[proj:plain]]')).toEqual([
      { scope: 'project', kind: 'page', value: 'plain' },
    ]);
    expect(parseWikiRefs('` unmatched before fence [[proj:before]]\n```\n[[proj:fenced]]\n```\n[[proj:after]] `')).toEqual([
      { scope: 'project', kind: 'page', value: 'before' },
      { scope: 'project', kind: 'page', value: 'after' },
    ]);
    // An unmatched inline delimiter is ordinary Markdown text; an unmatched
    // fenced delimiter owns the rest of the document.
    expect(parseWikiRefs('` unmatched [[proj:live]]')).toEqual([
      { scope: 'project', kind: 'page', value: 'live' },
    ]);
    expect(parseWikiRefs('```\n[[proj:not-live]]')).toEqual([]);
    expect(parseWikiRefs('[[PROJ:first]]\n[[org:tag:second]]')).toEqual([
      { scope: 'project', kind: 'page', value: 'first' },
      { scope: 'organization', kind: 'label', value: 'second' },
    ]);
  });

  it('reports exact source ranges for editor decoration and click targets', () => {
    const text = 'before [[proj:guides/a]] after';
    const [match] = scanWikiRefs(text);
    expect(match).toMatchObject({ start: 7, end: 24, raw: '[[proj:guides/a]]', value: 'guides/a' });
    expect(text.slice(match!.start, match!.end)).toBe(match!.raw);
  });

  it('resolves a page, a folder subtree, and a label into the pages they name', () => {
    const root = tmp();
    try {
      writeWikiPage(root, 'guides/a', '---\nlabels: security\n---\nx');
      writeWikiPage(root, 'guides/sub/b', '---\ndescription: d\n---\nx');
      writeWikiPage(root, 'loose', '---\nlabels: security\n---\nx');
      const tree = listWiki(root);
      const page = resolveWikiRefs(parseWikiRefs('[[proj:guides/a]]'), 'project', root, tree);
      expect(page).toEqual(['guides/a']);
      const folder = resolveWikiRefs(parseWikiRefs('[[proj:guides/*]]'), 'project', root, tree).sort();
      expect(folder).toEqual(['guides/a', 'guides/sub/b']);
      const label = resolveWikiRefs(parseWikiRefs('[[proj:tag:security]]'), 'project', root, tree).sort();
      expect(label).toEqual(['guides/a', 'loose']);
      // Scope-mismatched refs and non-existent pages resolve to nothing.
      expect(resolveWikiRefs(parseWikiRefs('[[org:guides/a]] [[proj:nope]]'), 'project', root, tree)).toEqual([]);
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
      expect(toc).toContain('- [Deploy checklist](deploy-checklist) — Steps before shipping');
      expect(toc).toContain('- [flaky-ci](flaky-ci) (memory) — The e2e suite is flaky on Fridays');
      expect(toc).toContain('- guides/');
      expect(toc).toContain('  - [E2E runbook](guides/e2e-runbook) — How to run e2e');
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

  /**
   * `search_wiki` takes its query straight from an agent, compiles it with
   * `new RegExp` and runs it per line synchronously on the host event loop — so a
   * catastrophic-backtracking pattern used to wedge the gateway, the worker, and
   * every in-flight activity in the same process.
   */
  it('does not hang on a catastrophic-backtracking pattern', () => {
    const root = tmp();
    try {
      writeWikiPage(root, 'bait', `---\ndescription: d\n---\n${'a'.repeat(60)}b\n`);
      const started = Date.now();
      const hits = searchWiki(root, '(a+)+$');
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(Array.isArray(hits)).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('caps the query length instead of compiling unbounded agent input', () => {
    const root = tmp();
    try {
      seedWiki(root);
      expect(() => searchWiki(root, 'x'.repeat(5_000))).toThrow(/too long/i);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  /**
   * For container worlds the world root is bind-mounted from the host, so a
   * symlink the sandboxed agent plants inside the wiki used to resolve against
   * the *host* filesystem — a container→host read primitive for any `*.md`. A
   * dangling symlink additionally made the unguarded `statSync` throw, 500-ing
   * search for the whole scope.
   */
  it('never follows symlinks and survives a dangling one', () => {
    const root = tmp();
    const outside = tmp();
    try {
      seedWiki(root);
      fs.writeFileSync(path.join(outside, 'secret.md'), 'HOST-ONLY-SECRET\n');
      fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'leak.md'));
      fs.symlinkSync(outside, path.join(root, 'leak-dir'));
      fs.symlinkSync(path.join(outside, 'gone.md'), path.join(root, 'dangling.md'));
      const hits = searchWiki(root, 'HOST-ONLY-SECRET');
      expect(hits).toEqual([]);
      // The dangling symlink must not abort the walk for its siblings.
      expect(searchWiki(root, 'migrations')).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('deleting a section is not an unversioned recursive wipe', () => {
  it('refuses to remove a section unless the caller opts in explicitly', () => {
    const root = tmp();
    try {
      writeWikiPage(root, 'guides/one', '---\ndescription: d\n---\nbody');
      writeWikiPage(root, 'guides/two', '---\ndescription: d\n---\nbody');
      expect(() => deleteWikiPage(root, 'guides')).toThrow(/section/i);
      expect(readWikiPage(root, 'guides/one')).toBeDefined();
      // A leaf page still deletes normally, and an explicit opt-in removes the section.
      expect(deleteWikiPage(root, 'guides/one')).toBe(true);
      expect(deleteWikiPage(root, 'guides', { recursive: true })).toBe(true);
      expect(fs.existsSync(path.join(root, 'guides'))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('built-in "How to work" override keeps every identity field', () => {
  /**
   * `resolveBuiltins` fell back to the bundled `name`/`description` but not
   * `labels`/`importance`. `buildWikiPromptContext` filters on the `default`
   * label, so a body-only override was neither inlined NOR replaced by the
   * default: every agent in the organization silently lost the global
   * instructions.
   */
  it('a body-only override still carries the default label, so it is still delivered', () => {
    const contentDir = tmp();
    try {
      const root = wikiRoot(contentDir, 'organization', 'org1');
      writeWikiPage(root, BUILTIN_WIKI_ENTRIES[0]!.path, 'Custom instructions with no frontmatter at all.');
      const resolved = resolveBuiltins(root)[0]!;
      expect(resolved.labels).toEqual(BUILTIN_WIKI_ENTRIES[0]!.labels);
      expect(resolved.importance).toBe(BUILTIN_WIKI_ENTRIES[0]!.importance);
      const prompt = buildWikiPromptContext({ contentDir, organizationId: 'org1' });
      expect(prompt).toContain('Custom instructions with no frontmatter at all.');
      expect(prompt).not.toContain(GLOBAL_INSTRUCTIONS);
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });
});

describe('`default`-page inlining is budgeted', () => {
  /**
   * `WIKI_TOC_TOKEN_BUDGET` governed only the TOC while every `default`-labelled
   * body was inlined in full into every turn of every task — twenty 5k-token
   * pages meant 100k tokens per turn, silently.
   */
  it('demotes overflow `default` pages to TOC lines instead of inlining them all', () => {
    const contentDir = tmp();
    try {
      const root = wikiRoot(contentDir, 'organization', 'org1');
      for (let i = 0; i < 12; i++)
        writeWikiPage(root, `bulk/page-${String(i).padStart(2, '0')}`, `---\ndescription: d${i}\nlabels: default\nimportance: ${20 - i}\n---\n${`BODY${i} `.repeat(4_000)}`);
      const prompt = buildWikiPromptContext({ contentDir, organizationId: 'org1' });
      // The most important pages are inlined; the rest are still discoverable.
      expect(prompt).toContain('BODY0');
      expect(prompt).not.toContain('BODY11 BODY11');
      expect(prompt).toContain('bulk/page-11');
      expect(estimateTokens(prompt)).toBeLessThan(WIKI_TOC_TOKEN_BUDGET * 4);
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });
});

describe('a page may not be created on top of a section', () => {
  it('rejects the write that would hide a whole subtree', () => {
    const root = tmp();
    try {
      writeWikiPage(root, 'guides/one', '---\ndescription: d\n---\nbody');
      expect(() => writeWikiPage(root, 'guides', 'shadowing content')).toThrow(/section/i);
      expect(listWiki(root).children!.some((c) => c.kind === 'section' && c.path === 'guides')).toBe(true);
      expect(readWikiPage(root, 'guides/one')).toBeDefined();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('wiki refs are matched case-insensitively', () => {
  it('parses [[PROJ:…]]/[[Org:…]] while preserving path and label case', () => {
    expect(parseWikiRefs('see [[PROJ:guides/one]] and [[Org:tag:Default]]')).toEqual([
      { scope: 'project', kind: 'page', value: 'guides/one' },
      { scope: 'organization', kind: 'label', value: 'Default' },
    ]);
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
      expect(ctx).toContain('[org-skill](org-skill) — org one');
      expect(ctx).toContain('[proj-skill](proj-skill) — proj one');
      // A `default` entry is inlined in full, so it is NOT also listed in the TOC.
      expect(ctx).not.toContain('org-rules]');
      expect(ctx).toContain('read_wiki(scope, id, path?)');
      expect(ctx).toContain('project id "p1"');
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });

  it('inlines the pages a task references in its prompt (`[[proj:…]]`/`[[org:…]]`) in full', () => {
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
      const tagged = buildWikiPromptContext({ ...base, taggedText: 'Do the deploy [[proj:runbooks/*]] using [[org:tag:security]]' });
      expect(tagged).toContain('Deploy body.');
      expect(tagged).toContain('Rollback body.');
      expect(tagged).toContain('Threat model body.');
      // The wiki-context field inlines the same way, independent of the prompt.
      const viaField = buildWikiPromptContext({ ...base, contextTokens: ['[[proj:runbooks/deploy]]'] });
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
      expect(optOut).toContain('[house-rules](house-rules) {default}');
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
      expect(ctx).not.toContain(GLOBAL_INSTRUCTIONS);
      // Drop the `default` label → its body leaves the standing prompt (still in the org TOC).
      writeWikiPage(orgRoot, BUILTIN_WIKI_ENTRIES[0]!.path, '---\nname: How to work\ndescription: house rules\n---\nHouse variant.');
      const indexed = buildWikiPromptContext({ contentDir, organizationId: 'org1', projectId: 'p1' });
      expect(indexed).not.toContain('House variant.');
      expect(indexed).toContain('[How to work](@builtin/how-to-work) — house rules');
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });
});

describe('KarmaxApi wiki surface (what the gateway routes and MCP tools call)', () => {
  const harness = async () => {
    const contentDir = tmp();
    const tokens = new TokenAuthority();
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Acme' }));
    const project = (await store.createProject('web', {}, organization.id));
    const k = new KarmaxApi({ store, client: {} as any, taskQueue: 'tq', tokens, contentDir } as any);
    const mint = async (caps: string[]) =>
      (await tokens.mint({ taskId: 't', profileId: 'do', principal: 'user:a', projectId: project.id, organizationId: organization.id, ceiling: caps, grantorCaps: caps })).token;
    return { k, contentDir, organization, project, mint };
  };

  it('round-trips pages, exposes the read-only built-in, and enforces create/rename guards', async () => {
    const { k, contentDir, organization, project, mint } = (await harness());
    try {
      const rw = (await mint(['project:read', 'organization:read', 'skill:write']));
      (await k.saveWikiPage(rw, 'project', project.id, { path: 'guides/deploys', content: '---\ndescription: how\n---\nShip it.', kind: 'skill', create: true }));
      const projectRoot = wikiRoot(contentDir, 'project', project.id);
      expect(fs.existsSync(path.join(projectRoot, '.git'))).toBe(true);
      expect(execFileSync('git', ['-C', projectRoot, 'log', '-1', '--format=%s'], { encoding: 'utf8' })).toContain('wiki: update guides/deploys');
      // Creating again at the same path is refused; a plain update is fine.
      await expect((async () => (await k.saveWikiPage(rw, 'project', project.id, { path: 'guides/deploys', content: 'x', create: true })))()).rejects.toThrow(/already exists/);
      (await k.saveWikiPage(rw, 'project', project.id, { path: 'guides/deploys', content: '---\ndescription: how\n---\nShip it now.' }));
      // Rename via prevPath moves the folder.
      (await k.saveWikiPage(rw, 'project', project.id, { path: 'guides/shipping', content: '---\ndescription: how\n---\nShip it now.', prevPath: 'guides/deploys' }));
      const page = (await k.readWiki(rw, 'project', project.id, 'guides/shipping')) as any;
      expect(page.page.content).toContain('Ship it now.');
      expect(((await k.readWiki(rw, 'project', project.id, 'guides/deploys')) as any).page).toBeUndefined();
      // The organization tree carries the built-in (delivered unconditionally),
      // and the Index response carries the agent-exact TOC text.
      const org = (await k.readWiki(rw, 'organization', organization.id)) as any;
      expect(org.toc.children[0]).toMatchObject({ path: BUILTIN_WIKI_ENTRIES[0]!.path, builtin: true, labels: ['default'] });
      expect(org.unconditional[0].body).toBe(GLOBAL_INSTRUCTIONS);
      expect(org.tocText).toBeDefined();
      const proj = (await k.readWiki(rw, 'project', project.id)) as any;
      expect(proj.tocText).toContain('how'); // the same rendering agents receive
      const builtinPage = (await k.readWiki(rw, 'organization', organization.id, BUILTIN_WIKI_ENTRIES[0]!.path)) as any;
      expect(builtinPage.page.builtin).toBe(true);
      // Editing a built-in writes its override; deleting the override restores the default.
      // Built-in and `default`-labelled organization pages reach every prompt in the
      // organization, so `skill:write` alone (every Do agent) is refused: it takes
      // an organization administrator.
      await expect((async () => (await k.saveWikiPage(rw, 'organization', organization.id, { path: BUILTIN_WIKI_ENTRIES[0]!.path, content: '---\nlabels: default\n---\nOur own rules.' })))()).rejects.toThrow(/organization:edit/);
      await expect((async () => (await k.saveWikiPage(rw, 'organization', organization.id, { path: 'rules/everywhere', content: '---\nlabels: default\n---\nEverywhere.', create: true })))()).rejects.toThrow(/organization:edit/);
      const admin = (await mint(['project:read', 'organization:read', 'skill:write', 'organization:edit']));
      (await k.saveWikiPage(admin, 'organization', organization.id, { path: BUILTIN_WIKI_ENTRIES[0]!.path, content: '---\nlabels: default\n---\nOur own rules.' }));
      expect((await k.organizationWikiHistory(rw, organization.id, BUILTIN_WIKI_ENTRIES[0]!.path)).versions[0])
        .toMatchObject({ version: 2, operation: 'write', content: expect.stringContaining('Our own rules.') });
      expect((await k.organizationWikiHistory(rw, organization.id, BUILTIN_WIKI_ENTRIES[0]!.path)).versions[1])
        .toMatchObject({ version: 1, operation: 'baseline', content: expect.stringContaining('# How to work') });
      const edited = (await k.readWiki(rw, 'organization', organization.id, BUILTIN_WIKI_ENTRIES[0]!.path)) as any;
      expect(edited.page).toMatchObject({ builtin: true, overridden: true });
      await expect((async () => (await k.deleteWikiPage(rw, 'organization', organization.id, BUILTIN_WIKI_ENTRIES[0]!.path)))()).rejects.toThrow(/organization:edit/);
      expect((await k.deleteWikiPage(admin, 'organization', organization.id, BUILTIN_WIKI_ENTRIES[0]!.path)).deleted).toBe(true);
      expect(((await k.readWiki(rw, 'organization', organization.id, BUILTIN_WIKI_ENTRIES[0]!.path)) as any).page.overridden).toBeUndefined();
      (await k.saveWikiPage(rw, 'organization', organization.id, {
        path: 'rules/original',
        content: 'Original rules.',
        create: true,
      }));
      (await k.saveWikiPage(rw, 'organization', organization.id, {
        path: 'rules/renamed',
        prevPath: 'rules/original',
        content: 'Renamed rules.',
      }));
      expect((await k.organizationWikiHistory(rw, organization.id, 'rules/original')).versions[0])
        .toMatchObject({ operation: 'move', path: 'rules/renamed', previousPath: 'rules/original' });
      // A page that predates the version-history feature is captured before its
      // first overwrite, so the prior state remains recoverable.
      const organizationRoot = wikiRoot(contentDir, 'organization', organization.id);
      writeWikiPage(organizationRoot, 'legacy/page', 'Before history.', 'memory', { create: true });
      (await k.saveWikiPage(rw, 'organization', organization.id, {
        path: 'legacy/page',
        content: 'After history.',
        kind: 'memory',
      }));
      expect((await k.organizationWikiHistory(rw, organization.id, 'legacy/page')).versions)
        .toMatchObject([
          { version: 2, operation: 'write', content: 'After history.' },
          { version: 1, operation: 'baseline', content: 'Before history.' },
        ]);
      expect((await k.searchWiki(rw, 'project', project.id, 'ship')).hits.length).toBeGreaterThan(0);
      expect((await k.deleteWikiPage(rw, 'project', project.id, 'guides/shipping')).deleted).toBe(true);
      // Read-only token: reads fine, writes denied.
      const ro = (await mint(['project:read', 'organization:read']));
      await (async () => (await k.readWiki(ro, 'project', project.id)))();
      await expect((async () => (await k.saveWikiPage(ro, 'project', project.id, { path: 'x', content: 'y' })))()).rejects.toThrow(/skill:write/);
      // Unknown project refuses rather than minting a stray directory.
      await expect((async () => (await k.readWiki(rw, 'project', 'nope')))()).rejects.toThrow(/no project/);
      expect(fs.existsSync(path.join(contentDir, 'wiki', 'project', project.id))).toBe(true);
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });
});

describe('project wiki git branches', () => {
  it('migrates existing pages in place and materializes isolated branch views', () => {
    const contentDir = tmp();
    try {
      const root = wikiRoot(contentDir, 'project', 'p1');
      writeWikiPage(root, 'notes/first', 'Before git.');
      ensureProjectWikiRepository(contentDir, 'p1');
      execFileSync('git', ['-C', root, 'switch', '-q', '-c', 'karmax/task-1']);
      writeWikiPage(root, 'notes/first', 'Only on the task branch.');
      commitProjectWiki(root, 'wiki: task edit');
      execFileSync('git', ['-C', root, 'switch', '-q', 'main']);
      expect(readWikiPage(root, 'notes/first')!.content).toBe('Before git.');
      expect(projectWikiBranches(root)).toEqual(expect.arrayContaining(['main', 'karmax/task-1']));
      const view = projectWikiBranchView(contentDir, 'p1', 'karmax/task-1');
      expect(readWikiPage(view, 'notes/first')!.content).toBe('Only on the task branch.');
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });

  it('commits only the pathspecs a caller names, not the whole shared root', () => {
    const contentDir = tmp();
    try {
      const root = wikiRoot(contentDir, 'project', 'p1');
      ensureProjectWikiRepository(contentDir, 'p1');
      // Two agents edit the shared canonical root concurrently: A writes, B
      // writes, THEN A commits. With `git add -A` that commit carried B's
      // half-finished page under A's message and author.
      writeWikiPage(root, 'notes/from-a', 'A');
      writeWikiPage(root, 'notes/from-b', 'B');
      commitProjectWiki(root, 'wiki: update notes/from-a', ['notes/from-a']);
      const committed = execFileSync('git', ['-C', root, 'show', '--name-only', '--format=', 'HEAD'], { encoding: 'utf8' });
      expect(committed).toContain('notes/from-a');
      expect(committed).not.toContain('notes/from-b');
      // B's page is still there, still uncommitted, ready for B's own commit.
      expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })).toContain('notes/from-b');
      commitProjectWiki(root, 'wiki: update notes/from-b', ['notes/from-b']);
      expect(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim()).toBe('');
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });

  it('reuses an up-to-date branch view instead of deleting it under a concurrent reader', () => {
    const contentDir = tmp();
    try {
      const root = wikiRoot(contentDir, 'project', 'p1');
      writeWikiPage(root, 'notes/first', 'v1');
      ensureProjectWikiRepository(contentDir, 'p1');
      commitProjectWiki(root, 'wiki: v1');
      execFileSync('git', ['-C', root, 'branch', 'karmax/task-1']);

      const first = projectWikiBranchView(contentDir, 'p1', 'karmax/task-1');
      const marker = path.join(first, '.reader-was-here');
      fs.writeFileSync(marker, 'reading');
      // A second reader of the same branch used to `worktree remove --force` the
      // directory the first was midway through reading.
      const second = projectWikiBranchView(contentDir, 'p1', 'karmax/task-1');
      expect(second).toBe(first);
      expect(fs.existsSync(marker)).toBe(true);
      expect(readWikiPage(second, 'notes/first')!.content).toBe('v1');

      // A view that is BEHIND its branch still moves forward.
      writeWikiPage(root, 'notes/first', 'v2');
      commitProjectWiki(root, 'wiki: v2', ['notes/first']);
      execFileSync('git', ['-C', root, 'branch', '-f', 'karmax/task-1', 'HEAD']);
      const third = projectWikiBranchView(contentDir, 'p1', 'karmax/task-1');
      expect(third).toBe(first);
      expect(readWikiPage(third, 'notes/first')!.content).toBe('v2');
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });

  it('assembles each turn from the task branch checkout, not canonical main', () => {
    const contentDir = tmp();
    try {
      const canonical = wikiRoot(contentDir, 'project', 'p1');
      const taskRoot = path.join(contentDir, 'task-wiki');
      writeWikiPage(canonical, 'rules/review', 'Canonical instructions.', 'skill',
        { create: true });
      writeWikiPage(taskRoot, 'rules/review', 'Task-branch instructions.', 'skill',
        { create: true });
      const prompt = buildWikiPromptContext({
        contentDir,
        projectId: 'p1',
        projectRoot: taskRoot,
        contextTokens: ['[[proj:rules/review]]'],
      });
      expect(prompt).toContain('Task-branch instructions.');
      expect(prompt).not.toContain('Canonical instructions.');
    } finally { fs.rmSync(contentDir, { recursive: true, force: true }); }
  });
});

describe('existing project wiki remote backfill', () => {
  it('uses an authorized organization owner without gating gateway readiness', async () => {
    const home = tmp();
    const remotes = path.join(home, 'remotes');
    fs.mkdirSync(remotes);
    const previousHome = process.env.KARMAX_HOME;
    const previousGit = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
    };
    process.env.KARMAX_HOME = home;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.file://${remotes}/.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = 'git@github.com:acme/';

    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Backfill org', ownerUserId: 'owner' }));
    const project = (await store.createProject('Existing project', {}, organization.id));
    const connection = (await store.upsertGitConnection({
      organizationId: organization.id,
      provider: 'github',
      installationId: '42',
      accountLogin: 'acme',
      accountType: 'Organization',
    }));
    const actors: string[] = [];
    const inputs: Array<{ name: string; private?: boolean }> = [];
    const githubApp = {
      status: (userId?: string) => ({ userAuthorized: userId === 'owner' }),
      async ensureRepository(_connectionId: string, userId: string, input: { name: string; private?: boolean }) {
        actors.push(userId);
        inputs.push(input);
        execFileSync('git', ['init', '-q', '--bare', path.join(remotes, `${input.name}.git`)]);
        return (await store.upsertRepository({
          organizationId: organization.id,
          provider: 'github',
          providerId: '77',
          owner: 'acme',
          name: input.name,
          sshUrl: `git@github.com:acme/${input.name}.git`,
          defaultBranch: 'main',
          private: true,
          gitConnectionId: connection.id,
        }));
      },
      brokerCredentials: async () => ({ httpsToken: 'unused-for-file-transport' }),
    };
    const worlds = new WorldRegistry();
    const gateway = (await Gateway.create({
      store,
      worlds,
      githubApp,
      bus: new KarmaxBus(),
      tokens: new TokenAuthority(),
      staticDir: fs.mkdtempSync(path.join(home, 'static-')),
    } as any));
    let listening: Awaited<ReturnType<Gateway['listen']>> | undefined;
    try {
      listening = await gateway.listen(49_000);
      await expect.poll(() => actors, { timeout: 5_000 }).toEqual(['owner']);
      expect(inputs).toMatchObject([{ private: true }]);
      await expect.poll(async () => (await store.projectWiki(project.id))?.repository, { timeout: 5_000 }).toBeTruthy();
      const linked = (await store.projectWiki(project.id))!.repository;
      expect(linked).toMatchObject({ private: true, gitConnectionId: connection.id });
      await expect.poll(() => {
        try {
          return execFileSync('git', ['--git-dir', path.join(remotes, `${linked!.name}.git`),
            'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim();
        } catch {
          return '';
        }
      }, { timeout: 5_000 }).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await listening?.close();
      (await store.close());
      if (previousHome === undefined) delete process.env.KARMAX_HOME;
      else process.env.KARMAX_HOME = previousHome;
      if (previousGit.count === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = previousGit.count;
      if (previousGit.key === undefined) delete process.env.GIT_CONFIG_KEY_0;
      else process.env.GIT_CONFIG_KEY_0 = previousGit.key;
      if (previousGit.value === undefined) delete process.env.GIT_CONFIG_VALUE_0;
      else process.env.GIT_CONFIG_VALUE_0 = previousGit.value;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('remote task wiki views', () => {
  it('reads and edits the live provider checkout rather than the global wiki', async () => {
    const contentDir = tmp();
    const store = (await Store.create(':memory:'));
    const organization = (await store.createOrganization({ name: 'Remote org' }));
    const project = (await store.createProject('Remote project', {}, organization.id));
    const wikiRepository = (await store.upsertRepository({ organizationId: organization.id, provider: 'github',
      providerId: 'remote-task-wiki', owner: 'acme', name: 'wiki',
      sshUrl: 'git@github.com:acme/wiki.git', defaultBranch: 'main', private: true }));
    (await store.setProjectWikiRepository(project.id, wikiRepository.id));
    const task = (await store.createTask({ projectId: project.id, title: 'Cloud task', workflow: 'software-dev',
      workflowVersion: '1.0.0', params: { prompt: 'x' } }));
    const root = '/remote/world';
    const repoRoot = `${root}/project-wiki`;
    const handle: any = { kind: 'fake-remote', id: task.id, root, branch: `karmax/${task.id}`, base: 'main',
      repos: [{ name: 'project-wiki', role: 'project-wiki', repo: 'git@github.com:acme/wiki.git',
        root: repoRoot, branch: `karmax/${task.id}`, base: 'main', target: 'main' }] };
    (await store.registerWorld(handle, project.id));
    const files = new Map<string, Buffer>([['project-wiki/notes/live/SKILL.md', Buffer.from('Live branch.')]]);
    const commits: string[] = [];
    const world: any = {
      handle,
      listFiles: async () => [...files.keys()],
      readFileBuffer: async (file: string) => files.get(file)!,
      readFile: async (file: string) => files.get(file)!.toString('utf8'),
      writeFileBuffer: async (file: string, value: Buffer) => { files.set(file, Buffer.from(value)); },
      writeFile: async (file: string, value: string) => { files.set(file, Buffer.from(value)); },
      exec: async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'commit') commits.push(args.at(-1)!);
        return { code: 0, stdout: '', stderr: '' };
      },
      destroy: async () => {},
    };
    const worlds = new WorldRegistry();
    worlds.register({ kind: 'fake-remote', parkable: false, capabilities: { remote: true },
      create: async () => world, open: async () => world } as any);
    const tokens = new TokenAuthority();
    const token = (await tokens.mint({ taskId: task.id, profileId: 'do', principal: `task-agent:${task.id}:do`,
      projectId: project.id, organizationId: organization.id,
      ceiling: ['project:read', 'skill:write'], grantorCaps: ['project:read', 'skill:write'] })).token;
    let canonicalPublishAttempts = 0;
    const api = new KarmaxApi({ store, client: {} as any, taskQueue: 'tq', tokens, contentDir, worlds,
      githubApp: { brokerCredentials: async () => { canonicalPublishAttempts++; return { env: {} }; } } } as any);
    try {
      expect((await api.readWikiResolved(token, 'project', project.id, 'notes/live') as any).page.content).toBe('Live branch.');
      await api.saveWikiPageResolved(token, 'project', project.id,
        { path: 'notes/live', content: 'Changed remotely.' });
      expect(files.get('project-wiki/notes/live/SKILL.md')!.toString()).toBe('Changed remotely.');
      expect(commits).toEqual(['wiki: update notes/live']);
      expect(canonicalPublishAttempts).toBe(0); // task branch still lands through Review/Merge
      expect(readWikiPage(ensureProjectWikiRepository(contentDir, project.id), 'notes/live')).toBeUndefined();

      files.set('project-wiki/notes/prompt/SKILL.md', Buffer.from('Instructions from the remote task branch.'));
      let systemPrompt = '';
      const adapter: any = {
        provider: 'mock',
        runTurn: async (input: any) => {
          systemPrompt = input.systemPrompt;
          return { termination: { kind: 'success', status: 'mock.completed' }, output: 'done' };
        },
      };
      const core = makeCoreActivities({
        store,
        worlds,
        adapters: new Map([['mock', adapter]]),
        profiles: new ProfileResolver(store, 'mock'),
        contentDir,
      });
      await core.runAgentTurn({
        taskId: task.id,
        role: 'do',
        worldHandle: handle,
        messages: [{ id: 'm1', role: 'user', text: 'continue', ts: 0 }],
        task: {
          projectId: project.id,
          project: {},
          title: task.title,
          prompt: 'Follow [[proj:notes/prompt]]',
          // This fake remote implements wiki files only; browser provisioning is tested separately.
          agents: { do: { provider: 'mock', mcpConnections: [] } },
          workflow: 'software-dev',
        } as any,
      });
      expect(systemPrompt).toContain('Instructions from the remote task branch.');
    } finally {
      (await store.close());
      fs.rmSync(contentDir, { recursive: true, force: true });
    }
  });
});

describe('wiki symlink confinement', () => {
  /**
   * A container world's root is bind-mounted from the host, and the project wiki's
   * canonical checkout sits on that host path — so a symlink planted by the
   * sandboxed agent used to resolve against the HOST filesystem. `searchWiki`
   * skipped symlinks for exactly this reason; the page read/write path did not,
   * which made `read_wiki` an arbitrary host-file read primitive.
   */
  const withRoot = (fn: (root: string, outside: string) => void) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-wiki-link-'));
    const root = path.join(base, 'wiki');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.key'), 'SUPER-SECRET');
    try { fn(root, outside); } finally { fs.rmSync(base, { recursive: true, force: true }); }
  };

  it('does not read a page whose markdown file is a symlink out of the root', () => {
    withRoot((root, outside) => {
      fs.mkdirSync(path.join(root, 'pwn'));
      fs.symlinkSync(path.join(outside, 'secret.key'), path.join(root, 'pwn', 'SKILL.md'));
      expect(readWikiPage(root, 'pwn')).toBeUndefined();
    });
  });

  it('does not read through a symlinked section folder', () => {
    withRoot((root, outside) => {
      fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: leak\n---\nSUPER-SECRET');
      fs.symlinkSync(outside, path.join(root, 'linked'));
      expect(readWikiPage(root, 'linked')).toBeUndefined();
      // …and it is not advertised in the tree either.
      expect(JSON.stringify(listWiki(root))).not.toContain('linked');
    });
  });

  it('does not write through a symlinked parent directory', () => {
    withRoot((root, outside) => {
      fs.symlinkSync(outside, path.join(root, 'linked'));
      expect(() => writeWikiPage(root, 'linked/planted', '---\nname: x\n---\nbody', 'skill'))
        .toThrow(/outside the wiki/);
      expect(fs.existsSync(path.join(outside, 'planted'))).toBe(false);
    });
  });

  it('still reads and writes ordinary pages', () => {
    withRoot((root) => {
      writeWikiPage(root, 'real/page', '---\nname: Real\n---\nbody text', 'skill');
      const page = readWikiPage(root, 'real/page');
      expect(page?.name).toBe('Real');
      expect(page?.content).toContain('body text');
    });
  });

  /**
   * The confinement failed OPEN. `resolveInRoot` wrapped `realpathSync(root)` in a
   * catch-everything whose comment claimed the only failure is "no root on disk
   * yet", and returned the UNCHECKED absolute path — so a transient EACCES/EIO, or
   * an ELOOP on the root itself, silently switched symlink confinement off for
   * that call and handed the write path straight back its host-write primitive.
   * Only ENOENT means "not created yet"; `secretFor` (src/auth/identity.ts) already
   * scopes its catch exactly that way.
   */
  it('fails closed when the root realpath fails for a reason other than ENOENT', () => {
    withRoot((root, outside) => {
      fs.symlinkSync(outside, path.join(root, 'linked'));
      const realpath = fs.realpathSync;
      const spy = vi.spyOn(fs, 'realpathSync').mockImplementation(((p: any, ...rest: any[]) => {
        if (p === root) {
          const error: NodeJS.ErrnoException = new Error(`EACCES: permission denied, realpath '${root}'`);
          error.code = 'EACCES';
          throw error;
        }
        return (realpath as any)(p, ...rest);
      }) as any);
      try {
        let thrown: unknown;
        try {
          writeWikiPage(root, 'linked/planted', '---\nname: x\n---\nbody', 'skill');
        } catch (error) { thrown = error; }
        expect(fs.existsSync(path.join(outside, 'planted'))).toBe(false); // no host write
        expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe('EACCES'); // and the real error surfaces
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('still treats a wiki root that does not exist yet as nothing to escape through', () => {
    withRoot((root) => {
      const fresh = path.join(root, 'not-created-yet');
      expect(readWikiPage(fresh, 'anything')).toBeUndefined();
      writeWikiPage(fresh, 'first/page', '---\nname: First\n---\nbody', 'skill');
      expect(readWikiPage(fresh, 'first/page')?.name).toBe('First');
    });
  });
});

describe('search regex safety guard', () => {
  /**
   * The guard rejected quantified GROUPS, backreferences, lookaround and adjacent
   * quantifiers — but a flat SEQUENCE of unbounded quantifiers needs none of
   * those. `a*a*a*…b` is 21 characters (far under WIKI_SEARCH_QUERY_MAX), compiles
   * fine, passes every check, and backtracks super-polynomially against a line of
   * `a`s with no `b`. `searchWiki` runs synchronously in the single
   * gateway+worker process, so that wedges precisely what the guard exists to
   * prevent.
   */
  it('rejects a flat sequence of unbounded quantifiers, which needs no group to blow up', () => {
    expect(isSafeSearchPattern('a*a*a*a*a*a*a*a*a*a*b')).toBe(false);
    expect(isSafeSearchPattern('a+a+a+a+a+a+a+a+a+a+b')).toBe(false);
    expect(isSafeSearchPattern('\\w*\\w*\\w*\\w*\\w*\\w*\\w*!')).toBe(false);
    expect(isSafeSearchPattern('a{1,}a{1,}a{1,}a{1,}a{1,}a{1,}b')).toBe(false);

    // …and the rejection is what keeps the process responsive: the pattern falls
    // back to a literal match, so this returns promptly instead of hanging.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kx-wiki-redos-'));
    try {
      writeWikiPage(root, 'notes/long', `---\nname: Long\n---\n${'a'.repeat(4_000)}`, 'skill');
      const started = Date.now();
      expect(searchWiki(root, 'a*a*a*a*a*a*a*a*a*a*b')).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('still accepts the ordinary regexes a search box is for', () => {
    for (const ok of [
      'migrations',
      'deploy.*runbook',
      '^#+ Setup',
      'TODO|FIXME',
      'karmax\\s+task',
      '[Ww]iki (page|entry)',
      'v\\d+\\.\\d+',
      'foo.*bar.*baz',
    ]) expect(isSafeSearchPattern(ok)).toBe(true);
    // Quantifiers inside a character class are literal characters, not repetition,
    // so they must not count against the cap. (`[*+]` itself still trips the older
    // adjacent-quantifier rule — that pre-existing conservatism is left alone.)
    expect(isSafeSearchPattern('[*]a[+]b')).toBe(true);
    // Escaped quantifiers are literals too.
    expect(isSafeSearchPattern('a\\*b\\*c\\*d\\*e\\*f\\*')).toBe(true);
    // The existing rejections must stay rejections.
    expect(isSafeSearchPattern('(a+)+b')).toBe(false);
    expect(isSafeSearchPattern('(a|a)*b')).toBe(false);
    expect(isSafeSearchPattern('(a)\\1')).toBe(false);
    expect(isSafeSearchPattern('(?=a)b')).toBe(false);
  });
});

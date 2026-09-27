import fs from 'node:fs';
import path from 'node:path';
import { GLOBAL_INSTRUCTIONS } from '../agent/instructions.js';

/**
 * The org/project wiki (skills, memories, and prompts — one system).
 *
 * On disk (under `<contentDir>/wiki/`), each scope owns a directory tree:
 *
 *   wiki/organization/<orgId>/          wiki/project/<projectId>/
 *     deploy-checklist/SKILL.md           guides/            ← section (no SKILL.md)
 *     flaky-ci/MEMORY.md                    e2e-runbook/SKILL.md
 *
 * An **entry** is a folder holding a `SKILL.md` or `MEMORY.md` in the standard
 * Agent Skills format (YAML frontmatter, then markdown). The folder name is the
 * entry's title; any other files (scripts, images, further md files or
 * directories) ride along inside the folder and do NOT count as more entries.
 * A folder WITHOUT a SKILL/MEMORY.md is a section and is recursed into.
 *
 * Frontmatter fields: `name`, `description`, `importance` (a number or
 * low/medium/high, default 0) and `labels` (a free-form list). Delivery is no longer a fixed per-page
 * choice — **every** entry is always listed in the table of contents agents
 * receive each turn. What varies is which entries' *full bodies* are inlined
 * into a given task's prompt:
 *   - an entry labelled `default` is inlined for every task (this is how a
 *     scope's "general prompt" is expressed — it is just a `default` entry);
 *   - a task additionally inlines the entries it tags in its prompt with
 *     `[[proj:…]]`/`[[org:…]]` — a single page, a whole `label`
 *     (`[[proj:tag:…]]`), or a folder (`[[proj:some/section/*]]`). See
 *     `parseWikiRefs`/`resolveWikiRefs`.
 * `importance` orders siblings (higher first) and decides which entries survive
 * a TOC `[more…]` fold. The built-in karmax working instructions are a virtual
 * read-only `default` entry under `@builtin/` — the `@` first segment is
 * reserved and unwritable. Content is snapshotted at the point of use (SPEC
 * §4.4): freely editable, never versioned per execution.
 */

export type WikiScope = 'organization' | 'project';

/** The label that inlines an entry's full body into every task's prompt (what
 *  the old `delivery: unconditional` used to mean — now just a label). */
export const DEFAULT_LABEL = 'default';

export interface WikiEntry {
  /** Folder name (the title unless frontmatter overrides `name`). */
  name: string;
  /** Wiki-root-relative folder path, `/`-separated — the stable handle. */
  path: string;
  kind: 'skill' | 'memory' | 'section';
  /** Frontmatter `description` (skills/memories only). */
  description?: string;
  /** Frontmatter `labels` (skills/memories only). */
  labels?: string[];
  importance?: number;
  /** Virtual, read-only entry shipped by karmax (not on disk). */
  builtin?: boolean;
  /** Section children, sorted (leaves by importance desc, then sections). */
  children?: WikiEntry[];
}

export interface WikiPage {
  name: string;
  path: string;
  kind: 'skill' | 'memory';
  description?: string;
  labels?: string[];
  importance?: number;
  builtin?: boolean;
  /** A built-in whose bundled default is shadowed by an on-disk edit (§9 overlay). */
  overridden?: boolean;
  /** Full markdown (frontmatter included). */
  content: string;
  /** Other files shipped inside the skill folder (relative to it). */
  files: string[];
}

/** TOC lists whose estimated tokens exceed this get [more…]-folded (see renderWikiToc). */
export const WIKI_TOC_TOKEN_BUDGET = 20_000;
/** A penultimate list this long keeps its first FOLD_KEEP entries and folds the rest. */
const FOLD_AT = 10;
const FOLD_KEEP = FOLD_AT - 1;

const PAGE_FILES = ['SKILL.md', 'MEMORY.md'] as const;

/** Reserved first path segment for virtual built-in entries. */
export const BUILTIN_WIKI_PREFIX = '@builtin';

/** Does an entry carry the `default` label (inlined into every task's prompt)? */
export function isDefaultDelivered(e: { labels?: string[] }): boolean {
  return !!e.labels?.includes(DEFAULT_LABEL);
}

/** The karmax working instructions, unified into the wiki as a `default` entry
 *  (shown in every organization wiki, delivered first). These are the bundled
 *  DEFAULTS (§9): an on-disk entry at the same `@builtin/…` path is the editable
 *  override that shadows one; deleting it restores the default. */
export const BUILTIN_WIKI_ENTRIES: WikiPage[] = [
  {
    name: 'How to work',
    path: `${BUILTIN_WIKI_PREFIX}/how-to-work`,
    kind: 'skill',
    description: 'Built-in krmax working instructions, sent to every agent.',
    labels: [DEFAULT_LABEL],
    importance: 1000,
    builtin: true,
    content: GLOBAL_INSTRUCTIONS,
    files: [],
  },
];

/**
 * Resolve the built-ins against a wiki root: an on-disk entry at a built-in's
 * exact path is its editable override and wins; otherwise the bundled default
 * applies. With no root (no organization in scope), defaults apply as-is.
 */
export function resolveBuiltins(root?: string): WikiPage[] {
  return BUILTIN_WIKI_ENTRIES.map((builtin) => {
    if (root) {
      try {
        const override = readWikiPage(root, builtin.path);
        if (override) {
          // Frontmatter the override does not restate keeps the default's
          // identity (its folder name `how-to-work` is not a display name).
          //
          // `labels` is the delivery switch (`isDefaultDelivered` decides whether
          // the body is inlined into every prompt), so it needs a *deliberate*
          // rule rather than the same per-field fallback:
          //   - an override that WROTE a frontmatter block owns its labels —
          //     omitting `default` is how you demote the built-in to a TOC entry
          //     (an intentional affordance, covered by the wiki tests);
          //   - an override with NO frontmatter block at all never expressed an
          //     opinion, so it inherits the default's delivery. Without this, a
          //     user who simply typed replacement instructions into the editor
          //     stripped GLOBAL_INSTRUCTIONS from every agent prompt in the
          //     organization — the body was neither inlined nor replaced by the
          //     bundled default.
          // `importance` is pure ordering, never delivery, so it always falls back.
          const fm = parseFrontmatter(override.content);
          const hasFrontmatter = /^---\r?\n/.test(override.content);
          return {
            ...override,
            name: fm.name ?? builtin.name,
            description: fm.description ?? builtin.description,
            labels: hasFrontmatter ? override.labels : builtin.labels,
            importance: fm.importance ?? builtin.importance,
            builtin: true,
            overridden: true,
          };
        }
      } catch { /* unreadable override — fall back to the bundled default */ }
    }
    return builtin;
  });
}

/** The on-disk root of one scope's wiki. */
export function wikiRoot(contentDir: string, scope: WikiScope, id: string): string {
  return path.join(contentDir, 'wiki', scope, id);
}

/** ~4 chars/token — the same coarse estimate used elsewhere for budget checks. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Reject traversal/absolute segments and normalize a wiki-relative path. Every
 * external `path` input funnels through here before touching the filesystem.
 */
export function safeWikiPath(rel: string): string {
  const parts = String(rel ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.some((s) => s === '.' || s === '..' || s.includes('\0'))) throw new Error('invalid wiki path');
  return parts.join('/');
}

/**
 * Resolve `rel` under the wiki root, refusing anything that leaves the root through
 * a SYMLINK. Returns the absolute path, or undefined if it escapes.
 *
 * `safeWikiPath` above is string surgery — it rejects `..` and absolute segments but
 * cannot see a symlink, and `fs.readFileSync`/`existsSync`/`statSync` all follow
 * them. That was a real read primitive, not a theoretical one: for a CONTAINER world
 * the world root is bind-mounted from the host (`-v ${handle.root}:/work`,
 * src/world/container.ts), and `KarmaxApi.wikiScope` hands back that same host path
 * as the wiki root. So a sandboxed agent could plant
 * `<wiki-repo>/pwn/SKILL.md -> /home/<user>/.karmax/vault/vault.key`, call
 * `read_wiki(path: "pwn")`, and get the host file back in its context — and, via a
 * symlinked intermediate directory, `writeWikiPage`'s recursive mkdir + write gave
 * it a constrained write primitive too.
 *
 * `searchWiki` already skipped symlinks for exactly this reason (see its lstat
 * check); the page read/write path is what was missed. Resolving with `realpath`
 * covers the symlinked-parent case that a per-entry lstat would not.
 *
 * For a path that does not exist yet (a page being created), the nearest existing
 * ancestor is what gets checked — that is the one an attacker could have symlinked.
 */
function resolveInRoot(root: string, rel: string): string | undefined {
  const abs = path.resolve(root, rel);
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch (error) {
    // ONLY "the root isn't there yet" means there is nothing to escape through.
    // Catching every error made this confinement fail OPEN: a transient
    // EACCES/EIO, or an ELOOP on the root itself, returned the UNCHECKED path and
    // silently handed the read/write primitive above straight back. Same reasoning
    // as `secretFor` in src/auth/identity.ts.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    return abs; // no root on disk yet — nothing to escape through
  }
  let probe = abs;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      const suffix = path.relative(probe, abs);
      const resolved = suffix ? path.join(real, suffix) : real;
      return real === realRoot || real.startsWith(realRoot + path.sep) ? resolved : undefined;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return undefined;
      probe = parent;
    }
  }
}

/** A path writes may target: safe AND not under the reserved `@` namespace —
 *  except a built-in's exact path, where the write IS the editable override. */
function writableWikiPath(rel: string): string {
  const safe = safeWikiPath(rel);
  if (!safe) throw new Error('a wiki page needs a folder path');
  if (safe.split('/')[0]!.startsWith('@') && !BUILTIN_WIKI_ENTRIES.some((b) => b.path === safe))
    throw new Error('"@…" paths are reserved for built-in entries');
  return safe;
}

/** Split a frontmatter `labels` value — a comma-separated list, optionally in
 *  `[a, b]` flow form — into trimmed, de-duplicated, non-empty labels. */
export function parseLabels(raw?: string): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.replace(/^\[|\]$/g, '').split(',')) {
    const label = part.trim().replace(/^["']|["']$/g, '');
    if (label && !out.includes(label)) out.push(label);
  }
  return out;
}

/** Worded `importance` values, so `importance: high` keeps its intent rather
 *  than dropping to the default; the scale matches the numbers pages use. */
const IMPORTANCE_WORDS = new Map(Object.entries({ lowest: -200, low: -100, medium: 0, normal: 0, high: 100, highest: 200, critical: 200 }));

/** Minimal YAML-frontmatter reader — the flat `key: value` scalars the Agent
 *  Skills format uses (`name`, `description`, `labels`, `importance`), plus a
 *  `- item` block list under an empty key (read as a comma list); anything
 *  richer is ignored rather than mis-parsed. A legacy `delivery: unconditional`
 *  is read forward as the `default` label. */
export function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  labels: string[];
  importance?: number;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { body: content, labels: [] };
  const fields: Record<string, string> = {};
  let listKey: string | undefined;
  for (const line of m[1]!.split(/\r?\n/)) {
    const item = listKey && /^\s*-\s+(.*)$/.exec(line);
    if (item) {
      fields[listKey!] = [fields[listKey!], item[1]!.trim()].filter(Boolean).join(', ');
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    listKey = undefined;
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    fields[key] = kv[2]!.trim().replace(/^["']|["']$/g, '');
    if (!fields[key]) listKey = key;
  }
  const worded = IMPORTANCE_WORDS.get((fields.importance ?? '').toLowerCase());
  const importance = worded ?? (fields.importance ? Number(fields.importance) : NaN);
  const labels = parseLabels(fields.labels);
  // Back-compat: an older `delivery: unconditional` is the `default` label now.
  if (fields.delivery === 'unconditional' && !labels.includes(DEFAULT_LABEL)) labels.unshift(DEFAULT_LABEL);
  return {
    name: fields.name || undefined,
    description: fields.description || undefined,
    labels,
    importance: Number.isFinite(importance) ? importance : undefined,
    body: content.slice(m[0].length),
  };
}

/** Does `dir` hold at least one nested entry (i.e. is it a real section)? An
 *  empty folder is not — writing a page into one is ordinary. */
function isSectionDir(dir: string): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((child) => {
    if (child.startsWith('.')) return false;
    try {
      if (!fs.lstatSync(path.join(dir, child)).isDirectory()) return false;
    } catch {
      return false;
    }
    const entry = readEntry(dir, child);
    return !!entry && (entry.kind !== 'section' || !!entry.children?.length);
  });
}

function pageFileIn(dir: string): { file: string; kind: 'skill' | 'memory' } | undefined {
  for (const f of PAGE_FILES) {
    if (fs.existsSync(path.join(dir, f))) return { file: f, kind: f === 'SKILL.md' ? 'skill' : 'memory' };
  }
  return undefined;
}

/** Sibling order everywhere (tree, TOC, folds): leaves by importance desc then
 *  name, sections after, by name. */
function sortEntries(entries: WikiEntry[]): WikiEntry[] {
  const rank = (e: WikiEntry) => (e.kind === 'section' ? 1 : 0);
  return entries.sort(
    (a, b) => rank(a) - rank(b) || (b.importance ?? 0) - (a.importance ?? 0) || a.name.localeCompare(b.name),
  );
}

function readEntry(root: string, rel: string): WikiEntry | undefined {
  const dir = path.join(root, rel);
  const folder = path.basename(rel) || path.basename(root);
  const page = pageFileIn(dir);
  if (page) {
    const entry: WikiEntry = { name: folder, path: rel.replace(/\\/g, '/'), kind: page.kind };
    try {
      const fm = parseFrontmatter(fs.readFileSync(path.join(dir, page.file), 'utf8'));
      if (fm.name) entry.name = fm.name;
      entry.description = fm.description;
      if (fm.labels.length) entry.labels = fm.labels;
      if (fm.importance !== undefined) entry.importance = fm.importance;
    } catch { /* unreadable — index by folder name alone */ }
    return entry;
  }
  const children: WikiEntry[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const child of names.sort((a, b) => a.localeCompare(b))) {
    // `@…` at the root holds built-in overrides — resolved by resolveBuiltins(),
    // never listed as an ordinary section (it would double the entry).
    if (child.startsWith('.') || (!rel && child.startsWith('@'))) continue;
    const childRel = rel ? `${rel}/${child}` : child;
    try {
      // lstat, not stat: a symlinked section would pull an out-of-root tree into
      // the listing, and every page under it would then read through. Same reason
      // searchWiki skips them — see resolveInRoot.
      if (!fs.lstatSync(path.join(dir, child)).isDirectory()) continue;
    } catch {
      continue;
    }
    const entry = readEntry(root, childRel);
    if (entry && (entry.kind !== 'section' || entry.children!.length)) children.push(entry);
  }
  return { name: folder, path: rel.replace(/\\/g, '/'), kind: 'section', children: sortEntries(children) };
}

/**
 * Walk one scope's wiki into its entry tree. `rel` narrows to a subtree (used
 * to expand a `[more…]` fold). Returns an empty section when nothing exists yet.
 */
export function listWiki(root: string, rel = ''): WikiEntry {
  const safe = safeWikiPath(rel);
  return readEntry(root, safe) ?? { name: safe ? path.basename(safe) : '', path: safe, kind: 'section', children: [] };
}

/** Visit every leaf (skill/memory) entry of a tree in order. */
function walkLeaves(tree: WikiEntry, fn: (e: WikiEntry) => void): void {
  const rec = (e: WikiEntry) => {
    if (e.kind === 'section') (e.children ?? []).forEach(rec);
    else fn(e);
  };
  rec(tree);
}

/** Read one skill/memory page (its markdown plus the folder's other files). */
export function readWikiPage(root: string, rel: string): WikiPage | undefined {
  const safe = safeWikiPath(rel);
  if (!safe) return undefined;
  const dir = resolveInRoot(root, safe);
  if (!dir) return undefined; // symlinked out of the wiki root — see resolveInRoot
  const page = pageFileIn(dir);
  if (!page) return undefined;
  // The page file itself must not be a symlink either: the folder can be genuine
  // while `SKILL.md` inside it points at an arbitrary host file.
  const pageFile = resolveInRoot(root, path.join(safe, page.file));
  if (!pageFile) return undefined;
  const content = fs.readFileSync(pageFile, 'utf8');
  const fm = parseFrontmatter(content);
  const files: string[] = [];
  const walk = (sub: string) => {
    for (const f of fs.readdirSync(path.join(dir, sub))) {
      if (f.startsWith('.')) continue;
      const relFile = sub ? `${sub}/${f}` : f;
      if (relFile === page.file) continue;
      // Attachments are listed by name and fetched separately; a symlinked one
      // would make that fetch read outside the root, so drop it here.
      const st = fs.lstatSync(path.join(dir, relFile));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(relFile);
      else files.push(relFile);
    }
  };
  try { walk(''); } catch { /* folder listing is best-effort */ }
  return {
    name: fm.name || path.basename(safe),
    path: safe,
    kind: page.kind,
    description: fm.description,
    labels: fm.labels.length ? fm.labels : undefined,
    importance: fm.importance,
    content,
    files: files.sort(),
  };
}

/**
 * Create or overwrite a skill/memory page. Section folders are made on demand.
 * `create: true` refuses to overwrite an existing entry (the UI's new-entry
 * guard). `kind` picks SKILL.md vs MEMORY.md: an omitted `kind` keeps an
 * existing entry's file, but passing one that differs converts the entry in
 * place (the old SKILL.md/MEMORY.md is swapped out; attached files stay put).
 */
export function writeWikiPage(
  root: string,
  rel: string,
  content: string,
  kind?: 'skill' | 'memory',
  opts: { create?: boolean } = {},
): WikiPage {
  const safe = writableWikiPath(rel);
  // Same symlink confinement as the read path (see resolveInRoot): a symlinked
  // intermediate directory would otherwise let the recursive mkdir + write below
  // land a SKILL.md/MEMORY.md anywhere on the host filesystem.
  const dir = resolveInRoot(root, safe);
  if (!dir) throw new Error(`"${safe}" resolves outside the wiki`);
  const existing = fs.existsSync(dir) ? pageFileIn(dir) : undefined;
  // A built-in "exists" even without an on-disk override — create must not
  // silently become the override for one.
  if (opts.create && (existing || BUILTIN_WIKI_ENTRIES.some((b) => b.path === safe)))
    throw new Error(`an entry already exists at "${safe}"`);
  // Writing a page AT a section path turns that folder into a leaf: `readEntry`
  // stops recursing and the whole subtree vanishes from every wiki API while it
  // is still on disk. Reject it rather than silently hiding content.
  if (!existing && fs.existsSync(dir) && isSectionDir(dir))
    throw new Error(`"${safe}" is a section holding other entries; pick a path inside it instead`);
  fs.mkdirSync(dir, { recursive: true });
  const file = (kind ? (kind === 'memory' ? 'MEMORY.md' : 'SKILL.md') : existing?.file) ?? 'SKILL.md';
  if (existing && existing.file !== file) fs.rmSync(path.join(dir, existing.file));
  fs.writeFileSync(path.join(dir, file), content);
  return readWikiPage(root, safe)!;
}

/** Rename/move an entry's folder (attached files travel with it). Built-in
 *  paths are fixed identities — nothing moves onto or away from them. */
export function moveWikiPage(root: string, from: string, to: string): void {
  const src = writableWikiPath(from);
  const dst = writableWikiPath(to);
  if (src === dst) return;
  if (src.startsWith('@') || dst.startsWith('@')) throw new Error('built-in entries cannot be renamed');
  // Both ends confined — see resolveInRoot. A symlinked source would move a host
  // directory into the wiki; a symlinked destination parent would move wiki
  // content out of it.
  const srcDir = resolveInRoot(root, src);
  const dstDir = resolveInRoot(root, dst);
  if (!srcDir || !dstDir) throw new Error('that path resolves outside the wiki');
  if (!pageFileIn(srcDir)) throw new Error(`no entry at "${src}"`);
  if (fs.existsSync(dstDir)) throw new Error(`an entry already exists at "${dst}"`);
  fs.mkdirSync(path.dirname(dstDir), { recursive: true });
  fs.renameSync(srcDir, dstDir);
}

/**
 * Remove a skill/memory folder from the wiki.
 *
 * A *section* (a folder with no SKILL/MEMORY.md, holding other entries) is a
 * different and far more destructive operation: the delete is unversioned and
 * unrecoverable, so one mistyped path could take out an entire subtree of an
 * organization's knowledge. Removing one therefore requires an explicit
 * `recursive: true` from the caller, which makes the accidental path impossible
 * from any API that does not deliberately ask for it.
 */
export function deleteWikiPage(root: string, rel: string, opts: { recursive?: boolean } = {}): boolean {
  const safe = writableWikiPath(rel);
  // Confined like the read/write paths — a symlinked section must not turn this
  // recursive rm loose on a host directory outside the wiki (see resolveInRoot).
  const dir = resolveInRoot(root, safe);
  if (!dir || !fs.existsSync(dir)) return false;
  if (!pageFileIn(dir) && !opts.recursive)
    throw new Error(`"${safe}" is a section, not a page; deleting it removes every entry under it — pass recursive to confirm`);
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export interface WikiSearchHit {
  /** Wiki-root-relative file path of the match. */
  file: string;
  line: number;
  text: string;
}

/** Longest `search_wiki` query we will compile. The query is agent-controlled
 *  and matched synchronously per line, so it is bounded input, not free text. */
export const WIKI_SEARCH_QUERY_MAX = 512;

/**
 * Is `pattern` safe to hand to `new RegExp` and run per line on the host event
 * loop? A regex engine with backtracking can take exponential time on patterns
 * that nest an unbounded quantifier inside another (`(a+)+`, `(a|a)*`), and
 * karmax runs the gateway, the worker and every activity in ONE process — so a
 * single catastrophic pattern from `search_wiki` wedges all of them.
 *
 * Rather than try to decide the general case, this is deliberately conservative:
 * only patterns built from clearly-linear constructs pass. Anything else falls
 * through to a literal (escaped) match, which is what a human typing prose into
 * the search box wanted anyway. False negatives cost an agent an exotic regex;
 * a false positive costs the whole process.
 */
/** How many unbounded quantifiers (`*`, `+`, `{n,}`) a query may contain. A flat
 *  run of n of them costs O(line^n) to fail, so this stays small; real search
 *  queries ("deploy.*runbook", "v\d+\.\d+") sit at one or two. */
const MAX_UNBOUNDED_QUANTIFIERS = 3;

/** Count unbounded quantifiers, ignoring the two places a `*`/`+`/`{n,}` is just a
 *  character: escaped (`\*`) and inside a character class (`[*+]`). */
function countUnboundedQuantifiers(pattern: string): number {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c === '*' || c === '+') { count++; continue; }
    if (c === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) continue; // a literal `{`, not a repetition
      if (/^\{\s*\d+\s*,\s*\}$/.test(pattern.slice(i, close + 1))) count++;
      i = close;
    }
  }
  return count;
}

export function isSafeSearchPattern(pattern: string): boolean {
  // Any group that can repeat is the ingredient catastrophic patterns need.
  // Reject a quantifier applied to a group, and nested quantifiers generally.
  if (/\)\s*[*+?{]/.test(pattern)) return false;
  // Back-references turn matching super-linear in several engines.
  if (/\\\d/.test(pattern)) return false;
  // Lookaround can hide a quantified group behind an assertion.
  if (/\(\?[=!<]/.test(pattern)) return false;
  // Two adjacent unbounded quantifiers (`a+*`, `a*+`) — not valid JS anyway.
  if (/[*+?}][*+]/.test(pattern)) return false;
  // Unbounded repetition counts (`a{2,}`) applied repeatedly.
  if (/\{\s*\d+\s*,\s*\}\s*[*+?]/.test(pattern)) return false;
  // A GROUP is not required to blow up. Every check above looks for nesting, but a
  // flat SEQUENCE of unbounded quantifiers over overlapping atoms backtracks
  // super-polynomially all the same: `a*a*a*a*a*a*a*a*a*a*b` is 21 characters,
  // compiles, passed every rule above, and never returns against a line of `a`s
  // with no `b`. Cap the count rather than try to prove the atoms disjoint.
  if (countUnboundedQuantifiers(pattern) > MAX_UNBOUNDED_QUANTIFIERS) return false;
  return true;
}

/**
 * Grep the wiki's markdown (host-side, so it works identically for cloud
 * worlds where the agent's shell cannot reach the karmax home). The query is a
 * case-insensitive regular expression, falling back to a literal match when it
 * does not parse **or when it is not provably linear** (see
 * `isSafeSearchPattern`).
 *
 * The walk uses `lstatSync` and skips symlinks entirely. That is load-bearing,
 * not tidiness: for container worlds the world root is bind-mounted from the
 * host, so a symlink planted by the sandboxed agent would otherwise resolve
 * against the *host* filesystem and give it a read primitive for any `*.md`.
 * Each entry is also stat'd inside its own try/catch so a dangling symlink or a
 * racing delete cannot 500 the search for the whole scope.
 */
export function searchWiki(root: string, query: string, limit = 50): WikiSearchHit[] {
  const raw = String(query ?? '');
  if (raw.length > WIKI_SEARCH_QUERY_MAX)
    throw new Error(`wiki search query is too long (${raw.length} > ${WIKI_SEARCH_QUERY_MAX} characters)`);
  const literal = () => new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  let re: RegExp;
  if (!isSafeSearchPattern(raw)) {
    re = literal();
  } else {
    try {
      re = new RegExp(raw, 'i');
    } catch {
      re = literal();
    }
  }
  const hits: WikiSearchHit[] = [];
  const walk = (rel: string) => {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(root, rel)).sort((a, b) => a.localeCompare(b));
    } catch {
      return;
    }
    for (const f of names) {
      if (hits.length >= limit) return;
      if (f.startsWith('.')) continue;
      const relFile = rel ? `${rel}/${f}` : f;
      const abs = path.join(root, relFile);
      try {
        const st = fs.lstatSync(abs);
        if (st.isSymbolicLink()) continue; // never escape the wiki root
        if (st.isDirectory()) walk(relFile);
        else if (st.isFile() && f.endsWith('.md')) {
          const lines = fs.readFileSync(abs, 'utf8').split('\n');
          for (let i = 0; i < lines.length && hits.length < limit; i++) {
            if (re.test(lines[i]!)) hits.push({ file: relFile, line: i + 1, text: lines[i]!.trim().slice(0, 240) });
          }
        }
      } catch { /* dangling symlink, racing delete, unreadable file — skip it */ }
    }
  };
  walk('');
  return hits;
}

// ─── Tagging wiki context onto a task (`[[proj:…]]` / `[[org:…]]`) ───────

/** A reference a task's prompt makes to wiki content it wants inlined in full:
 *  a single `page`, an entire `label`, or a `folder` and everything under it. */
export interface WikiRef {
  scope: WikiScope;
  kind: 'page' | 'label' | 'folder';
  /** Page path, label name, or folder path (already wiki-markup stripped). */
  value: string;
}

/** A parsed reference together with its exact source range. Keeping ranges in
 *  the shared grammar lets callers decorate or inspect text without trying to
 *  rediscover where a reference came from. */
export interface WikiRefMatch extends WikiRef {
  start: number;
  end: number;
  raw: string;
}

/** The wiki-context tokens a task gets when it never touches the context field:
 *  the two scopes' `default` labels (so `default` pages are inlined by default,
 *  and a task can opt out by clearing them from the field). */
export const DEFAULT_CONTEXT_TOKENS = ['[[proj:tag:default]]', '[[org:tag:default]]'];

/** Markdown code ranges. Fences follow CommonMark's important rules (up to
 *  three leading spaces, backtick or tilde runs, a closing run at least as long
 *  as the opener); inline spans close only on an equal-length backtick run.
 *  Unclosed inline delimiters are ordinary text, while an unclosed fence owns
 *  the remainder of the document. */
function markdownCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fenced: Array<[number, number]> = [];
  const indented: Array<[number, number]> = [];
  let open: { char: '`' | '~'; length: number; start: number } | undefined;
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const end = newline < 0 ? text.length : newline + 1;
    const line = text.slice(offset, newline < 0 ? text.length : newline).replace(/\r$/, '');
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(line);
      if (close && close[1]![0] === open.char && close[1]!.length >= open.length) {
        fenced.push([open.start, end]);
        open = undefined;
      }
    } else {
      const begin = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (begin && (begin[1]![0] !== '`' || !begin[2]!.includes('`'))) {
        open = { char: begin[1]![0] as '`' | '~', length: begin[1]!.length, start: offset };
      } else if (/^(?: {4}|\t)/.test(line)) indented.push([offset, end]);
    }
    offset = end;
  }
  if (open) fenced.push([open.start, text.length]);
  ranges.push(...fenced, ...indented);

  const blockAt = (at: number) => ranges.find(([start, end]) => at >= start && at < end);
  for (let i = 0; i < text.length;) {
    const block = blockAt(i);
    if (block) {
      const range = block;
      i = range[1];
      continue;
    }
    if (text[i] !== '`') { i++; continue; }
    let length = 1;
    while (text[i + length] === '`') length++;
    const boundary = ranges.filter(([start]) => start > i).reduce((min, [start]) => Math.min(min, start), text.length);
    let close = i + length;
    while (close < boundary) {
      close = text.indexOf('`'.repeat(length), close);
      if (close < 0 || close >= boundary) { close = -1; break; }
      const exact = text[close - 1] !== '`' && text[close + length] !== '`';
      if (exact) break;
      close += length;
    }
    if (close >= 0 && close < text.length) {
      ranges.push([i, close + length]);
      i = close + length;
    } else {
      i += length;
    }
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/**
 * Locate every `[[proj:…]]` / `[[org:…]]` reference in free text (a task
 * prompt, review prompt, or follow-up). Backslash-escaped openers and references
 * inside Markdown inline/fenced code are literal examples, never context.
 * Grammar of the part after the scope colon:
 *   `tag:<label>`   → a whole label            (kind `label`)
 *   `<path>/*`      → a folder and its subtree  (kind `folder`)
 *   `<path>`        → one page                  (kind `page`)
 * Values are deliberately whitespace/bracket-free, making the closing `]]`
 * unambiguous and keeping stored tokens portable between prose and form fields.
 */
export function scanWikiRefs(text: string): WikiRefMatch[] {
  const source = String(text ?? '');
  const out: WikiRefMatch[] = [];
  const code = markdownCodeRanges(source);
  const inCode = (start: number, end: number) => code.some(([a, b]) => start < b && end > a);
  const re = /\[\[(proj|org):([^\s\[\]]+)\]\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const start = m.index;
    const end = start + m[0].length;
    let slashes = 0;
    for (let i = start - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
    if (slashes % 2 || inCode(start, end)) continue;
    const scope: WikiScope = m[1]!.toLowerCase() === 'proj' ? 'project' : 'organization';
    const rest = m[2]!;
    let kind: WikiRef['kind'] = 'page';
    let value = rest;
    if (/^tag:/i.test(rest)) {
      kind = 'label';
      value = rest.slice(4).replace(/\/+$/, '');
    } else if (rest.endsWith('/*')) {
      kind = 'folder';
      value = rest.slice(0, -2);
    }
    if (value) out.push({ scope, kind, value, start, end, raw: m[0] });
  }
  return out;
}

/** Extract references without their source-location metadata. */
export function parseWikiRefs(text: string): WikiRef[] {
  return scanWikiRefs(text).map(({ scope, kind, value }) => ({ scope, kind, value }));
}

/** Resolve the refs that target `scope` into the set of page paths they name
 *  (a page that exists, every page under a folder, every page with a label). */
export function resolveWikiRefs(refs: WikiRef[], scope: WikiScope, root: string, tree: WikiEntry): string[] {
  const out = new Set<string>();
  for (const ref of refs) {
    if (ref.scope !== scope) continue;
    let value: string;
    try {
      value = safeWikiPath(ref.value);
    } catch {
      if (ref.kind !== 'label') continue;
      value = ref.value;
    }
    if (ref.kind === 'page') {
      if (pageFileIn(path.join(root, value))) out.add(value);
    } else if (ref.kind === 'folder') {
      walkLeaves(tree, (e) => { if (e.path === value || e.path.startsWith(`${value}/`)) out.add(e.path); });
    } else {
      walkLeaves(tree, (e) => { if (e.labels?.includes(ref.value)) out.add(e.path); });
    }
  }
  return [...out];
}

// ─── The `@`-mention search (what the task-form dropdown queries) ─────────────

export interface WikiSuggestion {
  kind: 'page' | 'label' | 'folder';
  /** The value to append after `[[proj:`/`[[org:` to insert this suggestion. */
  ref: string;
  /** Display label. */
  name: string;
  description?: string;
  /** For labels/folders: how many pages it covers. */
  count?: number;
}

/** Case-insensitive relevance of `needle` against `hay`: prefix > word-start >
 *  substring > subsequence; -1 for no match. Empty needle matches everything. */
function matchScore(hay: string, needle: string): number {
  if (!needle) return 1;
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  const idx = h.indexOf(n);
  if (idx === 0) return 100 - h.length * 0.01;
  if (idx > 0) return 60 + (/[\s/_-]/.test(h[idx - 1]!) ? 20 : 0) - idx * 0.1;
  let hi = 0;
  for (const c of n) {
    hi = h.indexOf(c, hi);
    if (hi < 0) return -1;
    hi++;
  }
  return 20;
}

/** The best of a page/folder's path or last segment against the query. */
function pathScore(p: string, needle: string): number {
  return Math.max(matchScore(p, needle), matchScore(p.split('/').pop() ?? p, needle));
}

/**
 * Rank wiki pages, folders, and labels of one scope against a typed query for
 * the `@`-mention dropdown. A `tag:` prefix restricts to labels; a trailing
 * `*` (or `/*`) biases folders; otherwise pages, folders, and labels are mixed
 * by relevance (importance breaks near-ties so the useful entries surface).
 */
export function suggestWiki(root: string, query: string, limit = 8): WikiSuggestion[] {
  const tree = listWiki(root);
  const leaves: WikiEntry[] = [];
  const folders: WikiEntry[] = [];
  const labelCounts = new Map<string, number>();
  walkLeaves(tree, (e) => {
    leaves.push(e);
    for (const l of e.labels ?? []) labelCounts.set(l, (labelCounts.get(l) ?? 0) + 1);
  });
  const collectFolders = (e: WikiEntry) => {
    if (e.kind !== 'section') return;
    if (e.path) folders.push(e);
    (e.children ?? []).forEach(collectFolders);
  };
  (tree.children ?? []).forEach(collectFolders);
  const folderCount = (p: string) => leaves.filter((e) => e.path === p || e.path.startsWith(`${p}/`)).length;

  const raw = String(query ?? '').trim();
  const labelsOnly = raw.toLowerCase().startsWith('tag:');
  const foldersBias = /\/?\*+$/.test(raw);
  const q = (labelsOnly ? raw.slice(4) : raw).replace(/\/?\*+$/, '').trim();

  const scored: (WikiSuggestion & { score: number })[] = [];
  if (!labelsOnly) {
    for (const e of leaves) {
      const s = pathScore(e.path, q);
      if (s > 0) scored.push({ kind: 'page', ref: e.path, name: e.name, description: e.description, score: s + (e.importance ?? 0) * 0.001 });
    }
    for (const e of folders) {
      const s = pathScore(e.path, q);
      if (s > 0) scored.push({ kind: 'folder', ref: `${e.path}/*`, name: `${e.path}/*`, count: folderCount(e.path), score: s + (foldersBias ? 15 : 0) });
    }
  }
  if (!foldersBias) {
    for (const [label, count] of labelCounts) {
      const s = matchScore(label, q);
      if (s > 0) scored.push({ kind: 'label', ref: `tag:${label}`, name: `tag:${label}`, count, score: s + (labelsOnly ? 15 : 0) });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
  return scored.slice(0, limit).map(({ score: _score, ...s }) => s);
}

/**
 * Ceiling on the total tokens of *inlined page bodies* per scope, per turn.
 *
 * `WIKI_TOC_TOKEN_BUDGET` only ever governed the table of contents, while every
 * `default`-labelled body was inlined in full into every turn of every task —
 * twenty 5k-token pages meant 100k tokens per turn with no warning anywhere.
 * Bodies are far more expensive than TOC lines, so this budget is separate and
 * smaller. Overflow is not dropped: a page that does not fit is demoted to a TOC
 * line (it stops being in the `exclude` set), so the agent can still find and
 * open it.
 */
export const WIKI_INLINE_TOKEN_BUDGET = 20_000;

/** Read a set of page paths into ordered (importance desc, then path) pages with
 *  their bodies for prompt delivery. Unreadable entries are skipped.
 *  `budget`, when given, caps the total inlined body tokens: pages are taken in
 *  priority order until the budget is spent and the rest are returned to the
 *  caller separately as `overflow` so it can list them in the TOC instead. */
function readOrderedPages(
  root: string,
  paths: Iterable<string>,
  budget?: number,
): { pages: (WikiPage & { body: string })[]; overflow: string[] } {
  const all: (WikiPage & { body: string })[] = [];
  for (const rel of paths) {
    try {
      const page = readWikiPage(root, rel);
      if (page) all.push({ ...page, body: parseFrontmatter(page.content).body.trim() });
    } catch { /* unreadable entry — skip from delivery */ }
  }
  all.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || a.path.localeCompare(b.path));
  if (budget === undefined) return { pages: all, overflow: [] };
  const pages: (WikiPage & { body: string })[] = [];
  const overflow: string[] = [];
  let spent = 0;
  for (const page of all) {
    const cost = estimateTokens(page.body);
    // Always inline at least the single most important page, even if it alone
    // exceeds the budget — otherwise a scope with one huge `default` page would
    // deliver no instructions at all.
    if (pages.length && spent + cost > budget) { overflow.push(page.path); continue; }
    pages.push(page);
    spent += cost;
  }
  return { pages, overflow };
}

/** Every `default`-labelled entry of a tree (importance desc, then path), with
 *  its body read back — the pages inlined into every task's prompt. */
export function collectDefaultPages(root: string, tree: WikiEntry): (WikiPage & { body: string })[] {
  const paths: string[] = [];
  walkLeaves(tree, (e) => { if (isDefaultDelivered(e)) paths.push(e.path); });
  return readOrderedPages(root, paths).pages;
}

/**
 * Render the TOC the agent sees: every entry of a scope's catalogue, expanded
 * to every leaf, names + descriptions only, siblings in importance order.
 * Entries whose full body is already inlined into this task's prompt (the
 * `exclude` set — `default`-labelled and `@`-tagged pages) are left out so they
 * are not sent twice. When the whole TOC would exceed `budget` tokens, every
 * penultimate list (a section's direct skills) with ≥ FOLD_AT entries keeps its
 * FOLD_KEEP most important and folds the rest behind a `[more…]` line naming
 * the exact `read_wiki` call that expands it.
 */
export function renderWikiToc(tree: WikiEntry, opts: { scope: WikiScope; id: string; budget?: number; exclude?: Set<string> }): string {
  const base = { fold: false, scope: opts.scope, id: opts.id, exclude: opts.exclude ?? new Set<string>() };
  const full = renderEntries(tree.children ?? [], 0, base);
  if (estimateTokens(full) <= (opts.budget ?? WIKI_TOC_TOKEN_BUDGET)) return full;
  return renderEntries(tree.children ?? [], 0, { ...base, fold: true });
}

function renderEntries(entries: WikiEntry[], depth: number, opts: { fold: boolean; scope: WikiScope; id: string; exclude: Set<string> }): string {
  const pad = '  '.repeat(depth);
  const lines: string[] = [];
  const leaves = entries.filter((e) => e.kind !== 'section' && !opts.exclude.has(e.path));
  const sections = entries.filter((e) => e.kind === 'section');
  const shown = opts.fold && leaves.length >= FOLD_AT ? leaves.slice(0, FOLD_KEEP) : leaves;
  for (const e of shown) {
    const tag = e.kind === 'memory' ? ' (memory)' : '';
    const labels = e.labels?.length ? ` {${e.labels.join(', ')}}` : '';
    // The entry is a Markdown link to its own path: agents still read the path
    // verbatim, and the wiki UI renders it as a click-through to the page.
    lines.push(`${pad}- [${e.name}](${e.path})${tag}${labels}${e.description ? ` — ${e.description}` : ''}`);
  }
  if (shown.length < leaves.length) {
    const parent = leaves[0]!.path.split('/').slice(0, -1).join('/');
    lines.push(
      `${pad}- [more…] ${leaves.length - shown.length} more entries — read_wiki(scope: "${opts.scope}", id: "${opts.id}"${parent ? `, path: "${parent}"` : ''}) lists them all`,
    );
  }
  for (const s of sections) {
    const subtree = renderEntries(s.children ?? [], depth + 1, opts);
    if (!subtree) continue;
    lines.push(`${pad}- ${s.name}/`);
    lines.push(subtree);
  }
  return lines.filter(Boolean).join('\n');
}

/** The body of a page (frontmatter stripped), falling back to the full content. */
function pageBody(page: WikiPage): string {
  return parseFrontmatter(page.content).body.trim() || page.content;
}

/**
 * The per-turn prompt block (SPEC §5.4 "global + project instructions"): the
 * built-in working instructions (an on-disk `@builtin/…` edit in the org wiki
 * shadows the bundled default), then per scope (organization, then project) the
 * full bodies of the entries inlined for this task, followed by the TOC of the
 * rest, with one usage line so the agent knows how to open, expand, and search
 * entries from ANY world (the tools run host-side).
 *
 * Which entries are inlined = the task's **wiki-context tokens** (`contextTokens`,
 * defaulting to `[[proj:tag:default]] [[org:tag:default]]` when the task never set the
 * field — so `default` pages inline by default, and a task can opt out by
 * clearing them) UNION the `[[proj:…]]`/`[[org:…]]` references written inline in the
 * prompt/follow-ups (`taggedText`). The built-in working instructions are always
 * delivered regardless (they are not subject to the context field).
 */
export function buildWikiPromptContext(args: {
  contentDir: string;
  organizationId?: string;
  projectId?: string;
  /** Live task-world checkout for the project wiki. When absent, use the
   * canonical repository under `contentDir` (human/default-branch reads). */
  projectRoot?: string;
  /** External override for the built-in instructions (tests/deployments). */
  builtinInstructions?: string;
  /** Task text scanned for `[[proj:…]]`/`[[org:…]]` references. */
  taggedText?: string;
  /** The task's wiki-context field tokens; `undefined` ⇒ the default tokens. */
  contextTokens?: string[];
}): string {
  const orgRoot = args.organizationId ? wikiRoot(args.contentDir, 'organization', args.organizationId) : undefined;
  const builtins = args.builtinInstructions === undefined ? resolveBuiltins(orgRoot) : [];
  // Old tasks may still carry the former @-tokens in their dedicated context
  // field. Read those forward here, but never recognize them in prose: new and
  // edited text has one unambiguous canonical syntax.
  const tokens = (args.contextTokens ?? DEFAULT_CONTEXT_TOKENS).map((token) => {
    const t = String(token).trim();
    if (/^\[\[(?:proj|org):[^\s\[\]]+\]\]$/i.test(t)) return t;
    if (/^@(proj|org):\S+$/i.test(t)) return `[[${t.slice(1)}]]`;
    if (/^(proj|org):\S+$/i.test(t)) return `[[${t}]]`;
    return t;
  });
  const refs = [...parseWikiRefs(tokens.join(' ')), ...(args.taggedText ? parseWikiRefs(args.taggedText) : [])];
  const entryOf = ({ content: _c, files: _f, ...entry }: WikiPage): WikiEntry => entry;
  const sections: string[] =
    args.builtinInstructions !== undefined
      ? [args.builtinInstructions]
      : builtins.filter(isDefaultDelivered).map(pageBody);
  const scopes: { scope: WikiScope; id: string; heading: string }[] = [];
  if (args.organizationId) scopes.push({ scope: 'organization', id: args.organizationId, heading: 'Organization' });
  if (args.projectId) scopes.push({ scope: 'project', id: args.projectId, heading: 'Project' });
  let hasWiki = false;
  for (const { scope, id, heading } of scopes) {
    const root = scope === 'project' && args.projectRoot
      ? args.projectRoot
      : wikiRoot(args.contentDir, scope, id);
    const tree = listWiki(root);
    // Inlined in full: every ref this task resolves to (context field defaults +
    // inline prompt tags). The built-in `default` entries are inlined above
    // (before the scope headings), so only on-disk pages are gathered here.
    const inlined = new Set<string>();
    for (const p of resolveWikiRefs(refs, scope, root, tree)) inlined.add(p);
    // Bodies are budgeted (WIKI_INLINE_TOKEN_BUDGET); anything that does not fit
    // drops out of `inlined` and is therefore listed in the TOC below instead.
    const { pages, overflow } = readOrderedPages(root, inlined, WIKI_INLINE_TOKEN_BUDGET);
    for (const p of overflow) inlined.delete(p);
    // The TOC lists every entry NOT already inlined above (built-ins included in
    // the org catalogue; the `default` ones are inlined, so they drop out too).
    const tocTree =
      scope === 'organization' && builtins.length
        ? { ...tree, children: [...builtins.map(entryOf), ...(tree.children ?? [])] }
        : tree;
    const exclude = new Set(inlined);
    if (scope === 'organization') for (const b of builtins) if (isDefaultDelivered(b)) exclude.add(b.path);
    const toc = renderWikiToc(tocTree, { scope, id, exclude });
    if (!pages.length && !toc) continue;
    hasWiki = true;
    const parts = [`# ${heading} instructions`];
    for (const page of pages) if (page.body) parts.push(page.body);
    if (toc) parts.push(`## ${heading} wiki — skills & memories (titles only; open before relying on one)\n${toc}`);
    sections.push(parts.join('\n\n'));
  }
  if (hasWiki) {
    const apiBase = (s: { scope: WikiScope; id: string }) =>
      s.scope === 'project' ? `/api/projects/${s.id}/wiki` : `/api/organizations/${s.id}/wiki`;
    sections.push(
      `Wiki access (works from any world, including cloud sandboxes): read_wiki(scope, id, path?) — no path lists a full table of contents (expanding any [more…]), a section path lists that section, a skill path returns its full markdown; search_wiki(scope, id, query) greps every wiki page. ` +
        `Scopes here: ${scopes.map((s) => `${s.scope} id "${s.id}"`).join(', ')}. ` +
        `To add or update an entry, platform_request PUT ${scopes.map(apiBase).join('/page or ')}/page with {path, content, kind} (SKILL.md format: YAML frontmatter name/description/labels/importance, then markdown; label an entry \`default\` to inline it into every task). ` +
        `To inline a page/label/folder into a task's context, reference it as \`[[proj:<path>]]\` / \`[[org:<path>]]\` (a whole label is \`[[proj:tag:<label>]]\`, a folder is \`[[proj:<section>/*]]\`); create_task also accepts a \`wikiContext\` array of these references.`,
    );
  }
  return sections.join('\n\n');
}

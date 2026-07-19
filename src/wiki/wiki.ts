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
 * Frontmatter fields: `name`, `description`, and two delivery controls —
 *   delivery: unconditional | indexed   (default indexed)
 *   importance: <number>                (default 0)
 * An *indexed* entry appears in the table of contents agents receive each turn;
 * an *unconditional* entry's full body is sent with every prompt instead (this
 * is how a scope's "general prompt" is expressed — it is just an entry).
 * `importance` orders siblings (higher first) and decides which entries survive
 * a TOC `[more…]` fold. The built-in karmax working instructions are a virtual
 * read-only unconditional entry under `@builtin/` — the `@` first segment is
 * reserved and unwritable. Content is snapshotted at the point of use (SPEC
 * §4.4): freely editable, never versioned per execution.
 */

export type WikiScope = 'organization' | 'project';
export type WikiDelivery = 'unconditional' | 'indexed';

export interface WikiEntry {
  /** Folder name (the title unless frontmatter overrides `name`). */
  name: string;
  /** Wiki-root-relative folder path, `/`-separated — the stable handle. */
  path: string;
  kind: 'skill' | 'memory' | 'section';
  /** Frontmatter `description` (skills/memories only). */
  description?: string;
  delivery?: WikiDelivery;
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
  delivery?: WikiDelivery;
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

/** The karmax working instructions, unified into the wiki as an unconditional
 *  entry (shown in every organization wiki, delivered first). These are the
 *  bundled DEFAULTS (§9): an on-disk entry at the same `@builtin/…` path is the
 *  editable override that shadows one; deleting it restores the default. */
export const BUILTIN_WIKI_ENTRIES: WikiPage[] = [
  {
    name: 'How to work',
    path: `${BUILTIN_WIKI_PREFIX}/how-to-work`,
    kind: 'skill',
    description: 'Built-in karmax working instructions, sent to every agent.',
    delivery: 'unconditional',
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
          const fm = parseFrontmatter(override.content);
          return {
            ...override,
            name: fm.name ?? builtin.name,
            description: fm.description ?? builtin.description,
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

/** A path writes may target: safe AND not under the reserved `@` namespace —
 *  except a built-in's exact path, where the write IS the editable override. */
function writableWikiPath(rel: string): string {
  const safe = safeWikiPath(rel);
  if (!safe) throw new Error('a wiki page needs a folder path');
  if (safe.split('/')[0]!.startsWith('@') && !BUILTIN_WIKI_ENTRIES.some((b) => b.path === safe))
    throw new Error('"@…" paths are reserved for built-in entries');
  return safe;
}

/** Minimal YAML-frontmatter reader — the flat `key: value` scalars the Agent
 *  Skills format uses (`name`, `description`, `delivery`, `importance`);
 *  anything richer is ignored rather than mis-parsed. */
export function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  delivery?: WikiDelivery;
  importance?: number;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { body: content };
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    fields[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, '');
  }
  const importance = Number(fields.importance);
  return {
    name: fields.name || undefined,
    description: fields.description || undefined,
    delivery: fields.delivery === 'unconditional' ? 'unconditional' : fields.delivery === 'indexed' ? 'indexed' : undefined,
    importance: Number.isFinite(importance) ? importance : undefined,
    body: content.slice(m[0].length),
  };
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
      if (fm.delivery) entry.delivery = fm.delivery;
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
      if (!fs.statSync(path.join(dir, child)).isDirectory()) continue;
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

/** Read one skill/memory page (its markdown plus the folder's other files). */
export function readWikiPage(root: string, rel: string): WikiPage | undefined {
  const safe = safeWikiPath(rel);
  if (!safe) return undefined;
  const dir = path.join(root, safe);
  const page = pageFileIn(dir);
  if (!page) return undefined;
  const content = fs.readFileSync(path.join(dir, page.file), 'utf8');
  const fm = parseFrontmatter(content);
  const files: string[] = [];
  const walk = (sub: string) => {
    for (const f of fs.readdirSync(path.join(dir, sub))) {
      if (f.startsWith('.')) continue;
      const relFile = sub ? `${sub}/${f}` : f;
      if (relFile === page.file) continue;
      if (fs.statSync(path.join(dir, relFile)).isDirectory()) walk(relFile);
      else files.push(relFile);
    }
  };
  try { walk(''); } catch { /* folder listing is best-effort */ }
  return {
    name: fm.name || path.basename(safe),
    path: safe,
    kind: page.kind,
    description: fm.description,
    delivery: fm.delivery,
    importance: fm.importance,
    content,
    files: files.sort(),
  };
}

/**
 * Create or overwrite a skill/memory page. Section folders are made on demand.
 * `create: true` refuses to overwrite an existing entry (the UI's new-entry
 * guard); `kind` applies only at creation — an existing page keeps its file.
 */
export function writeWikiPage(
  root: string,
  rel: string,
  content: string,
  kind: 'skill' | 'memory' = 'skill',
  opts: { create?: boolean } = {},
): WikiPage {
  const safe = writableWikiPath(rel);
  const dir = path.join(root, safe);
  const existing = fs.existsSync(dir) ? pageFileIn(dir) : undefined;
  // A built-in "exists" even without an on-disk override — create must not
  // silently become the override for one.
  if (opts.create && (existing || BUILTIN_WIKI_ENTRIES.some((b) => b.path === safe)))
    throw new Error(`an entry already exists at "${safe}"`);
  fs.mkdirSync(dir, { recursive: true });
  const file = existing?.file ?? (kind === 'memory' ? 'MEMORY.md' : 'SKILL.md');
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
  if (!pageFileIn(path.join(root, src))) throw new Error(`no entry at "${src}"`);
  if (fs.existsSync(path.join(root, dst))) throw new Error(`an entry already exists at "${dst}"`);
  fs.mkdirSync(path.dirname(path.join(root, dst)), { recursive: true });
  fs.renameSync(path.join(root, src), path.join(root, dst));
}

/** Remove a skill folder (or an entire section) from the wiki. */
export function deleteWikiPage(root: string, rel: string): boolean {
  const safe = writableWikiPath(rel);
  const dir = path.join(root, safe);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export interface WikiSearchHit {
  /** Wiki-root-relative file path of the match. */
  file: string;
  line: number;
  text: string;
}

/**
 * Grep the wiki's markdown (host-side, so it works identically for cloud
 * worlds where the agent's shell cannot reach the karmax home). The query is a
 * case-insensitive regular expression, falling back to a literal match when it
 * does not parse.
 */
export function searchWiki(root: string, query: string, limit = 50): WikiSearchHit[] {
  let re: RegExp;
  try {
    re = new RegExp(query, 'i');
  } catch {
    re = new RegExp(String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
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
      if (fs.statSync(abs).isDirectory()) walk(relFile);
      else if (f.endsWith('.md')) {
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          if (re.test(lines[i]!)) hits.push({ file: relFile, line: i + 1, text: lines[i]!.trim().slice(0, 240) });
        }
      }
    }
  };
  walk('');
  return hits;
}

/** Every unconditional entry of a tree (importance desc, then path), with its
 *  body read back for delivery. */
export function collectUnconditional(root: string, tree: WikiEntry): (WikiPage & { body: string })[] {
  const found: WikiEntry[] = [];
  const walk = (e: WikiEntry) => {
    if (e.kind === 'section') (e.children ?? []).forEach(walk);
    else if (e.delivery === 'unconditional') found.push(e);
  };
  walk(tree);
  found.sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || a.path.localeCompare(b.path));
  const out: (WikiPage & { body: string })[] = [];
  for (const e of found) {
    try {
      const page = readWikiPage(root, e.path);
      if (page) out.push({ ...page, body: parseFrontmatter(page.content).body.trim() });
    } catch { /* unreadable entry — skip from delivery */ }
  }
  return out;
}

/**
 * Render the TOC the agent sees: the indexed entries (unconditional ones are
 * delivered in full instead), expanded to every leaf, names + descriptions
 * only, siblings in importance order. When the whole TOC would exceed `budget`
 * tokens, every penultimate list (a section's direct skills) with ≥ FOLD_AT
 * entries keeps its FOLD_KEEP most important and folds the rest behind a
 * `[more…]` line naming the exact `read_wiki` call that expands it.
 */
export function renderWikiToc(tree: WikiEntry, opts: { scope: WikiScope; id: string; budget?: number }): string {
  const full = renderEntries(tree.children ?? [], 0, { fold: false, scope: opts.scope, id: opts.id });
  if (estimateTokens(full) <= (opts.budget ?? WIKI_TOC_TOKEN_BUDGET)) return full;
  return renderEntries(tree.children ?? [], 0, { fold: true, scope: opts.scope, id: opts.id });
}

function renderEntries(entries: WikiEntry[], depth: number, opts: { fold: boolean; scope: WikiScope; id: string }): string {
  const pad = '  '.repeat(depth);
  const lines: string[] = [];
  const leaves = entries.filter((e) => e.kind !== 'section' && e.delivery !== 'unconditional');
  const sections = entries.filter((e) => e.kind === 'section');
  const shown = opts.fold && leaves.length >= FOLD_AT ? leaves.slice(0, FOLD_KEEP) : leaves;
  for (const e of shown) {
    const tag = e.kind === 'memory' ? ' (memory)' : '';
    lines.push(`${pad}- ${e.name}${tag} [${e.path}]${e.description ? ` — ${e.description}` : ''}`);
  }
  if (shown.length < leaves.length) {
    const parent = leaves[0]!.path.split('/').slice(0, -1).join('/');
    lines.push(
      `${pad}- [more…] ${leaves.length - shown.length} more entries — read_wiki(scope: "${opts.scope}", id: "${opts.id}"${parent ? `, path: "${parent}"` : ''}) lists them all`,
    );
  }
  for (const s of sections) {
    const subtree = renderEntries(s.children ?? [], depth + 1, opts);
    if (!subtree) continue; // e.g. a section whose entries are all unconditional
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
 * shadows the bundled default), then per scope (organization, then project)
 * its unconditional entries in full followed by the indexed TOC, with one usage
 * line so the agent knows how to open, expand, and search entries from ANY
 * world (the tools run host-side).
 */
export function buildWikiPromptContext(args: {
  contentDir: string;
  organizationId?: string;
  projectId?: string;
  /** External override for the built-in instructions (tests/deployments). */
  builtinInstructions?: string;
}): string {
  const orgRoot = args.organizationId ? wikiRoot(args.contentDir, 'organization', args.organizationId) : undefined;
  const builtins = args.builtinInstructions === undefined ? resolveBuiltins(orgRoot) : [];
  const sections: string[] =
    args.builtinInstructions !== undefined
      ? [args.builtinInstructions]
      : builtins.filter((b) => b.delivery === 'unconditional').map(pageBody);
  const scopes: { scope: WikiScope; id: string; heading: string }[] = [];
  if (args.organizationId) scopes.push({ scope: 'organization', id: args.organizationId, heading: 'Organization' });
  if (args.projectId) scopes.push({ scope: 'project', id: args.projectId, heading: 'Project' });
  let hasWiki = false;
  for (const { scope, id, heading } of scopes) {
    const root = wikiRoot(args.contentDir, scope, id);
    const tree = listWiki(root);
    const unconditional = collectUnconditional(root, tree);
    // A built-in overridden to `delivery: indexed` moves from the standing
    // prompt into the organization TOC like any other indexed entry.
    const indexedBuiltins = scope === 'organization' ? builtins.filter((b) => b.delivery !== 'unconditional') : [];
    const tocTree = indexedBuiltins.length
      ? { ...tree, children: [...indexedBuiltins.map(({ content: _c, files: _f, ...entry }) => entry), ...(tree.children ?? [])] }
      : tree;
    const toc = renderWikiToc(tocTree, { scope, id });
    if (!unconditional.length && !toc) continue;
    hasWiki = true;
    const parts = [`# ${heading} instructions`];
    for (const entry of unconditional) if (entry.body) parts.push(entry.body);
    if (toc) parts.push(`## ${heading} wiki — skills & memories (titles only; open before relying on one)\n${toc}`);
    sections.push(parts.join('\n\n'));
  }
  if (hasWiki) {
    const apiBase = (s: { scope: WikiScope; id: string }) =>
      s.scope === 'project' ? `/api/projects/${s.id}/wiki` : `/api/organizations/${s.id}/wiki`;
    sections.push(
      `Wiki access (works from any world, including cloud sandboxes): read_wiki(scope, id, path?) — no path lists a full table of contents (expanding any [more…]), a section path lists that section, a skill path returns its full markdown; search_wiki(scope, id, query) greps every wiki page. ` +
        `Scopes here: ${scopes.map((s) => `${s.scope} id "${s.id}"`).join(', ')}. ` +
        `To add or update an entry, platform_request PUT ${scopes.map(apiBase).join('/page or ')}/page with {path, content, kind} (SKILL.md format: YAML frontmatter name/description/delivery/importance, then markdown).`,
    );
  }
  return sections.join('\n\n');
}

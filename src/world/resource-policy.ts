import path from 'node:path';
import type { World } from './types.js';

/**
 * How a writable resource's files merge (pramana: generated and binary files —
 * compressed staged records, caches, SQLite side files — were line-merged and
 * conflicted on nearly every sub-task). A `.tavyamerge` file at the resource's
 * root names, like a .gitattributes, what happens to the files a pattern
 * matches when both sides changed them:
 *
 *   # pattern        policy
 *   *.sqlite-shm     skip      never saved: it stays in the world that wrote it
 *   cache/           newest    the copy modified last wins
 *   staged/*.zst     theirs    the incoming copy wins (a sub-task's, a newer published one)
 *   notes.md         mine      this copy wins
 *
 * Patterns follow .gitignore: `*` and `?` within a name, `**` across folders,
 * a leading `/` or a `/` inside anchors to the resource's root, otherwise the
 * name matches at any depth; a trailing `/` matches a folder and everything in
 * it. The last line that matches decides. The file itself is part of the
 * resource, so a merge reads this copy's.
 */
export type MergePolicy = 'mine' | 'theirs' | 'newest' | 'skip';
export const POLICY_FILE = '.tavyamerge';
const POLICIES: readonly MergePolicy[] = ['mine', 'theirs', 'newest', 'skip'];

export interface PolicyRule {
  pattern: string;
  policy: MergePolicy;
  /** Matches a resource-relative path (no leading slash). */
  regex: RegExp;
}

/** The rules of a `.tavyamerge` file; lines it cannot read are ignored. */
export function parsePolicies(text: string): PolicyRule[] {
  const rules: PolicyRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '').replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^(\S+)\s+(\S+)$/);
    if (!match || !POLICIES.includes(match[2] as MergePolicy)) continue;
    const regex = patternRegex(match[1]!);
    if (regex) rules.push({ pattern: match[1]!, policy: match[2] as MergePolicy, regex });
  }
  return rules;
}

/** The policy for a resource-relative path: the last rule matching it. */
export function policyFor(rules: PolicyRule[], file: string): MergePolicy | undefined {
  let found: MergePolicy | undefined;
  for (const rule of rules) if (rule.regex.test(file)) found = rule.policy;
  return found;
}

/** restic `--exclude` patterns for the `skip` rules of a resource saved from
 * `root` (an absolute folder): restic matches an unanchored pattern at any
 * depth, as .gitignore does, and an anchored one against the absolute path. */
export function skipExcludes(rules: PolicyRule[], root: string): string[] {
  return rules.filter((rule) => rule.policy === 'skip').map((rule) => {
    const pattern = rule.pattern.replace(/\/+$/, '');
    return anchored(rule.pattern) ? path.posix.join(root, pattern.replace(/^\/+/, '')) : pattern;
  }).filter(Boolean);
}

/** This copy's rules: its `.tavyamerge`, if the resource is a folder that has one. */
export async function readPolicies(world: World, place: { path: string; file?: boolean }): Promise<PolicyRule[]> {
  if (place.file) return [];
  const read = await world.exec('bash', ['-c', 'f="$1/$2"; [ -f "$f" ] && head -c 65536 -- "$f" || true', 'policy', place.path, POLICY_FILE],
    { cwd: world.handle.root, timeoutMs: 30_000 }).catch(() => undefined);
  return read && read.code === 0 ? parsePolicies(read.stdout) : [];
}

function anchored(pattern: string): boolean {
  return pattern.replace(/\/+$/, '').includes('/');
}

function patternRegex(pattern: string): RegExp | undefined {
  const directory = pattern.endsWith('/');
  const body = pattern.replace(/\/+$/, '').replace(/^\/+/, '');
  if (!body || body.split('/').includes('..')) return undefined;
  let source = '';
  for (let i = 0; i < body.length; i++) {
    const char = body[i]!;
    if (char === '*' && body[i + 1] === '*') {
      // `**/` any folders (or none); a trailing `**` everything below.
      if (body[i + 2] === '/') { source += '(?:.*/)?'; i += 2; } else { source += '.*'; i += 1; }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const prefix = anchored(pattern) ? '^' : '^(?:.*/)?';
  // A folder (named with `/`, or any name that is one) takes what is inside it.
  return new RegExp(`${prefix}${source}${directory ? '/.*$' : '(?:/.*)?$'}`);
}

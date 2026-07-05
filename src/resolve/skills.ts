import fs from 'node:fs';
import path from 'node:path';

/**
 * The self-healing loop (SPEC §3.4). Resolve skills were WRITE-ONLY: `saveSkill` wrote
 * `skills/resolve/<slug>.md` but nothing read them back, so a hard-won fix never helped
 * the next time. This indexes them so the Resolve agent's prompt (`{{skills}}`) lists
 * prior resolutions — it reuses a known fix instead of rediscovering one.
 */
export interface ResolveSkill {
  /** Canonical name, e.g. "resolve/npm-eresolve". */
  name: string;
  /** One-line gist (first non-heading line of the skill file). */
  summary: string;
}

/** Index the saved resolve skills under `<contentDir>/skills/`. Reads the canonical
 *  `resolve/<slug>.md` subdir and the legacy flattened `resolve-<slug>.md` form. */
export function listResolveSkills(contentDir: string): ResolveSkill[] {
  const skillsDir = path.join(contentDir, 'skills');
  const out: ResolveSkill[] = [];
  const seen = new Set<string>();
  const add = (name: string, file: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    let summary = '';
    try {
      const txt = fs.readFileSync(file, 'utf8');
      summary = txt.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
    } catch { /* unreadable — index by name alone */ }
    out.push({ name, summary: summary.slice(0, 200) });
  };
  // Canonical: skills/resolve/<slug>.md
  try {
    const dir = path.join(skillsDir, 'resolve');
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) add(`resolve/${f.replace(/\.md$/, '')}`, path.join(dir, f));
  } catch { /* none */ }
  // Legacy flattened: skills/resolve-<slug>.md (before saveSkill kept subdirs)
  try {
    for (const f of fs.readdirSync(skillsDir)) {
      if (f.startsWith('resolve-') && f.endsWith('.md')) add(`resolve/${f.slice('resolve-'.length).replace(/\.md$/, '')}`, path.join(skillsDir, f));
    }
  } catch { /* none */ }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Render the index into the resolve prompt's `{{skills}}` slot. */
export function renderSkillsIndex(skills: ResolveSkill[]): string {
  if (!skills.length) return '(none saved yet — if you resolve a mechanically-recognizable error, save one so it helps next time.)';
  return skills.map((s) => `- ${s.name}${s.summary ? ` — ${s.summary}` : ''}`).join('\n');
}

import fs from 'node:fs';
import path from 'node:path';

/**
 * .env parsing helpers for onboarding surfaces (PLAN-state §3.1). Secret
 * STORAGE is the typed resource model (secret@1 attachments, values in the
 * vault) — these helpers only turn pasted/checked-in text into names/values.
 */

/** Secret names a repo's .env example files declare (PLAN-state phase 2): the
 * repo already names its secrets — onboarding only has to ask for the values.
 * Unlike parseEnv, blank values count here: `STRIPE_KEY=` IS the declaration. */
export function envExampleNames(dirs: string[]): string[] {
  const names = new Set<string>();
  for (const dir of dirs) {
    for (const file of ['.env.example', '.env.sample', '.env.template']) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(dir, file), 'utf8');
      } catch {
        continue;
      }
      for (const name of envExampleNamesFromText(text)) names.add(name);
    }
  }
  return [...names];
}

/** The name-extraction half of {@link envExampleNames}, for content that
 * arrives without a filesystem (the GitHub contents API on hosted). */
export function envExampleNamesFromText(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) names.add(m[1]!);
  }
  return [...names];
}

/** Parse .env text: KEY=value lines, optional `export `, quotes, # comments. */
export function parseEnv(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, ''); // unquoted trailing comment
    if (!value) continue; // a blank value is a template line (.env.example), not a secret
    out.push({ name: m[1]!, value });
  }
  return out;
}

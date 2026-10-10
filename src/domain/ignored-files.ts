/** How files Git ignores are classified when a project is onboarded: the
 * console's scan (src/world/resource-scan.ts) and `tavya import` share these
 * rules. Pure: names and sizes only. */

/** A name that commonly holds credentials (its contents are never guessed at). */
export function likelySecret(name: string): boolean {
  return /^\.env(?:\.|$)/.test(name) || /(?:secret|credentials?|tokens?)(?:\.|$)/.test(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name);
}

/** An example file documents variables; it holds none. */
export function exampleEnvironmentFile(name: string): boolean {
  return /^\.env\.(?:example|sample|template|dist|defaults?)$/i.test(name);
}

export function sqliteDatabase(relative: string): boolean { return /\.(sqlite3?|db)$/i.test(relative); }

/** A top-level folder worth keeping as data even when small. */
export function dataFolder(top: string): boolean { return /^(data|datasets?|models?|uploads?|artifacts?|assets?)$/i.test(top); }

/** What a build or package manager regenerates: never data. */
export function regenerated(top: string): boolean {
  return /^(node_modules|dist|build|out|target|coverage|\.next|\.nuxt|\.turbo|\.cache|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.gradle|\.idea|\.vscode|\.DS_Store|\.tavya|\.karmax-injection)$/.test(top);
}

/** Folders at least this large are proposed as data. */
export const DATA_FOLDER_BYTES = 50 * 1024 * 1024;

export function variableName(name: string): string {
  const clean = name.replace(/^\.+/, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^([^A-Z_])/, '_$1');
  return clean || 'SECRET';
}

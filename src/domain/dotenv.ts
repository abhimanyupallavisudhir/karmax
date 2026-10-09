/**
 * `.env` files: what a project's repository-scoped variables are rendered into
 * inside a world (and by the tavya CLI), and how a pasted file is read. Pure, so
 * the CLI bundle can import it.
 */

/** A dotenv file name (`.env`, `.env.local`, `.env.production`), not a template. */
export function dotenvFile(file: string): boolean {
  const base = file.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  return /^\.env(\.|$)/.test(base) && !/^\.env\.(example|sample|template)$/.test(base);
}

/** Parse KEY=value lines. Quotes are removed; double quotes may span lines and
 * carry \n, \" and \\ escapes; blank values are dropped (nothing to store). */
export function parseDotenv(text: string): Array<{ name: string; value: string }> {
  const values: Array<{ name: string; value: string }> = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!;
    if (value.startsWith('"')) {
      let body = value.slice(1);
      while (!closingQuote(body) && index + 1 < lines.length) body += `\n${lines[++index]}`;
      const end = closingQuote(body);
      value = (end === undefined ? body : body.slice(0, end))
        .replace(/\\(.)/g, (_, char: string) => char === 'n' ? '\n' : char === 'r' ? '\r' : char === 't' ? '\t' : char);
    } else if (value.startsWith("'")) {
      const end = value.indexOf("'", 1);
      value = end < 0 ? value.slice(1) : value.slice(1, end);
    } else value = value.replace(/\s+#.*$/, '').trim();
    if (value) values.push({ name: match[1]!, value });
  }
  return values;
}

function closingQuote(body: string): number | undefined {
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') i++;
    else if (body[i] === '"') return i;
  }
  return undefined;
}

/** Render variables as a dotenv file that Node's dotenv, python-dotenv and
 * Docker Compose all read back unchanged: bare when safe, single-quoted
 * (literal everywhere) when possible, else double-quoted with escapes. */
export function renderDotenv(values: Array<{ name: string; value: string }>): string {
  return values.map(({ name, value }) => `${name}=${dotenvValue(value)}\n`).join('');
}

function dotenvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]*$/.test(value)) return value;
  if (!/['\n\r]/.test(value)) return `'${value}'`;
  return `"${value.replace(/[\\"\n\r]/g, (char) => char === '\n' ? '\\n' : char === '\r' ? '\\r' : `\\${char}`)}"`;
}

/** A `.env` line's secret name, unique in its project (names are): two
 * repositories may each have their own DATABASE_URL. */
export function dotenvSecretName(file: { path: string; repository?: string }, variable: string): string {
  return `${file.repository === undefined ? '' : `${file.repository}/`}${file.path.replace(/^\.\//, '')}:${variable}`;
}

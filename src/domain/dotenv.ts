/** The variables a `.env` file sets (values unquoted; empty ones skipped).
 * The server's secret import and `tavya import` read files the same way. */
export function parseEnvironmentValues(text: string): Array<{ name: string; value: string }> {
  const values: Array<{ name: string; value: string }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    if (value) values.push({ name: match[1]!, value });
  }
  return values;
}

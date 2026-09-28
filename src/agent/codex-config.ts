/** The MCP server names a Codex `config.toml` defines, read without running
 * Codex (LT-1). Karmax writes the remote home's config itself, so launching
 * `codex mcp list` in the sandbox only to learn those names cost a CLI start
 * every turn. Returns undefined for anything this scanner does not fully
 * understand, or for configuration that makes Codex load servers from another
 * layer (trusted project config, plugins); the caller then asks Codex. */
export function codexConfigMcpServers(source: string): string[] | undefined {
  const names = new Set<string>();
  let table: string[] = [];
  let i = 0;
  const blank = () => { while (source[i] === ' ' || source[i] === '\t') i++; };
  const toLineEnd = () => { while (i < source.length && source[i] !== '\n') i++; };
  // A string of any of TOML's four kinds; false for one that never closes.
  const string = (): boolean => {
    const quote = source[i]!;
    if (source.startsWith(quote.repeat(3), i)) {
      const close = quote.repeat(3);
      for (i += 3; i < source.length; i++) {
        if (quote === '"' && source[i] === '\\') { i++; continue; }
        if (source.startsWith(close, i)) {
          i += 3;
          // Up to two quotes may end the content itself: """a""""
          for (let extra = 0; extra < 2 && source[i] === quote; extra++) i++;
          return true;
        }
      }
      return false;
    }
    for (i++; i < source.length && source[i] !== '\n'; i++) {
      if (quote === '"' && source[i] === '\\') { i++; continue; }
      if (source[i] === quote) { i++; return true; }
    }
    return false;
  };
  const key = (): string[] | undefined => {
    const parts: string[] = [];
    for (;;) {
      blank();
      const start = i;
      if (source[i] === '"' || source[i] === "'") {
        if (source.startsWith(source[i]!.repeat(3), i) || !string()) return undefined;
        const part = source.slice(start + 1, i - 1);
        // An escaped name is legal TOML, but not worth decoding here.
        if (source[start] === '"' && part.includes('\\')) return undefined;
        parts.push(part);
      } else {
        while (/[A-Za-z0-9_-]/.test(source[i] ?? '')) i++;
        if (i === start) return undefined;
        parts.push(source.slice(start, i));
      }
      blank();
      if (source[i] !== '.') return parts;
      i++;
    }
  };
  // Skip one value, including arrays and inline tables spanning lines.
  const value = (): boolean => {
    let depth = 0;
    while (i < source.length) {
      const c = source[i]!;
      if (c === '"' || c === "'") { if (!string()) return false; }
      else if (c === '[' || c === '{') { depth++; i++; }
      else if (c === ']' || c === '}') { if (--depth < 0) return false; i++; }
      else if (c === '#') toLineEnd();
      else if (c === '\n') { if (!depth) return true; i++; }
      else i++;
    }
    return !depth;
  };
  const lineEnd = (): boolean => {
    blank();
    if (source[i] === '#') toLineEnd();
    if (source[i] === '\r') i++;
    return i >= source.length || source[i] === '\n';
  };
  const layered = (parts: string[]) => parts[0] === 'projects' || parts[0] === 'plugins';
  const server = (parts: string[]): boolean => {
    if (parts[0] !== 'mcp_servers') return true;
    // `mcp_servers = { … }` and `[[mcp_servers]]` are rare; let Codex read them.
    if (parts.length < 2) return false;
    names.add(parts[1]!);
    return true;
  };
  while (i < source.length) {
    blank();
    const c = source[i];
    if (c === '\n' || c === '\r') { i++; continue; }
    if (c === '#') { toLineEnd(); continue; }
    if (c === '[') {
      const array = source[i + 1] === '[';
      i += array ? 2 : 1;
      const parts = key();
      if (!parts || source[i] !== ']' || (array && source[i + 1] !== ']')) return undefined;
      i += array ? 2 : 1;
      if (!lineEnd() || layered(parts) || (array && parts[0] === 'mcp_servers') || (parts.length > 1 && !server(parts))) return undefined;
      table = parts;
      continue;
    }
    const parts = key();
    if (!parts || source[i] !== '=') return undefined;
    i++;
    blank();
    const full = [...table, ...parts];
    if (layered(full) || !server(full) || !value()) return undefined;
  }
  return [...names];
}

/** One POSIX shell word: safe for any string, including spaces and quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A name the shell can `export`: letters, digits and _, not starting with a digit. */
export function isEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

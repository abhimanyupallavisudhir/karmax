/** One POSIX shell word: safe for any string, including spaces and quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

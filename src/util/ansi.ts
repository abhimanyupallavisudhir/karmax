/** Text without terminal escape sequences (colours, cursor moves): CLIs such as
 * Codex colour their logs even when writing to a pipe. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

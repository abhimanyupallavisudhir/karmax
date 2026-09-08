/**
 * A branch name karmax will hand to `git` as a positional argument. The rules
 * are git's own (`git check-ref-format --branch`): no leading `-` (`git branch
 * <target> <base>` with target `-D` deletes the base; `git fetch origin
 * --upload-pack=<cmd>` runs a program on the host), no control characters,
 * spaces or `~ ^ : ? * [ \`, no `..`, `@{` or `//`, no component that starts
 * with `.` or ends with `.lock`, no trailing `/` or `.`. Anything else git
 * accepts — including non-ASCII names — is accepted here too.
 */
export function validGitBranch(value: string): boolean {
  if (!value || value.length > 250) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(value)) return false;
  if (value.includes('..') || value.includes('@{') || value.includes('//') || value === '@') return false;
  return value.split('/').every((component) => component.length > 0 && !component.startsWith('.') && !component.endsWith('.lock'));
}

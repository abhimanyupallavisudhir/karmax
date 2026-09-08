/**
 * A branch name karmax will hand to `git` as a positional argument. Anything
 * git's own `check-ref-format --branch` would reject is refused, and so is a
 * leading `-`: `git branch <target> <base>` with target `-D` deletes the base,
 * and `git fetch origin --upload-pack=<cmd>` runs a program on the host.
 */
export function validGitBranch(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(value)
    && !value.includes('..') && !value.includes('@{') && !value.includes('//')
    && !value.endsWith('/') && !value.endsWith('.') && !value.endsWith('.lock');
}

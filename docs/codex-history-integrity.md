# Codex history integrity: audit and repair

Codex `0.144.5`–`0.153.4` could reuse a rollout ordinal after resuming a thread
whose last record ended in a decimal number (upstream fix
[69cebb5](https://github.com/openai/codex/commit/69cebb5d15939bf9b6c1b4647b53879beab91ba2)).
The next paginated fork then failed history projection. Karmax pins a fixed Codex
(the installed dependency, remote launcher, browser image and handoff commands
share one version; cloud images are version-checked before their baked binary is
used). Upgrading prevents new damage but does not repair existing files.

## Audit and repair

Audit a stopped account home (read-only):

```sh
npx tsx src/scripts/codex-history.ts --home /path/to/codex-home
```

To publish recoveries, first take a control-plane/database backup and stop every
writer of that home, then rerun with `--repair`. The command prints old → new
identity mappings and fails if any history cannot be validated.

What a repair does:

- Recognizes the demonstrated decimal-tail ordinal reuse, keeps both records, and
  writes a **new standalone identity** with consecutive ordinals. Ancestors
  contribute exactly their frozen byte prefixes; leaf metadata, native tool
  records and compactions are retained.
- Records old/new identities, source lengths and hashes in
  `.karmax-history-recovery`. Publication is atomic and prefix-checked; Codex's
  indexed rollout path is kept, and obsolete aliases are backed up outside its
  discovery directories.
- Fails explicitly on unknown gaps, missing ancestors, divergent copies or
  partial tails instead of guessing.

Runtime resume and fork preparation apply the same recovery automatically
(including identities retained in Temporal retry heartbeats), so a manual repair
is only needed for offline homes or to audit.

## Rules

- Never rewrite source histories, change ancestor files, or delete originals after
  recovery: existing descendants reference their byte offsets.
- Stop remote writers and confirm their exit before synchronizing to the host.
- Downloads are immutable JSONL snapshots; an issued URL keeps serving the same
  bytes after the task advances. Native Codex uploads go through the same
  validation instead of transcript conversion.

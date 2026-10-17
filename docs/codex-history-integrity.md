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

## Imported conversations with invented item ids

panagent 0.3.0 and earlier, which converts a Claude conversation into a Codex
one (a fork that switches agents), gave each assistant message an invented id
(`msg_` and 32 hex digits), and a Codex fork copies it. Codex sends item ids back
to the model. OpenAI's Responses API now looks up any id it did not issue, so the
first turn failed with `400 Supplied input item IDs require persisted-item lookup
that is not supported` (task #643, 2026-10-15). panagent no longer writes them.
The same preparation removes them from histories that descend from a panagent
import (a `session_meta` with `originator: "panagent"`, which forks keep) and
resumes the rewritten copy. Ids that Codex assigns (UUID-shaped) and ids OpenAI
issues are left alone (`tests/codex-imported-ids.test.ts`). The rewrite is part of
the copy's identity: an earlier release had already named a copy of the same
history that kept the ids, and reusing that name failed every retry with
"conflicting copies … histories diverge".

A retried import continues the conversion its first attempt made instead of
converting again (`reuseNativeImport`): the id is stable per task, role and
source, but panagent's bytes are not (a release changed them, and each run stamps
fresh ids), and a cloud world that already holds the first conversion refuses a
different second one under the same id. In a cloud world the world's copy wins
and is copied to the host before seeding; locally the home's copy is reused.

## Rules

- Never rewrite source histories, change ancestor files, or delete originals after
  recovery: existing descendants reference their byte offsets.
- Stop remote writers and confirm their exit before synchronizing to the host.
- Downloads are immutable JSONL snapshots; an issued URL keeps serving the same
  bytes after the task advances. Native Codex uploads go through the same
  validation instead of transcript conversion.

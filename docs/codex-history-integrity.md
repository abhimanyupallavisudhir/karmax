# Codex pagination regression and recovery

Karmax commit `85d6ba47a0198143da1dfbd02d40f402a18c57f1` upgraded Codex from
`0.144.5` to `0.153.4` on September 5, 2026. That exposed an upstream rollout
decoder bug: the reverse ordinal scanner skipped otherwise valid records that
contained decimal JSON numbers. A token-count record ending in `used_percent:
0.0` or `1.5` could therefore have its ordinal reused when a thread resumed.
The next paginated fork failed history projection. This reproduces with the
official CLI alone, without Karmax or cloud transfers.

The upstream correction is
[69cebb5: Route rollout reads through canonical JSON decoder](https://github.com/openai/codex/commit/69cebb5d15939bf9b6c1b4647b53879beab91ba2).
Karmax pins the official `0.154.0-alpha.11`, which contains that correction.
The installed dependency, remote launcher, browser image, and downloadable
handoff commands use that version. Existing cloud images are version-checked
before using their baked executable.

Upgrading prevents new damage; it does not repair existing files. The shared
history preparer validates complete JSONL, identities, ancestor byte cutoffs,
ordinal sequences, and prefix-compatible copies. It recognizes the demonstrated
decimal-tail ordinal reuse, retains both distinct records, and writes a new
standalone identity with consecutive ordinals. Ancestors contribute exactly
their frozen byte prefixes; their metadata headers are removed. The leaf metadata,
native tool records, compactions, and other payloads are retained. Unknown gaps,
missing ancestors, divergent copies, and partial tails produce explicit errors.

Source histories are never rewritten to change metadata, tools, or ordinals.
Recovery manifests under `.karmax-history-recovery` record old/new identities,
source lengths and hashes. Publication uses atomic prefix-checked updates;
Codex's indexed rollout path is retained or restored, and obsolete aliases are
backed up outside its discovery directories. An unreadable index keeps all
aliases synchronized instead of deleting a potentially indexed path. Remote
writers are stopped before destination publication and their exit is confirmed
before synchronization to the host.

Downloads are immutable, self-contained JSONL snapshots. The sessions endpoint
returns their export identity, canonical filename, required CLI version, and
bound download URL. An existing URL continues to download the same bytes after
the task advances. A native Codex upload follows the same validation and recovery
path, preserving native records instead of converting them through a transcript.

Audit a stopped account home:

```sh
npx tsx src/scripts/codex-history.ts --home /path/to/codex-home
```

After taking a control-plane/database backup and stopping its writers, add
`--repair` to publish recoveries. Originals remain available. The command prints
identity mappings and fails if any history cannot be validated. Runtime resume
and fork preparation also recover old identities, including references retained
in Temporal retry heartbeats. Do not change ancestor files or delete originals
after recovery: existing descendants can still reference their byte offsets.

Regression coverage includes repeated decimal-tail resumes with the real pinned
binary, nested lineage, tool migration, transfers/restores, completed model
turns, frozen exports, explicit corruption failures, and large tool records.

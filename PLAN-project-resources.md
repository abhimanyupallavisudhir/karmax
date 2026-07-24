# Project resources — state beyond Git

> Status: architecture accepted; staged implementation plan. This plan extends
> `SPEC.md` §11.4. It replaces `copyGlobs` as the long-term model without making
> a repository layout, cloud vendor, or devcontainer a prerequisite.

## The decision

Karmax must not pretend that every project is a repository, and it must not
pretend that every non-repository thing is a file. A project may need source
repositories, secret values, a directory of large objects, a mutable database,
or access to an external service. Those things have different security,
snapshot, concurrency, and publish semantics.

The product presents one small **Resources** section during project onboarding.
Internally, each entry is a typed **resource attachment** handled by a driver.
A task never owns the attachment itself. It receives a scoped, revocable
**resource lease** in its private world.

Every task world is a composition of four layers:

```text
immutable environment (OS, tools, dependency caches)
  + Git checkouts (one task branch per repository)
  + resource revisions (forked/read-only data, database branches, object trees)
  + ephemeral injections (secret files, environment variables, service tokens)
  = one isolated task world
```

This is one model for local and hosted Karmax. Local paths and Docker volumes are
drivers, not assumptions in the workflow. E2B/Daytona snapshots are acceleration
caches, not the durable format. S3-compatible objects, a customer-owned bucket,
or a future runner-side cache can implement the same resource contract.

## Why one generic sync folder is not enough

There is no correct universal merge for non-Git state:

- an `.env` file must never be checkpointed or published;
- an object/model corpus is usually immutable and content-addressed;
- a SQLite database must be transactionally snapshotted, not copied while live;
- a hosted Postgres database should be branched by its provider when possible;
- a production API is shared external state and cannot be forked at all.

A magic writable project volume would reintroduce cross-task races and leak one
task's credentials and mutations into another. A whole-directory upload would
also make secrets indistinguishable from ordinary assets. The abstraction must
be uniform at its boundary while preserving type-specific behavior behind it.

## Durable records and ephemeral leases

The control plane owns these provider-neutral records:

```ts
interface ResourceAttachment {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  driver: string;                 // open registry id, e.g. object-tree@1
  target: ResourceTarget;         // path, environment variable, or named service
  access: 'read' | 'write';
  isolation: 'fork' | 'shared';   // shared+write is exceptional and policy-gated
  source: Record<string, unknown>;// non-secret driver config only
  credentialHandles: string[];    // vault handles, never values
  revision?: string;              // immutable source revision/digest
  publish: 'discard' | 'review';
}

interface ResourceLease {
  id: string;
  attachmentId: string;
  taskId: string;
  worldGeneration: number;
  revision?: string;
  expiresAt: number;
  sealedDriverRef: string;        // opaque outside the trusted driver
}
```

Only attachment ids and immutable revision ids enter workflow history. An
activity asks the resource registry to prepare a lease just before the world is
made ready. The driver may return:

- a read-only or copy-on-write filesystem projection;
- an environment variable or file written on the non-checkpointed injection
  surface;
- a short-lived service endpoint/token pair;
- provider-native mount instructions understood by the selected runner.

Raw credentials, signed URLs, provider tokens, and live database URLs never
enter a `WorldHandle`, event, prompt, or checkpoint manifest. The world handle
contains only non-secret lease ids needed for cleanup and status.

Drivers implement a small lifecycle:

```ts
interface ResourceDriver {
  prepare(attachment, task, worldGeneration): Promise<ResourceLease>;
  materialize(lease, world): Promise<void>;
  diff?(lease, world): Promise<ResourceChangeSummary>;
  publish?(lease, expectedRevision): Promise<string>; // returns new revision
  release(lease): Promise<void>;
}
```

`prepare`, `publish`, and `release` are idempotent. Publish uses an expected
revision (optimistic concurrency); a stale attachment returns to Review instead
of overwriting newer project state. A shared writable external service cannot
offer that guarantee, so it requires an explicit capability, visible warning,
and audit event.

## Built-in drivers

The first driver set should cover ordinary projects without requiring users to
redesign them:

| Driver | Input | Task projection | Default completion behavior |
| --- | --- | --- | --- |
| `secret@1` | Vault handle | env var or 0600 file on injection surface | Revoke and erase; never checkpoint |
| `object-tree@1` | Uploaded/local directory or bucket prefix | read-only or COW directory | Discard writes, or review a new immutable revision |
| `volume@1` | Filesystem snapshot (including SQLite/Docker data) | task-private COW volume | Review a new snapshot; never merge bytes |
| `database@1` | Database connector + credential handles | provider branch/clone URL | Delete branch, or explicit provider-specific promote |
| `service@1` | External endpoint + credential policy | short-lived endpoint/token | Revoke; external side effects are audited |
| `local-path@1` | Self-hosted path | bind read-only, COW clone, or import to object tree | Local-only compatibility/import |

The registry is open: a driver declares its config schema, supported targets,
snapshot/publish abilities, and whether it can run on a given runner pool. The UI
renders that schema through the existing contribution system. Workflows only see
the provider-neutral attachment/lease operations.

Provider-native database branching is the ideal fast path but not the contract.
For example, Neon describes a branch as a point-in-time schema+data copy without
duplicating the entire database, matching task isolation well
([Neon branching](https://neon.com/docs/introduction/branching)). A Postgres
provider without branching can restore a logical/physical snapshot into a
task-private instance. A non-clonable production database remains `shared` and
is never presented as isolated.

## Arbitrary files and large objects

The portable representation of a directory is an immutable snapshot backed by
content-addressed chunks, encrypted per organization. Files are uploaded in
chunks, deduplicated inside that organization, and materialized lazily when the
provider supports it. Small/local projects may eagerly extract the same snapshot.
The representation supports sparse restore, resumable upload, integrity checks,
retention, and moving a task between providers.

**Karmax owns the resource-revision manifest and policy, not a new backup
format.** A small `SnapshotEngine` adapter supplies the difficult data plane:

```ts
interface SnapshotEngine {
  capture(source, parentRevision?): Promise<SealedSnapshotRef>;
  restore(snapshot, target, paths?): Promise<void>;
  diff?(from, to): Promise<ResourceChangeSummary>;
  delete(snapshot): Promise<void>;
  verify(snapshot): Promise<void>;
}
```

The Karmax revision records ownership, target, engine id/version, root digest,
size, parent revision, retention, and a sealed engine reference. It does not
expose the engine's repository password, object keys, pack indexes, or snapshot
id to workflows. Replacing an engine is an explicit verify-and-copy migration;
it does not change attachment ids or workflow contracts.

The first implementation should evaluate **Kopia** as the default engine, not
reimplement content-defined chunking, encryption, pack indexes, deduplication,
verification, and garbage collection in TypeScript. Kopia already layers
encrypted content-addressable block/object/manifest storage over simple S3/local
blob stores and supports a central server/API
([Kopia architecture](https://kopia.io/docs/advanced/architecture/)). Its current
repository-wide password/no-per-user-ACL model means Karmax must use a separate
repository per organization (or equivalently isolated encryption domain) and
keep every authorization decision in the control plane; sandboxes never receive
repository credentials. **restic** is the second conformance candidate: its
repository format is a versioned public API and already provides authenticated
encryption, Rabin content-defined chunking, immutable packs, and integrity checks
([restic design](https://github.com/restic/restic/blob/master/doc/design.rst)).
Pin the first engine only after a spike proves streaming capture/restore, Windows
and Linux support, concurrent writers, cancellation, repair, retention/GC,
organization isolation, and direct S3-compatible storage. `casync`/`desync` are
useful distribution references but do not by themselves cover the full encrypted
multi-tenant snapshot lifecycle.

S3 is only an object-store backend. Its native versioning retains whole object
versions rather than diffs, so the snapshot engine owns the manifest/chunk layer
and Karmax must not equate an S3 version with a resource revision
([S3 versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/versioning-workflows.html)).
Provider snapshots remain useful fast paths: E2B snapshots can spawn many new
sandboxes from one captured state, while pause/resume is one-to-one
([E2B snapshots](https://e2b.dev/docs/sandbox/snapshots)). Neither provider id is
the portable source of truth.

SQLite and other embedded databases use the volume driver, but the snapshot hook
must quiesce them (SQLite backup API, filesystem freeze, or application hook)
before producing a revision. Copying a live WAL-backed directory is forbidden.

## A low-setup onboarding experience

The machinery should remove setup from the common path:

1. The user connects a repository or points local Karmax at an existing working
   directory.
2. A trusted onboarding scan inspects ignored files, file sizes, known database
   formats, `.env` names, Docker Compose/devcontainer volumes, and common asset
   directories. It uploads nothing yet.
3. Karmax proposes a short classification: “3 secrets”, “data/ (12 GiB,
   read-only)”, “dev.db (fork per task)”. The only required user action is to
   accept or correct sensitive/ambiguous entries.
4. Secrets go to the vault. Ordinary trees become resource revisions. Known
   databases use a database/volume driver. Local-only users may leave a path
   attached and migrate it later.
5. Each new task automatically receives the project's default attachments. A
   task form only shows an override when the user expands **Resources**.

Heuristics can reduce questions but must never silently upload likely secrets or
grant a shared writable production resource. A `.karmax/resources.yaml` file may
export the setup for teams that want infrastructure-as-code, but it is generated
and optional; repository layout is never the source of truth.

Large initial imports need a resumable uploader and an optional outbound
`karmax runner`/desktop helper so bytes travel directly from the user's machine
to object storage. Hosted Karmax must not require its control plane to see a
local path. Customer-owned buckets and databases use the same connectors and
short-lived leases.

## Review and publication

Git merge remains Git merge. Resource publication is a sibling operation in the
same workflow Review gate:

```text
task changes
  ├─ Git commits                 -> existing merge queue / PR
  ├─ object or volume revision  -> summary + explicit Promote
  ├─ database branch            -> migration/schema/data summary + Promote/Delete
  └─ external service effects   -> audit only (already happened under capability)
```

The review shows which resources were read, which were mutated, their byte/schema
change summaries, expected base revisions, estimated retained size/cost, and the
exact publish action. Read-only resources and discarded forks add no ceremony.
Every publish enters a durable `resource-publish/<attachmentId>` singleton
coordinator — the same lease/queue/position/audit pattern as the merge queue.
Optimistic concurrency is checked *after* the task reaches the front: the
coordinator provides fairness and one active publisher, while the expected base
revision detects a baseline changed by an earlier publish. A task publishing
several resources acquires coordinator leases in attachment-id order, mirroring
the multi-repository merge queue's deadlock avoidance. Drivers with transactional
promotion may commit; otherwise a partial publish is explicit and retryable.

## Security and retention invariants

- Default task access is read-only; writable resources are task-private forks.
- `shared + write` requires a dedicated capability and an explicit task grant.
- Secret projections live outside checkpointed paths and are erased/revoked on
  park, checkpoint, cancellation, generation change, and release.
- Resource objects and snapshots are tenant-scoped, encrypted, checksummed,
  retention-bound, malware-scanned where applicable, and never addressed by a
  user-supplied object-store key.
- A resource lease is bound to `{task, world generation, attachment, access}`;
  restoring a checkpoint mints new leases rather than reviving old credentials.
- Every prepare/read/write/publish/release operation emits an audit record and a
  usage record. Promoted revisions outlive worlds; task forks follow world
  retention unless explicitly preserved.
- Egress policy remains a separate control. A service credential is not useful
  unless the world is also allowed to reach its endpoint.

## What happens to `copyGlobs`

`copyGlobs` remains readable for old self-hosted projects and workflows. It is a
deprecated local compatibility adapter equivalent to importing matching files
into a task-private, non-publishable file projection. It must never be the hosted
transport, must never imply that `.env` is a durable file, and must never be
checkpointed as project data.

Migration is lazy and reversible:

- on first project edit, classify each matching path;
- likely secrets become proposed `secret@1` attachments;
- ordinary files/directories become a `volume@1` revision initially;
- keep the old setting until the resulting attachments have been tested;
- then hide it from normal settings and leave an Advanced compatibility switch.

## Delivery order

1. **Thin v1 — secrets and forked files:** attachment/revision/lease records,
   driver registry, capabilities/audit, non-checkpointed injection surface, and
   `copyGlobs` deprecation. Implement only `secret@1` and a task-private
   `volume@1` backed by a proven `SnapshotEngine`; volumes are read-only or COW
   and discarded at completion. Include safe quiescing and SQLite backup, eager
   restore, basic retention/accounting, and portable checkpoint references.
2. **Hosted onboarding:** resumable direct import, resource settings and the
   scan/propose/confirm flow. Do not add another driver merely for UI taxonomy;
   arbitrary directories use `volume@1` until scale or read-only access proves
   the need for specialized object-tree behavior.
3. **Publication:** diff summaries, the resource-publish coordinator, optimistic
   revision checks, explicit Promote/Delete/Discard, and `object-tree@1` only if
   lazy/sparse materialization is measurably valuable.
4. **Connectors:** database branching/restore drivers and `service@1`, beginning
   with one Postgres provider and generic credentialed HTTP/TCP services.
5. **Optimization:** lazy mounts, runner-local chunk cache, customer-owned storage,
   generated optional manifest, and more provider drivers.

The first release is useful after step 2: secrets and arbitrary project files work
locally and in hosted worlds without Git. It intentionally has no general Publish
operation, database connector, lazy mount, or custom chunk implementation. Later
drivers add semantics, not a second model.

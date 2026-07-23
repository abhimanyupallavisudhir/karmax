# Plan — project state beyond git (secrets, data, services)

karmax has operated under the pretense that a project *is* its git repos, with
`copyGlobs` as a patch for the gitignored leftovers. Real projects also have
secrets, databases, and large objects — and hosted karmax makes the pretense
untenable, because a hosted control plane has no local checkout to copy from at
all (PLAN-cloud.md decision 8). Design only; phases at the end.

---

## 1. What exists today (read first)

- **`copyGlobs`** (`ProjectConfig.copyGlobs`, `src/domain/types.ts:343`):
  project-named gitignored files copied into each world at setup. Worktree
  worlds copy top-level matches from the origin checkout
  (`src/world/worktree.ts:137,274`); container worlds inherit them because they
  bind-mount that host worktree (`src/world/container.ts:45`); E2B/Daytona
  worlds clone fresh over SSH and explicitly warn *"copyGlobs are host-local
  and were not copied"* (`src/world/e2b.ts:122`). Gitignored files simply never
  reach remote worlds.
- **`node_modules` symlink**: worktree worlds symlink the origin repo's
  `node_modules` with a `.git/info/exclude` entry (`src/world/worktree.ts:134`)
  — a local-only fast path for one specific reconstructible directory.
- **Hardcoded exclusions**: the portable checkpoint delta skips `.env` and
  `.karmax-injection/` by name (`src/world/checkpoint.ts:43`). Merge rejects
  dirty trees; commit-vs-gitignore is the merge agent's judgment
  (PLAN-git-config.md §6).
- **The right machinery already exists — unused for this.** The vault + broker
  (SPEC §8.4: secrets move as handles, resolved JIT, never journaled) and
  config-homes minting (`src/autonomy/`) already carry provider API keys, git
  profiles, and agent logins. There is no notion of a *project runtime secret*
  (the `DATABASE_URL` the user's own code reads), no object storage, and no
  service model.
- **PLAN-cloud.md already forbids the status quo for hosted**: "Hosted
  environments do not copy `.env` files with `copyGlobs`; they use broker
  injection" — but that injection, and everything non-secret, is undesigned.
  This plan fills that hole.

## 2. Why "copy the gitignored files" is the wrong primitive

`copyGlobs` fails not because the implementation is shallow (top-level only,
worktree only) but because the *category* is wrong. "Gitignored" is a
distribution decision, not a kind of state — it lumps together things that need
opposite treatment:

- A **secret** copied as a file wants to be excluded from checkpoints, merges,
  and handoffs, injected per-world, and revocable centrally. Copying couples it
  to one host and spreads it through every surface that moves files.
- A **cache** (`node_modules`, `.venv`, `target/`) copied is wasted transfer of
  state that should be *recreated* from lockfiles — and is often
  platform-specific, so copying host → Linux sandbox is actively wrong.
- A **data file** (fixtures, a dev SQLite db, model weights) copied has no
  versioning, no dedup, no story for changes flowing back, and no home when the
  project lives in the cloud.
- A **live database** is not a file at all; copying its storage under a running
  server is corruption with extra steps.

And all four copies share one fatal dependency: the user's checkout as the
source of truth. Hosted karmax must invert this — the *project record* is the
source of truth, and the laptop checkout is just another world.

The industry has converged on exactly this decomposition. GitHub Actions gives
every developer **secrets, caches, artifacts, and service containers** — four
primitives nobody had to redesign a codebase for. Warp Oz *never* copies
gitignored files: images + setup recreate caches, a scoped store injects
secrets as env vars, and an explicit declaration names extra files to snapshot.
Daytona has first-class opaque secret substitution. Devin builds environments
once from blueprints. This is convergent evolution; karmax should not invent a
fifth taxonomy.

## 3. The design: four kinds of state, four transports

| Kind | Examples | Transport | Never |
| --- | --- | --- | --- |
| **Secrets & config** | `.env`, service-account JSON, `.npmrc` tokens | Vault handle → injected at world boot (env var by default, file when a tool demands one) | In git, checkpoints, merges, events, or images |
| **Reconstructible** | `node_modules`, `.venv`, build dirs, model caches | Not transported. Environment image + setup + content-addressed caches (PLAN-cloud.md `EnvironmentSpec`) | Copied between hosts |
| **Data objects** | fixtures, dev db seeds, weights, media | Content-addressed project object store + declared mounts | Committed to git or silently mutated in place |
| **Live services** | Postgres, Redis, queues | Not files. External service → connection string is a Secret; per-world service → Environment service + seed Object | File-copied |

Reconstructible state needs nothing new here — it is the Environment's job and
is already designed in PLAN-cloud.md. The three new surfaces:

### 3.1 Project secrets

A first-class, vault-backed record set per project (org-scoped sharing later):

```ts
interface ProjectSecret {
  name: string;             // e.g. DATABASE_URL
  handle: string;           // vault handle; value is write-only
  present:
    | { env: string }                       // default: env var, same name
    | { file: string; mode?: number };      // world-relative path, 0600 default
}
```

- **Injection is a world-provider duty, uniform across backends.** Local/
  container executions merge secret env into the spawned process env
  (`src/world/local-execution.ts` already threads `spec.env`); E2B sets sandbox
  env at trusted provisioning; Daytona uses native opaque substitution.
  File-shaped secrets are materialized 0600 into the world with a
  `.git/info/exclude` entry.
- **A materialization manifest replaces name-based hardcoding.** The world
  handle records every secret-materialized path; checkpoint, merge finalize,
  handoff, and branch publish consult the manifest instead of the literal
  `.env` string in `checkpoint.ts:43`. New file-shaped secrets are excluded
  automatically, everywhere, by construction.
- **Values never enter workflow history.** Workflows and events carry handles;
  resolution happens inside activities at the injection boundary, exactly like
  provider API keys today.
- **Import, don't configure.** The settings UI accepts a pasted `.env` and
  parses it into named secrets in one step. Local onboarding offers to import
  an existing `.env` directly. From then on rotation happens in one place and
  every backend — including cloud — gets identical injection.

### 3.2 Project objects

A content-addressed object store — a directory under `KARMAX_HOME/objects`
locally, an S3-compatible bucket hosted — with declared placements:

```ts
interface ProjectObjectMount {
  path: string;                       // world-relative, e.g. fixtures/dev.sqlite
  object: string;                     // sha256 key in the store
  mode: 'seed' | 'readonly' | 'writeback';
}
```

- **seed** — materialized fresh per world; task-local changes ride the existing
  checkpoint delta and die with the task unless promoted. The right mode for
  dev databases and fixtures: every attempt starts from a known state.
- **readonly** — shared immutable data (model weights, large media) hardlinked
  or mounted from a shared store, never copied per world.
- **writeback** — a task's modified copy may be *promoted* to a new object
  version at Review, through the same gate code changes pass. Object history is
  a version chain, so promotion is auditable and reversible.

This is also where oversized task *outputs* belong: an agent that produced a
2 GiB artifact promotes it to the object store and references it from the task
record instead of committing it — the artifact story and the data story are the
same mechanism.

### 3.3 Services

A database is a dependency to *reach* or *recreate*, never state to copy:

- **external** — the shared dev/staging database: its connection string is just
  a Secret. Nothing else to build.
- **per-world** — declared in the Environment (imported from docker-compose /
  devcontainer, which onboarding already inspects), with initial state pulled
  from a seed Object. Every world gets a private, known-state instance;
  parallel attempts stop trampling each other's data.

## 4. Onboarding: propose, don't configure

The "no setup" requirement is met by the existing bootstrap-task pattern
(PLAN-cloud.md), not by a config language. At project creation an agent
inspects `.gitignore`, `.env` / `.env.example`, docker-compose / devcontainer,
lockfiles, and the sizes of untracked-ignored files, and **proposes** the
classification: these keys become secrets (values imported locally, or asked
for when onboarding from a bare GitHub repo — `.env.example` supplies the
names), these dirs are caches for the Environment, these files become seed
objects, these compose services become per-world services. One approval; a
human decides, mechanical work is automated. Nothing about the user's codebase
layout is prescribed — `.gitignore` and compose files they already have *are*
the declaration.

## 5. Migration

- `copyGlobs` becomes deprecated import sugar: on first use, matched files are
  offered for import — small text files as (file-shaped) secrets, large/binary
  files as objects — after which the project no longer depends on the host
  checkout. Honored locally in the interim; the E2B/Daytona warning gains a
  pointer to the import.
- The hardcoded `.env` / `.karmax-injection/` skip in `checkpoint.ts` is
  subsumed by the materialization manifest.
- The `node_modules` symlink survives as a local Environment-cache fast path.

## 6. Security notes

- Untrusted repo code can still read an injected secret and write it into an
  ordinary world file; checkpoints therefore remain encrypted, access-scoped,
  and retention-bound regardless of the manifest (PLAN-cloud.md already states
  this).
- Injected env is scrubbed from anything that leaves the world (events, review
  info, published branches) the same way config-homes minting scrubs today.
- Scoping starts at project level; org-shared secrets and per-workflow/task
  capability gating (only tasks with `secret:use` see injection) layer on the
  existing authorization model without new machinery.

## 7. Non-goals

- Not a git-lfs/DVC replacement — projects already using those keep using them;
  objects cover projects that never adopted one.
- Not a database sync engine — seed-and-promote is the whole story; live
  replication is out of scope.
- No per-provider special cases — injection and mounts are provider *duties*
  behind the existing world contract, not provider features leaking upward.

## 8. Phases

1. **Project secrets, locally.** Secret records + vault storage + env/file
   injection in worktree/container worlds + materialization manifest driving
   checkpoint/merge/handoff exclusions + paste-`.env` import UI. This alone
   replaces the main real-world use of `copyGlobs`.
   *Shipped:* `src/autonomy/project-secrets.ts` (registry in kv, values in the
   vault under `secret:<projectId>:<name>`, git-profiles pattern),
   `src/world/secrets.ts` (0600 materialization + worktree-scoped
   `core.excludesFile` exclusion — deliberately NOT the shared `info/exclude`,
   which would leak patterns into the user's checkout), createWorld injection +
   `meta.secretFiles`/`meta.secretEnv` manifest, JIT env merge into local agent
   turns, checkpoint manifest backstop + restore re-materialization,
   `/api/projects/:id/secrets` (write-only; `{env}` bulk import), Settings →
   Secrets UI. Remote worlds record a `world.warning` until phase 2.
2. **Secrets in cloud worlds.** E2B provisioning-time env + file
   materialization; Daytona opaque substitution. Deprecate `copyGlobs` behind
   the import flow. Hosted onboarding asks for values named by `.env.example`.
   *Shipped:* injection is uniform across backends — file secrets materialize
   through the same `world.writeFile`/`exec` provider duties remote worlds
   already implement (no provisioning-time special case needed), and env
   secrets travel as their own `secretEnv` turn input that adapters merge
   lowest-precedence locally and forward BY NAME across the remote env
   allowlist (`remoteAgentEnv(..., forward)`), so per-spawn JIT resolution
   works identically in E2B/Daytona. `copyGlobs` warnings and its settings
   label now point at the Secrets import. `GET .../secrets` returns
   `suggestions` parsed from `.env.example`/`.env.sample`/`.env.template` in
   local checkouts or the managed clone; the Secrets card offers them as
   one-click chips.
3. **Project objects.** Local content-addressed store, `seed`/`readonly`
   mounts, checkpoint-delta capture, Review-gated `writeback` promotion; hosted
   backend is an S3 bucket behind the same interface.
   *Shipped:* `src/store/project-objects.ts` (mount registry in kv, blobs at
   `objects/<projectId>/<sha256>` in the existing ObjectStore — S3 hosted comes
   free), `src/world/mounts.ts` materialization (readonly ⇒ chmod 444) +
   `meta.objectMounts` manifest, createWorld wiring, checkpoint captures
   sha-drift of gitignored mounts (and skips readonly mounts, whose 444 copies
   would otherwise collide at restore — restore also chmod-retries read-only
   delta targets), restore re-materializes mounts before applying the delta,
   `/api/projects/:id/objects` (+`/data` download) and
   `/api/tasks/:id/objects/promote` (task:review:execute, emits
   `object.promoted`), Settings → Data card with file upload and mode select.
4. **Services.** Compose/devcontainer import into the Environment
   (depends on PLAN-cloud.md environment builds), seed objects wired in.
   *Shipped:* `ProjectService` records (`src/store/project-services.ts`) —
   external services are just a named connection Secret; per-world services
   launch a private Docker container per task world
   (`src/world/services.ts`: `karmax.task=<taskId>` label, 127.0.0.1 ephemeral
   port, seed object bind-mounted read-only, connection env rendered from
   `urlTemplate` and recorded as `meta.serviceEnv`, injected into every turn
   via the same secretEnv channel, containers destroyed with the world by
   label). Compose import (`composeServiceProposals`, `yaml` dep) turns the
   repo's own docker-compose file into one-click proposals with ready
   connection templates for postgres/mysql/redis/mongo;
   `/api/projects/:id/services` + `/compose-import` routes and a Settings →
   Services card. Per-world launch is worktree-backend-only for now (host
   Docker on 127.0.0.1); container/remote worlds get a warning pointing at
   external-via-Secret, and in-environment services for cloud worlds remain
   the PLAN-cloud environment-build follow-up. devcontainer.json import also
   remains follow-up work.

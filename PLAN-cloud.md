# Karmax Cloud — product and architecture plan

> Status: hosted product baseline implemented, 2026-07-14. This is the hosted evolution of
> `SPEC.md`, not an instruction to put the current single-host process on a VPS.
> Prices and vendor capabilities below are point-in-time and linked to primary
> sources so they can be rechecked before procurement.

### Implementation status

The repository now implements the hosted product baseline end to end:

- provider-owned exec/process/PTY/files/preview/park operations, with local,
  Docker, memory, E2B, and Daytona adapters;
- auto-pause plus explicit park-on-wait and transparent resume;
- remote SSH clone provisioning, API-key tool loops plus full Claude/Codex
  subscription agents executing inside the remote world, authenticated
  terminals/artifacts/previews, and a trusted host Git
  bundle broker for branch/merge/PR handoff;
- hosted bind/public-origin settings and a public view projection that never
  exposes world handles, sandbox IDs, repository locations, or provider tokens;
- a GitHub App installation flow, organization-owned repository catalogue,
  repository-scoped read-only clone keys, and broker-only write keys;
- encrypted provider-portable checkpoints in S3-compatible storage, generation
  fencing, runner capacity/budget leases, usage records, and lifecycle sweeps;
- organizations, teams, project membership, workflow-owned human routing,
  per-user inbox/delivery, OIDC/SCIM, export, and idempotent tenant deletion;
- durable tokens, executions/output, previews, events, production Temporal,
  online backup/verified restore, diagnostics/metrics, and a single-writer
  hosted-cell deployment under `deploy/`.

The optional native `karmax runner` handoff and additional provider/GPU pools are
enterprise expansion points, not holes in the hosted task/review product.

## The product decision

Karmax Cloud should feel like one thing:

1. Connect a GitHub organization and choose repositories.
2. Write a task; its workflow routes each decision to the right people.
3. Karmax prepares a private workspace, does the work, and pings the audience
   declared by the current workflow step.
4. That person can talk to the agent, run the app, open an artifact, or enter a
   terminal from the task. The workspace wakes automatically and goes back to
   sleep afterward.
5. The accepted result lands through the repository's normal protected path.

The task remains the only user-facing organizing abstraction. A **world** is the
task's private room, not another item people have to administer. Images,
sandboxes, snapshots, runner pools, leases, and SSH keys belong behind an
advanced deployment surface. The default task form should say only **Run in:
Karmax Cloud**; most people should never need to change it.

This is the useful part of the Steve Jobs test: remove concepts from the product,
not capabilities from the system. The hard infrastructure should make the task
feel more direct, not turn Karmax into a cloud console.

## Ten decisions

1. **Offer both Karmax Cloud and self-hosted Karmax from one codebase.** They are
   deployment profiles, not separate products.
2. **Separate the control plane from execution.** The web app, authorization,
   Temporal workflows, metadata, audit, and scheduling are the control plane.
   Untrusted code, agents, terminals, tests, and previews run on runner pools.
3. **Give every task attempt one logical world.** Never share a mutable checkout,
   process namespace, or injected secret between unrelated tasks.
4. **Do not give every task a permanently running VM.** A task world is durable;
   its compute is an on-demand lease. Project environment layers and caches are
   shared immutably, while task filesystem changes are copy-on-write.
5. **Add two concepts beneath a world:** an immutable project **Environment**
   describes what runs, and a **Runner pool** describes where it runs. This is
   the clean distinction Warp Oz also makes between environments and hosts.
6. **Implement E2B first, behind a provider contract.** It most directly supplies
   the existing design's missing remote PTY, pause/resume, secure controller,
   network policy, and Firecracker isolation. Add Daytona second to prove the
   contract and provide a strong BYOC path. Do not build a sandbox scheduler yet.
7. **Make checkpoints portable and Git-backed.** Provider snapshots are a fast
   cache, not the only copy of work. Task branches plus an encrypted filesystem
   delta in object storage allow recovery or movement to another runner.
8. **Make GitHub a connected service and repositories first-class records.** A
   hosted control plane has no source checkouts and no repository paths. A
   self-hosted project may instead resolve a local checkout's existing remote.
9. **Preserve SSH for Git transport without giving agents a write key.** Use a
   GitHub App for discovery, installation authorization, webhooks, and API calls;
   provision repository-scoped SSH credentials for Git; keep write credentials
   in a trusted Git broker outside the task world.
10. **Put an Organization above Project before calling the app multi-user.** Add
    membership, teams, workflow-owned human routing, per-user inboxes, and tenant
    isolation together. Authentication alone is not collaboration.

## The four runtime nouns

The design stays understandable if these names never blur together.

| Noun | Lifetime | Mutable? | Meaning |
| --- | --- | --- | --- |
| **Environment** | Many tasks | No; versioned | A provider-specific image/template/snapshot, toolchain, setup recipe, and cache policy. Runtime size/network/lifecycle live in the provider-neutral organization execution policy. |
| **Runner pool** | Installation/org | Configuration only | Where environments execute: local host, Karmax-managed E2B, customer VPC, or a later provider. |
| **World** | One task attempt | Yes | Repositories, working files, branch/base SHAs, and a checkpoint chain. Exactly one active generation may write it. |
| **Execution** | Seconds to hours | Ephemeral | One agent turn, command, PTY, browser, test, or preview service inside a world. |

An agent profile is not an environment. A workflow is not a runner. A GitHub
repository is not a checkout. Keeping these separate prevents the settings model
from becoming a matrix of provider-specific exceptions.

Warp Oz's public model independently arrives at the useful split: an environment
contains the image, repositories, and setup commands, while a host selects Warp
cloud or self-hosted execution. It also treats local interactive execution as a
different host for the same run model, not as a second orchestration product
([Warp environments](https://docs.warp.dev/agent-platform/cloud-agents/environments),
[Oz CLI](https://docs.warp.dev/reference/cli)).

## One logical world per attempt is the right granularity

A shared mutable sandbox per project looks cheaper but creates the expensive
problems:

- concurrent agents overwrite branches, dependencies, ports, and processes;
- a secret exposed to one task is exposed to every task using the sandbox;
- untrusted repository code crosses task boundaries;
- cancellation cannot reliably clean up one task without harming another;
- retries and reviews stop being reproducible;
- multiple attempts cannot be compared honestly.

The efficient alternative is not sharing the mutable machine. It is sharing the
immutable base:

```text
project environment image + dependency/cache layers
                      |
          +-----------+-----------+
          |                       |
    task #41 world           task #42 world
    copy-on-write disk        copy-on-write disk
          |                       |
  executions wake/stop      executions wake/stop
```

One task's Do, Resolve, Merge, terminal, and review processes may reuse its world
serially. Different task attempts get different worlds. Multiple cooperating
services for one task may get linked sandboxes in the same world generation, but
that is an implementation detail behind the world provider.

## Prepare an environment once, not on every task

Fast worlds come from moving stable setup out of task boot. A versioned
`EnvironmentSpec` contains:

```ts
interface EnvironmentSpec {
  image: string;                  // immutable digest after resolution
  setup: string[];                // image-build commands
  boot?: string[];                // cheap per-world commands only
  resources: { cpu: number; memoryGiB: number; diskGiB: number };
  caches?: Array<{ name: string; path: string; keyFiles: string[] }>;
  networkPolicy: NetworkPolicy;
  tools: { browser?: boolean; docker?: boolean };
}
```

Karmax ships curated, digest-pinned base images containing Git, SSH, common
language toolchains, the agent harnesses, browser support, and the version-matched
Karmax runtime/MCP bridge. During project onboarding, the existing bootstrap-task
pattern inspects a devcontainer/Dockerfile and lockfiles and **proposes** an
environment; it does not silently execute guessed setup forever. The project may
import its devcontainer or select a custom image and setup commands.

An environment build runs once in an isolated builder and produces an immutable
snapshot keyed by the spec, source image digest, setup commands, and relevant
lockfiles. Task worlds clone/fork that snapshot, then run only cheap boot commands.
Dependency caches are content-addressed and scoped to the organization/project;
they are never a shared writable home between task worlds. Environment changes
create a new version for new worlds while existing worlds retain the digest they
started with. Build-time network may be broader than runtime network, but both are
declared and audited. Runtime secrets are never baked into an image or cache.

This is the useful pattern visible in Warp's image/repos/setup environments and
Devin's blueprint -> build -> snapshot flow: make expensive preparation a
versioned project artifact, then boot every session from a fresh copy
([Warp environments](https://docs.warp.dev/agent-platform/cloud-agents/environments),
[Devin blueprints](https://docs.devin.ai/onboard-devin/environment/blueprints)).

## World lifecycle: warm briefly, park aggressively, hibernate portably

Temporal already makes human waits free. The world must follow the workflow into
that wait instead of staying awake beside it.

```text
provisioning -> ready/active -> warm -> parked -> hibernated -> released
                     ^          |        |           |
                     +----------+--------+-----------+
                           ensureReady on demand
```

### State policy

| State | What exists | Billing intent | Default transition |
| --- | --- | --- | --- |
| **active** | Compute + filesystem; one or more leased executions | CPU/RAM billed | While an agent, PTY, review command, browser, or preview is live |
| **warm** | Compute + filesystem, no execution | Brief latency optimization | Park after 10 minutes without an execution lease |
| **parked** | Provider filesystem snapshot/disk; no process is trusted to survive | No CPU/RAM | Explicitly after every workflow wait; provider auto-pause is the backstop |
| **hibernated** | Task branch + encrypted portable delta + checkpoint manifest in Karmax storage | Cheap object/Git storage only | After 7 days parked, or earlier under budget pressure |
| **released** | Durable task history, commits/PR, review artifacts per retention policy | No world cost | On terminal completion/cancel plus retention window |

These are defaults with organization retention policy, not hard-coded promises.
The workflow should request `park` as it enters Review, escalation, dependency,
account-limit, funding, or human-confirmation waits. A provider idle timer is only
a safety net because provider activity is not the same thing as workflow intent.

### Do not preserve live process memory between turns

E2B can preserve memory and running processes while paused, but Karmax should
normally stop executions and snapshot the filesystem only. The existing runtime
already models an agent as one process per turn and stores its session ID. Keeping
process memory:

- retains credentials and arbitrary servers longer than necessary;
- makes snapshots provider-specific;
- makes process custody and software upgrades harder;
- contradicts the durable workflow as the source of control flow.

A PTY or preview holds an explicit execution lease while attached. Disconnecting
ends the lease. A preview service gets a bounded lease (one hour by default) with
an Extend button; there is no unbounded `keepAlive` switch hidden in review info.

### Checkpoint contents

`WorldCheckpoint` is a manifest, not a raw vendor snapshot ID:

```ts
interface WorldCheckpoint {
  id: string;
  worldId: string;
  generation: number;
  environmentDigest: string;
  repos: Array<{
    repositoryId: string;
    checkoutPath: string;
    baseSha: string;
    branch: string;
    headSha?: string;
  }>;
  providerSnapshot?: { provider: string; sealedRef: string };
  filesystemDelta?: { objectKey: string; sha256: string; bytes: number };
  createdAt: number;
}
```

Before parking, Karmax terminates execution leases, flushes files, records Git
status, pushes committed task refs through the trusted Git broker, and stores an
encrypted delta for uncommitted/untracked state. Secrets, provider credentials,
browser cookies, and ephemeral MCP tokens live on non-checkpointed injection
surfaces and are excluded. Because untrusted code could still write sensitive
data into ordinary files, the entire checkpoint is treated as sensitive,
encrypted, access-scoped, and retention-bound. Restore verifies the image digest
and object hash before making a new writable generation. Hosted environments do
not copy `.env` files with `copyGlobs`; they use broker injection.

Provider snapshots make the common resume fast. The portable layer is the
disaster-recovery copy and lets a world move from managed cloud to a customer VPC
or local runner. A monotonically increasing generation lease prevents two restored
copies from accepting writes at once.

## The remote world contract

The original provider interface was not a remote boundary. It had a closed
`WorldKind`, exposed host paths, and only
`exec/readFile/writeFile/listFiles/destroy`. Several higher layers bypassed it:

- the gateway spawns `node-pty` at `TaskView.worldPath`;
- review actions spawn local `bash` processes;
- artifact downloads read the host filesystem directly;
- agent SDK/CLI subprocesses and config homes live on the Karmax host;
- the container provider is a host worktree bind-mounted into Docker;
- `TokenAuthority` is in-memory and cannot be verified by another gateway;
- project repositories are local paths and the metadata index is SQLite.

Changing only `WorldProvider.create()` would have produced a remote sandbox
that agents, terminals, previews, artifacts, session forks, and merges cannot
actually use.

### Implemented contract

Make handles opaque, versioned, and free of provider credentials:

```ts
interface WorldHandleV2 {
  version: 2;
  id: string;
  provider: string;       // registry id, not a TypeScript union
  runnerPoolId: string;
  generation: number;
  environmentDigest: string;
  workspaceRoot: string;  // path inside the world, normally /workspace
  repos: Array<{
    repositoryId: string;
    path: string;         // world-relative checkout path
    branch: string;
    baseSha: string;
  }>;
  checkpointId?: string;
  sealedProviderRef: string;
}
```

The control plane stores provider API credentials separately. `sealedProviderRef`
is only meaningful to that provider adapter and is safe to journal; a sandbox ID
plus controller token is not.

The provider/runner surface needs these capabilities:

```ts
interface WorldProvider {
  id: string;
  capabilities: {
    pty: boolean;
    snapshots: boolean;
    ports: boolean;
    networkPolicy: boolean;
  };

  create(spec: WorldSpecV2): Promise<WorldHandleV2>;
  status(world: WorldHandleV2): Promise<WorldStatus>;
  ensureReady(world: WorldHandleV2): Promise<WorldHandleV2>;
  exec(world: WorldHandleV2, spec: CommandSpec): Promise<CommandHandle>;
  pty(world: WorldHandleV2, spec: PtySpec): Promise<PtyHandle>;
  exposePort(world: WorldHandleV2, spec: PortSpec): Promise<PortHandle>;
  readArtifact(world: WorldHandleV2, path: string): Promise<ReadableStream>;
  checkpoint(world: WorldHandleV2): Promise<WorldCheckpoint>;
  park(world: WorldHandleV2): Promise<WorldHandleV2>;
  destroy(world: WorldHandleV2): Promise<void>;
}
```

Commands, PTYs, services, and agent turns all produce durable platform process
handles plus ordered output frames. A review action is no longer “spawn bash on
the gateway”; it is an execution in the task world. An artifact is no longer “a
path on the gateway”; it is a scoped stream or promoted object. A URL such as
`localhost:3000` in review info is a requested port, not a URL the user's browser
is expected to reach directly.

### The Karmax runtime boundary

The versioned runtime protocol remains coordinated by the trusted activity
worker. Metered API loops run there. Subscription-backed Claude/Codex SDK agents
run as native subprocesses inside the task's provider-owned world, after the
leased config home is seeded into a task-private directory. The provider CLI,
its tools, session files, and repository cwd therefore share the same sandbox,
matching local execution instead of emulating filesystem calls from the host.
The stock adapters launch pinned `@anthropic-ai/claude-code` and `@openai/codex`
packages through `npx` (cached in the sandbox); custom images can override those
package specs with `KARMAX_REMOTE_CLAUDE_PACKAGE` and
`KARMAX_REMOTE_CODEX_PACKAGE`. Their PTY transport runs raw so large JSON protocol
frames are not subject to canonical-line limits. A sandbox-local process-group
lease reaps a surviving CLI before a Temporal retry starts another writer.

The determinism boundary is unchanged: the workflow awaits one `runAgentTurn`
activity, the activity emits the typed stream and heartbeats, and cancellation
kills provider-owned processes. Sandboxes need no inbound SSH and receive only
the repository read key needed during provisioning; platform actions use a
short-lived, audience-bound token at the trusted MCP boundary.

## Karmax MCP from a cloud world

Most of this path already exists. `platformMcpSpec()` configures a stdio bridge
to the gateway, and the activity injects a capability-scoped token. For cloud:

1. The activity bundles and seeds the version-matched MCP bridge on the world's
   non-checkpointed injection surface.
2. The bridge calls the Karmax public gateway over TLS. World tools execute
   directly in the sandbox through the native provider agent.
3. A turn token carries organization, project, origin task, role, capabilities,
   audience, expiry, and unique ID. Any gateway replica can verify it.
4. The selected Claude/Codex subscription home is copied into the task-private
   injection directory on first use. Later turns preserve provider-refreshed auth,
   enforce private file modes, and copy only a specifically requested native
   session when resuming or forking across worlds. Only the scoped Karmax token is
   added to the turn env.
5. Revoke the execution lease on cancellation/end. Keep an auditable token ID,
   never the raw bearer value, in events.

Provider-controller keys, vault roots, Git write keys, Temporal credentials, and
runner-pool credentials never enter a world. The leased model subscription is
the intentional exception: its native config files are seeded so the full SDK
agent can authenticate from inside the sandbox.

Cloud execution seeds the selected config home into the task sandbox and lets the
native provider manage its session state there. A later credential-broker
optimization may split these layers without changing the execution contract:

- **Agent account**: encrypted broker record, organization/user scoped;
- **Agent profile**: model, behavior, limits, and account-selection policy;
- **Conversation session**: task × role state/artifact, world-portable where the
  provider permits and transcript-replayable otherwise.

A task-private home lives on the non-checkpointed injection surface for that
world generation, preserving native sessions across turns. The host login home
is copied, never mounted or shared mutably across task sandboxes. Remote
subscription turns use provider-world capacity and do not consume the host RAM/load
agent-slot queue; their account concurrency and world-pool limits still apply.

## Network and preview security

General-purpose coding defaults to normal outbound internet. Agents routinely
need arbitrary package registries, documentation, web search, GitHub, and model
APIs; pretending that a tiny static allowlist is turnkey only produces fragile
failures. Organizations that maintain an egress policy can explicitly enable
restricted mode and declare allowed classes:

- Karmax gateway and runner control channel;
- selected LLM provider endpoints;
- GitHub SSH (`ssh.github.com:443` when port 22 is unavailable) and API;
- approved package registries/mirrors;
- task-specific destinations granted by capability/policy.

The UI makes restricted mode and every expansion visible because network access
is a data-exfiltration decision. The allowlist is an enterprise hardening option,
not the out-of-box coding experience.

`exposePort()` returns an internal provider endpoint. The gateway exchanges it
for a short-lived, viewer-authorized URL on a unique per-lease wildcard preview
origin and proxies HTTP/WebSocket traffic safely. Repository-controlled code can
therefore reach neither Karmax's authenticated origin nor another open preview.
The task's project authorization is checked before minting access; provider access
tokens never appear in task prose or durable view models. Public preview links
are an explicit reviewed action with expiry, not the default.

## Provider survey and cost

### Normalized active cost

Representative Linux workspace: **2 vCPU + 4 GiB RAM**, before network and
provider-specific storage, using public prices on 2026-07-14.

| Provider | Isolation/lifecycle fit | Approx. active cost | Fixed plan notes | Decision |
| --- | --- | ---: | --- | --- |
| **E2B** | Firecracker microVM; direct PTY; secure controller; network rules; pause/resume preserves filesystem and memory; paused sandboxes retained indefinitely | **$0.1656/hr** | Hobby $0 with 20 concurrent/1-hour continuous runs; Pro $150/mo with 100 concurrent/24-hour runs | **First adapter.** Closest match to the contract with the smallest integration surface. |
| **Daytona** | Sandboxes with process/PTY/SSH, signed previews, network allowlists, opaque secret substitution, snapshots, stop/archive/delete, and BYOC | **$0.1656/hr** plus storage above 5 GiB | Public pricing is usage based; enterprise/BYOC is sales-assisted | **Second adapter.** Proves portability and is attractive for enterprise controls. |
| **Runloop** | Purpose-built devboxes; microVM isolation, suspend/resume, snapshot branching, browser, credential gateway, VPC deployment | **$0.3168/hr** list compute; vendor example says ~$2.73 per 8-hour day including its assumptions | Basic $0 + usage; Pro $250/mo + usage | Excellent enterprise benchmark/optional adapter; too expensive and feature-overlapping for the first integration. |
| **Modal Sandboxes** | gVisor by default; VM mode beta; filesystem snapshots; memory snapshots alpha; strong GPU fleet | **$0.2380/hr** | Starter $0 + compute; Team $250/mo + compute | Add for GPU/special workloads, not general coding worlds first. |
| **Cloudflare Sandbox** | Dedicated containers and very low-granularity billing, but idle restart currently loses all filesystem state | No exact 2/4 size. `standard-3` (2 vCPU/8 GiB/16 GB) is at most about **$0.2200/hr** at full CPU after included usage | Workers Paid $5/mo plus Workers and Durable Objects | Useful later for stateless/scratch execution; poor primary durable-world fit today. |

Calculations:

- E2B/Daytona: `2 × $0.000014 + 4 × $0.0000045` per second.
- Modal: one physical core (2 vCPU equivalent) at `$0.00003942/s` plus
  `4 × $0.00000667/s` memory.
- Cloudflare standard-3 upper active rate: `2 × $0.000020/s` CPU +
  `8 × $0.0000025/s` memory + `16 × $0.00000007/s` disk. Cloudflare bills CPU
  by actual use, so real cost may be lower; Workers/Durable Objects are extra.

At the E2B/Daytona normalized rate, a 30-minute active task costs about **$0.083**
in sandbox compute and 1,000 such tasks cost about **$82.80**. Leaving the same
world running costs **$3.97/day**; leaving 100 review-blocked worlds running costs
about **$397/day**. That is why explicit park-on-wait is a correctness property,
not a later optimization. Model inference will usually dominate active sandbox
cost, while accidental idle compute can dominate both.

### Primary sources

- E2B publishes per-second CPU/RAM prices, plan/concurrency limits, and says
  paused sandboxes stop billing
  ([pricing](https://e2b.dev/pricing),
  [billing](https://e2b.dev/docs/billing)). Its persistence documentation says
  pause preserves filesystem and memory, resumes in about a second, and paused
  sandboxes are retained indefinitely
  ([persistence](https://e2b.dev/docs/sandbox/persistence)). It exposes a
  reconnectable PTY and secure controller APIs
  ([PTY](https://e2b.dev/docs/sandbox/pty),
  [secured access](https://e2b.dev/docs/sandbox/secured-access)); its enterprise
  page states Firecracker and BYOC/on-prem support
  ([E2B](https://www.e2b.dev/)).
- Daytona publishes per-second CPU/RAM/storage prices
  ([pricing](https://www.daytona.io/pricing)), explicit running/stopped/archived/
  deleted resource states
  ([limits](https://www.daytona.io/docs/limits)), signed port previews and SSH
  access
  ([SDK](https://www.daytona.io/docs/en/typescript-sdk/sandbox/),
  [previews](https://www.daytona.io/docs/en/preview/)), and network/opaque-secret
  controls
  ([network](https://www.daytona.io/docs/en/network-limits/),
  [creation options](https://www.daytona.io/docs/en/typescript-sdk/daytona/)).
- Runloop publishes plan and resource prices, states suspended devboxes stop CPU/
  RAM billing, and documents microVM isolation, credential gateway, egress policy,
  and VPC deployment
  ([Runloop pricing](https://runloop.ai/pricing)).
- Modal publishes sandbox-specific CPU/RAM pricing and snapshot retention
  ([pricing](https://modal.com/pricing),
  [snapshots](https://modal.com/docs/guide/sandbox-snapshots)).
- Cloudflare publishes container rates and instance sizes
  ([container pricing](https://developers.cloudflare.com/containers/pricing/));
  its lifecycle documentation says the current sandbox restarts fresh and loses
  state after idle
  ([lifecycle](https://developers.cloudflare.com/sandbox/concepts/sandboxes/)).

Do not expose provider names as the primary task choice. The provider is an
operator decision behind the **Karmax Cloud** runner pool. Enterprise projects may
select a named customer pool when policy requires it.

## Where Karmax itself runs

### Three deployment profiles, one protocol

| Profile | Control plane | Default runner pools | Best for |
| --- | --- | --- | --- |
| **Local** | One Node process + local Temporal + SQLite | Worktree/container | Current individual install and offline development |
| **Karmax Cloud** | Managed regional control-plane cell | Managed E2B first; later alternatives | Teams that want the website and no infrastructure |
| **Customer managed** | Karmax-managed or self-hosted control plane | Outbound-connected local/VPC/Kubernetes runners | Enterprise network/data-residency constraints |

The UI and API speak only to the gateway in all three. Workflows speak only to
activities. Activities speak to runner pools. A local worktree is the smallest
runner implementation, not a different architecture.

### Hosted control-plane shape

```text
browser / CLI / GitHub webhooks
              |
       edge auth + gateway  <---- WebSocket/SSE event fan-out
              |
       Karmax application services
        |          |          |
 cell SQLite   object store  Temporal namespace
        |                         |
        +------ activity workers--+
                       |
               runner broker / leases
                 |             |
          managed sandbox   customer/local runner
```

The first hosted release deploys one active application/worker process per cell.
The boundaries matter more than microservices. Execution scales independently
through runner pools; tenant scale comes from adding cells.

Required changes from the local process:

- A cell keeps SQLite for metadata, Better Auth, inbox, durable tokens/grants,
  executions, and audit on an encrypted single-writer block volume. SQLite's
  synchronous API is load-bearing in the Store and gives the cleanest correct
  first release; pretending it is multi-writer through asynchronous filesystem
  replication would risk acknowledged-write rollback. Online SQLite backups and
  active/passive volume failover are implemented. PostgreSQL is justified only
  if one cell must later accept concurrent application writers.
- S3-compatible object storage holds promoted artifacts, portable checkpoints,
  and provider session artifacts. Content-addressed prompt attachments remain on
  the encrypted single-writer cell volume in the first release and are included
  in its verified backup/restore path.
- Temporal Cloud or a production Temporal cluster replaces the embedded dev
  server. Workflow IDs include organization scope; finite task executions remain
  version-pinned.
- Gateway event fanout tails the durable ordered event table; process-local bus
  delivery is only a latency optimization. Interactive output is bounded and
  durable, and stale executions are reconciled as lost after failover.
- Capability tokens are durably introspected and store only hashes/revocation
  metadata, so restart does not resurrect or forget grants.
- Long-lived review processes and agent custody belong to the runner, not the
  gateway process.
- Every provider operation has organization/project/task labels for usage,
  quotas, support diagnostics, and deletion.

### Cells, not a giant global database

Start with one region, but make an organization belong to one **cell**: a region's
single-writer database/volume, object store, Temporal namespace, and runner broker.
Routing knows only `organization -> cell`. Large or regulated customers can get a
dedicated cell or attach a VPC runner pool without creating a separate product.
This contains failures and makes residency/backups/deletion explainable.

Do not create one Temporal namespace or database per ordinary customer. That
makes small tenants operationally expensive. Use `organizationId` in every
resource and enforce it at authorization, repository, token, and object-key
boundaries; use dedicated cells only when isolation policy pays for them.

## Local testing with hosted Karmax

The browser should already cover most checks:

- Terminal opens a provider PTY in the task world.
- Run actions create command/service executions in the world.
- Preview actions expose a port through an authenticated Karmax URL.
- Open actions stream a world artifact or promoted object.
- Browser/computer-use sessions stream from the world when the workflow declares
  them.

For native apps, hardware, private networks, or an editor, ship a small
`karmax runner` daemon. It registers to an organization with a one-time code and
maintains an outbound mTLS/WebSocket connection; no inbound port or public tunnel
is required. A project can select that runner pool, or a user can choose
**Continue on this machine**:

1. Karmax parks the cloud generation and takes a portable checkpoint.
2. It transfers the single-writer generation lease to the local runner.
3. The local runner restores into a disposable worktree/container.
4. The web task, conversation, MCP calls, audit, and review gate remain hosted.

This generalizes existing path-copy commands into product operations:

| Today | Hosted operation |
| --- | --- |
| `cd <worldPath> && $SHELL` | `karmax attach <task>` or browser PTY to a world ID |
| CLI command containing config-home path + provider session ID | **Fork conversation** API creates a task/attempt with a conversation checkpoint; CLI attaches by task ID |
| Gateway-local review server | Runner service execution + authenticated port lease |
| Gateway-local artifact path | Scoped world artifact stream or promoted object |

The public task view should stop exposing `worldPath`. Local debug views may show
a runner-local path, but no workflow, URL, review action, or session reference may
depend on it.

## GitHub repositories and SSH

### Repository model

Projects refer to durable repository records, not strings:

```ts
interface Repository {
  id: string;
  organizationId: string;
  forge: 'github';
  connectionId: string;       // GitHub App installation
  forgeRepositoryId: string;  // stable GitHub numeric/node id
  owner: string;
  name: string;
  sshUrl: string;
  defaultBranch: string;
  archived: boolean;
}

interface ProjectRepository {
  projectId: string;
  repositoryId: string;
  checkoutPath: string;
}
```

`ProjectConfig.repos: string[]` remains only for the local compatibility adapter.
Hosted projects require `ProjectRepository` records. The control plane stores no
checkout; a world clones the exact base SHA into `/workspace/<checkoutPath>`.
Mirrors and dependency caches may exist in the execution plane but are disposable.

### Connect flow

1. An organization owner installs the Karmax GitHub App on selected repositories.
2. Karmax imports repository IDs, permissions, default branches, and webhook
   routing. The installation is organization-owned, not tied to whichever user
   happened to click Connect.
3. For each enrolled repository, Karmax generates distinct Ed25519 SSH material
   and registers the public deploy key through the GitHub API. Private material
   goes directly to the vault.
4. A world receives at most a read-only clone credential. Git writes and pushes
   are performed by a trusted Git broker with a separate repository write key.
5. App uninstall/repository removal triggers key deletion, vault deletion, runner
   cache purge, and project health warnings. Reconciliation catches missed
   webhooks.

The manifest is deployment-aware. A publicly reachable HTTPS control plane
registers its webhook URL. A localhost, LAN, or other private installation omits
the webhook because GitHub cannot deliver to it and refreshes every installation
through the API on demand instead. `installation` and
`installation_repositories` are not requested in `default_events`: GitHub sends
those App lifecycle events automatically and rejects manual subscription to the
latter. Organization settings owns only this shared connection. Repository
discovery, creation, and attachment live together in project settings, where a
new repository is created and attached in one action.

GitHub documents that deploy keys are SSH keys scoped to a single repository,
that a write deploy key is powerful, and that GitHub Apps are preferred for
fine-grained service authorization
([deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)).
The deploy-key API accepts GitHub App installation tokens with repository
Administration write permission
([API](https://docs.github.com/en/rest/deploy-keys/deploy-keys)). A Karmax
installation therefore makes the elevated setup permission conspicuous, then
keeps the resulting write key out of agent worlds. Because app uninstall does
not automatically remove deploy keys created by the app, explicit cleanup and
reconciliation are mandatory.

For sync, the world exports a Git bundle/object pack for its claimed task ref.
The broker imports it into an ephemeral trusted bare repository, verifies the
world generation, repository ID, expected ancestry, object limits, destination
ref, and exact branch capability, and then pushes `<verified-sha>:<allowed-ref>`
over SSH. It never accepts a shell fragment or remote URL from the world. Target
branch updates additionally require the merge-queue lease and reviewed commit.

For GitHub Enterprise Cloud customers that already operate an SSH certificate
authority, a customer runner may instead receive short-lived user certificates;
GitHub supports expiring OpenSSH certificates for Git operations
([SSH CAs](https://docs.github.com/en/enterprise-cloud@latest/organizations/managing-git-access-to-your-organizations-repositories/about-ssh-certificate-authorities)).
Do not upload users' personal private SSH keys to Karmax Cloud.

### Branch and delivery policy

- A task starts from a recorded base SHA, not whatever `main` means later.
- Each attempt owns a collision-proof task branch. It checkpoints committed state
  to the remote branch through the Git broker.
- Dirty/untracked state lives in the encrypted world checkpoint until an agent
  deliberately commits or ignores it; machinery still never performs blind
  `git add -A`.
- The hosted default is a pull request. Protected branches, required reviews,
  status checks, and signed commits remain GitHub's enforcement boundary.
- When signed target commits are required, the broker produces a signed squash or
  merge commit after review; it does not expose a reusable signing key to the Do
  world.
- Commit and PR provenance is an organization policy. The sensible default is a
  Karmax service author, the initiating human as co-author, and immutable task,
  attempt, world-generation, and audit links in commit/PR metadata. Attribution
  does not substitute for the separate `createdBy`, executor, and workflow-gate
  confirming-principal audit.
- A no-PR direct push is available only when repository policy permits it and the
  Merge role holds the queue lease and exact target capability.
- The agent never receives the Git write key. A push is a capability-checked
  platform operation that accepts a validated commit/ref from its own world and
  constrains the destination branch.

This refines `PLAN-git-config.md`: local installs may continue to fall back to
host SSH state; cloud has no host fallback. Cloud repository connections are
organization resources, while `GitProfile` remains commit identity/signing and
local compatibility rather than a bucket of shared cloud credentials.

## Multi-user Karmax

### Tenant hierarchy

```text
user <-> organization membership <-> organization
                                      |
                                   projects
                                      |
                              lists / tasks / repos
```

The Organization is the product settings root. The historical `global` spelling
remains only as an internal schema/backward-compatibility key. Settings are:

- user settings: theme, personal notification delivery, connected personal
  agent accounts;
- organization settings: people/teams, the shared GitHub connection, execution
  policy and provider connections/templates, task/agent defaults, installation
  resources, and advanced identity/data controls, in one column beside a sticky
  section rail;
- project settings: repositories, workflows, access, and sparse execution
  exceptions (another connected provider/pool or a tighter cloud budget);
- task parameters: one execution's overrides.

Every project, task, event, attachment, workflow installation, profile, secret
handle, repository, runner, checkpoint, saved view, inbox row, and audit record
has an organization owner. Authorization queries start with organization scope;
cross-organization identifiers must return not-found rather than reveal existence.

### Workflow routing and collaboration

Implement `PLAN-collaboration.md` as part of hosted readiness:

- immutable `createdBy` provenance;
- teams and project membership;
- human Confirm layers naming users, `@team:<slug>`, `@creator`, `@owners`, `@project`,
  or `@all` at the exact decision point;
- event-derived per-user inbox and delivery preferences;
- no generic assignee/delegate/reviewer/follower state competing with workflows.

Routing never grants access. Repository access does not automatically grant
Karmax project access, and Karmax membership does not silently expand a GitHub
installation. A review records the human principal, policy target it satisfied,
world/commit generation, and exact diff/check results approved.

### Enterprise runway

Sequence these after the core organization/member model, without changing it:

- invitations and verified email domains;
- OIDC/SAML SSO and enforced organization sessions;
- SCIM provisioning/deprovisioning and group-to-team mapping;
- audit export and retention/legal-hold policy;
- IP/network policy and customer-managed encryption keys;
- dedicated cells and customer VPC runner pools;
- usage limits, budgets, cost centers, and chargeback labels.

## Reliability, quotas, and observability

World capacity is another durable lease coordinator:

- organization and project caps for active worlds, CPU, RAM, GPU, and previews;
- priority/reorderable queue using the existing coordinator pattern;
- reservation before provisioning and guaranteed release on every terminal path;
- provider rate-limit/concurrency feedback;
- budget policy that can park queued work before spend exceeds a cap.

Record provider-neutral lifecycle events (`world.provisioning`, `world.ready`,
`execution.started`, `world.parked`, `world.restored`, `checkpoint.created`,
`world.failed`) with provider diagnostic detail in a protected operator field.
Metrics need active seconds, requested resources, checkpoint bytes, boot/restore
latency, failure classification, and cost attribution by organization/project/
task/provider. Do not put provider billing IDs or secrets in workflow history.

Provider loss is recoverable if the last portable checkpoint exists. A dead
active world becomes `degraded`, the task parks, Karmax attempts restore into a
new generation, and only then escalates. A provider adapter is considered ready
only after it passes the same conformance and failure-injection suite as local.

## Build order

### Phase 0 — freeze the product contract (complete)

- Accept the Environment / Runner pool / World / Execution vocabulary.
- Add organization ownership to new domain designs before more “global” records
  accumulate.
- Define provider capabilities, lifecycle events, checkpoints, process streams,
  artifacts, and port leases as provider-neutral types.
- Write a conformance test kit using the memory provider.

### Phase 1 — remove local-path leakage with no behavior change (complete)

- Make provider IDs registry strings and introduce `WorldHandleV2` alongside the
  replay-compatible old handle.
- Route terminal, review actions, artifact reads, file access, and world status
  through a `WorldService`; keep worktree/container adapters underneath.
- Route agent turns through the versioned `karmax-runtime` execution protocol,
  locally at first.
- Replace UI/session dependencies on `worldPath` and config-home paths with IDs.
- Add checkpoint/park calls to workflow wait transitions; local worktrees may
  implement park as a no-op plus checkpoint metadata.

Exit test: the full existing suite passes, while a gateway process can operate a
world without reading its root path or spawning its processes directly.

### Phase 2 — remote repository and organization foundations (complete)

- Idempotent SQLite-to-organization migration (one personal organization for an
  existing install), plus durable cell state and verified online backup/restore.
- Organizations, memberships, invitations, teams, project membership, and
  organization-aware authorization/audit.
- Repository/ProjectRepository/GitConnection records.
- GitHub App install, webhook verification, repository import, SSH deploy-key
  lifecycle, and Git broker.
- Remote branch/base-SHA setup and delivery tests against a disposable Git remote.

### Phase 3 — one complete E2B vertical slice (complete)

- Versioned Karmax environment Dockerfile/template and provider snapshot cache.
- Provision from a GitHub repository over SSH; run agent and test commands.
- Cloud MCP connectivity with scoped token renewal and audit.
- Browser PTY, review action stream, signed preview, artifact open.
- Explicit park at Review, resume on follow-up, portable checkpoint fallback.
- Merge/push/PR, cancellation, cleanup, quotas, and measured cost events.

This phase is complete only when a task can wait for a human for several days
with zero sandbox CPU/RAM, then resume and merge without manual repair.

### Phase 4 — hosted control plane (complete)

- Production Temporal, single-writer cell storage, object storage, durable gateway event fanout,
  durable token verification, backup/restore, and a cell identity/routing contract.
- Hosted signup/organization onboarding, GitHub connect, project creation, and
  usage/budget UI.
- Deployment automation, health/SLOs, incident diagnostics, deletion/export.

### Phase 5 — collaboration product (complete)

- Workflow-owned human routes on every confirmation layer, including named
  users, teams, `@creator`, `@owners`, `@project`, and `@all`.
- A per-user attention inbox derived from the workflow's current wait, plus
  delivery adapters; no parallel assignment or following model.
- Organization audit and workflow-bottleneck views.
- SSO/SCIM and enterprise policy after the base model is proven.

This is the hosted multi-user baseline: workflow routing, attention inbox,
organization/repository onboarding, and enterprise identity all share the same
tenant boundary and audit model.

### Phase 6 — optional portability and specialized execution

- `karmax runner` local/VPC connector and single-writer checkpoint handoff.
- Daytona adapter as the second conformance implementation. **Complete.**
- Customer-managed Kubernetes/Kata or vendor BYOC only after real demand; reuse
  the runner protocol rather than exposing cluster details to workflows.
- Modal/GPU pool when a workflow declares GPU resources.

## Verification strategy

The contract needs tests more than provider wrappers need cleverness:

- provider conformance: exec streaming, cancellation, PTY resize/disconnect,
  artifacts, port auth, park/restore, destroy idempotence, lifecycle events;
- Temporal replay with old and V2 handles;
- park at every durable human/resource wait and restore after simulated days;
- provider deletion/outage followed by portable restore into a new generation;
- split-brain test proving stale generations cannot execute or push;
- cross-organization authorization and identifier enumeration tests;
- prompt-injection exfiltration tests against egress deny and secret broker;
- Git tests proving task worlds can clone but cannot push directly, while the Git
  broker can push only the leased branch/target;
- token restart/replica/revocation tests;
- concurrent multi-repo merge lease ordering on remote repositories;
- cost accounting reconciliation against provider usage exports;
- local runner disconnect/reconnect and custody cleanup;
- end-to-end: GitHub issue/web task -> cloud world -> review preview -> days parked
  -> follow-up -> PR -> merge -> retention deletion.

## Explicit non-goals

- No mutable project-wide “pet VM”.
- No provider-specific fields in `TaskInput`, workflow code, or the main task UI.
- No Kubernetes control plane built before a managed provider proves the product.
- No local repository checkout on the hosted Karmax control plane.
- No personal SSH private keys copied into Karmax Cloud.
- No write-capable repository credential inside an untrusted agent world.
- No public unauthenticated terminals, artifact URLs, or previews by default.
- No promise that a live Unix process survives a human wait; durable state lives
  in Temporal, Git, checkpoints, and conversation records.
- No “global” setting whose actual owner (user, organization, or installation) is
  ambiguous.

## Bottom line

Karmax Cloud is not a hosted local todo app and it is not a sandbox dashboard. It
is a durable collaborative control plane whose tasks can borrow secure computers.
Each attempt gets a private world; each execution wakes that world briefly; each
human wait turns compute off; and each accepted result moves through GitHub's
normal protected path. The same task can run on Karmax Cloud, a customer's VPC,
or a developer's machine without changing the workflow or collaboration model.

# Human and agent collaboration

> Status: implemented and corrected for workflow-owned routing, 2026-07-15.

## Finding

Karmax is not a conventional issue tracker. A task is an execution of a durable
workflow, so generic issue metadata such as assignee, delegate, reviewer,
approval, follower, or “My work” creates a second, competing orchestration model.
It cannot say which decision needs attention, and it goes stale as the workflow
moves between agents, automation, and human gates.

The workflow is the authority. Each human wait declares its audience at that
specific step; task events materialize a per-user inbox from that declaration.
There is no task-level responsibility editor in the product UI.

## Principals and tenancy

An Organization is the tenant and collaboration boundary. It owns users, teams,
projects, repositories, execution policy, inboxes, identity policy, and audit.
Stable principal references remain useful for provenance and routing:

```ts
type PrincipalRef =
  | { kind: 'user'; userId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'task-agent'; taskId: string; role: string };
```

`createdBy` is immutable provenance, not an assignee. Assignment never grants
access. Organization/project membership and attenuated capabilities remain the
authorization model.

## Workflow-owned human routing

A human Confirm layer carries an audience:

```ts
type ConfirmLayer =
  | { kind: 'agent'; provider?: string; model?: string; prompt?: string }
  | { kind: 'human'; audience: HumanAudience };

type HumanAudience = string[]; // any matching person may satisfy this layer
```

Selectors are stable ids or explicit workflow vocabulary:

- `@creator` — the initiating human. For an agent-created subtask, resolve back
  through the parent-task chain to that human.
- `@all` — every member of the organization.
- `@owners` — organization owners.
- `@project` — everyone with access to the project.
- `@team:<slug>` — a team through a readable stable route such as
  `@team:leaders`; `team:<id>` remains a compatibility spelling.
- `user:<id>` — a specific person.

The schema-driven Confirm editor provides searchable people/teams plus these
special selectors. Multiple selectors in one layer mean “any”; multiple human
layers express sequential decisions. Agent and human layers can be interleaved.
Legacy naked human gates normalize to `@creator`.

Membership is only the routing/scope fact. Human authority is selected once
through Developer, Project maintainer, Automation operator, or Administrator.
The store retains a hidden protected-owner marker solely to preserve one tenant
recovery principal; it grants no independent permissions and is not selectable.
Teams intentionally have no sub-roles.

Team membership editors use account names and email addresses, never durable
user IDs. Teams may be renamed; the previous slug remains a routing alias so an
in-flight workflow cannot be stranded. An unused team may be deleted. Deletion
is rejected while project access, saved defaults, or unfinished work still
references the team, because silently turning a human gate into an empty
audience is not an acceptable lifecycle behavior.

When a workflow publishes `waitingFor: { kind: 'human', audience }`, only a
matching human may send its Confirm signal. The confirming principal and declared
audience are recorded in the event log. The compatibility API may still read old
task-level confirmation policies, but new UI/workflows never create them.

## Inbox and delivery

Events remain the source of truth:

```text
workflow wait/event -> audience resolver -> one actionable inbox row per human
                                      \-> browser/email/Slack delivery adapters
```

The inbox contains only events routed to that user. It is not a saved task query,
and it does not depend on following/subscription state. Agents do not need a
simulated human inbox: agent-directed work uses durable task signals, child tasks,
and workflow coordination.
The UI exposes this as one page reached from the top-bar attention icon; there is
no competing sidebar item or abbreviated popover.

## Authorization and execution

Human routing does not widen authority. The selected user must already be an
organization/project member with permission to view and signal the task. Agent
roles remain bounded by the intersection of the workflow role ceiling, selected
authorization profile, creator's grant, and task scope.
People is the only UI for organization membership and project Access is the only
UI for project membership. Agent permissions configure task-agent profiles only;
they do not repeat human accounts or grants.

Authoring and protected-target merging remain separate trust domains. The Do
agent edits an isolated world; Merge receives a concrete merge capability only
while holding the durable queue lease after all Confirm layers have passed.

## Compatibility boundary

The database retains creator, legacy responsibility, subscriber, and confirmation
records so historical workflows replay and old API clients can migrate safely.
They are not product concepts for new work. New task creation does not synthesize
reviewer policies, and the task list/detail/settings UI exposes none of the old
assignee/delegate/reviewer/approval/following controls or saved views.

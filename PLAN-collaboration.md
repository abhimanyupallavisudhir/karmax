# Human and agent collaboration

> Status: implemented as part of the Karmax Cloud baseline, 2026-07-14.

## Finding

Authentication and authorization are necessary but not a collaboration model.
Karmax has real user identities and scoped grants, and tasks now model creators,
assignees, delegates, reviewers, subscribers, and notification recipients. The
notification bell is a per-user durable inbox projection, with browser/email/
Slack delivery derived from that source of truth.

For hosted Karmax, an **Organization** is the tenant and collaboration root
(`PLAN-cloud.md`). Every principal reference below is resolved inside that
organization; today's installation-global records migrate into a personal
organization rather than becoming implicitly visible to every hosted tenant.

The useful common shape across mature task systems is:

- one accountable assignee, rather than ambiguous shared ownership;
- separate delegates/executors, collaborators/subscribers, and reviewers;
- people and teams as explicit review targets;
- automatic subscription for responsibility and participation, with user-level
  delivery preferences;
- assignment and responsibility as searchable fields.

Karmax should retain that clarity while admitting agents as first-class actors.

## Principals and provenance

A logical principal reference is one of:

```ts
type PrincipalRef =
  | { kind: 'user'; userId: string }
  | { kind: 'team'; teamId: string }
  | { kind: 'task-agent'; taskId: string; role: string };
```

`task-agent` deliberately names a logical role (for example, “Task #120's Do
agent”), not a provider process or retry attempt. Attempts, sessions, and forked
conversations remain provenance records beneath that stable actor. A retry can
therefore neither lose responsibility nor manufacture a new identity.

Every task then has distinct relationships:

- `createdBy` — immutable provenance; a user, task agent, or system service.
- `assignee` — zero or one accountable user or agent. “Owner” is a UI synonym,
  not a second field.
- `delegate` — optional executing agent when a human remains accountable.
- `subscribers` — users or teams who opted into ordinary updates.
- `confirmationPolicy` — the principals allowed/required to make a particular
  decision.

Assignment never grants access. A user/team must already be a project member;
an agent receives only its stored, attenuated task grant. This prevents an
assignment edit from becoming a privilege-escalation path.

## Teams and confirmation routing

Use first-class teams, not free-form “categories of humans”. Teams may be
organization-wide or project-local and have members plus optional semantic roles
(project owner, triage, security review, billing approver). A confirmation target
is a selector:

```ts
type ConfirmationTarget =
  | PrincipalRef
  | { kind: 'project-role'; projectId: string; role: string };

type ConfirmationPolicy = {
  targets: ConfirmationTarget[];
  rule: 'any' | 'all' | { quorum: number };
};
```

There is no durable naked `human` recipient. The task form resolves “Human” to a
named user/team/project role and shows that resolution before queueing. Existing
tasks with legacy `confirm.mode = human` use the project's configured default
review team; if none exists, project administrators are the explicit fallback
and the UI warns that the default needs configuration.

## Inbox and delivery

Events stay the source of truth. A recipient resolver consumes responsibility
events (assigned, mentioned, review requested, escalated), expands team/role
selectors at event time, and materializes one deduplicated inbox row per human:

```text
event -> responsibility + subscriptions -> audience resolver -> user inbox
                                                    \-> delivery preferences
```

Creators and assignees are automatically subscribed; mentions subscribe the
mentioned user to the relevant thread; users may unsubscribe from routine
updates but not suppress a currently assigned review/escalation. Do not notify
every project member. Email/browser/Slack are delivery adapters over the inbox,
not independent sources of truth.

Agents do not need a simulated human notification bell. Agent-directed work is
durable coordination: a task signal for an attached live workflow, or a new
assigned task for asynchronous work. That preserves retries and auditability.

## Search and organization

Expose `assignee`, `delegate`, `creator`, `subscriber`, `reviewer`, and
`participant` through the existing declared search-field registry. Add derived
facets `is:mine`, `is:unassigned`, and `needs:my-review`; “My work” and “Inbox”
are saved-query projections, not new task containers. Display names are for UI
and fuzzy lookup only; persisted filters store immutable principal IDs.

## Worktree author versus merger

Yes: authoring and protected-target merging are different trust domains. Keep
the separation already described by `SPEC.md` §8:

- the Do role may edit its isolated world/branch;
- the Merge role alone receives a concrete `merge-into:<repo>:<branch>` grant,
  and only while holding the merge-queue lease after the review gate;
- Resolve and Confirm receive their own smaller role ceilings;
- retries/replacements inherit the same logical role and attenuated task grant.

Do not make users hand-author a raw permission set for every workflow agent. The
workflow manifest declares each role's maximum; the task's selected authorization
profile declares the job envelope; the runtime grants their intersection. Offer
per-role profile overrides as an advanced workflow setting. Worktree filesystem
isolation belongs to the world provider (container/microVM for an enforcement
boundary), while karmax capabilities enforce server/MCP operations. A cosmetic
`worktree:write` server capability would not sandbox a host process and would
therefore promise security it cannot provide.

## Delivered layers

1. Organizations, organization/project membership, teams, and immutable
   principal references.
2. Task creator, assignee, delegate, and subscribers are exposed in task
   create/edit, MCP, event history, and search.
3. Naked human confirmation is replaced by explicit confirmation policies.
4. The per-user inbox and delivery preferences are materialized from task events.
5. “My work”, “Needs my review”, and audit are query projections.

The migration and workflow compatibility layer preserve older executions while
new tasks use explicit principal references throughout workflow, search, UI,
notification, and authorization paths.

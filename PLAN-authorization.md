# Identity, authorization, and complete agent API

## Boundary

Better Auth owns human identity: accounts, password hashing, sessions, cookies,
rotation, and rate limiting. Karmax owns authorization because its resources and
workflow delegation model are domain-specific. Agent credentials are short-lived,
opaque server-side tokens; secrets and capabilities are never prompt text.

Every gateway and MCP operation maps to one named capability. The high-level MCP
tools cover ordinary coordination; `describe_platform` plus `platform_request`
make the entire authenticated gateway surface automatable without maintaining a
second, incomplete administration API.

The settings UI renders that same authoritative catalogue as grouped,
described checklists. Raw names are shown as secondary reference, not used as the
editing interface. The administrator wildcard remains explicit because it means
“all current and future capabilities”; concrete target-scoped grants have a
separate advanced control because their resource names cannot be enumerated.

## Account creation

The first account is an explicit setup-only administrator. After setup, people
may self-register through Better Auth. A self-registered identity receives no
karmax grant: it can authenticate and wait for an administrator to assign a
global or project profile, but it cannot discover projects or call platform
operations. Admin-created accounts may receive a grant atomically at creation.
This keeps account signup separate from access approval and leaves room for
email verification/invitations without changing the authorization model.

## Default profiles

| Profile | Intended use | Adds |
| --- | --- | --- |
| Developer | Normal task agents and contributors | Project/task discovery, task and conversation work, review execution, skills, queue/workflow/profile read |
| Project maintainer | Owners of one project | Project settings, queue changes, agent profiles, workflow install and reviewed workflow edits |
| Automation operator | Cross-project automation | Project creation, diagnostics/process control, credentials, payments, global automation settings and safe mode |
| Administrator | Trust root | Users, grants/profile policy, deletion, and every other operation |

These are defaults, not hard-coded roles. Global records can be customized and a
project can overlay a profile with the same id. Each scope also selects its own
default profile for new tasks.

A project-scoped human grant is structurally capped at project resources even if
it names Administrator. Host/global powers (users, grants, credential writes,
payments, process control, safe mode, and global settings) require a global
grant. A project overlay also cannot redefine or escalate an account's global
grant.

## Delegation invariants

1. A human or agent creates a task and selects an authorization profile (or uses
   the project/global default).
2. Karmax intersects that profile with the creator's effective project grant and
   stores the result, grantor, and whether it was attenuated on the task.
3. At each turn the workflow intersects the stored task grant with the concrete
   role profile (Do/Merge/Resolve/Confirm) and mints a short-lived token carrying
   project scope and origin-task provenance.
4. Retries mint a replacement token from the same stored grant. Resolve agents and
   additional agents therefore cannot gain privileges merely because workflow
   topology changed.
5. Child tasks copy the already-attenuated parent grant and add only the exact
   merge-back branch capability owned by the parent.

There is intentionally no silent elevation. When a creator asks for a profile it
does not possess, v1 records an attenuated grant and starts with the safe subset.
An approval workflow can later replace this with an explicit pending grant.

## Workflow repositories

`workflow:edit` authorizes proposing a workflow change; it does not publish code.
Publication remains a merge-only task under the protected merge queue, with tests
and an authorized Merge role. A workflow repository can choose its own restrictive
project default, so agents that manage ordinary application projects need not be
able to change orchestration infrastructure.

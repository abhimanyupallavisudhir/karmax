# Hosting readiness — env vars & the path to a multi-tenant SaaS

Your instinct is right: **env vars can't carry per-user config in a hosted app.**
But not every env var is a problem — the fix is to sort them into two buckets and
only migrate the ones that are actually per-tenant.

## The distinction

- **Operator config** — set **once** by whoever runs the karmax deployment. Env
  vars (or a secrets manager) are the correct home for these even when hosted.
- **Per-tenant config** — differs per user/workspace. These **must** live in the
  DB/vault keyed by tenant, never in process env, or one tenant's setting leaks to
  all of them.

## Audit of every `process.env.*` in karmax today

| Env var | Bucket | Verdict |
|---|---|---|
| `KARMAX_HOME`, `KARMAX_PORT`, `KARMAX_GATEWAY_URL` | operator | ✅ fine — infra |
| `TEMPORAL_CLI`, `KARMAX_TEMPORAL_LOG`, `KARMAX_MAX_WFT`/`_ACT`/`_CACHED_WORKFLOWS` | operator | ✅ fine — Temporal infra |
| `KARMAX_VAULT_KEY` | operator | ✅ correct — the vault master key belongs in a secrets manager, never per-user |
| `KARMAX_CONTAINER_IMAGE`, `KARMAX_AGENT_PROVIDER`, `KARMAX_*_MODEL`, `KARMAX_*_BASE_URL` | operator default | ✅ fine as platform defaults; already overridable per-tenant via profiles |
| `KARMAX_CLAUDE_LOGIN_ARGS`, `KARMAX_CODEX_LOGIN_ARGS` | operator/test | ✅ fine — how the login CLI is invoked |
| `KARMAX_TOKEN`, `CLAUDE_CONFIG_DIR` | runtime | ✅ not user config — injected per agent spawn |
| `STRIPE_CLIENT_ID`, `STRIPE_SECRET_KEY` | **operator** | ✅ **correct as-is** — these are the *platform's* Stripe Connect app, set once. Each tenant connects **their own** Stripe account via OAuth; the connected-account id is stored per-tenant. (Messaging fixed to say so.) |
| `KARMAX_SAFE_MODE` | operator/global | ✅ fine (also a UI toggle); becomes per-workspace when workspaces exist |
| `KARMAX_PASSWORD` | operator (single-tenant) | ⚠️ becomes **per-user auth** in hosted — replace with a real accounts/auth system |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (+ the ambient `~/.claude` login) | **per-tenant** | ⚠️ **the real hazard** — see below |

## The one genuine multi-tenancy hazard: credential fallback

The agent adapters currently **fall back** to `process.env.ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` (and the ambient `~/.claude` login) when a profile has no resolved
auth. In a shared hosted deployment that means **a tenant with no connected account
would silently run on the operator's key / the operator's Claude subscription** —
the operator pays, and it's a cross-tenant credential leak.

The per-tenant path already exists and is correct: connected **logins** (config
homes) and **API-key handles** (vault) resolved per profile. The fix for hosting is
to **disable the env/ambient fallback** in a hosted deployment so every turn must
use a tenant-owned credential.

**Recommended (small, when the tenant model lands):** a `KARMAX_MULTI_TENANT=1`
flag that makes `runAgentTurn` refuse the `process.env` key / ambient-login
fallback and require a resolved per-account credential (broker handle or config
home), failing the turn with a clear "connect an account" message otherwise. This
is a few lines in `core.ts` auth resolution + `claude.ts`/`codex.ts`. Left unbuilt
for now because there is **no tenant/workspace model yet** — building the gate
before the thing it protects would be premature (and would break your current
single-user ambient-login setup).

## What hosted multi-tenancy actually needs (the bigger effort)

1. **Workspaces + accounts + auth** — replace the single `user: "me"` +
   `KARMAX_PASSWORD` with real user accounts, sessions, and workspaces. Every
   store row (projects, tasks, profiles, cards, logins, vault handles) gets scoped
   by `workspaceId`; the gateway authorizes each request against the caller's
   workspace.
2. **Per-tenant credential isolation** — the fallback gate above; config homes and
   vault entries already key by account, so extend that to workspace.
3. **Per-tenant Stripe** — already the model: platform Connect app (operator) +
   per-tenant connected accounts (stored per workspace).
4. **Resource isolation** — worktrees/containers, token/budget coordinators, and
   task queues partitioned or fair-shared per workspace.

None of these are env-var problems; they're the standard single-tenant → SaaS
migration. The env audit above confirms only the **credential fallback** and
**KARMAX_PASSWORD** are env-vars that block hosting — everything else is either
correct operator config or already per-tenant in the DB/vault.

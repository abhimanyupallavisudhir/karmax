# Hosting readiness — env vars & the path to a multi-tenant SaaS

Your instinct is right: **env vars can't carry per-user config in a hosted app.**
But not every env var is a problem — the fix is to separate infrastructure
bootstrap from settings an operator reasonably expects to manage in the product.

## The distinction

- **Operator config** — set **once** by whoever runs the karmax deployment.
  Infrastructure roots (vault master key, database, network) belong in deployment
  secrets. Application integrations such as Stripe and GitHub should be
  manageable in the UI, backed by the encrypted vault, with env vars only as an
  optional bootstrap path.
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
| `STRIPE_CLIENT_ID`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | **optional bootstrap** | The installation administrator normally enters these under **Organization settings → Payments → Stripe platform setup**; secrets are encrypted in the Karmax vault. Environment variables remain an optional first-boot/managed-secret fallback. They identify the deployment's Connect application and webhook, never a funding source. |
| `STRIPE_API_VERSION` | operator | Optional Stripe API-version override. The default is the direct real-time authorization version used by the webhook response contract. |
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
3. **Per-tenant Stripe (only if you offer Issuing)** — the `vault-card` rail is
   already per-tenant, since each card is an org-scoped vault handle. Issuing is
   implemented as a platform Connect app (operator) plus
   organization-owned connected accounts and Issuing balances. OAuth state,
   account ids, cardholders, cards, reservations, authorization decisions, and
   transaction/dispute reconciliation are tenant-scoped. The operator key is
   used only to act as the Connect platform and is never treated as tenant money.
4. **Resource isolation** — worktrees/containers, token/budget coordinators, and
   task queues partitioned or fair-shared per workspace.

The remaining items are broader tenancy concerns rather than reasons to require
shell access for application setup. The credential fallback and
`KARMAX_PASSWORD` still need the hosted treatment described above; Stripe and
GitHub application setup are already UI-managed and vault-backed.

## Payment rails

Karmax has three rails, in increasing order of setup cost. **Only the first two
move real money, and only the first works everywhere.**

| Rail | Who can use it | Setup | Enforcement |
|---|---|---|---|
| **Your own virtual card** (`vault-card`) | anyone, any country | none — paste a card | the human's own issuer declines |
| Stripe Issuing (`stripe`) | registered businesses in US/UK/EEA | Connect app + webhook + cardholder | per-card spending controls |
| Local test funds (`mock`) | development only | none | simulated; no money moves |

**The default rail is `vault-card`, and it is the one to reach for.** The human
creates a virtual card with a spending limit in their own banking app — Revolut,
Wise, Monzo, most EU banks, a prepaid card — and registers it under
**Payments → Cards**. Karmax encrypts the number in the vault, types it into
checkout through the origin-checked secure fill, and never shows it to an agent.
The issuer enforces the limit and declines when it runs out; "topping up" is the
human raising that limit.

The trade is deliberate and worth stating plainly: karmax cannot read the real
balance, so the limit recorded against the card is the human's *declared* figure.
It drives fast failure, the review threshold, and the audit trail — but the
authoritative answer is always the issuer's decline, never karmax's arithmetic.
Size the card to the blast radius you are willing to accept.

Stripe Issuing remains for organizations that are already registered businesses
and want karmax to mint a separate capped, merchant-locked card per agent or per
task. It is a considerably heavier lift — see below — and it is not required.

## Stripe Issuing deployment setup (optional)

Open **Organization settings → Payments → Stripe platform setup** as an installation
administrator. Create one Stripe Connect application for the Karmax deployment,
then paste its client ID, platform secret key, and webhook signing secret into the
form. Karmax stores the secret values in its encrypted vault and shows the exact
OAuth callback and webhook URLs to register in Stripe.

The OAuth redirect is:

`https://<karmax-origin>/api/payments/stripe/callback`

Create a Connect webhook endpoint at:

`https://<karmax-origin>/api/payments/stripe/webhook`

Subscribe the webhook to Issuing authorization, card, transaction, and dispute
events plus `account.application.deauthorized`. Direct real-time authorization
requests must be delivered to that endpoint. Karmax refuses to issue an active
Stripe card until the webhook signing secret is saved.

`STRIPE_CLIENT_ID`, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` are retained
only as an optional deployment bootstrap path. UI-managed values take precedence.
The public origin comes from `KARMAX_PUBLIC_URL` or trusted forwarded headers.

Every organization then uses its own Connect button. Its connected account and
Issuing balance remain separate; Local test funds remain the non-money-moving
development rail.

Stripe requires every Issuing card to reference a Cardholder. This is a real
Stripe compliance record for the individual or company legally authorized to use
the card, not a cosmetic Karmax label or a funding source. Use accurate identity
and billing details; Stripe may place verification requirements on the record.

Karmax's agent checkout flow retrieves virtual-card PAN/CVC through Stripe's
explicit `expand[]=number&expand[]=cvc` API and immediately types them into the
origin-checked browser page without persisting or returning them. That makes the
deployment part of the card-data path. Operators offering cards to customers
must complete the applicable PCI-DSS service-provider work with Stripe; use
Issuing Elements instead when the goal is only to display card details to a human.

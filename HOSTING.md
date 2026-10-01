# Hosting krmax

`deploy/README.md` is the operator runbook — DNS, backups, upgrades. This page
is the *why*: which configuration belongs to the operator, which belongs to a
tenant, and what the hosted profile enforces on your behalf.

For the deployment topologies themselves, see `deploy/compose.turnkey.yml`
(one VPS) and `deploy/compose.hosted.yml` (managed Temporal + S3).

## The configuration boundary

- **Operator config** — set **once** by whoever runs the deployment.
  Infrastructure roots (vault master key, database, network) belong in
  deployment secrets, delivered as `NAME_FILE` paths and hydrated by
  `hydrateSecretFiles()` before any subsystem reads `process.env`.
- **Per-tenant config** — differs per organization. These live in the DB and the
  encrypted vault keyed by `organizationId`, never in process env, or one
  tenant's setting becomes everyone's.

Operator variables can also be written once to **`$KARMAX_HOME/karmax.env`**
(`hydrateEnvFile()`, same file format as `node --env-file`; the real environment
always wins). A managed cell gets its variables from compose and a secret
manager, but a self-host is booted by hand with a bare `npm start` — without that
file an operator setting lives only as long as the shell that exported it, and
"configured" quietly means "until the next reboot".

| Env var | Bucket | Notes |
|---|---|---|
| `KARMAX_HOME`, `KARMAX_HOST`, `KARMAX_PORT`, `KARMAX_PUBLIC_URL`, `KARMAX_PREVIEW_ORIGIN` | operator | Infrastructure and origins. |
| `KARMAX_AUTH_SECRET`, `KARMAX_VAULT_KEY`, `KARMAX_WORLD_REF_KEY` | operator | Stable keys. Hosted startup refuses to boot without all three at ≥ 32 chars. New sandbox references are sealed with the vault's `world-reference:key:v2` (`WorldReferenceKeys`); `KARMAX_WORLD_REF_KEY` still opens references sealed before it. |
| `KARMAX_DATABASE_URL`, `KARMAX_TEMPORAL_*`, `KARMAX_OBJECT_STORE`, `KARMAX_S3_*` | operator | Durability. Hosted requires PostgreSQL and a real Temporal address; managed cells require S3. |
| `KARMAX_MANAGED_STORAGE_QUOTA_BYTES` | operator | Private installations only: a managed-storage cap per organization (unset or `0` means none). Hosted managed storage follows each organization's plan and storage packs (`HOSTED_PLANS`, `STORAGE_PACK` in `src/domain/entitlements.ts`). |
| `KARMAX_MANAGED_MODEL_REQUEST_CEILINGS` | operator | Optional JSON map of `provider/model` (or `provider/*`) to a conservative per-request micro-dollar ceiling. Empty means BYOK-only. It authorizes bounded admission, not provider credits. |
| `KARMAX_MANAGED_MODEL_PRICING` | operator | Optional JSON map using the same keys and `{inputMicrosPerMillionTokens, outputMicrosPerMillionTokens, cacheReadMicrosPerMillionTokens, cacheWriteMicrosPerMillionTokens}`. Complete provider-reported counters become incurred cost; otherwise the request ceiling is retained and shown explicitly as an estimate. |
| `KARMAX_OIDC_*` | operator | Optional enterprise SSO (PKCE and issuer validation enforced). Register `https://<your-karmax-origin>/api/auth/callback/enterprise` as the redirect URI at the IdP (before the better-auth 1.7 upgrade it was `/api/auth/oauth2/callback/enterprise`). |
| `KARMAX_GOOGLE_CLIENT_ID`, `KARMAX_GOOGLE_CLIENT_SECRET` | operator | Optional "Continue with Google". Separate from `KARMAX_OIDC_*` deliberately: that slot holds exactly one provider, so an install pointed at its company IdP would otherwise have to choose between the two. Set both or neither — the button appears only when both are non-empty. Register `https://<your-karmax-origin>/api/auth/callback/google` as the authorized redirect URI in the Google Cloud console; Better Auth serves that path itself, so it must match `KARMAX_PUBLIC_URL` exactly. Only the default `openid`/`email`/`profile` scopes are requested and no refresh token is asked for: karmax wants an identity, not access to the user's Google data, and an unused refresh token is only a long-lived secret to leak. A Google login on an address that already has a **verified** email+password account links into it rather than creating a duplicate; on an *unverified* one it is refused (the sign-in card explains why), because karmax's signup never proved that account owns the address. Read the comment in `src/auth/identity.ts` before relaxing either half of that. |
| `KARMAX_MAX_WFT` / `_ACT` / `_CACHED_WORKFLOWS`, `KARMAX_AGENT_*` | operator | Worker and host-admission capacity. |
| `KARMAX_CONTAINER_IMAGE`, `KARMAX_AGENT_PROVIDER`, `KARMAX_*_MODEL`, `KARMAX_*_BASE_URL` | operator default | Platform defaults; already overridable per-tenant via profiles. |
| `KARMAX_TOKEN`, `CLAUDE_CONFIG_DIR` | runtime | Not config — injected per agent spawn. |
| `STRIPE_CLIENT_ID`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | optional bootstrap | Normally entered under **Organization settings → Payments**; UI values take precedence. They identify the deployment's Connect app, never a funding source. |
| `KARMAX_PASSWORD` | **local only** | Rejected outright in hosted mode — the gateway returns 503 and requires the identity service. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (+ ambient `~/.claude`) | **local only** | See below. |

## What the hosted profile already enforces

`KARMAX_DEPLOYMENT=hosted` (set in both compose files) is not a hint — it is a
fail-closed switch. `validateDeployment()` in `src/config/deployment.ts` refuses
to boot unless the public and preview origins are **separate** HTTPS origins,
the stable keys exist, the application database is PostgreSQL, Temporal is durable, and the object store fits the
profile. On top of that:

- **SQLite is imported once, never mutated or deleted.** The first PostgreSQL
  boot takes a database-wide advisory lock, creates the current schema, imports
  both `state/karmax.db` and `state/auth.db` in transactions, validates every
  table count, advances generated sequences, and records durable markers. A
  validation failure rolls back and aborts startup. The old files remain an
  operator-controlled rollback artifact; later boots skip the import.

- **Host-machine affordances are withdrawn, not hidden.** `hostLocal()` returns
  false, so importing from the host's `pass` store, typing a host filesystem
  path, and materializing a local checkout are refused *by the gateway*. The UI
  hides them too (via `/api/meta`), but that is cosmetic — the server is the gate.
- **Repository code never runs on the control plane.** Hosted projects cannot
  select worktree, memory, or Docker worlds; execution is forced onto E2B or
  Daytona.
- **Previews are isolated per lease.** Each gets an opaque
  `p-<digest>.<preview-domain>` origin behind an HttpOnly, lease-scoped cookie,
  and Caddy asks karmax (`/api/tls/preview-allow`) before obtaining a
  certificate — so the catch-all cannot be used to mint certs for arbitrary names.
- **Tenancy is enforced in the store, not the UI.** Projects, repositories,
  vault items, config homes, executions, preview leases and usage all carry
  `organizationId`, and the caller's token — not a query parameter — is
  authoritative for scope.

### Agent credentials cannot leak between tenants

An earlier version of this page called the `process.env` credential fallback the
one genuine multi-tenancy hazard, and proposed a `KARMAX_MULTI_TENANT` flag to
close it. No flag is needed; it is already closed, twice over:

1. `src/activities/core.ts` refuses a turn for any organization other than the
   installation's own `org_personal` unless that org has a connected login or
   API-key handle, failing with *"connect an organization login or API key"*.
   Every self-signup lands in a freshly minted `org_<id>`, so this covers all of
   them.
2. The shipped compose files pass **no** `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
   into the app container, and the image has no `~/.claude` login — so there is
   nothing to fall back *to*.

The fallback therefore survives only where it is wanted: a local single-user
install, where the operator's ambient login is the whole point.

### Diagnosing credential incidents

Settings → Codex/Claude (Availability & quota) distinguishes a timed quota
exhaustion from a credential that needs attention. For the latest automatic quarantine it retains only a
secret-safe provider diagnostic (kind, native code, HTTP status, request id,
model, operation, retry disposition/count, and bounded message), plus the
originating task/activity and timestamp. Raw provider envelopes are never
persisted because they can contain OAuth tokens and Authorization headers. The
task's `resolve.auto` event carries the same whitelist, and the account
coordinator logs the state transition.

Codex remote worlds receive the organization's current ID/access tokens plus a
fixed, non-secret `karmax-host-managed-refresh` marker; the rotating refresh token
stays in the canonical control-plane home. The marker is required because current
Codex treats refresh-token presence as its login-state flag: deleting the field
makes it discard an otherwise-valid access token and call Responses without a
bearer header. The marker cannot refresh OAuth and remote auth is never imported
back into the canonical home.
Usage probes (Insights, Settings) read quota with the current token first and rotate OAuth
only when that authenticated read fails; a usage refresh must never rotate
credentials out from under live remote turns. Current Codex also treats that
projection as logged out when its short-lived ID token expires, even while the
access token is still valid. Before each remote process Karmax checks the ID-token
expiry locally (no provider request) and, inside a ten-minute safety window,
serializes one refresh through the canonical host authority before projection.
If a long-running projection nevertheless receives a terminal
expired/unauthorized response — including `codexErrorInfo=other` with an HTTP 401
"Missing bearer or basic authentication" message — Karmax extracts the safe HTTP
status/request id, performs one bounded forced refresh, re-projects the result,
and resumes the same thread. The raw error envelope and tokens are never retained.
Explicitly invalid/revoked credentials and wrong scopes still quarantine the
login for a human.

An app-server `error` notification with `willRetry=true` is not a task failure.
Messages such as `Reconnecting... 2/5` are retained as safe task activity with
their native error enum, HTTP status, and attempt count, while Codex continues
its own retry loop. Only `willRetry=false`, a failed `turn/completed`, or a
process/transport close can terminate the Karmax turn; this prevents an
intermediate reconnect from poisoning the shared credential pool.

The Diagnostics panel also shows the current runtime incarnation. Every start
and graceful stop is written to the durable audit log as `runtime.started` and
`runtime.stopped`; a surviving active marker becomes
`runtime.previous-unclean` on the next boot. This makes a redeploy, crash, or
SIGKILL visible after the old container and its stdout logs are gone. Correlate
that timestamp with the task's source activity and native provider request id
before attributing a failure to quota, billing, authentication, or a restart.

## Edge rate limiting

Registration is open to the internet, so the edge bounds a stranger's cost
before traffic reaches the app. `deploy/Caddyfile` defines three zones, all
keyed on the client address (Caddy terminates TLS, so that is the real peer and
not a header anyone can set):

| Zone | Paths | Budget per IP |
|---|---|---|
| `signup` | `/api/signup`, `/api/setup` | 10 / hour |
| `auth` | `/api/login`, `/api/auth/*`, `/api/invitations/accept` | 30 / minute |
| `api` | everything else | 600 / minute |

The `signup` and `auth` zones are load-bearing rather than belt-and-braces:
karmax's own `/api/signup`, `/api/setup` and `/api/login` call Better Auth's
**server** API directly, which bypasses Better Auth's built-in limiter — that
runs only inside its HTTP router, which those routes never enter. Without the
edge they are unmetered.

Zones are independent: exhausting the signup budget does not affect the rest of
the site. Preview origins are deliberately unmetered — they serve someone's
running app behind a lease, and a shared control-plane budget would throttle
legitimate traffic.

`rate_limit` is a third-party module, so the edge is built from
`deploy/Caddy.Dockerfile` rather than pulled from the stock image; Caddy refuses
to start on a directive it does not recognise, which makes a mismatch loud
instead of silent. `tests/deploy-edge.test.ts` guards the zone coverage, and CI
validates the Caddyfile against the built image.

## The remaining decision: open registration

Once the first administrator exists, `/api/signup` is reachable by anyone who
finds the URL, and each signup provisions its own personal-workspace
organization. That is intentional for a public SaaS. Two consequences worth
knowing:

- **Compute and managed project storage are bounded.** A new tenant has no agent
  credential and no cloud-world provider, so they cannot spend your model tokens
  or boot a sandbox — every turn fails closed. Versioned project data, review
  artifacts and checkpoints are admitted against the organization's plan quota
  (Free 5 GiB) using physical encrypted-byte accounting. Wiki/metadata growth
  remains small-row database traffic and should still be covered by deployment
  disk monitoring and abuse controls.
- **Platform-funded model use is opt-in, never a balance.** A hosted organization
  cannot use an installation model credential until an owner sets a monthly
  managed-spend cap and explicitly enables that model provider, and the operator
  has configured a worst-case request debit for that model. The cap is a hard
  admission guard over incurred/estimated ledger cost plus active reservations;
  reservations are never displayed as incurred provider cost. The cap is not presented as OpenAI,
  Anthropic, E2B, or transferable "credits". Organization API keys and subscription
  logins remain BYOK and are reported separately from managed usage.
- **Email addresses are unverified.** `emailVerification.sendOnSignUp` is on, but
  `requireEmailVerification` is not set, so an account is usable immediately and
  the address may be junk. Turning it on is a one-line change in
  `src/auth/identity.ts`, with one catch: the mailer is injected *after* the
  Better Auth instance is constructed (so a provider connected later in Settings
  works without a restart), so it must be a lazy getter rather than a static
  boolean — otherwise it reads `undefined` at boot and never requires anything.
  Do not enable it before outbound email is configured, or nobody can sign in.

To run invite-only instead, gate `/api/signup` behind the existing
organization-invitation flow, which is already token-hash validated.

## Git handoff storage

The trusted Git broker transfers bundles incrementally against commits verified
in the receiving repository. Already-present tips need no bundle. Bootstrap and
genuinely large new content use 4 MiB file-transfer chunks; the worker does not
load an entire bundle into memory. Git itself still needs temporary disk space
and memory to clone, pack, and import repository objects. Credentials stay on
the trusted host.

There is no default 256 MiB bundle ceiling. Operators may set
`KARMAX_MAX_GIT_BUNDLE_MB` to a positive number to impose a per-transfer size
limit; it is checked before reading bundle payloads. This is separate from
managed project-resource storage quotas and remote Git hosting limits. Temporary
clones and bundle files still require sufficient worker and sandbox disk space.

## Managed storage and customer-owned S3

The deployment object store remains the control-plane default: portable world
checkpoints, promoted artifacts, and organizations that need no special setup use
operator storage. Versioned project resources can instead select an
organization-owned S3-compatible location under **Organization settings →
Projects → Data storage**. The bucket configuration is safe metadata; access keys live only in
the encrypted credential broker. A connection must pass a write/read/delete
probe before it can become the organization default.

Review `open` actions for local files automatically save their current bytes in
the deployment object store before the attachment is acknowledged. They retain
the 100 MiB per-file limit and count toward the organization's managed-storage
quota. The original authenticated task links continue working after workspace
cleanup, including for uncommitted screenshots and reports. Reattaching a file
captures its new contents; editing the workspace alone does not change an
already saved attachment. External URLs and `run` actions still depend on their
original destination or a running world.

Before destroying a workspace, Karmax saves any older Review attachments that
have no durable copy; a failed upload prevents cleanup. Tasks whose workspaces
were already removed before this feature require recovery from another copy
of the files (for example, their landed Git commit).

Storage placement is pinned on every immutable resource revision. Changing the
default affects only new revisions; old revisions continue restoring from their
original bucket. Chunk names include the customer-location identity, preserving
tenant-local deduplication without confusing copies held in two buckets.

Use a dedicated bucket policy restricted to the configured prefix. Customer S3
is billed by the customer and therefore has no krmax managed-storage ceiling.
This is for large *versioned* data. A live bucket, database, or API should instead
be configured as a project Service so tasks access it directly and krmax stores
no snapshot copy.

## Hosted SaaS subscription billing

Subscription billing is enabled only when `KARMAX_DEPLOYMENT=hosted`. Private and
self-hosted installations remain unmetered and do not contact the subscription
provider. This billing domain pays for krmax.io itself; it is deliberately
separate from the customer-owned cards that agents use under **Passwords &
payments** and from the optional Stripe Issuing Connect application below.

Create recurring monthly USD prices in the platform's Stripe Billing account:

| Plan component | Amount |
|---|---:|
| Individual | $9 / month |
| Team base (includes first active user) | $19 / month |
| Team additional active user | $5 / month |

Open **Installation settings → Paid launch** and follow the guided setup. Price
and optional product IDs are persisted installation configuration; the Stripe
secret key and webhook signing secret are stored in the encrypted vault. No
subscription-billing environment variables are required. Enterprise is
intentionally absent from self-service checkout. Register the distinct webhook
endpoint shown on that page (normally):

`https://<krmax-origin>/api/subscriptions/webhook`

Subscribe it to `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`invoice.paid`, and `invoice.payment_failed`. The gateway verifies Stripe's raw
payload signature before parsing it. Checkout and API responses never grant a
plan: the signed subscription event's configured price IDs are the only source
of billed plan and seat state. Reconciliation writes effective access through
the central organization-entitlement Store boundary. Duplicate event IDs and
user retries are durably idempotent. Only an interactive organization owner can
start checkout, open the portal, change or cancel a plan, or request a seat sync;
an agent holding `payment:write` cannot administer the SaaS subscription.

The canonical checkout seam is
`POST /api/organizations/:organizationId/subscription/checkout`, backed by
`SubscriptionBillingService.checkout`. Its response includes the server-derived
plan and commercial snapshot, the durable local idempotency/request reference,
and the provider checkout-session reference. Policy acceptance is deliberately
not owned by billing; callers that require it can wrap this owner-only seam and
persist their versioned acceptance record alongside the returned commercial
snapshot without trusting prices submitted by the browser.

Webhook reconciliation persists both the provider timestamp and a deterministic
same-second precedence. Signed subscription snapshots outrank invoice summaries,
terminal deletion/cancellation is sticky, and `invoice.paid` outranks an
equal-time `invoice.payment_failed`; a strictly newer event can still recover or
start a replacement subscription. Organization deletion is refused whenever a
mapped provider subscription is nonterminal—even if effective access is Free.
Only signed `canceled`/deleted or `incomplete_expired` state is terminal; an
account with no associated provider subscription is also safe to remove.

Active and trialing subscriptions grant the verified plan. Past-due
organizations retain it for seven days and receive a billing portal recovery
action. A process-level sweep runs every minute and returns the organization to
Free after that grace deadline even when Stripe sends no later webhook.
Canceled/deleted, unpaid, paused, incomplete, and expired subscriptions also
return to Free. Existing members are not deleted when a downgrade leaves an
organization over its member limit; the entitlement layer restricts new
admission until the owner upgrades or reduces membership.

For local test-mode setup, use Stripe test keys and forward events with the
Stripe CLI:

```bash
stripe listen --forward-to localhost:4505/api/subscriptions/webhook
```

Copy the CLI's `whsec_...` value into Installation settings → Paid launch, use
test-mode price IDs there, and start with `KARMAX_DEPLOYMENT=hosted`. The
automated suite does not use the CLI,
network, or paid calls: `FakeSubscriptionProvider` drives signed-event-equivalent
fixtures against an in-memory database.

## Organization usage admission

Organization settings exposes current-month incurred cost, explicitly estimated
cost, active reservations, and provider-reported token or request quantities,
split into managed and BYOK funding, plus active model turns,
remote worlds, and commands. Provider/model allowlists, per-minute model and
sandbox start limits, and concurrent turn/world limits are enforced immediately
before the trusted provider boundary. Hosted concurrency defaults to the central
Free/Individual/Team entitlement (5/10/20 shared active agent runs, with Team
adding 5 for every active user after the first); the usage policy can only
supply an owner-selected tighter cap. Admission rows use the durable agent-turn
id, and provider lifecycle rows use provider execution ids, so activity retries
and reconciliation/webhook duplication cannot reserve or count the same work
twice.

Remote E2B and Daytona launch remains organization BYOK. Runner pools control
capacity; they do not confer provider balance. The organization API refuses a
centrally funded remote pool, and the execution boundary rejects legacy managed
remote pools on hosted deployments. Centrally resold E2B would require a separate
installation authorization and billing boundary that this deployment does not
implement.

The hosted worker's default activity envelope is deliberately high (1,000), so
the generic Temporal pool does not silently replace these per-organization
entitlements with the private-install default of 8. Operators may set
`KARMAX_MAX_ACT` as an explicit fleet-capacity guard and scale workers when
aggregate tenant demand approaches it.

The hosted sticky workflow cache defaults to 250 (private installs: 20). A query
or task for a workflow outside the cache replays its whole history, and the
console and every running turn query their task's workflow. Raise
`KARMAX_MAX_CACHED_WORKFLOWS` when a cell keeps more tasks open, as long as the
worker's heap has room for their conversations.

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

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

| Env var | Bucket | Notes |
|---|---|---|
| `KARMAX_HOME`, `KARMAX_HOST`, `KARMAX_PORT`, `KARMAX_PUBLIC_URL`, `KARMAX_PREVIEW_ORIGIN` | operator | Infrastructure and origins. |
| `KARMAX_AUTH_SECRET`, `KARMAX_VAULT_KEY`, `KARMAX_WORLD_REF_KEY` | operator | Stable keys. Hosted startup refuses to boot without all three at ≥ 32 chars. |
| `KARMAX_TEMPORAL_*`, `KARMAX_OBJECT_STORE`, `KARMAX_S3_*` | operator | Durability. Hosted requires a real Temporal address; managed multi-node requires S3. |
| `KARMAX_OIDC_*` | operator | Optional enterprise SSO (PKCE and issuer validation enforced). |
| `KARMAX_MAX_WFT` / `_ACT` / `_CACHED_WORKFLOWS`, `KARMAX_AGENT_*` | operator | Worker and host-admission capacity. |
| `KARMAX_CONTAINER_IMAGE`, `KARMAX_AGENT_PROVIDER`, `KARMAX_*_MODEL`, `KARMAX_*_BASE_URL` | operator default | Platform defaults; already overridable per-tenant via profiles. |
| `KARMAX_SAFE_MODE` | operator | Also a UI toggle. |
| `KARMAX_TOKEN`, `CLAUDE_CONFIG_DIR` | runtime | Not config — injected per agent spawn. |
| `STRIPE_CLIENT_ID`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | optional bootstrap | Normally entered under **Organization settings → Payments**; UI values take precedence. They identify the deployment's Connect app, never a funding source. |
| `KARMAX_PASSWORD` | **local only** | Rejected outright in hosted mode — the gateway returns 503 and requires the identity service. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` (+ ambient `~/.claude`) | **local only** | See below. |

## What the hosted profile already enforces

`KARMAX_DEPLOYMENT=hosted` (set in both compose files) is not a hint — it is a
fail-closed switch. `validateDeployment()` in `src/config/deployment.ts` refuses
to boot unless the public and preview origins are **separate** HTTPS origins,
the stable keys exist, Temporal is durable, and the object store fits the
profile. On top of that:

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

- **Cost is bounded; storage is not.** A new tenant has no agent credential and
  no cloud-world provider, so they cannot spend your model tokens or boot a
  sandbox — every turn fails closed. They *can* create projects, tasks, wiki
  pages and attachments, which the `signup` zone bounds but does not eliminate.
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

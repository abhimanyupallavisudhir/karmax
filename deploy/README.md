# Host Karmax

Karmax keeps its trusted control plane on the VPS and runs repository code,
agents, terminals, tests, and previews in isolated E2B or Daytona worlds. The
normal self-hosted installation needs only Docker, a domain, and two DNS records.

## Hosted subscription billing with Paddle

Hosted operators can select **Paddle** in **Installation → Paid-launch setup**.
This is separate from the cards agents use to buy services. Private/self-hosted
installations remain unmetered. Existing Stripe subscriptions retain their
provider and webhook route; changing the default does not migrate customers.

1. Create a Paddle Billing account and complete its website, identity and payout
   checks. A UK individual can onboard as a sole trader; incorporation is not an
   application requirement. Publish the actual operator and reviewed policies.
2. Save a same-environment Paddle API key, then choose **Set up Paddle
   automatically** (or POST `/api/settings/paid-launch/paddle/provision` with
   installation authority). Setup discovers/reuses the two products, three USD
   monthly prices, browser token and signed notification destination. It does
   not enable paid checkout or approve legal terms. The setup key needs read/write
   product, price, client-token and notification-setting permissions. Runtime
   needs transaction and subscription read/write; keep keys in the vault and
   arrange rotation before their expiry.
3. In Paddle's Checkout settings, save the default payment link as
   `https://YOUR_DOMAIN/billing/checkout`. Live domains require Paddle approval.
   Sandbox accepts test domains. This setting is required even when transactions
   supply their own checkout URL.
4. Verify checkout, signed events, seats, plan changes, portal, failed-payment
   recovery and cancellation in a separate sandbox installation. Never switch
   an installation with Paddle billing records between sandbox and live.
5. Review the exact policy version and enable paid launch only after live
   verification. Setup never checks off the founder's review on their behalf.

New Paddle checkout uses server-created transactions; only signed subscription
events grant access. `/api/subscriptions/paddle/checkout-config` exposes the
public browser token, never the API key or signing secret. The Paddle webhook is
`/api/subscriptions/paddle/webhook`; the original `/api/subscriptions/webhook`
continues handling Stripe. Sandbox notification simulators must never be sent
to an installation handling live entitlements.

An unchanged pending checkout is reused. Changing its commercial terms cancels
the previous unpaid link before creating a replacement. Owners can also cancel
an abandoned checkout from Plan & billing before deleting the organization.
Paddle writes are serialized locally: network/5xx uncertainty retains a durable
reservation, not an automatic retry. **Check pending billing request** (POST
`/api/organizations/:id/subscription/reconcile`, owner authority) performs only
provider reads after a one-minute settling period. It releases the reservation
only when the result can be proven. If still uncertain, the operator must inspect
Paddle and the retained request before resolving it; do not blindly delete locks
or replay financial requests. Entitlements still wait for signed events.

The legacy `KARMAX_SUBSCRIPTION_PROVIDER=paddle` and
`KARMAX_SUBSCRIPTION_PADDLE_*` environment settings remain a bootstrap option;
the normal setup uses encrypted installation settings and needs no `.env` edits.

## Turnkey VPS installation

On an Ubuntu/Debian VPS (including one.com), install Docker Engine with its
Compose plugin, clone Karmax, and run:

```bash
./deploy/karmax up karmax.example.com
```

That single command generates stable keys, validates the configuration, builds
Karmax, and starts PostgreSQL, Temporal, the Karmax app/worker, and Caddy. The
same PostgreSQL service holds separate `karmax`, `temporal`, and
`temporal_visibility` databases. It
waits for the complete stack to become healthy. No `.env` editing, certificate
generation, GitHub App creation, or provider key files are required.

Before or after running it, point these records at the VPS:

```text
A/AAAA  karmax.example.com
A/AAAA  *.preview.karmax.example.com
```

Ports 80 and 443 must be reachable. Caddy automatically obtains the app
certificate. Preview certificates are issued on demand only for an active,
opaque lease hostname approved by Karmax; there is no wildcard private key to
manage. You can choose another preview base as the second argument:

```bash
./deploy/karmax up karmax.example.com previews.example.net
```

Running `up` with a different application domain records the previous domain as
`KARMAX_LEGACY_DOMAIN`. Caddy keeps the old apex and `www` host on HTTPS and
permanently redirects them to the new canonical origin. Keep both domains'
DNS records pointed at the VPS. Also update exact callback URLs registered with
Google, GitHub, or an OIDC provider before relying on sign-in at the new origin.
Users must sign in again because browser cookies do not cross domains. The old
`/api/github/webhook` endpoint remains proxied (not redirected) so deliveries
continue while the GitHub App's webhook URL is being updated.

To activate a domain change with the next reviewed, CI-validated release, set
`KARMAX_PENDING_DOMAIN` and `KARMAX_PENDING_PREVIEW_DOMAIN` in `.turnkey.env`.
`update` consumes them and records the old domain; existing running containers
are unchanged until the release starts. Failed deployments restore the old
environment. An interrupted update retains `.turnkey.env.migration.*` for
operator recovery; inspect container/source state before retrying.

The human-facing name is independent of the domain: use **Installation →
Appearance → Site identity**, or authenticated `PUT /api/settings/installation`
with `{"siteName":"tavya"}` (`settings:write`). `GET` requires `settings:read`;
the public `/api/meta` includes the effective `siteName`. This does not rename
real projects, repositories, environment variables, or stored identifiers.

Open the URL, create the first administrator, then use **Organization settings**
to:

1. Connect E2B or Daytona (the key is write-only and encrypted in Karmax's
   vault). Test, rotate, disable, or remove the connection in the same screen.
2. Add capacity under Runner pools. The default pool parks worlds automatically
   whenever a workflow waits for a person and hibernates old parked worlds.
3. Choose **Set up GitHub**. GitHub's App Manifest flow creates the App and sends
   Karmax its generated credentials; install it for the desired repositories.
4. Add an existing repository or create a new private GitHub repository from
   Karmax. Git transport remains SSH. Sandboxes get clone-only deploy keys;
   writes are performed by Karmax's trusted Git broker.
5. Add an Anthropic/OpenAI API key under agent credentials if the deployment
   does not use another connected login.
6. In Payments, register a card. The default rail takes a virtual card the user
   already holds: create one with a spending limit in your own banking app and
   paste it in — no signup, no Stripe account, works in any country. The issuer
   enforces the limit and declines when it runs out. Organizations that are
   registered businesses can instead connect Stripe Issuing (see `HOSTING.md`)
   to have Karmax mint capped, merchant-locked cards per agent or per task.

### Optional social sign-in

Social sign-in belongs to the *installation*, not to a tenant. Google is an
operator-provided client; GitHub reuses the deployment GitHub App.

For Google, create a **Web application** client in the
[Google Cloud console](https://console.cloud.google.com/auth/clients) whose
authorized redirect URI is exactly

```text
https://karmax.example.com/api/auth/callback/google
```

Better Auth serves that path itself, so the host must match the domain you
deployed on. Then add the pair to `deploy/.turnkey.env` and restart:

```bash
KARMAX_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
KARMAX_GOOGLE_CLIENT_SECRET=GOCSPX-...
```

Only the basic `openid`/`email`/`profile` scopes are requested, which is why the
consent screen can be published without Google's verification review. Set both
or neither — the button appears only when both are non-empty.

GitHub sign-in needs no second OAuth App. The deployment-wide GitHub App created
from **Organization settings → Git & GitHub** supplies its OAuth client and both
callback URLs. On the next Karmax start, **Continue with GitHub** is enabled and
the same user grant becomes that person's GitHub development identity. Installing
the App on repositories remains a separate organization-owner action.

`KARMAX_GITHUB_OAUTH_CLIENT_ID` and `KARMAX_GITHUB_OAUTH_CLIENT_SECRET` remain a
legacy fallback for installations that have not configured the GitHub App. When
the shared App is configured, its vaulted credentials take precedence.

Apps created by an older Karmax release need a one-time edit in GitHub App
settings: add `https://karmax.example.com/api/auth/callback/github` as a callback
URL and apply the permission envelope shown under **Installation → GitHub**.
Karmax uses a broad repository-scoped App grant for transport, CI, review,
landing, deployment, and repository automation; Karmax capabilities remain the
per-agent authorization boundary. After the App owner changes the registration,
every existing installation owner must approve the added permissions. GitHub
does not expose registration settings through its App API, so Karmax links to
both approval pages and verifies every permission at both layers.

`KARMAX_OIDC_*` (enterprise SSO) is another separate slot, so an installation
can offer Google, GitHub, and company SSO together. Every provider button appears
only when its full credential pair is non-empty.

That same HTTPS URL works from a phone—no VPN and no Karmax-specific native app
are required. **Organization settings → Phone Access** offers an
**Add Karmax to this phone** action; the browser installs the responsive web app
to the Home Screen. Tailscale is for reaching a Karmax process that lives on a
private laptop or workstation, not for this hosted stack.

All of those operations have authenticated HTTP APIs. Provider discovery,
connection, testing, rotation, and removal also have permission-checked platform
MCP tools, so an authorized agent can connect E2B or Daytona without shell
access.

## Local development with a hosted control plane

A hosted installation does not clone repositories onto its own filesystem.
When a remote task reaches human review, choose **Work locally** in the task.
Karmax gives you secret-free SSH commands that clone the exact task branch to
your laptop. Commit and push normally, then choose **Refresh cloud world from
GitHub**. The trusted broker fast-forwards the parked world and parks it again.
It refuses imports while an agent, terminal, or review process is active, and it
never copies GitHub credentials into a sandbox.

This same execution surface powers hosted terminals, commands, previews, and
forked agent conversations. They wake the task's logical world on demand and
release their execution lease when finished.

## Operations

```bash
./deploy/karmax doctor              # Compose, secrets, containers, DNS/HTTPS
./deploy/karmax status
./deploy/karmax logs                # or: logs temporal
./deploy/karmax backup              # deploy/backups/<UTC timestamp>
./deploy/karmax update              # backup, validate commit ancestry, rebuild
./deploy/karmax down                # preserves all volumes and certificates
./deploy/karmax restore BACKUP_DIR  # verified, explicit destructive prompt
```

A backup includes PostgreSQL dumps of Karmax metadata, identity, and Temporal,
plus a consistent online snapshot of the encrypted credential vault,
attachments, local object/checkpoint data, and stable decryption/signing keys.
Task VMs are deliberately excluded: Git plus encrypted portable checkpoints are
their durable form. Copy backups to encrypted off-host storage. Anyone holding a
backup can recover the vault, so protect it like production credentials.

On Linux hosts with the util-linux `hardlink` command, completed backups share
identical large object-store files automatically. This preserves every restore
point and its verified bytes while avoiding a full physical copy of unchanged
checkpoints on every deployment. To compact existing backups, run
`sh deploy/compact-backups.sh`. Treat completed backup directories as immutable;
copy files out before editing them. The live data volume is never linked to a
backup. The release workflow also retains its existing 14-day age limit.

`restore` verifies the control-plane payload, PostgreSQL dumps, and deployment
secrets before stopping the running instance or changing data. It restores the
Karmax and Temporal databases, reapplies the current Temporal schema, and retains the
destination's domain. It requires typing `RESTORE` and will not delete Docker
volumes as part of ordinary `down` or `update` operations.

### Rollback compatibility

`deploy/data-epoch` marks compatibility for automatic code-only rollback. Builds
without a marker are epoch 1. Epoch 2 separates task conversation storage and
introduces new durable workflow activity histories. If an update crosses epochs
and then fails readiness, the updater stops the app and preserves the candidate
code and current data; it does **not** start the incompatible previous image.
This deliberately trades availability for avoiding a misleading or destructive
rollback. Same-epoch readiness failures retain the existing automatic rollback.
Build and backup failures still leave the previous app running.

Recover a failed epoch transition by repairing forward, or restore the pre-update
backup with its matching application revision **and Temporal history**. Restoring
a snapshot can discard work performed after it was taken. Do not run an older
release against the migrated database or restore only one database. Validate this
procedure on an isolated deployment before the production epoch transition.

## Cost and idle-world behavior

Karmax owns lifecycle policy, not the operator. Workflow waits park provider
compute immediately; provider auto-pause is a safety net. Terminals and previews
hold bounded explicit leases. Parked worlds are checkpointed and later
hibernated to Git/object storage, and runner leases/usage remain visible in the
UI. You do not need a cron job or manual provider cleanup. A failed park remains
tracked and billable in diagnostics instead of being falsely reported as free.

## Managed/enterprise cell

`compose.turnkey.yml` is deliberately a single active control-plane writer with
durable local object storage and an embedded PostgreSQL-backed data/Temporal cluster.
It is the clean choice for one VPS and can serve many users, but its availability
is that VPS plus your backup/restore policy.

Larger installations can use `compose.hosted.yml` with managed PostgreSQL,
managed Temporal, S3, and one active Karmax cell. Copy `.env.example`, provide
the listed infrastructure secrets under `deploy/.secrets` (including a complete
PostgreSQL connection string in `database_url`), and validate with:

```bash
docker compose --env-file deploy/.env.example \
  -f deploy/compose.hosted.yml config
```

Do not scale one cell to multiple app writers yet: workflow worker ownership and
other process-local coordinators still assume one active writer even though the
database is remote. Assign organizations to separate cells for horizontal scale
or residency. Managed provider and GitHub credentials still belong in the
Karmax UI/vault, not Compose.

Health endpoints are `/api/health/live` and `/api/health/ready`; diagnostics and
metrics require the diagnostic capability. Hosted startup fails closed unless
HTTPS origins are separated, stable keys exist, PostgreSQL and Temporal are
durable, and the object-store profile is appropriate. Hosted projects cannot select worktree,
memory, or Docker worlds, so repository code never executes in the control-plane
container.

The Linux deployment runs Caddy on the host network so IPv6 connections retain
real peer addresses. The app publishes port 4505 on host loopback only. Its
Compose bridge gateway is pinned to `172.30.0.1` (subnet `172.30.0.0/24`); only
that host peer may supply Caddy's overwritten, single-address X-Forwarded-For.
Host-local processes are trusted at this boundary. Reserve this subnet on the
host, or change both IPAM and `KARMAX_TRUSTED_PROXY_IP` together if it conflicts.
Never expose port 4505 publicly or trust an entire proxy subnet. Other installs
ignore forwarded headers unless an exact trusted proxy IP is configured. The
gateway groups IPv6 clients by /64 for login lockout and hosted request budgets;
Caddy also enforces its per-address edge budgets. These budgets are per replica.

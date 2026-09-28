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
   The full pre-launch list is [docs/paid-launch-checklist.md](../docs/paid-launch-checklist.md).

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
./deploy/karmax doctor              # Compose, secrets, containers, database role, DNS/HTTPS
./deploy/karmax status
./deploy/karmax logs                # or: logs temporal
./deploy/karmax backup              # deploy/backups/<UTC timestamp>
./deploy/karmax update              # backup, validate commit ancestry, rebuild
./deploy/karmax down                # preserves all volumes and certificates
./deploy/karmax restore BACKUP_DIR  # verified and signature-checked, explicit destructive prompt
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
secrets, then restores every dump into a staging database (`karmax_restore`,
…) beside the live ones; it refuses when PostgreSQL's disk cannot hold even
the dumps, and warns before the prompt when it may not hold the restored
databases, since filling it would stop the live instance. Only when all of
them restored does it stop the
instance, drop the live databases and rename the staged ones into place; a
failure before that leaves the instance as it was. Dumps are restored without
owners or grants, so a new host or an empty PostgreSQL volume works; the next
start hands the karmax database back to the app's role. It reapplies the
current Temporal schema and retains the destination's domain. It requires
typing `RESTORE` and will not delete Docker volumes as part of ordinary `down`
or `update` operations.

Backups are signed: the control-plane manifest (`manifest.sig`) and
`SHA256SUMS` (`SHA256SUMS.sig`), which covers the dumps, the deployment secrets
and the control-plane manifest, so the two signatures vouch for one backup. The
key is an Ed25519 key at the root of the app's data volume
(`/var/lib/karmax/backup-signing.key`), outside everything a backup copies, and
a restore never replaces it. The manifest stays `version: 1`, so the previous
release can still restore a signed backup. `backup` prints the key's
`SHA256:…` fingerprint; record it off-host, since it is what lets another host
trust the backup. A restore on the same host needs nothing more. On a fresh
host, run `./deploy/karmax restore --trust-key SHA256:… DIR` with the recorded
fingerprint. An unsigned backup (taken before signing) is refused unless you
pass `--accept-unsigned-v1` and type `RESTORE UNSIGNED`. Do that only for a
backup you know has stayed in trusted storage. `restore` first copies the
backup into a private directory, refuses symbolic links, and verifies and
restores only that copy (the backup's size again in free disk space). Every
restore, signed or not, is written to the audit log at the next boot
(`backup.restored`, `backup.restored.unsigned`).

### Rollback compatibility

`deploy/data-epoch` marks compatibility for automatic code-only rollback. Builds
without a marker are epoch 1. Epoch 2 separates task conversation storage and
introduces new durable workflow activity histories. Epoch 3 binds every vault
entry to its handle (`v2.` ciphertext, AU-27) and moves each stored card's CVC
into its own entry (AU-31); the previous release cannot read either, so this
migration is one-way. If an update crosses epochs
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

`update` checks the vault read-only with the new image after the pre-update
backup and before switching (`npm run vault-preflight`, with the key the app
itself reads): whether the key would be accepted, which files cannot be read,
and which secrets the first boot would quarantine. Any finding stops the update
with the previous app still serving; `./deploy/karmax update REVISION
--accept-vault-findings` proceeds anyway.

The epoch 3 vault migration moves the previous release's `vault/secrets.json`
into `vault/entries/`, one bound file per secret, and leaves `secrets.json`
empty. It reads everything first; a file it cannot read (permissions, an I/O
error) stops boot with a list and changes nothing. Secrets that do not parse or
authenticate under the vault key are moved to `vault/entries/quarantine/` (kept
30 days) and recorded in the audit log (`vault.entry.quarantined`). The previous
release cannot read the result: **the only way back is the pre-update backup
with its code.** There is no vault-only rollback. If a previous release runs
against the migrated vault anyway, it sees an empty vault and writes new
secrets to `secrets.json`; the next boot of this release then refuses to start
("vault/secrets.json holds N secrets although the vault moved"), so restore the
backup.

"the vault key does not open this vault" says which check failed:
- "vault/vault.canary fails to authenticate": `KARMAX_VAULT_KEY` (or
  `vault/vault.key`) is not the key the vault was created with. Restore it; do
  not delete the canary to get past it.
- "vault/vault.canary is missing or damaged, and the key opens none of the N
  entries": no override applies; this key is not the vault's.
- "... opens M of N entries while vault/vault.key opens K": with no usable
  canary the secrets decide, and secrets no known key opens are not counted.
When the message names `KARMAX_VAULT_ACCEPT_KEY=vk-…` and you are certain the
key is right, set it once: on the turnkey stack, append it to the app's
`/var/lib/karmax/karmax.env` (`./deploy/karmax` has no flag for it; the Compose
environment does not pass it through), restart, then remove it. The vault
preflight reads the same file. Secrets the key cannot open are then
quarantined. A missing or damaged canary alone is not an error.

"vault entry for H is not bound to its handle" means a secret in the
pre-upgrade format sits in a bound vault: a file was copied in from an older
vault or backup. Restore that secret from the backup it belongs to.

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
is that VPS plus your backup/restore policy. The app connects as its own `karmax`
role, which owns the `karmax` database and nothing else; Temporal and the
backup commands keep the `temporal` superuser. On every start the one-shot
`karmax-database` job (`postgres/karmax-role.sh`) re-applies the role, taking
over anything an older release or a restore created as the superuser. It
generates the app's URL once into the `karmax_database` Docker volume, which
only it and the app mount; deleting that volume rotates the app's password at
the next `up`. `./deploy/karmax doctor` reports which role the app is
connected as, and warns if it is the superuser: a `KARMAX_DATABASE_URL` in
the app's `/var/lib/karmax/karmax.env` overrides the role's URL.

Releases before the `karmax` role gave the app the `temporal` superuser
password. After the first update to a release with the role, confirm it with
`./deploy/karmax doctor` (`update` also reports it), then rotate that
password, since the old app process held it:

```bash
./deploy/karmax rotate-postgres-password
```

It changes the password through psql's standard input (never a command line
`ps` would show), rewrites `.turnkey.env`, and recreates PostgreSQL, Temporal
and the setup jobs without rebuilding images: expect a minute of downtime while
they restart; in-flight workflows resume once Temporal is back.

Larger installations can use `compose.hosted.yml` with managed PostgreSQL,
managed Temporal, S3, and one active Karmax cell. Copy `.env.example`, provide
the listed infrastructure secrets under `deploy/.secrets` (including a complete
PostgreSQL connection string in `database_url` for a role that owns its database
but is not a superuser), and validate with:

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

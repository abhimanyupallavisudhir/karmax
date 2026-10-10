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

Previews run other people's apps, so a separately registered domain is safer
than a subdomain of yours: tenants' pages then share no cookies with the
console and cannot get your domain blocklisted. A busy installation should also
use **one wildcard certificate** instead of one per preview (Let's Encrypt
issues 50 a week per registered domain). With the preview domain's DNS on
Cloudflare:

```bash
KARMAX_PREVIEW_TLS=cloudflare        # in .turnkey.env; default on-demand
```

and a Cloudflare API token with **Zone DNS Edit and Zone Read on that zone
only** in `deploy/.secrets/cloudflare_dns_api_token` (empty until then; only
Caddy mounts it). Caddy proves the domain by DNS-01 and renews the certificate
itself. `up`, `update` and `doctor` refuse a wildcard without the token. Point
`*.<preview domain>` at the VPS; the bare preview domain serves nothing.

Moving previews to another domain (`up` with a new second argument, or
`KARMAX_PENDING_PREVIEW_DOMAIN` below) records the old one as
`KARMAX_LEGACY_PREVIEW_DOMAIN`: leases issued under it keep their hostnames,
served on demand as before, until they expire (at most a day, plus a day in
which a stopped preview still explains itself). Delete that line once they have.

### Agent email

Agents receive sign-up codes and links at a per-organization address. With no
mail server: point a mail subdomain's MX at Cloudflare Email Routing, send its
catch-all rule to the Email Worker this deploys, and the Worker posts each
message, signed, to the app:

```bash
CLOUDFLARE_API_TOKEN=… ./deploy/karmax deploy-agent-mail-edge mail.example.net
```

It needs a token with Workers Scripts: Edit, records `KARMAX_AGENT_MAIL_DOMAIN`
and restarts the app. Organizations without their own mail provider then get
`agent-<token>@mail.example.net` (placeholder `@agent.local` addresses move
over, keeping their token); an organization that connected its own AgentMail
inbox keeps it. The Worker stores nothing, rejects mail for any other domain
and anything over 4 MiB, and signs with a key derived from `auth_secret`, so
rotating that secret means running this again. Enabling Email Routing for the
subdomain (MX and SPF records) and the catch-all rule (action: Worker
`tavya-agent-mail`) is done on the zone, in Cloudflare.

Running `up` with a different application domain records the previous domain as
`KARMAX_LEGACY_DOMAIN`. Caddy keeps the old apex and `www` host on HTTPS and
permanently redirects them to the new canonical origin. Keep both domains'
DNS records pointed at the VPS. Also update exact callback URLs registered with
Google, GitHub, or an OIDC provider before relying on sign-in at the new origin.
Users must sign in again because browser cookies do not cross domains. The old
`/api/github/webhook` endpoint remains proxied (not redirected) so deliveries
continue while the GitHub App's webhook URL is being updated.

To activate a domain change with the next reviewed, CI-validated release, set
`KARMAX_PENDING_DOMAIN` and/or `KARMAX_PENDING_PREVIEW_DOMAIN` in `.turnkey.env`.
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
only when its full credential pair is non-empty. Register
`https://karmax.example.com/api/auth/callback/enterprise` as the redirect URI at
your identity provider. Installations set up before the better-auth 1.7 upgrade
registered `/api/auth/oauth2/callback/enterprise`; that path no longer exists, so
update it at the IdP when upgrading.

That same HTTPS URL works from a phone—no VPN and no Karmax-specific native app
are required. **Organization settings → Phone Access** offers an
**Add Karmax to this phone** action; the browser installs the responsive web app
to the Home Screen. Tailscale is for reaching a Karmax process that lives on a
private laptop or workstation, not for this hosted stack.

All of those operations have authenticated HTTP APIs. Provider discovery,
connection, testing, rotation, and removal also have permission-checked platform
MCP tools, so an authorized agent can connect E2B or Daytona without shell
access.

### Object storage on S3 or Cloudflare R2

Checkpoints, resource snapshots and saved review files go to the `karmax_data`
volume unless `.turnkey.env` selects an S3-compatible bucket:

```bash
KARMAX_OBJECT_STORE=s3
KARMAX_S3_ENDPOINT=https://<account-id>.eu.r2.cloudflarestorage.com   # R2, EU jurisdiction
KARMAX_S3_BUCKET=karmax-objects
KARMAX_S3_REGION=auto                                                # R2; an AWS region elsewhere
```

An R2 bucket in the EU jurisdiction answers only on the `.eu.` host; the
default `https://<account-id>.r2.cloudflarestorage.com` returns 403 for it.

Write the key pair to `deploy/.secrets/s3_access_key_id` and
`deploy/.secrets/s3_secret_access_key` (they exist empty until then), then
restart with `./deploy/karmax up`. `./deploy/karmax doctor` names the active
store and, for S3, writes, reads back and deletes a probe object.

Backups copy the local volume but not a bucket, and R2 has no object versioning.
So with S3 a deleted object stays in the bucket for
`KARMAX_OBJECT_DELETE_DELAY_DAYS` (default 30; `0` deletes at once) before the
lifecycle sweep purges it: a restored backup younger than that still finds every
object it references.

`./deploy/karmax migrate-objects` copies the local store into the configured
bucket while the app keeps running. It is resumable (objects already there are
skipped), `--verify-only` checks without writing, `--concurrency N` bounds
parallel transfers, and it never deletes anything. It ends with an inventory of
local objects the database no longer references. To switch, run it once while
serving, stop the app, run it again, then with `--verify-only`, set the
variables above, and start. Keep the local copy until the delay has passed: to
go back, stop the app, copy what was written since with `--from-s3`, unset
`KARMAX_OBJECT_STORE`, and start.

### Memory caps

Every container has a memory cap, a ceiling the kernel enforces on that
container alone: one that reaches it is OOM-killed, not the host. Each is a
line of `.turnkey.env`, and the defaults are the caps of the original 8 GB
server:

| Container | Setting | Default |
| --- | --- | ---: |
| app (gateway and worker) | `KARMAX_APP_MEM_LIMIT` | `4g` |
| postgresql | `KARMAX_POSTGRES_MEM_LIMIT` | `768m` |
| temporal | `KARMAX_TEMPORAL_MEM_LIMIT` | `2g` |
| caddy | `KARMAX_CADDY_MEM_LIMIT` | `512m` |
| pg-backup | `KARMAX_PG_BACKUP_MEM_LIMIT` | `512m` |
| temporal-schema, temporal-namespace (exit after setup) | `KARMAX_TEMPORAL_SCHEMA_MEM_LIMIT`, `KARMAX_TEMPORAL_NAMESPACE_MEM_LIMIT` | `512m` |
| karmax-database (exits after setup) | `KARMAX_DATABASE_ROLE_MEM_LIMIT` | `256m` |

No container has a CPU limit.

Two containers size themselves to their cap:

- **The app.** Every V8 heap's limit comes from the cap
  (`src/runtime/memory-budget.ts`): 15% for the gateway, 30% each for the
  worker's process and its workflow thread, and the last quarter for native
  memory. A hosted cell's sticky workflow cache follows the workflow heap at
  4.9 MiB per workflow: 250 at `4g`, 438 at `7g`. `KARMAX_MAX_CACHED_WORKFLOWS`
  overrides it.
- **PostgreSQL** (`postgres/postgres-memory.sh`). `shared_buffers` is 1/4 of the
  cap, at least 128 MB. `effective_cache_size` is 3/4, because the container's
  page cache counts against the same cap. `work_mem` is what is left after the
  buffers, split over every allowed connection running three sorts at once,
  from 4 MB to 64 MB. `maintenance_work_mem` is 1/16 of the cap, from 64 MB to
  1 GB. `max_connections` is `KARMAX_POSTGRES_MAX_CONNECTIONS`, default 100.
  These are command-line settings, so they win over `ALTER SYSTEM`; change the
  cap instead.

After editing the file, run `./deploy/karmax up`. It recreates only the
containers whose settings changed; PostgreSQL's restart takes Temporal and the
app offline for under a minute. `./deploy/karmax doctor` prints each container's
use against its cap, what the caps leave the host, and PostgreSQL's settings
with its connections in use.

**A 16 GB server** (8 vCPU; tavya.io since 2026-10-10):

```bash
KARMAX_APP_MEM_LIMIT=7g
KARMAX_POSTGRES_MEM_LIMIT=3g
KARMAX_POSTGRES_MAX_CONNECTIONS=150
```

Temporal, Caddy and pg-backup keep their defaults. The long-running caps then
add up to 13 GiB of the 15.6 GiB the kernel reports, leaving 2.6 GiB for the
host itself: the kernel, Docker and the image builds every update runs outside
any container. The setup containers exit before the app starts. Why each number:

- **app `7g`** (from 4g). The app is the container whose OOM kill stops every
  tenant's work, and its heaps and workflow cache grow with its cap: the
  gateway gets 1075 MiB and each worker isolate 2150 MiB, and the cache grows
  from 250 to 438 workflows. On tavya.io the app held 1.1 GiB after a restart.
  In the 2026-10 load test it peaked at 1.6 GiB at 128 tenants, with
  684 running workflows against the cache of 250. Every evicted workflow costs a
  full history replay, which kept workflow tasks queued. 8g would leave the host
  under 2 GiB unless Temporal shrank, and nothing shows the app needs it.
- **postgresql `3g`** (from 768m). The databases hold 1.85 GB (karmax 1.05 GB,
  temporal 0.74 GB, on 2026-10-10). At 768m, with 128 MB of buffers, only a
  fraction of that fit in memory. At 3g the buffers are 768 MB and the cache
  2.3 GB, so the working set fits with room to grow. It used 362 MB of 768m at
  128 tenants with stock settings.
- **max_connections `150`** (from 100). Temporal keeps about 53 connections
  open, idle or not. The app's pools can reach 34: 8 for each of the two
  processes' stores, plus identity's 8-connection store and 10-connection pool.
  Backups and operators add a few. That is about 90 of 100 at the peak, and the
  load test reached 67. The extra 50 slots cost about a megabyte of shared
  memory, and they leave room to raise `KARMAX_STORE_POOL_SIZE`. `work_mem`
  falls from 7 to 5 MB, which matters little: the busiest statements take
  under a millisecond and sort almost nothing.
- **temporal `2g`** (unchanged). It used 129 MB after a restart and 260 MB at
  128 tenants. Its caches are sized by its dynamic configuration, not by the
  memory it is given, so a larger cap would go unused.
- **caddy and pg-backup `512m`** (unchanged). Caddy peaked at 134 MB with
  384 open sockets; a WAL-G base backup streams.

The worker's workflow-task slots follow the cores, not memory. A hosted cell
takes two per core, from 8 up to 16 (`KARMAX_MAX_WFT` overrides; 16 on 8 vCPUs).
They all share the SDK's one workflow thread, so slots don't add workflow CPU.
What they overlap is the wait for Temporal, history pages and completions, and
Temporal and PostgreSQL can serve more of those at once on more cores. The cap
of 16 keeps every accepted task inside Temporal's 10 s workflow-task timeout
while it queues behind the others on that thread.

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
./deploy/karmax doctor              # Compose, secrets, containers, memory caps, database role, DNS/HTTPS
./deploy/karmax status
./deploy/karmax logs                # or: logs temporal
./deploy/karmax backup              # deploy/backups/manual-<UTC timestamp>
./deploy/karmax prune-backups       # drop automatic snapshots past retention
./deploy/karmax update              # backup, validate commit ancestry, rebuild
./deploy/karmax down                # preserves all volumes and certificates
./deploy/karmax restore BACKUP_DIR  # verified and signature-checked, explicit destructive prompt
./deploy/karmax rotate-vault-key    # replace the vault's key encryption key (resumable)
./deploy/karmax configure-backups … # stream PostgreSQL off-host continuously (below)
./deploy/karmax pg-restore …        # point-in-time restore of those into a scratch volume
```

A backup includes PostgreSQL dumps of Karmax metadata, identity, and Temporal,
plus a consistent online snapshot of the encrypted credential vault,
attachments, local object/checkpoint data, and the auth and world-reference
secrets. Task VMs are deliberately excluded: Git plus encrypted portable
checkpoints are their durable form.

**A backup never contains the vault key** (`deploy/.secrets/vault_key`). Every
secret in the vault is encrypted under a data key of the organization, user or
installation that owns it, and those data keys are stored only wrapped under
the vault key, so the backup's vault is unreadable without it. Keep a copy of
`vault_key` off-host (a password manager, another machine): losing it makes the
vault and every backup unreadable. `restore` checks, before it changes
anything, that the key it will use is the one the backup's vault is wrapped
under: this instance's own, or the copy you pass with `--vault-key FILE`. The
rest of a backup (database dumps, provider logins in config homes, the auth
secret) is still sensitive: copy backups to encrypted off-host storage and
protect them like production credentials.

`rotate-vault-key` replaces the vault key. It wraps every data key under a new
key while the app serves, stops the app briefly to wrap whatever was created
meanwhile and switch `vault_key`, starts it on the new key, then removes the
previous key's wraps and leaves it as `.secrets/vault_key.retired-<UTC>`. Each
step can be repeated, and the previous key keeps opening the vault until the
last one, so an interrupted rotation is finished by running the command again
(`doctor` warns about one). Backups taken before the rotation still need the
retired key (`restore --vault-key .secrets/vault_key.retired-…`): copy it
off-host, keep it as long as those backups, then delete it from the host.

On Linux hosts with the util-linux `hardlink` command, completed backups share
identical large files (object-store checkpoints, agent transcripts)
automatically. This preserves every restore point and its verified bytes while
avoiding a full physical copy of unchanged data on every deployment. To compact
existing backups, run `sh deploy/compact-backups.sh`. Treat completed backup
directories as immutable; copy files out before editing them. The live data
volume is never linked to a backup.

Automatic snapshots are pruned: `update` keeps the newest 10 `predeploy-*`
snapshots, and the bare `<UTC timestamp>` snapshots earlier updaters took are
kept for 14 days. A successful update also prunes dangling images and caps the
Docker build cache at 8 GB. Snapshots with any other name (`manual-*` from
`backup`, or a directory you choose) are never deleted automatically.

These snapshots live on the disk they protect: they undo a bad deploy, not a
lost server. For that, keep an off-host copy, such as your provider's daily
server backup or these directories copied elsewhere.

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

### Continuous off-host PostgreSQL backups

The snapshots above are taken at each update, on the same disk. For a lost
server, PostgreSQL (Karmax's metadata and Temporal's histories, every database
in the cluster) can also be streamed to an S3 bucket with
[WAL-G](https://github.com/wal-g/wal-g): every WAL segment within a minute
(`archive_timeout=60`), and a base backup every 24 hours
(`KARMAX_PG_BACKUP_INTERVAL_HOURS`) from the `pg-backup` service, which reads
the data directory read-only. With nothing configured, PostgreSQL archives
through the same script, which reports success, and `pg-backup` idles.

Set it up so a stolen host cannot destroy the history:

1. A bucket of its own, never the object store's. On Cloudflare R2, add a
   **bucket lock rule** (every object, age N days): no key can then delete or
   overwrite a backup for N days. Add a **lifecycle rule** deleting objects
   after N+1 days. Nothing in Karmax ever deletes from this bucket. A point in
   time can be restored while its base backup is still in the bucket, so the
   window is about N days minus the base-backup interval.
2. A key that can write only that bucket (R2: an Object Read & Write account
   token restricted to it). WAL-G needs read access to check an existing
   segment before overwriting it, and the lock refuses the overwrite anyway.
3. An OpenPGP key pair (RSA). The host gets only the **public** key, so it can
   encrypt backups but not read them. Keep the private key off-host. It is the
   only way to restore, and losing it loses every backup.

```bash
KARMAX_PG_BACKUP_ACCESS_KEY_ID=… KARMAX_PG_BACKUP_SECRET_ACCESS_KEY=… \
  ./deploy/karmax configure-backups s3://BUCKET/INSTALLATION https://ENDPOINT backup-public.asc
./deploy/karmax doctor   # passes once the first base backup is in the bucket
```

`configure-backups` restarts PostgreSQL (seconds) and starts the first base
backup. `doctor` fails when WAL has been waiting more than 10 minutes to be
archived, or the newest base backup is older than the interval plus 6 hours;
`./deploy/karmax logs pg-backup` shows the base backups.

**Point-in-time restore.** `pg-restore` restores into a scratch Docker volume,
never production. The copy has archiving off and no network listener, so it
cannot write to the bucket. It replays WAL to the time you name, or to the end,
and prints what it recovered. The volume is deleted afterwards unless you pass
`--keep`:

```bash
./deploy/karmax pg-restore --private-key ~/backup-private.asc --to '2026-10-08 12:00:00+00'
```

A restored cluster is only PostgreSQL. To serve from it, the installation also
needs `deploy/.secrets/` (`vault_key`, `auth_secret`, `world_ref_key`), and the
data volume, which holds config homes and the local object store. From data
epoch 5 the vault itself is rows of the `karmax` database, so the point-in-time
restore carries it (as ciphertext, useless without `vault_key`); before epoch 5
its entries are on the data volume too. The vault key comes from your off-host
copy (above). The other two
secrets and the data volume are in the snapshots and the provider's disk image.
For a lost server, take PostgreSQL from the point-in-time restore (`--keep`,
then use the volume as `temporal_postgres`) and everything else from the newest
snapshot or disk image.

### Recovering on a new server

Restoring on the same host needs only `./deploy/karmax restore BACKUP_DIR`. When
the server itself is lost, three things must exist off-host, because none of
them can be recovered from the others:

- **a backup directory.** `deploy/backups/` is on the server's own disk, so copy
  backups off-host (encrypted storage) as you take them;
- **the vault key** (`deploy/.secrets/vault_key`), which no backup contains: a
  single line with no trailing newline;
- **the backup-signing fingerprint** (`SHA256:…`) that `backup` prints.

A provider's full-disk image (one.com Basic Backup) is the exception: it brings
back `deploy/.secrets/` with everything else, so restoring it needs neither the
key nor the fingerprint.

On the new server:

```bash
# 1. Install Docker Engine with Compose, clone Karmax at the release the backup
#    was taken with (or a newer one), and start a fresh stack.
./deploy/karmax up karmax.example.com

# 2. Copy the backup directory onto the server, e.g. scp -r BACKUP admin@host:~/

# 3. Put the vault key in a private file, byte for byte, e.g. from pass:
umask 077
pass show PATH/TO/ENTRY | head -n 1 | tr -d '\n' > ~/vault_key

# 4. Restore. It checks the signature, every checksum and that the key opens
#    the backup's vault before it changes anything; type RESTORE to confirm.
./deploy/karmax restore --trust-key SHA256:FINGERPRINT --vault-key ~/vault_key ~/BACKUP

# 5. Check the stack, then delete the key copy: restore installed it as
#    deploy/.secrets/vault_key.
./deploy/karmax doctor
shred -u ~/vault_key
```

The fresh stack's own keys are replaced by the backup's (the auth and
world-reference keys come from the backup; the vault key from `--vault-key`).
A backup taken before a `rotate-vault-key` needs the key it was taken under,
the retired one. Point DNS at the new server as in the installation section.

On tavya.io the vault key is escrowed as the vault item recorded in the project
wiki's `ops/secrets-and-accounts`, whose pass-store copy is
`tavya/vi_murj15zj778a901db5.api-key` (step 3:
`pass show tavya/vi_murj15zj778a901db5.api-key | head -n 1 | tr -d '\n'`), and the
signing fingerprint is recorded on the wiki's `ops/production-tavya`. Update the
item after every `rotate-vault-key`.

### Replay check

A running workflow replays its recorded history under whatever code the next
worker loads, and one that cannot replay is stuck from its next event. Before
`update` backs anything up or restarts, the new image replays every running
workflow (`npm run replay-check`, coordinators included). If any fails, the
update stops, lists them, and leaves the previous release running. Fix the
release. `KARMAX_SKIP_REPLAY_CHECK=1 ./deploy/karmax update …` skips the check,
for when the listed workflows are already broken or may break.

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

Epoch 4 moves every vault secret under a data key of its owner (SS-1, wiki
features/vault-encryption): `v3.` ciphertext, recorded with the organization,
user or installation that owns it, whose data keys live in `vault/keys/`
wrapped under the vault key. The first boot finds each secret's owner in the
database (vault item indexes, resource attachments, cards, storage and
provider connections, handles that name their organization or user) and
re-encrypts it and its revisions; secrets no owner is found for stay under
the installation's data key until a write names their owner, and the count is
in the audit log (`vault.scopes.migrated`). Each entry is rewritten atomically,
so an interrupted first boot finishes on the next one. The epoch 3 release
cannot read the result (it refuses: "vault/vault.canary is missing or damaged,
and the key opens none of the N entries"). **The way back is the pre-update
backup with its code**; the vault key is unchanged, so it still opens that
backup. Backups no longer carry the vault key: the epoch 3 `deploy/karmax
restore` would generate a new one, so before restoring a backup taken by this
release with the previous release's code, copy the key into it first:
`cp deploy/.secrets/vault_key BACKUP/deployment-secrets/` (the checksums list
only the files they cover, so this does not fail verification).

Epoch 5 moves the vault into the application database when that database is
PostgreSQL (wiki planned/host-local-state), so every process and host shares
one vault without a host-local file lock. The first boot finishes the epoch 3
and 4 steps, copies every entry, keyring and key canary into the
`vault_entries`, `vault_keyrings` and `vault_kek_canaries` tables exactly as
stored (ciphertext and wrapped data keys; nothing is decrypted to copy it),
reads every secret back through the database and compares it with the file,
and only then records the move (`vault.moved-to-database` in the audit log).
It then replaces `vault/secrets.json` with a marker the epoch 4 release refuses
("not a secret map") and moves the vault's files, unchanged, into
`vault/retired-epoch5/` (`vault/vault.key`, if there is one, stays: it is the
vault key, not the vault). No release reads that copy; it is the cheapest way
back, and it still opens with the same key (`npm run vault-key -- --vault
vault/retired-epoch5 status`). Deleting an organization or closing an account
shreds its files there too, so the copy cannot outlive crypto-shredding. A
later release deletes `vault/retired-epoch5/` once epoch 5 is verified in
production. An interrupted first boot repeats the copy; one interrupted after
the move only finishes moving the files. The vault key is unchanged, `karmax.dump` now carries the encrypted
vault, and backups still leave the key out. `npm run vault-key` and
`vault-preflight` work on the database once the move is recorded. **The way
back is the pre-update backup with its code**, whose `control-plane/vault/`
still holds the files. A self-host on SQLite keeps the file vault.

Epoch 6 moves model logins into the vault (wiki planned/host-local-state,
step 2). A Claude, Codex or OpenCode login was its CLI's credential files in
`config-homes/<provider>-<account>` (`.credentials.json`, `auth.json`, the
captured setup token); they are now one vault entry per login,
`model-login:<organization>:<provider>:<account>`, owned by the account's
organization, and the files in the home are a cache the app materializes from
the vault and writes back through the login's refresh lease. Every refresh of a
stored OAuth credential (Claude, Codex, MCP OAuth, GitHub user tokens) takes a
lease row in `credential_refresh_leases` and writes back with a
compare-and-set, so the gateway and the activity worker never spend one
single-use refresh token twice. The first boot copies each home's credential
files into the vault, reads every entry back and compares it with the files,
and only then records the move (`model-logins.moved-to-vault` in the audit
log); an interrupted boot repeats the copy. It then keeps the files it found,
unchanged, in `retired-epoch6/config-homes/` (no release reads them; a
disconnect, a rename and an organization's deletion take them along, and a
later release deletes the directory once epoch 6 is verified in production;
after the first refresh their tokens are spent). Session histories stay in the
homes. The epoch 5 release must not run on this: it would refresh from the
cache and sign logins out. So on PostgreSQL `vault/entries` becomes a file
explaining that, and the epoch 5 release stops at boot with "EEXIST: file
already exists, mkdir '…/vault/entries'"; on a SQLite install `vault/secrets.json`
becomes a sentinel the epoch 5 release refuses ("not a secret map"). From epoch
6 on the database also records the highest data epoch that has run against it
(`kv` row `data-epoch`), and an older release refuses to start on it.
`npm run model-logins -- status` lists the logins in the vault and whether
this host's cache of each agrees. **The way back is the pre-update backup with
its code.**

Recover a failed epoch transition by repairing forward, or restore the pre-update
backup with its matching application revision **and Temporal history**. Restoring
a snapshot can discard work performed after it was taken. Do not run an older
release against the migrated database or restore only one database. Validate this
procedure on an isolated deployment before the production epoch transition.

`scripts/rehearse-upgrade.sh --to <revision>` does that validation in one
command: it installs `origin/master` in a scratch clone, seeds it through its
API, backs it up, runs this `update`, verifies every record, and restores the
backup onto a fresh stack. See "Rehearsing an upgrade" in the project wiki's
ops/release-and-deploy page for what it checks and its traps.

`update` checks the vault read-only with the new image after the pre-update
backup and before switching (`npm run vault-preflight`, with the key the app
itself reads): whether the key would be accepted, which files cannot be read,
and which secrets the first boot would quarantine. Any finding stops the update
with the previous app still serving. `./deploy/karmax update REVISION
--accept-vault-findings` proceeds past secrets to quarantine, never past a
refused key, an unreadable file or a vault that cannot be opened: the new
release could not boot with those.

The epoch 3 vault migration moves the previous release's `vault/secrets.json`
into `vault/entries/`, one bound file per secret, then replaces `secrets.json`
with a marker the previous release refuses to open ("not a secret map"). It reads everything first; a file it cannot read (permissions, an I/O
error) stops boot with a list and changes nothing. Secrets that do not parse or
authenticate under the vault key are moved to `vault/entries/quarantine/` (kept
30 days) and recorded in the audit log (`vault.entry.quarantined`). The previous
release cannot read the result: **the only way back is the pre-update backup
with its code.** There is no vault-only rollback: the previous release cannot
start on the migrated vault. If `secrets.json` is replaced by hand and it runs
anyway, the next boot of this release refuses to start ("vault/secrets.json
holds N secrets although the vault moved"); restore the backup.

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

The Linux deployment runs Caddy on the host network so IPv6 connections keep
their real peer addresses (Docker's userland proxy would present every IPv6
client as one bridge address). The app publishes port 4505 on host loopback
only, and `KARMAX_TRUSTED_PROXY_IP=gateway` makes it believe Caddy's overwritten,
single-address X-Forwarded-For only from its own bridge gateway, where host
connections to that port arrive from. No subnet is pinned, so an update never
rebuilds the Compose network. Host-local processes are trusted at this boundary.
Never expose port 4505 publicly or trust an entire proxy subnet. Other installs
ignore forwarded headers unless `KARMAX_TRUSTED_PROXY_IP` names an exact proxy
address. The gateway groups IPv6 clients by /64 for login lockout and hosted
request budgets; Caddy also enforces its per-address edge budgets. These budgets
are per replica. Host-network Caddy binds ports 80 and 443 itself, so a host
firewall must allow them, including UDP 443 for HTTP/3 (Docker's published ports
used to bypass it). Its admin API is off, since on the host network it would let
any local process rewrite the edge, so `caddy reload` is unavailable: a changed
Caddyfile takes effect when the Caddy container is recreated. `deploy/karmax`
labels Caddy with the Caddyfile's digest, so its `up` and `update` do that
whenever the Caddyfile changed; with `compose.hosted.yml`, set
`KARMAX_CADDYFILE_SHA256=$(sha256sum deploy/Caddyfile | cut -d' ' -f1)` for
`docker compose up`, or restart Caddy yourself.

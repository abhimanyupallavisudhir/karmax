# Paid launch checklist

For hosted operators turning on subscription billing. The bundled policies are a
launch draft, not legal advice: they contain no guessed entity, address,
jurisdiction, tax or certification claims. Have the final configuration and text
reviewed before enabling charges.

Everything is configured in **Installation → Paid-launch setup** (or
`GET|PUT /api/settings/paid-launch` with installation authority). Legal and
catalog values are stored in the installation database, provider secrets in the
encrypted vault, and the page shows the exact webhook and checkout URLs plus a
durable founder checklist. No environment variables are required.

**Paddle** is the default provider; its setup steps are in
[deploy/README.md](../deploy/README.md#hosted-subscription-billing-with-paddle).
Stripe Billing remains supported for existing subscriptions; changing the default
does not migrate customers.

## What blocks enabling paid checkout

The server refuses to enable checkout until all of these hold (`canEnable` in
`src/launch/settings.ts`):

- Every legal/contact value: legal name, country of establishment, governing law
  and courts, legal notice address, and legal, privacy, security, incident, DPA
  and billing emails.
- Founder approval of the **current** policy version. A policy change deliberately
  voids the previous approval; setup never ticks it on the founder's behalf.
- The selected provider's billing configuration. Paddle: API key, webhook signing
  secret, client-side token, and the Individual, Team base and Team seat price IDs,
  in the **live** environment. Stripe: secret key, webhook secret and the same
  three price IDs.

`/pricing` withholds the operator identity until the public operator details are
configured, and the billing service validates provider configuration independently.

## Before you enable it

- **Contracting party.** Enter the exact operator (an individual sole trader or a
  company) and monitored role addresses with owners and escalation coverage. Add a
  tax ID or certification only if it is real and verified.
- **Catalog.** Recurring monthly USD prices of exactly $9 (Individual), $19 (Team
  base) and $5 (Team additional active user). Paddle's automated setup creates or
  reuses them; verify them anyway.
- **Billing lifecycle, in a separate sandbox installation.** Checkout, signed webhook
  reconciliation, renewal, failed payment and grace expiry, seat changes, plan
  change, portal and period-end cancellation, refund handling and organization
  deletion with a pending checkout. Never send sandbox events to an installation
  that holds live entitlements, and never switch one between sandbox and live.
- **Live transport.** After configuring live keys, confirm a signed webhook reaches
  the installation and that replays are deduplicated, without granting entitlements.
- **Legal and data operations.** Review every `/legal/*` page, the signup checkbox,
  checkout acceptance and the cancellation path on mobile and desktop. Check the
  subprocessor list and DPA against the providers you actually use (hosting,
  sandboxes, email, storage, model and repository providers). Exercise personal and
  organization export, deletion-request routing, ownership transfer, offboarding and
  backup restore, and adopt a written retention schedule instead of inventing a
  number of days.
- **Records.** Keep policy acceptance and billing records under that schedule. A
  policy edit needs a new version and a decision about re-acceptance and notice.

The Installation page carries the longer founder checklist (business structure,
banking and bookkeeping, tax, name clearance, provider account verification,
inboxes, incident procedures and the final public launch review).

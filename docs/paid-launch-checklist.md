# Paid launch checklist

The bundled policies are an initial founder-reviewed launch draft, not legal
advice. They deliberately contain no guessed entity, address, jurisdiction, tax,
or certification claims. Have qualified counsel review the final configuration
and text before enabling charges.

Configure this in **Installation settings → Paid launch**. That page stores the
legal and catalog values in the installation database, stores Stripe secrets in
the encrypted krmax vault, shows the exact subscription webhook URL, and keeps a
durable checklist for the real-world work. No paid-launch environment variables
are required.

Only enable **real paid checkout** after every applicable item is complete. The
UI refuses to enable it while a required legal/contact value, founder policy
review, Stripe secret, webhook secret, or Price ID is absent. `/pricing`
withholds the operator identity until the same configuration is complete, and
the organization billing service independently validates Stripe configuration.
A future policy-version change intentionally breaks the founder acknowledgement
until the new text is reviewed.

## Contracting party and contacts

- Enter the exact contracting name, formation/operating country,
  counsel-approved governing-law wording, and real legal-notice address.
- Enter monitored legal, privacy, security, incident, DPA, and billing role
  addresses with owners and escalation coverage.
- Do not add a tax ID or compliance certification unless it is real, required,
  and separately verified. The current public draft claims none.

## Canonical organization billing

- Enter the Stripe Billing secret key and the separate subscription webhook
  signing secret shown by Stripe for the URL on the page. Do not reuse the
  agent-card/Issuing Stripe Connect webhook rail.
- Enter the Individual, Team base, and Team additional-active-user Price IDs.
  Verify in Stripe test mode that they are recurring monthly USD prices for
  exactly $9, $19, and $5.
- Complete owner checkout, signed webhook reconciliation, renewal,
  failed-payment/grace expiry, seat changes, downgrade, direct online
  cancellation, portal cancellation, refund, and terminal organization-deletion
  exercises. Confirm the durable acceptance evidence contains the same
  organization, plan, active-user pricing, and provider references.

## Operational review

- Review every `/legal/*` page, the signup checkbox, organization checkout,
  commercial-terms acceptance, and the cancellation portal at mobile and desktop sizes.
- Confirm BYOK, connected subscription, managed-model, E2B/Daytona, repository
  host, object storage, email, monitoring, and support providers match the
  deployed subprocessor list and DPA.
- Exercise personal and organization export, account-deletion request routing,
  privacy/security/incident inboxes, ownership transfer, backup deletion, and
  offboarding. Complete a written retention schedule and DPA instead of adding
  an invented number of days to the public draft.
- Preserve policy acceptance records and billing-provider records under the approved
  retention schedule. A policy edit requires a new version and a deliberate
  decision about re-acceptance and customer notice.

The Installation page contains the longer founder checklist, including business
formation, banking/bookkeeping, tax review, name/IP clearance, Stripe account
activation, portal and webhook setup, counsel and privacy review, staffed
inboxes, incident procedures, data operations, billing lifecycle testing, and
the final public launch review.

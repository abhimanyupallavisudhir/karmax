# Paid launch checklist

The bundled policies are an initial founder-reviewed launch draft, not legal
advice. They deliberately contain no guessed entity, address, jurisdiction, tax,
or certification claims. Have qualified counsel review the final configuration
and text before enabling charges.

Set `KARMAX_PAID_LAUNCH=1` only after every item below is complete. Hosted
startup then fails closed if a required value is absent, `/pricing` withholds the
operator identity until the same checklist is complete, and the canonical
organization billing service independently validates its provider configuration.

Set `KARMAX_FOUNDER_REVIEWED_POLICY_VERSION=2026-08-15` only after the founder
has reviewed that exact version of every public page and recorded any counsel
feedback. A future policy-version change intentionally breaks this acknowledgement
until the new text is reviewed.

## Contracting party and contacts

- `KARMAX_LEGAL_ENTITY_NAME`: exact contracting name.
- `KARMAX_LEGAL_ENTITY_COUNTRY`: formation/operating country as counsel directs.
- `KARMAX_GOVERNING_LAW`: counsel-approved governing-law wording.
- `KARMAX_LEGAL_NOTICE_ADDRESS`: real legal-notice address.
- `KARMAX_LEGAL_EMAIL`, `KARMAX_PRIVACY_EMAIL`, `KARMAX_SECURITY_EMAIL`,
  `KARMAX_INCIDENT_EMAIL`, `KARMAX_DPA_EMAIL`, and `KARMAX_BILLING_EMAIL`:
  monitored role addresses with owners and escalation coverage.
- Do not add a tax ID or compliance certification unless it is real, required,
  and separately verified. The current public draft claims none.

## Canonical organization billing

- Configure `KARMAX_SUBSCRIPTION_STRIPE_SECRET_KEY` and the separate
  `KARMAX_SUBSCRIPTION_STRIPE_WEBHOOK_SECRET` for `/api/subscriptions/webhook`.
  Do not reuse the `STRIPE_*` agent-card/Issuing webhook rail.
- Configure the Individual, Team base, and Team additional-active-user Price IDs
  with `KARMAX_SUBSCRIPTION_STRIPE_INDIVIDUAL_PRICE_ID`,
  `KARMAX_SUBSCRIPTION_STRIPE_TEAM_BASE_PRICE_ID`, and
  `KARMAX_SUBSCRIPTION_STRIPE_TEAM_SEAT_PRICE_ID`. Verify in Stripe test mode
  that they are recurring monthly USD prices for exactly $9, $19, and $5.
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

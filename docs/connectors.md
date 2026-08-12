# External event connectors

Karmax connectors turn provider events into runs of an existing repeatable task. The task is the policy boundary: its project, workflow, authorization, credentials, review policy, and spend limits remain fixed. An external event may only fill task-form inputs such as `title` and `prompt`.

## Built-in sources

- **GitHub App:** connected repositories are automatically available as sources. Adding the `planned` label to an issue emits `github.issue.label-added`; use the filter `label.name = planned`.
- **Slack Events API:** create a Slack source, copy its endpoint into the Slack app's Event Subscriptions request URL, and subscribe to `app_mention` and/or `message.im`. Bot and message-subtype events are ignored.
- **Discord interactions:** create a Discord source with the application's public key and use the returned endpoint as its Interactions Endpoint URL. Ping verification and application commands are supported.
- **Signed webhook:** use this for Pipedream, n8n, Activepieces, Windmill, Zapier, or an internal service. It performs no agent work and is therefore appropriate for fixed routing and transformation jobs.

Sources are created in **Organization settings → Connectors**. Then create or edit a repeatable task and add an **External event** trigger. Mappings use bounded field interpolation such as `{{ subject.url }}` or `{{ issue.title }}`; they do not execute code.

## Signed webhook protocol

Send JSON to the endpoint shown when the source is created:

```json
{
  "type": "crm.deal.ready",
  "deliveryKey": "deal-123-ready-v4",
  "occurredAt": "2026-08-12T12:30:00Z",
  "actor": { "externalId": "user-42", "display": "Ada" },
  "subject": { "externalId": "deal-123", "url": "https://example.test/deals/123" },
  "data": { "deal": { "id": "123", "name": "Example" } }
}
```

Required headers:

- `X-Karmax-Timestamp`: current Unix time in seconds.
- `X-Karmax-Signature`: lowercase hex HMAC-SHA256 of `<timestamp>.<exact request body>`, using the one-time signing secret.
- `X-Karmax-Delivery`: recommended stable delivery ID. If omitted, `deliveryKey` or the body hash is used.

Example Node.js signing code:

```js
import crypto from 'node:crypto';

const timestamp = Math.floor(Date.now() / 1000);
const body = JSON.stringify(event);
const signature = crypto.createHmac('sha256', process.env.KARMAX_WEBHOOK_SECRET)
  .update(`${timestamp}.${body}`).digest('hex');
await fetch(process.env.KARMAX_WEBHOOK_URL, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-karmax-timestamp': String(timestamp),
    'x-karmax-signature': signature,
    'x-karmax-delivery': event.deliveryKey,
  },
  body,
});
```

The endpoint verifies signatures against the exact bytes, rejects timestamps outside five minutes, limits bodies to 2 MiB, deduplicates `(source, delivery ID)`, and rate-limits a source to 300 new deliveries per minute. A `_karmax.hops` value of 8 or more is rejected to break automation loops.

## Delivery semantics

Ingress is acknowledged only after the normalized event is persisted. Dispatch is at least once, while run creation is effectively once per `(event, task template)` through a durable fixed task ID. Failed deliveries retry with exponential backoff; after ten attempts they enter the dead-letter state and can be replayed from Organization settings.

External text is always marked as untrusted in the spawned task prompt. It cannot select a project, workflow, assignee, credentials, authorization profile, confirmation policy, priority, or spend authority.

For direct API task creation, clients can also send `Idempotency-Key` on `POST /api/projects/:projectId/tasks`. Reusing a key with the same request returns the original task; reusing it with a different body is rejected. Keys are retained for seven days.

## Polling and scheduled batches

For a source without webhooks, schedule a fixed integration job in Pipedream, n8n, Activepieces, Windmill, or your existing scheduler and have it send one signed delivery for each stable external item. Keep deterministic filtering, cursoring, and normalization in that job. Use a Karmax agent task only when the batch needs judgment—for example, deciding which incoming issues are duplicates and consolidating their evidence.

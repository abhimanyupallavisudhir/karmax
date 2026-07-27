# Plan — passwords & credentials for agents (vault items, scoped grants, escalation, 2FA/passkeys)

How agents log into accounts, create accounts, and use/create/store passwords,
SSH keys, API keys, TOTP secrets, and passkeys on the user's behalf — and how a
human scopes, grants, and audits all of it. Design only; phases at the end.

---

## 1. What exists today (most of the machine is already built)

- **Vault + broker are exactly the right substrate.** AES-256-GCM vault
  (`src/autonomy/vault.ts`) stores handle → secret; the broker
  (`src/autonomy/broker.ts`) resolves handles JIT inside activities, gated by
  `use-credential:<handle>` capabilities (wildcards supported:
  `use-credential:api-key:*`), with a full audit trail (who/when/granted/why
  denied). Agents never see handles resolved in prompt text (SPEC §8.4).
- **Per-item grants already exist in the capability grammar.** The prefix
  wildcard means "all passwords" (`use-credential:pw:*`), "one site"
  (`use-credential:pw:github.com:*`), or "one item" are all expressible today.
  What's missing is the *items*, the *UI*, and the *escalation path* — not the
  authorization model.
- **The escalation shape exists for money.** `request_spend` →
  `granted | needs_approval | needs_funding | denied`; pending requests park in
  the budget coordinator, surface at the Review gate, and a human approves,
  funds, or denies (`src/autonomy/payments.ts`, `src/coordinators/budget.ts`).
  Password access wants the *same* verbs with `needs_funding` swapped for
  `not_in_vault`.
- **Materialization patterns exist for every secret shape.** Env scrubbing +
  injection per spawn (`scrubbedEnv`, SPEC §7.3); 0600 key files +
  `GIT_SSH_COMMAND` / `GH_TOKEN` (git profiles, PLAN-git-config §4); config
  homes for whole login states. SSH keys and API keys for agents are a solved
  problem wearing a git-specific costume.
- **The browser is already in the loop.** Each config home wires a
  chrome-devtools MCP server next to the platform MCP — the platform-controlled
  process that can type into pages *without the text transiting the model* is
  already running.
- **SPEC §7.6 already commits to the vision**: registration/login via broker,
  TOTP-capable broker for MFA, write-back of newly created accounts, human gate
  only for un-automatable step-up.

## 2. The landscape (what to adopt, what to interoperate with)

Surveyed as of 2026-07: the industry converged on two patterns.

1. **Zero-exposure fill** — the credential is injected into the page by a
   trusted component; the model sees only "login succeeded". 1Password's
   *Secure Agentic Autofill* (Noise-framework channel, biometric approval per
   fill; Early Access, **Browserbase-only**, needs the user's desktop app awake)
   and its July 2026 Claude integration are the reference implementations.
   Kernel/Steel/Browser-Use hosted browsers do domain-matched fill + automatic
   TOTP the same way.
2. **Vault MCP** — Bitwarden's MCP server gives the agent CRUD over the vault
   via the local `bw` CLI; secrets *do* reach the model. Good for management,
   wrong for use.

Conclusions for karmax:

- **The karmax vault is the runtime source of truth; external stores are sync
  connectors.** A per-fill biometric ceremony on the user's phone contradicts
  "agents work while you sleep", and a runtime dependency on a desktop app or
  a partner-locked browser doesn't survive cloud worlds. Bitwarden (`bw` CLI),
  1Password (service accounts / `op` CLI), and unix `pass` are all scriptable:
  support them as **import/sync sources** (user picks items or folders to
  mirror in; optional write-back of agent-created accounts) rather than as
  five different runtime code paths. This also answers "any store vs
  engineered": engineered core, commodity connectors.
- **Build the zero-exposure fill natively.** karmax already owns both ends
  (broker + browser MCP); the 1Password/Browserbase architecture is
  reproducible in ~one activity without the partner lock-in, with karmax's own
  approval policy instead of a mandatory biometric per fill.

## 3. Principles

1. **The model never needs the secret to *use* it.** Three use paths in
   strictly decreasing preference: (a) materialize into env/files at spawn,
   (b) broker-side browser fill, (c) plaintext reveal to the agent. (c) exists
   because reality does (pasting a key into a remote dashboard), but it is
   per-item gated, `ask` by default, and marked in the audit log.
2. **Grant items, not the vault.** The unit of authorization is a vault item
   (or tag/domain wildcard), attached to a task like a budget is. "This task
   may use my GitHub login" — not "this task may read passwords".
3. **Pull, don't preload.** Tasks start with what the creator attached; the
   agent escalates for anything else. Denied ≠ failed: the request parks, the
   human grants/denies/adds, the task resumes. Same lifecycle as spend.
4. **Every grant is recorded with its grantor.** Human approval of an
   escalation *is* the explicit elevation path the authorization plan reserved
   — it extends the stored task grant, attributed, never silent.
5. **Agents create credentials, not just consume them.** Registration flows
   write the new login back as a vault item (generated password, TOTP seed
   captured at enrollment, agent-enrolled passkey), owned by the user from
   birth.

## 4. The model: `VaultItem`

Today the vault is handle → string. Add a typed metadata layer (metadata in the
Store, secrets stay in the vault under item-scoped handles — same split as
`GitProfile`):

```ts
interface VaultItem {
  id: string;                 // 'vi_...' — grant target: use-credential:item:<id>
  type: 'login' | 'api-key' | 'ssh-key' | 'env' | 'passkey' | 'note';
  label: string;              // 'GitHub (alice)'
  domains?: string[];         // ['github.com'] — fill matching + domain grants
  username?: string;          // metadata, not secret
  tags?: string[];            // grantable groups: use-credential:tag:<tag>
  secrets: Record<string, string>; // field → vault handle: password, totpSeed,
                              //   privateKey, envBlob, passkeySeed…
  policy: {
    use: 'auto' | 'ask';      // per-use human approval (fill/inject)
    reveal: 'auto' | 'ask' | 'never'; // plaintext to the model
  };
  provenance: { source: 'manual' | 'connector:<name>' | 'task:<id>'; at: number };
}
```

- A `login` bundles password + TOTP seed + domains — the natural unit of
  granting ("my GitHub login"), matching 1Password/Bitwarden items so
  connectors map 1:1.
- `env` is a KEY=VALUE bag (the ".env injection" case) — attach to a project
  or task, materialized at spawn.
- `ssh-key`/`api-key` generalize what git-profiles hard-coded.
- Grant grammar reuses the existing capability wildcards:
  `use-credential:item:vi_x`, `use-credential:tag:staging`,
  `use-credential:domain:github.com`, `use-credential:*`.

## 5. Use paths (how a secret actually gets used)

**A. Materialization at spawn** — for `env`, `api-key`, `ssh-key` items
attached to the task: env vars via the existing `extraEnv`/`scrubbedEnv` path;
key files 0600 under the world's private dir with the pointing env var
(`GIT_SSH_COMMAND`-style). Nothing new mechanically; git-profiles already does
this end to end.

**B. Broker-side browser fill** — new platform MCP tool:

```
fill_credential({ itemId?, domain?, field: 'username'|'password'|'totp', uid })
```

The **host-side** MCP/gateway resolves the handle, checks
`use-credential:...` + item policy, and types the value into the page element
via CDP (`Input.insertText` against the chrome-devtools session) — the secret
never appears in tool arguments, model context, or the transcript. `totp`
computes the current code from the stored seed (RFC 6238 is ~15 lines).
Domain check: the target page's origin must match the item's `domains` —
a prompt-injected agent cannot fill the GitHub password into evil.com.
Returns `{ filled: true }` or the escalation statuses of §7.

**C. Reveal** — `get_credential({ itemId, field })` returns plaintext to the
agent, gated by the same capability *plus* `policy.reveal` (default `ask`).
Needed for "paste this API key into the Vercel dashboard"-shaped work; loudly
audited (`revealed: true` in the audit entry).

## 6. Authorization: packages + line items (the dropdown grows up)

The dropdown picks one of four profiles; the capability model underneath is
already a list. Evolve the *interface*, keep the model:

- **Task creation**: profile stays as the base **package** (chip, not
  dropdown), plus an optional adjustments row: add/remove named capabilities,
  and a **credential picker** — specific items, tags, domains, or "all", each
  becoming a `use-credential:...` grant on the task. Stored grant =
  attenuate(package ± adjustments, creator's grant) — invariant unchanged; a
  creator still cannot attach an item they cannot use themselves.
- **Settings profiles UI** (already a grouped checklist per
  PLAN-authorization) gains the same credential picker so custom packages can
  include standing credential access (e.g. an "ops" profile with
  `use-credential:tag:staging`).
- Sub-tasks inherit the already-attenuated parent grant, exactly as today —
  credential grants flow down but never widen.

## 7. The pull model: `request_credential`

Mirror `request_spend` end to end:

```
request_credential({ itemId? | domain?, field?, mode: 'fill'|'inject'|'reveal', why })
  → granted | needs_approval | not_in_vault | denied
```

- **granted** — capability + policy allow; proceed (fill/inject/reveal).
- **needs_approval** — item exists but the task grant or item policy doesn't
  cover it. Request parks in the credential coordinator (the budget
  coordinator pattern; likely the same singleton generalized to "pending
  approvals"); surfaces as an **access request** at the Review gate / inbox
  with item, mode, and `why`. Human resolves: **once** (this use), **this
  task** (extends the stored task grant, recorded with grantor), **always**
  (edits item policy / adds to a profile package), or **deny** (agent gets
  `denied` + reason and reports/works around).
- **not_in_vault** — no item matches the domain. The same request card offers:
  *add item* (inline form or "pick from connector") then retry, or reply
  **"create one"** — the agent registers an account itself (§8) and writes the
  item back via `store_credential`.
- **denied** — hard no (capability ceiling, `reveal: never`); agent must not
  re-ask in a loop.

Agent write-back: `store_credential({ item })` creates/updates a VaultItem
(capability `credential:write` — the vault write, not the karmax-config write;
namespaced apart during implementation). Registration flows use it to persist
generated passwords and captured TOTP seeds with
`provenance: task:<id>`.

## 8. 2FA and passkeys (from "bullshit" to the easy path)

- **TOTP** — solved by §5B: seed lives in the item, broker computes and fills
  codes. Connector imports bring seeds along (1Password/Bitwarden both store
  them). Covers the large majority of 2FA sites with zero human involvement.
- **Email codes / magic links / verification mails** — give agents a mailbox,
  not the user's inbox: a **per-organization** agent email address used for
  registrations, provisioned automatically from an email backend the operator
  connects once (§7 impl: self-managed domain or hosted inbox — never a per-user
  env var chore); a `check_agent_mail` tool reads codes. Existing accounts on
  the user's personal email escalate to the human ("forward me the code" —
  which is just a `needs_approval`-style request card with a text reply).
- **SMS** — escalate by default: request card + push notification, human types
  the code, agent resumes. (A provisioned virtual number is a possible later
  connector; not v1 — carriers increasingly block VoIP for verification.)
- **Push-approve (Duo etc.)** — inherently human; escalate, same card.
- **Passkeys** — the user's own passkeys are unusable by design (the OS
  biometric gesture is the product). Instead the agent **enrolls its own
  passkey** on the account: a CDP virtual authenticator
  (`WebAuthn.addVirtualAuthenticator`, CTAP2/internal) whose credential is
  generated host-side and stored as a `passkey` item; at login the broker
  loads it into the virtual authenticator — same zero-exposure property as
  §5B, plus phishing-proof origin binding and *no* 2FA prompts afterward.
  Most sites allow multiple passkeys per account, so "karmax" appears
  alongside the user's own key and is individually revocable on the site.
  Once enrolled, a passkey login is the *most* automatable path — prefer it
  during account creation.

## 9. Connectors (external stores)

`CredentialConnector` interface with three commodity implementations:

- **Bitwarden** — `bw` CLI (session-key unlock at connect time; items →
  `login` VaultItems incl. TOTP seeds).
- **1Password** — service-account token + `op` CLI (Business/teams; no desktop
  ceremony). Optional: surface Secure Agentic Autofill as a *policy* option
  later if/when it opens beyond Browserbase.
- **unix pass** — read the GPG-decrypted tree (host-fallback spirit: works on
  the self-hosted box, absent on cloud).

Semantics: **selective mirror, not live proxy**. The user picks folders/items
to sync in; sync is pull-on-demand + periodic refresh; write-back of
agent-created items is per-connector opt-in. Runtime resolution always hits
the karmax vault — connectors down ≠ agents blocked, and cloud worlds need no
path to the user's desktop.

## 10. Settings → *Passwords & payments*

One section, five cards (payments cards join from the existing settings):

- **Vault** — items list (type icon, label, domains, tags, policy badges),
  add/edit/import, per-item audit peek ("last used by task #142, 2h ago").
- **Connectors** — connect Bitwarden / 1Password / pass; what's mirrored;
  write-back toggle.
- **Agent email** — each organization connects its own AgentMail inbox and API
  key with one compact form.
- **Access requests** — pending escalations (the §7 cards) + history; the
  same cards render at the task's Review gate and in notifications.
- **Policies** — defaults (`use`/`reveal` for new items, whether
  agent-created items start `ask`), profile-package credential grants.
- **Audit** — the broker audit log, filterable by item/task/decision; reveals
  highlighted.

Task form: the credential picker chip row (§6) next to the existing profile
selection.

## 11. Deliberately not built

- **Runtime dependence on any external vault** (incl. Secure Agentic
  Autofill's per-fill biometric) — mirror model only, for autonomy and cloud.
- **Using the user's own passkeys** — impossible by design; agent-enrolled
  passkeys instead (§8).
- **A second secrets store** — VaultItem is metadata over the *existing*
  vault; git-profiles/api-key handles migrate to items mechanically, later.
- **Browser session/cookie sync from the user's browser** — cookie jars are
  ambient authority with no per-item grant story; agents log in with items.
- **SMS numbers for agents (v1)** and **hardware-key (CTAP over USB) relay** —
  escalate to the human instead.

## 12. Phases

Phases 1–3 are implemented (tests: `tests/vault-items.test.ts` unit coverage
incl. RFC 6238 vectors and a mock-CDP fill; `tests/gateway.test.ts` runs the
item lifecycle and the full pull model over HTTP).

1. **VaultItem + grants** ✅ — `VaultItems` (`src/autonomy/vault-items.ts`):
   metadata in the store kv (`vault:items`), secrets in the existing vault
   under `item:<id>:<field>` handles (broker-resolved, GitProfiles-style);
   `use-credential:item|tag|domain` grammar via the existing wildcard matcher;
   `vault:store` capability (developer profile + do-role ceiling, which also
   gained `credential:read` + `use-credential:*`); `credentialGrants` on
   createTask / PATCH authorization (creator-capped: own coverage or
   `credential:write`); task-form **Vault credentials** picker; Settings →
   **Passwords & payments** with the Vault card (write-only secrets, per-item
   use/reveal policy).
2. **Use paths** ✅ — spawn-time `envFor` injection wired into
   `runAgentTurn`'s `extraEnv` (env bags, api-key `envVar`, ssh-key 0600 file
   paths; `auto`-policy granted items only; local worlds, like gitEnv);
   `POST /api/vault/fill` → `fillViaCdp` (`src/autonomy/fill.ts`: loopback
   CDP, live `location.origin` re-verified against item domains before
   typing, TOTP computed broker-side); `POST /api/vault/resolve` reveal with
   policy gate; durable audit via `store.appendAudit`
   (`vault.used/revealed/requested/…`).
3. **Escalation** ✅ — `request_credential` / `fill_credential` /
   `get_credential` / `store_credential` on both agent rails (Messages-API
   `tools.ts` + platform MCP `mcp.ts`); pending requests are **store-backed**
   (kv), not a Temporal coordinator — like `request_spend`, the decision
   itself is synchronous service logic, and approval works by editing durable
   state the next token mint reads: `once`/`task`/`always`/`deny`, with
   one-shot passes, per-task grant extensions (`vault:grant:<taskId>`,
   grantor recorded, merged into the grant at every mint — extending a
   running task without touching frozen workflow input), and `always`
   flipping item policy; Access-requests card in Settings.
4. **Connectors** ✅ — `Connectors` + `CredentialConnector`
   (`src/autonomy/connectors.ts`): Bitwarden (`bw`), 1Password service-account
   (`op`), and unix `pass`, each shelling out to the store's own CLI (injectable
   `Exec` for tests), availability probed like git preflight. Selective mirror:
   `list()` enumerates, `sync(name, ids)` pulls the selected items and writes
   them as VaultItems (provenance `connector:<name>` + `externalId`, so a
   re-sync updates in place rather than duplicating). Opt-in `writeBack` pushes
   an agent-created item back out. Unlock secrets (bw session key / op token)
   live in the vault under `connector:<name>:auth`. `/api/vault/connectors`
   surface + a Connectors card in Settings.
5. **Account creation autonomy** ✅ — **Agent mailbox**
   (`src/autonomy/agent-mail.ts`): a **per-organization** dedicated address
   (the organization is the tenant boundary — a shared inbox would let one
   tenant's agents read another's confirmation mails). Each org gets a random,
   unguessable local part; the inbound `POST /api/agent-mail/ingest` webhook
   (shared-secret authenticated, before the session gate) routes each message
   to the organization owning the recipient (subaddress `+tags` fold in;
   unknown recipients are dropped, never leaked into any tenant). Reads live at
   `GET /api/organizations/:id/agent-mail`, so requestScope + the org-scoped
   token check enforce tenancy — a cross-org agent token gets 403 (tested).
   Code/link extraction and `check_agent_mail(organizationId, …)` on both
   rails. **Passkeys**
   (`src/autonomy/passkey.ts` over shared `cdp.ts`): agent-enrolled via a CDP
   virtual authenticator (origin-verified), the manager holds the CDP session
   across the agent's create/sign-in click under a TTL; enrolled credentials
   store as `passkey` VaultItems; `enroll_passkey`/`save_passkey`/`use_passkey`
   tools. (Registration prompt guidance — the generate→register→enroll→store
   playbook — is left to per-task prompting / a future skill, not hard-coded.)

Implementation notes (phases 4–5):
- The CDP session-holding for passkeys is the one piece of cross-request state:
  a virtual authenticator is bound to the DevTools session that created it, so
  `PasskeyManager` keeps that WebSocket open (TTL-bounded, explicit release)
  between `enroll_passkey` and `save_passkey`. `cdp.ts` is shared with §5B fill.
- Connectors deliberately re-instantiate per request (cheap; CLIs are the state)
  and never cache secrets in memory beyond the call.
6. **Organization scoping (hosted multi-tenancy)** ✅ — vault items, access
   requests, connectors (config + unlock secrets), the mailbox, and payment
   **cards** are all keyed to the owning organization (the tenant boundary), so
   one tenant's agents can never read or spend another's. `VaultItems` and
   `Connectors` bind an `organizationId` at construction (keys `vault:items:<org>`,
   `vault:connector:<org>:<name>`, handle `connector:<org>:<name>:auth`); cards
   gain an `organization` scope (legacy `global` cards stay visible to the
   personal org only). The gateway derives the org from the caller's **token**
   (`authRecord.organizationId` — set and membership-validated by `auth()`, so
   it cannot be spoofed by a query param), the activity from the task's project
   org. Tested: two-org item/request isolation (unit) and card isolation +
   cross-org inbox 403 (gateway). Grants/passes stay task-keyed (a task is in
   one org). *Open follow-up:* the budget **policy** (allowance/threshold) is
   still global/project in the settings store, not org — a ceiling number, not
   a cross-tenant secret; org-scoping it rides the broader settings-scope work
   in PLAN-cloud.md.

7. **Organization AgentMail inbox** ✅ — each organization connects its existing
   AgentMail address and API key at
   `/api/organizations/:id/agent-mail/connect`. The key is stored under an
   organization-scoped vault handle and the outbound poller iterates each
   organization's effective config, so it works on a local install without a
   public webhook and keeps tenant billing and secrets separate. Settings shows
   only the compact AgentMail form. IMAP, self-managed push, hosted push, MIME
   ingest, and the webhook remain implemented but are intentionally hidden until
   demand justifies exposing them.
8. **Full-lifecycle password management (rotate / reset / propagate)** ✅ —
   what turns "use a password" into "manage a password like a human":
   - *Rotation rides the use-grant.* An agent that changed a password on the
     site may update the granted item's **secrets** via `store_credential`
     (`/api/vault/store`): a stale value locks everyone out, so writing the new
     secret is authorized by the same `covered()` check as using it. Metadata/
     policy/label edits on a foreign item stay a human / `credential:write`
     action (the rotation path ignores everything but `secrets`, 403s
     otherwise); audited as `vault.rotated`. Ungranted tasks still 403.
   - *`kind: "reset"` escalation.* When a stored secret is rejected by the site
     and the agent cannot self-reset (recovery goes to the human's inbox, not
     the agent mailbox), `request_credential(kind: 'reset')` **always parks**
     — even for a fully granted item, since granted access to a wrong password
     is useless. The request card shows "reported invalid" with the fix path:
     update the secret (per-item **Update secret** button in the vault card) or
     send the code as a task follow-up, then grant to unblock the retry.
     Agent-mailbox accounts need none of this: forgot-password →
     `check_agent_mail` → new password → rotation, fully autonomous.
   - *Field-level source propagation.* `CredentialConnector.updateSecret`
     (Bitwarden: get-item → edit one field; 1Password: `op item edit`
     assignment; pass: replace line 1 / the `otpauth://` line, notes preserved)
     plus `Connectors.propagate`: after a rotation (agent or human) of a
     mirrored-in item, the changed fields push back to the source store —
     best-effort, gated on that connector's write-back toggle; the karmax vault
     is already correct regardless. `push` (create-new) and `updateSecret`
     (edit-existing) stay distinct so write-back can never clobber notes.

9. **Task-native approval lifecycle** ✅ — credential access/reset requests are
   projected onto their owning task as an **Approval Requests** tab and an
   `approval needed` task/list label, while the Credentials settings page
   remains the organization-wide view. Request rows use the task's stable human
   number/title and link back to that tab. A new request emits an actionable
   creator/owner inbox notification; resolving it clears that notification and
   durably sends the decision back to the task so the workflow retries or
   continues without a mechanical “tell the agent” step. Credentials created
   by a task are covered for that task immediately, while the item's independent
   blind-use/plaintext-reveal policy still applies (so `reveal: ask` continues
   to require approval).

Implementation notes:
- Existing installs preserve customized profiles, while exact known historical
  built-in authorization profiles migrate to the current defaults. This gives
  future tasks `vault:store` without silently widening a user-edited profile;
  already-created task grants remain frozen.
- Agent-created items automatically follow every enabled connector write-back
  policy from `store_credential`; the agent does not also need the
  administrative `credential:write` capability. Unix `pass` imports recognize
  folder/domain/username paths (for example
  `software/www.overleaf.com/alice@example.com`) rather than treating the first
  folder as the fill domain.
- `fill_credential` discovers the CDP endpoint from inside the world, so the
  §5B trust boundary holds against prompt injection (live origin check over
  CDP), not against a malicious agent standing up a fake CDP server — stated
  in `fill.ts` and accepted for v1.

---

**Bottom line**: don't outsource the runtime to a password manager — karmax
already owns the correct architecture (vault handles, capability-gated JIT
broker, audit, spend-style escalation) and only lacks the product layer. Add
typed `VaultItem`s over the existing vault; grant *items* to *tasks* through
the existing wildcard grammar (profile = package, plus per-task credential
picker); let agents pull what they lack via `request_spend`-shaped
`request_credential` escalation with add-it/create-it resolutions; use secrets
through zero-exposure paths (spawn-time injection; host-side browser fill that
also types TOTP codes; agent-enrolled virtual-authenticator passkeys) with
plaintext reveal as the audited exception; and treat Bitwarden/1Password/pass
as selective sync connectors feeding the vault, never as the hot path.

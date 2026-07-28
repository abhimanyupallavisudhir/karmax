import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CredentialBroker } from './broker.js';
import { Capability, allows } from '../platform/capabilities.js';
import { newId } from '../util/id.js';
import { paths } from '../config/paths.js';

/**
 * Vault items (PLAN-passwords.md §4): the typed product layer over the raw
 * handle→secret vault. An item bundles what a human thinks of as "one
 * credential" — a site login (password + TOTP seed + domains), an API key, an
 * SSH key, a .env bag — so it can be granted to tasks as a unit.
 *
 * Metadata lives in the store's kv (like git profiles); secrets live in the
 * vault under item-scoped handles, resolved JIT through the broker after THIS
 * service's item-level capability + policy check (the broker call itself is
 * self-authorized, mirroring GitProfiles.resolveSecret — the real gate is here).
 *
 * Grants use the existing wildcard grammar (§6): a task may use an item when
 * its effective capabilities cover `use-credential:item:<id>`, one of the
 * item's `use-credential:tag:<tag>`s, or one of its
 * `use-credential:domain:<domain>`s — or when a human resolved an access
 * request for it (one-shot pass / task grant extension, §7).
 */

export type VaultItemType = 'login' | 'api-key' | 'ssh-key' | 'env' | 'passkey' | 'note';
export type VaultFieldName = 'password' | 'totp' | 'secret' | 'privateKey' | 'env' | 'passkey' | 'note';

/** The secret fields each item type may carry (write-only through the API). */
export const ITEM_FIELDS: Record<VaultItemType, VaultFieldName[]> = {
  login: ['password', 'totp'],
  'api-key': ['secret'],
  'ssh-key': ['privateKey'],
  env: ['env'],
  // A passkey stores the CDP virtual-authenticator credential as one JSON blob
  // ({credentialId, privateKey, rpId, userHandle, signCount}); §8.
  passkey: ['passkey'],
  note: ['note'],
};

export interface VaultItemPolicy {
  /** Non-revealing use (browser fill, spawn-time injection). */
  use: 'auto' | 'ask';
  /** Plaintext to the agent — the audited exception (§5C). */
  reveal: 'auto' | 'ask' | 'never';
}

/** A task may override either policy dimension for each credential it was
 * explicitly granted. Missing dimensions inherit the item's organization-wide
 * default, so later global changes still flow through to the task. */
export type VaultTaskPolicyOverrides = Record<string, Partial<VaultItemPolicy>>;

export interface VaultItem {
  id: string;
  type: VaultItemType;
  label: string;
  /** Fill/domain-grant matching; a page origin must suffix-match one (§5B). */
  domains?: string[];
  username?: string;
  tags?: string[];
  /** api-key: env var carrying the secret at spawn; ssh-key: env var carrying
   *  the materialized key file's path. Absent ⇒ not injected at spawn. */
  envVar?: string;
  /** Which secret fields currently have stored values (never the values). */
  fields: VaultFieldName[];
  policy: VaultItemPolicy;
  /** `source`: manual | connector:<name> | task:<id>. `externalId` identifies
   *  an imported connector item (and remains the legacy single write-back
   *  binding). `externalIds` records every connector an agent-created item was
   *  pushed to, so later rotations update the right entries without guessing.
   *  `syncedAt` is when the secrets were last mirrored IN, which is what a
   *  re-sync compares against the store's own change time (never `updatedAt`,
   *  which also moves when the user edits a policy here). */
  provenance: {
    source: string;
    taskId?: string;
    externalId?: string;
    externalIds?: Record<string, string>;
    at: number;
    syncedAt?: number;
  };
  updatedAt: number;
}

export type AccessMode = 'use' | 'reveal';
export type AccessStatus = 'granted' | 'needs_approval' | 'denied';

export interface CredentialAccessRequest {
  id: string;
  taskId: string;
  projectId?: string;
  itemId?: string;
  /** Set when the agent asked by site rather than by item (incl. not-in-vault). */
  domain?: string;
  field?: VaultFieldName;
  mode: AccessMode;
  /** `access` (default) = the task lacks a grant/policy approval. `reset` = the
   *  stored secret appears WRONG (login rejected it) and the agent cannot
   *  self-reset because recovery goes to the human's own inbox — fix the item
   *  (or send the reset code as a follow-up), then grant to let it retry. */
  kind?: 'access' | 'reset';
  why?: string;
  status: 'pending' | 'granted' | 'denied';
  resolution?: { action: 'once' | 'task' | 'always' | 'deny'; by: string; at: number };
  createdAt: number;
  /** Human-facing task metadata added by the gateway; never persisted in the
   * organization-scoped request record. */
  task?: { id: string; num?: number; title: string; projectId: string };
}

export interface VaultItemStore {
  kvGet(k: string): string | undefined;
  kvSet(k: string, v: string): void;
  appendAudit(entry: { principalId: string; action: string; scopeKey?: string; detail?: Record<string, unknown> }): number;
}

// Items and access requests are ORGANIZATION resources (the tenant boundary):
// one org's agents must never see another's credentials. Grants and one-shot
// passes are keyed by taskId (a task belongs to exactly one org), so they need
// no org qualifier.
const kvItems = (org: string) => `vault:items:${org}`;
const kvRequests = (org: string) => `vault:requests:${org}`;
const kvGrant = (taskId: string) => `vault:grant:${taskId}`;
const kvPasses = (taskId: string) => `vault:pass:${taskId}`;
const kvTaskPolicies = (taskId: string) => `vault:task-policy:${taskId}`;

export function itemHandle(itemId: string, field: VaultFieldName): string {
  return `item:${itemId}:${field}`;
}

/** The capability patterns that authorize using an item (§6 grant grammar). */
export function itemCaps(item: VaultItem): Capability[] {
  return [
    `use-credential:item:${item.id}`,
    ...(item.tags ?? []).map((t) => `use-credential:tag:${t}`),
    ...(item.domains ?? []).map((d) => `use-credential:domain:${d}`),
  ];
}

/** Does `host` belong to `domain` (exact or subdomain)? */
export function domainMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  const d = domain.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  return h === d || h.endsWith(`.${d}`);
}

// ── TOTP (RFC 6238, the broker-side code computation of §5B) ─────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32 TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Current TOTP code for a stored seed (accepts a bare base32 secret or an
 *  otpauth:// URI, which is what QR-code imports and connectors carry). */
export function totpCode(seed: string, nowMs = Date.now(), stepSeconds = 30, digits = 6): string {
  let secret = seed.trim();
  let step = stepSeconds;
  let len = digits;
  let algo = 'sha1';
  if (secret.startsWith('otpauth://')) {
    const u = new URL(secret);
    secret = u.searchParams.get('secret') ?? '';
    step = Number(u.searchParams.get('period') ?? step) || step;
    len = Number(u.searchParams.get('digits') ?? len) || len;
    algo = (u.searchParams.get('algorithm') ?? algo).toLowerCase();
  }
  const counter = Math.floor(nowMs / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algo, base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = ((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** len).toString().padStart(len, '0');
  return code;
}

// ── the service ──────────────────────────────────────────────────────────────

export class VaultItems {
  constructor(
    private store: VaultItemStore,
    private broker?: CredentialBroker,
    private home = paths().state,
    /** The owning organization (tenant boundary). Every item/request key is
     *  scoped to it; the gateway binds it from the caller's token org. */
    private organizationId = 'org_personal',
  ) {}

  // ── items ──
  list(): VaultItem[] {
    const raw = this.store.kvGet(kvItems(this.organizationId));
    if (!raw) return [];
    try {
      return JSON.parse(raw) as VaultItem[];
    } catch {
      return [];
    }
  }

  get(id: string): VaultItem | undefined {
    return this.list().find((i) => i.id === id);
  }

  /** Items whose `domains` cover `host` (subdomains match). */
  findByDomain(host: string): VaultItem[] {
    return this.list().filter((i) => (i.domains ?? []).some((d) => domainMatches(host, d)));
  }

  /** The item a connector previously mirrored for `externalId`, if any (§9). */
  findByExternal(source: string, externalId: string): VaultItem | undefined {
    return this.list().find((i) => i.provenance.source === source && i.provenance.externalId === externalId);
  }

  /** Internal: read a stored secret WITHOUT the capability/policy gate — for
   *  trusted host-side machinery only (connector write-back, passkey load).
   *  Never expose the result to an agent; the gated path is `resolveField`. */
  readSecret(item: VaultItem, field: VaultFieldName): string | undefined {
    if (!item.fields.includes(field)) return undefined;
    return this.requireBroker().resolve(itemHandle(item.id, field), { taskId: item.provenance.taskId, caps: [`use-credential:item:${item.id}:${field}`, `use-credential:*`] });
  }

  /**
   * Create/update an item. Sparse-update semantics throughout: secret fields
   * are write-only (a provided non-empty string replaces the vault entry;
   * absent leaves it untouched — mirrors GitProfiles.save), and on update an
   * omitted metadata field keeps its stored value (clear with '' / []).
   */
  save(args: {
    id?: string;
    type: VaultItemType;
    label?: string;
    domains?: string[];
    username?: string;
    tags?: string[];
    envVar?: string;
    policy?: Partial<VaultItemPolicy>;
    secrets?: Partial<Record<VaultFieldName, string>>;
    provenance?: { source: string; taskId?: string; externalId?: string; syncedAt?: number };
  }): VaultItem {
    if (!ITEM_FIELDS[args.type]) throw new Error(`unknown vault item type "${args.type}"`);
    const prior = args.id ? this.get(args.id) : undefined;
    if (args.id && !prior) throw new Error(`no vault item ${args.id}`);
    if (prior && prior.type !== args.type) throw new Error(`vault item ${prior.id} is a ${prior.type}, not a ${args.type}`);
    const label = args.label?.trim() || prior?.label;
    if (!label) throw new Error('a vault item needs a label');
    const id = prior?.id ?? newId('vi');
    const fields = new Set<VaultFieldName>(prior?.fields ?? []);
    for (const field of ITEM_FIELDS[args.type]) {
      const value = args.secrets?.[field];
      if (value?.trim()) {
        this.requireBroker().registerHandle(itemHandle(id, field), value);
        fields.add(field);
      }
    }
    const list = (v?: string[]) => v?.map((s) => s.trim()).filter(Boolean);
    const domains = args.domains !== undefined ? list(args.domains) : prior?.domains;
    const username = args.username !== undefined ? args.username.trim() : prior?.username;
    const tags = args.tags !== undefined ? list(args.tags) : prior?.tags;
    const envVar = args.envVar !== undefined ? args.envVar.trim() : prior?.envVar;
    const item: VaultItem = {
      id,
      type: args.type,
      label,
      ...(domains?.length ? { domains } : {}),
      ...(username ? { username } : {}),
      ...(tags?.length ? { tags } : {}),
      ...(envVar ? { envVar } : {}),
      fields: [...fields],
      policy: {
        use: args.policy?.use ?? prior?.policy.use ?? 'auto',
        reveal: args.policy?.reveal ?? prior?.policy.reveal ?? 'ask',
      },
      // Provenance is birth-data: only the mirror clock moves on a re-sync.
      provenance: prior
        ? { ...prior.provenance, ...(args.provenance?.syncedAt ? { syncedAt: args.provenance.syncedAt } : {}) }
        : { source: args.provenance?.source ?? 'manual', ...(args.provenance?.taskId ? { taskId: args.provenance.taskId } : {}), ...(args.provenance?.externalId ? { externalId: args.provenance.externalId } : {}), ...(args.provenance?.syncedAt ? { syncedAt: args.provenance.syncedAt } : {}), at: Date.now() },
      updatedAt: Date.now(),
    };
    this.store.kvSet(kvItems(this.organizationId), JSON.stringify([...this.list().filter((i) => i.id !== id), item]));
    // Key material may have changed — drop any materialized copies.
    fs.rmSync(this.keyDir(id), { recursive: true, force: true });
    return item;
  }

  /** Bind an item to a connector's external id (write-back round-trips, §9).
   *  The two-argument form preserves legacy callers/data; new write-back code
   *  supplies `connector` so multiple enabled stores retain distinct bindings.
   *  Provenance is otherwise birth-data and never mutated by `save`. */
  setExternalId(id: string, externalId: string): VaultItem;
  setExternalId(id: string, connector: string, externalId: string): VaultItem;
  setExternalId(id: string, connectorOrExternalId: string, boundExternalId?: string): VaultItem {
    const all = this.list();
    const item = all.find((i) => i.id === id);
    if (!item) throw new Error(`no vault item ${id}`);
    const connector = boundExternalId === undefined ? undefined : connectorOrExternalId;
    const externalId = boundExternalId ?? connectorOrExternalId;
    item.provenance = {
      ...item.provenance,
      // Keep the first legacy value stable for old readers. The connector map
      // is authoritative for agent-created items written to multiple stores.
      externalId: item.provenance.externalId ?? externalId,
      ...(connector
        ? { externalIds: { ...item.provenance.externalIds, [connector]: externalId } }
        : {}),
    };
    item.updatedAt = Date.now();
    this.store.kvSet(kvItems(this.organizationId), JSON.stringify(all));
    return item;
  }

  setPolicy(id: string, patch: Partial<VaultItemPolicy>): VaultItem {
    const all = this.list();
    const item = all.find((i) => i.id === id);
    if (!item) throw new Error(`no vault item ${id}`);
    item.policy = { ...item.policy, ...patch };
    item.updatedAt = Date.now();
    this.store.kvSet(kvItems(this.organizationId), JSON.stringify(all));
    return item;
  }

  delete(id: string) {
    const item = this.get(id);
    this.store.kvSet(kvItems(this.organizationId), JSON.stringify(this.list().filter((i) => i.id !== id)));
    for (const field of item?.fields ?? []) this.broker?.deleteHandle(itemHandle(id, field));
    fs.rmSync(this.keyDir(id), { recursive: true, force: true });
  }

  // ── grants: task extensions + one-shot passes (human-resolved escalations) ──

  /** Caps a human granted this task after creation (§7 approve-for-task),
   *  merged into the workflow grant at every subsequent token mint. */
  extensions(taskId: string): { cap: Capability; grantedBy: string; at: number }[] {
    const raw = this.store.kvGet(kvGrant(taskId));
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  extensionCaps(taskId: string): Capability[] {
    return this.extensions(taskId).map((e) => e.cap);
  }

  private extend(taskId: string, cap: Capability, grantedBy: string) {
    const cur = this.extensions(taskId);
    if (!cur.some((e) => e.cap === cap)) {
      this.store.kvSet(kvGrant(taskId), JSON.stringify([...cur, { cap, grantedBy, at: Date.now() }]));
    }
  }

  private passes(taskId: string): { itemId: string; mode: AccessMode }[] {
    const raw = this.store.kvGet(kvPasses(taskId));
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  private addPass(taskId: string, itemId: string, mode: AccessMode) {
    this.store.kvSet(kvPasses(taskId), JSON.stringify([...this.passes(taskId), { itemId, mode }]));
  }

  private takePass(taskId: string, itemId: string, mode: AccessMode, consume: boolean): boolean {
    const all = this.passes(taskId);
    // A reveal pass also covers non-revealing use of the same item.
    const idx = all.findIndex((p) => p.itemId === itemId && (p.mode === mode || p.mode === 'reveal'));
    if (idx < 0) return false;
    if (consume) {
      all.splice(idx, 1);
      this.store.kvSet(kvPasses(taskId), JSON.stringify(all));
    }
    return true;
  }

  /** Sparse task-local policy overrides. Invalid persisted values are ignored so
   * a damaged/migrated KV entry cannot accidentally weaken a credential policy. */
  taskPolicies(taskId: string): VaultTaskPolicyOverrides {
    const raw = this.store.kvGet(kvTaskPolicies(taskId));
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: VaultTaskPolicyOverrides = {};
      for (const [itemId, value] of Object.entries(parsed ?? {})) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const policy = value as Partial<VaultItemPolicy>;
        const clean: Partial<VaultItemPolicy> = {};
        if (policy.use === 'auto' || policy.use === 'ask') clean.use = policy.use;
        if (policy.reveal === 'auto' || policy.reveal === 'ask' || policy.reveal === 'never') clean.reveal = policy.reveal;
        if (Object.keys(clean).length) out[itemId] = clean;
      }
      return out;
    } catch {
      return {};
    }
  }

  setTaskPolicies(taskId: string, policies: VaultTaskPolicyOverrides): VaultTaskPolicyOverrides {
    const clean: VaultTaskPolicyOverrides = {};
    for (const [itemId, policy] of Object.entries(policies ?? {})) {
      const next: Partial<VaultItemPolicy> = {};
      if (policy?.use === 'auto' || policy?.use === 'ask') next.use = policy.use;
      if (policy?.reveal === 'auto' || policy?.reveal === 'ask' || policy?.reveal === 'never') next.reveal = policy.reveal;
      if (Object.keys(next).length) clean[itemId] = next;
    }
    this.store.kvSet(kvTaskPolicies(taskId), JSON.stringify(clean));
    return clean;
  }

  effectivePolicy(taskId: string | undefined, item: VaultItem): VaultItemPolicy {
    const override = taskId ? this.taskPolicies(taskId)[item.id] : undefined;
    return { ...item.policy, ...override };
  }

  // ── access decision (§5/§7): capability coverage, then item policy ──

  covered(caps: Capability[], taskId: string | undefined, item: VaultItem): boolean {
    // A task owns credentials it creates. This is deliberately only grant
    // coverage: the item's use/reveal policy still applies, so a same-task
    // credential with reveal=ask remains approval-gated for plaintext access.
    if (taskId && item.provenance.taskId === taskId) return true;
    const all = taskId ? [...caps, ...this.extensionCaps(taskId)] : caps;
    return itemCaps(item).some((c) => allows(all, c));
  }

  /**
   * Decide one access. A one-shot pass (a human approved exactly this) grants
   * regardless of coverage/policy and is consumed when `consume` is set — set
   * it on the actual use, not on peeks.
   */
  access(caps: Capability[], taskId: string | undefined, item: VaultItem, mode: AccessMode, opts: { consume?: boolean } = {}): { status: AccessStatus; reason?: string } {
    if (taskId && this.takePass(taskId, item.id, mode, opts.consume ?? false)) return { status: 'granted' };
    const policyForTask = this.effectivePolicy(taskId, item);
    if (mode === 'reveal' && policyForTask.reveal === 'never') return { status: 'denied', reason: `"${item.label}" is never revealed in plaintext (${taskId ? 'task' : 'item'} policy)` };
    if (!this.covered(caps, taskId, item)) return { status: 'needs_approval', reason: 'this task was not granted this credential' };
    const policy = mode === 'reveal' ? policyForTask.reveal : policyForTask.use;
    if (policy !== 'auto') return { status: 'needs_approval', reason: `"${item.label}" requires per-${mode} approval (${taskId ? 'task' : 'item'} policy)` };
    return { status: 'granted' };
  }

  /** Resolve a secret field AFTER an access decision granted it. Audited. */
  resolveField(item: VaultItem, field: VaultFieldName, ctx: { taskId?: string; principal?: string; mode: AccessMode }): string {
    if (!item.fields.includes(field)) throw new Error(`item "${item.label}" has no ${field}`);
    const handle = itemHandle(item.id, field);
    const secret = this.requireBroker().resolve(handle, { taskId: ctx.taskId, caps: [`use-credential:${handle}`] });
    this.store.appendAudit({
      principalId: ctx.principal ?? (ctx.taskId ? `task:${ctx.taskId}` : 'system'),
      action: ctx.mode === 'reveal' ? 'vault.revealed' : 'vault.used',
      detail: { itemId: item.id, label: item.label, field, ...(ctx.taskId ? { taskId: ctx.taskId } : {}) },
    });
    return secret;
  }

  /** The current TOTP code for a login item (never the seed). */
  totp(item: VaultItem, ctx: { taskId?: string; principal?: string }): string {
    return totpCode(this.resolveField(item, 'totp', { ...ctx, mode: 'use' }));
  }

  // ── spawn-time materialization (§5A) ──
  /**
   * Env for a task's agent subprocess from its granted `auto` items: `env`
   * items contribute their KEY=VALUE lines, `api-key` items their secret under
   * `envVar`, `ssh-key` items a 0600 key file path under `envVar`. `ask` items
   * and unattached items never inject ambiently.
   */
  envFor(taskId: string, caps: Capability[]): Record<string, string> {
    const env: Record<string, string> = {};
    for (const item of this.list()) {
      if (!['env', 'api-key', 'ssh-key'].includes(item.type)) continue;
      if (this.access(caps, taskId, item, 'use').status !== 'granted') continue;
      try {
        if (item.type === 'env' && item.fields.includes('env')) {
          for (const line of this.resolveField(item, 'env', { taskId, mode: 'use' }).split('\n')) {
            const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
            if (!m || line.trim().startsWith('#')) continue;
            env[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, '$2');
          }
        } else if (item.type === 'api-key' && item.envVar && item.fields.includes('secret')) {
          env[item.envVar] = this.resolveField(item, 'secret', { taskId, mode: 'use' });
        } else if (item.type === 'ssh-key' && item.envVar && item.fields.includes('privateKey')) {
          env[item.envVar] = this.materializeKey(item, { taskId });
        }
      } catch (e) {
        // One corrupted/missing secret must not block every turn granted to it;
        // the failure is audited instead of silently skipped.
        this.store.appendAudit({ principalId: `task:${taskId}`, action: 'vault.inject.failed', detail: { itemId: item.id, error: e instanceof Error ? e.message : String(e) } });
      }
    }
    return env;
  }

  // ── access requests (§7 — the request_spend-shaped escalation) ──

  requests(filter: { taskId?: string; status?: CredentialAccessRequest['status'] } = {}): CredentialAccessRequest[] {
    const raw = this.store.kvGet(kvRequests(this.organizationId));
    let all: CredentialAccessRequest[] = [];
    try {
      all = raw ? JSON.parse(raw) : [];
    } catch {
      all = [];
    }
    return all.filter((r) => (!filter.taskId || r.taskId === filter.taskId) && (!filter.status || r.status === filter.status));
  }

  private saveRequests(all: CredentialAccessRequest[]) {
    this.store.kvSet(kvRequests(this.organizationId), JSON.stringify(all));
  }

  /**
   * An agent asks for access (§7). Outcomes mirror request_spend:
   * granted | needs_approval (request parked for a human) | not_in_vault
   * (no matching item; parked with the domain so the human can add one or say
   * "create it yourself") | denied (hard policy no).
   */
  request(args: { taskId: string; projectId?: string; caps: Capability[]; itemId?: string; domain?: string; field?: VaultFieldName; mode?: AccessMode; kind?: 'access' | 'reset'; why?: string }): { status: AccessStatus | 'not_in_vault'; reason?: string; requestId?: string; itemId?: string } {
    const mode: AccessMode = args.mode === 'reveal' ? 'reveal' : 'use';
    const kind = args.kind === 'reset' ? 'reset' : 'access';
    const item = args.itemId
      ? this.get(args.itemId)
      : args.domain
        ? this.findByDomain(args.domain)[0]
        : undefined;
    if (!item) {
      if (!args.itemId && !args.domain) throw new Error('itemId or domain required');
      const parked = this.park({ ...args, mode, kind, itemId: undefined });
      this.store.appendAudit({ principalId: `task:${args.taskId}`, action: 'vault.requested', detail: { domain: args.domain, itemId: args.itemId, mode, kind, status: 'not_in_vault' } });
      return { status: 'not_in_vault', reason: args.itemId ? `no vault item ${args.itemId}` : `no vault item matches ${args.domain}`, requestId: parked.id };
    }
    // A reset report ALWAYS parks for the human — the whole point is that the
    // stored secret failed, so "granted" access to a wrong password is useless.
    if (kind !== 'reset') {
      const decision = this.access(args.caps, args.taskId, item, mode);
      if (decision.status === 'granted') return { status: 'granted', itemId: item.id };
      if (decision.status === 'denied') {
        this.store.appendAudit({ principalId: `task:${args.taskId}`, action: 'vault.requested', detail: { itemId: item.id, mode, status: 'denied' } });
        return { status: 'denied', reason: decision.reason, itemId: item.id };
      }
    }
    const parked = this.park({ ...args, mode, kind, itemId: item.id });
    this.store.appendAudit({ principalId: `task:${args.taskId}`, action: 'vault.requested', detail: { itemId: item.id, mode, kind, status: 'needs_approval' } });
    return { status: 'needs_approval', reason: kind === 'reset' ? `reported invalid: "${item.label}" — the human will update it (or send a reset code)` : undefined, requestId: parked.id, itemId: item.id };
  }

  private park(args: { taskId: string; projectId?: string; itemId?: string; domain?: string; field?: VaultFieldName; mode: AccessMode; kind?: 'access' | 'reset'; why?: string }): CredentialAccessRequest {
    const all = this.requests();
    const existing = all.find((r) => r.status === 'pending' && r.taskId === args.taskId && r.mode === args.mode
      && (r.kind ?? 'access') === (args.kind ?? 'access')
      && (args.itemId ? r.itemId === args.itemId : !r.itemId && r.domain === args.domain));
    if (existing) return existing;
    const req: CredentialAccessRequest = {
      id: newId('vreq'),
      taskId: args.taskId,
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.itemId ? { itemId: args.itemId } : {}),
      ...(args.domain ? { domain: args.domain } : {}),
      ...(args.field ? { field: args.field } : {}),
      mode: args.mode,
      ...(args.kind === 'reset' ? { kind: 'reset' as const } : {}),
      ...(args.why ? { why: args.why } : {}),
      status: 'pending',
      createdAt: Date.now(),
    };
    this.saveRequests([...all, req]);
    return req;
  }

  /**
   * A human resolves a parked request (§7): `once` (one-shot pass), `task`
   * (pass + a durable `use-credential:item:` extension of the task grant,
   * grantor recorded), `always` (extension + the item's policy flips to auto
   * for that mode), or `deny`. A not-in-vault request must be bound to an item
   * (created meanwhile) via `itemId` before a grant action.
   */
  resolve(requestId: string, args: { action: 'once' | 'task' | 'always' | 'deny'; by: string; itemId?: string }): CredentialAccessRequest {
    const all = this.requests();
    const req = all.find((r) => r.id === requestId);
    if (!req) throw new Error(`no credential request ${requestId}`);
    if (req.status !== 'pending') throw new Error(`request ${requestId} is already ${req.status}`);
    if (args.action !== 'deny') {
      const itemId = req.itemId ?? args.itemId;
      const item = itemId ? this.get(itemId) : undefined;
      if (!item) throw new Error('bind this request to a vault item first (add the item, then resolve with its itemId)');
      req.itemId = item.id;
      this.addPass(req.taskId, item.id, req.mode);
      if (args.action === 'task' || args.action === 'always') this.extend(req.taskId, `use-credential:item:${item.id}`, args.by);
      if (args.action === 'always') {
        this.setPolicy(item.id, req.mode === 'reveal' ? { reveal: 'auto' } : { use: 'auto' });
      }
    }
    req.status = args.action === 'deny' ? 'denied' : 'granted';
    req.resolution = { action: args.action, by: args.by, at: Date.now() };
    this.saveRequests(all);
    this.store.appendAudit({ principalId: args.by, action: 'vault.request.resolved', detail: { requestId, taskId: req.taskId, itemId: req.itemId, action: args.action } });
    return req;
  }

  /** Write a key to a 0600 file (idempotent per save) and return its path. */
  private materializeKey(item: VaultItem, ctx: { taskId?: string }): string {
    const file = path.join(this.keyDir(item.id), 'key');
    if (!fs.existsSync(file)) {
      const secret = this.resolveField(item, 'privateKey', { ...ctx, mode: 'use' });
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, secret.endsWith('\n') ? secret : `${secret}\n`, { mode: 0o600 });
    }
    return file;
  }

  private keyDir(id: string): string {
    return path.join(this.home, 'vault-items', id);
  }

  private requireBroker(): CredentialBroker {
    if (!this.broker) throw new Error('vault items: no credential broker configured');
    return this.broker;
  }
}

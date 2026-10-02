import type { World } from '../world/types.js';
import { decayVaultUsage, type VaultUsage, type VaultSelectionUsage } from '../util/vault-usage.js';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { CredentialBroker } from './broker.js';
import { deleteItemConnectorWrites } from './connector-writes.js';
import { Capability, allows } from '../platform/capabilities.js';
import { newId } from '../util/id.js';
import { parseSavedSession, sessionDomainError } from './browser-session.js';
import { paths } from '../config/paths.js';

/**
 * Vault items (wiki plans/PLAN-passwords §4): the typed product layer over the raw
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

export type VaultItemType = 'login' | 'api-key' | 'ssh-key' | 'env' | 'passkey' | 'session' | 'note';
export type VaultFieldName = 'password' | 'totp' | 'secret' | 'privateKey' | 'env' | 'passkey' | 'session' | 'note';

/** The secret fields each item type may carry. Item CRUD never returns their
 * values; the gateway's separate human-administrator inspection route resolves
 * one field explicitly and records the reveal in the audit log. */
export const ITEM_FIELDS: Record<VaultItemType, VaultFieldName[]> = {
  login: ['password', 'totp', 'note'],
  'api-key': ['secret'],
  'ssh-key': ['privateKey'],
  env: ['env'],
  // A passkey stores the CDP virtual-authenticator credential as one JSON blob
  // ({credentialId, privateKey, rpId, userHandle, signCount}); §8.
  passkey: ['passkey'],
  // A signed-in browser session: the site's cookies and localStorage, as
  // browser-session.ts captures them; one JSON blob.
  session: ['session'],
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

const USE_RANK: Record<VaultItemPolicy['use'], number> = { auto: 0, ask: 1 };
const REVEAL_RANK: Record<VaultItemPolicy['reveal'], number> = { auto: 0, ask: 1, never: 2 };

/** Does `next` make `prior` easier to obtain than its policy allows? */
export function loosensPolicy(prior: VaultItemPolicy, next: Partial<VaultItemPolicy> | undefined): boolean {
  return (next?.use !== undefined && USE_RANK[next.use] < USE_RANK[prior.use])
    || (next?.reveal !== undefined && REVEAL_RANK[next.reveal] < REVEAL_RANK[prior.reveal]);
}

/**
 * An edit that would hand out an existing item's secret without revealing it
 * outright, and therefore needs vault read access (`credential:reveal`):
 * loosening its policy, or adding a site its password can be filled into
 * (a page the editor controls reads the filled value back).
 */
export function weakensProtection(prior: VaultItem,
  next: { policy?: Partial<VaultItemPolicy>; domains?: string[] }): string | undefined {
  if (loosensPolicy(prior.policy, next.policy)) return `loosen the policy of "${prior.label}"`;
  const known = new Set((prior.domains ?? []).map((domain) => domain.trim().toLowerCase()));
  if (next.domains?.some((domain) => domain.trim() && !known.has(domain.trim().toLowerCase())))
    return `add sites "${prior.label}" can be filled into`;
  return undefined;
}

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
  /** session: in at most one task's browser at a time, for sites that rotate
   *  their tokens on use and would sign the other copies out (session-holds.ts). */
  exclusive?: boolean;
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
    /** Import format marker: older pass entries need one complete notes refresh. */
    passNotesVersion?: number;
    connectorFormatVersion?: number;
    syncedAt?: number;
    /** Source fingerprint recorded with the last successful import. */
    sourceRevision?: string;
  };
  /** Successful field accesses; absent on items created before usage tracking. */
  useCount?: number;
  frecencyScore?: number;
  frecencyUpdatedAt?: number;
  lastUsedAt?: number;
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
  /** Serialize compound reads and writes on the same transaction connection. */
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  vaultSelectionHistory?(organizationId: string, now: number): Promise<Record<string, VaultSelectionUsage>>;
  vaultUsageHistory?(itemIds: string[], now: number): (Record<string, VaultUsage>) | Promise<Record<string, VaultUsage>>;
  kvGet(k: string): (string | undefined) | Promise<string | undefined>;
  kvSet(k: string, v: string): (void) | Promise<void>;
  kvDelete?(k: string): (void) | Promise<void>;
  /** One range read of every key under a prefix; stores without it are read per key. */
  kvEntries?(prefix: string): Promise<Array<{ key: string; value: string }>>;
  appendAudit(entry: { principalId: string; action: string; scopeKey?: string; detail?: Record<string, unknown> }): (number) | Promise<number>;
}

// Items and access requests are ORGANIZATION resources (the tenant boundary):
// one org's agents must never see another's credentials. Grants and one-shot
// passes are keyed by taskId (a task belongs to exactly one org), so they need
// no org qualifier.
const kvItems = (org: string) => `vault:items:${org}`;
const kvRequests = (org: string) => `vault:requests:${org}`;
/** Access statistics live beside the index, one key per item: bumping them on
 *  every access used to rewrite the whole organization index (AU-25). */
export const kvUsagePrefix = (org: string) => `vault:usage:${org}:`;
type ItemUsage = Pick<VaultItem, 'useCount' | 'frecencyScore' | 'frecencyUpdatedAt' | 'lastUsedAt'>;

/** A damaged index must never read as empty: the next write would replace
 *  every entry with just the new one (AU-28). Fail closed; the stored bytes
 *  stay untouched for recovery. */
function parseIndex<T>(raw: string, what: string): T {
  try { return JSON.parse(raw) as T; }
  catch { throw new Error(`${what} is unreadable, so it was left untouched; restore it from a backup`); }
}
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
    if (u.hostname !== 'totp') throw new Error('Only TOTP otpauth URIs are supported');
    secret = u.searchParams.get('secret') ?? '';
    step = Number(u.searchParams.get('period') ?? step) || step;
    len = Number(u.searchParams.get('digits') ?? len) || len;
    algo = (u.searchParams.get('algorithm') ?? algo).toLowerCase();
  }
  // The URI comes from an import; bound it before it reaches the HMAC.
  if (!['sha1', 'sha256', 'sha512'].includes(algo)) throw new Error(`unsupported TOTP algorithm "${algo}"`);
  if (!Number.isInteger(step) || step < 5 || step > 300) throw new Error(`unsupported TOTP period ${step}`);
  if (!Number.isInteger(len) || len < 4 || len > 10) throw new Error(`unsupported TOTP digit count ${len}`);
  if (!secret) throw new Error('TOTP seed is empty');
  const counter = Math.floor(nowMs / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algo, base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = ((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** len).toString().padStart(len, '0');
  return code;
}

// ── the service ────────────────────────────────────────────────────���─────────

const TURN_KEYS = '.karmax-injection/vault';

const TURN_KEY_PREFIX = 'karmax-turn-keys-';

/** A private host directory for one turn's key files, named by its owner's pid
 * so a later sweep can tell a crashed turn's plaintext keys from a live one's. */
export function turnKeyDirectory(tmp = os.tmpdir()): string {
  return fs.mkdtempSync(path.join(tmp, `${TURN_KEY_PREFIX}${process.pid}-`));
}

/** Remove the turn key directories whose process is gone (a crash skipped
 * `removeTurnKeys`). Run at primary and worker start; returns how many. */
export function sweepTurnKeys(tmp = os.tmpdir()): number {
  let swept = 0;
  for (const name of fs.readdirSync(tmp)) {
    if (!name.startsWith(TURN_KEY_PREFIX)) continue;
    const pid = Number(/^karmax-turn-keys-(\d+)-/.exec(name)?.[1]);
    if (pid > 0) {
      try { process.kill(pid, 0); continue; } // alive (or not ours to signal): a live turn may own it
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') continue; }
    }
    fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
    swept++;
  }
  return swept;
}

/** Delete the key files `envFor` wrote for a turn that has ended. */
export async function removeTurnKeys(keys: World | string): Promise<void> {
  if (typeof keys === 'string') { fs.rmSync(keys, { recursive: true, force: true }); return; }
  const removed = await keys.exec('rm', ['-rf', '--', path.posix.join(keys.handle.root, TURN_KEYS)]);
  if (removed.code !== 0) throw new Error('could not remove the turn\'s key files');
}

/** Remove every host copy of a vault key left by versions before AU-33. */
export function removeLegacyKeyCopies(home = paths().state): void {
  fs.rmSync(path.join(home, 'vault-items'), { recursive: true, force: true });
}

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
  async list(): Promise<VaultItem[]> {
    return this.store.transaction(async () => {
    const raw = (await this.store.kvGet(kvItems(this.organizationId)));
    if (!raw) return [];
    const items = parseIndex<VaultItem[]>(raw, 'The vault item index');
    const legacy = items.filter((item) => item.frecencyUpdatedAt === undefined);
    if (legacy.length) {
      const now = Date.now();
      const history = (await this.store.vaultUsageHistory?.(legacy.map((item) => item.id), now)) ?? {};
      for (const item of legacy) {
        // Prefer dated audit evidence. Without it, preserve the old count as
        // the initial score, but do not invent a last-use timestamp.
        Object.assign(item, history[item.id] ?? {
          useCount: item.useCount ?? 0, frecencyScore: item.useCount ?? 0, frecencyUpdatedAt: now,
        });
      }
      (await this.store.kvSet(kvItems(this.organizationId), JSON.stringify(items)));
    }
    const prefix = kvUsagePrefix(this.organizationId);
    const usage = this.store.kvEntries ? await this.store.kvEntries(prefix)
      : (await Promise.all(items.map(async (item) => ({ key: prefix + item.id, value: await this.store.kvGet(prefix + item.id) }))))
        .filter((row): row is { key: string; value: string } => row.value !== undefined);
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const { key, value } of usage) {
      const item = byId.get(key.slice(prefix.length));
      if (item) Object.assign(item, JSON.parse(value) as ItemUsage);
    }
    return items;

    });
  }

  /** Presentation metadata kept separate from access statistics and secrets. */
  async listForSelection(): Promise<(VaultItem & VaultSelectionUsage)[]> {
    const items = await this.list();
    const now = Date.now();
    const usage = await this.store.vaultSelectionHistory?.(this.organizationId, now) ?? {};
    return items.map((item) => ({ ...item, ...(usage[item.id] ?? {
      selectionCount: 0, selectionFrecencyScore: 0, selectionUpdatedAt: now,
    }) }));
  }

  async get(id: string): Promise<VaultItem | undefined> {
    return (await this.list()).find((i) => i.id === id);
  }

  /** Items whose `domains` cover `host` (subdomains match). */
  async findByDomain(host: string): Promise<VaultItem[]> {
    return (await this.list()).filter((i) => (i.domains ?? []).some((d) => domainMatches(host, d)));
  }

  /** The item a connector previously mirrored for `externalId`, if any (§9). */
  async findByExternal(source: string, externalId: string): Promise<VaultItem | undefined> {
    return (await this.list()).find((i) => i.provenance.source === source && i.provenance.externalId === externalId);
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
  async save(args: {
    id?: string;
    type: VaultItemType;
    label?: string;
    domains?: string[];
    username?: string;
    tags?: string[];
    envVar?: string;
    exclusive?: boolean;
    policy?: Partial<VaultItemPolicy>;
    secrets?: Partial<Record<VaultFieldName, string>>;
    /** Internal connector snapshot: remove fields absent from the source. */
    replaceSecrets?: boolean;
    provenance?: { source: string; taskId?: string; externalId?: string; passNotesVersion?: number; connectorFormatVersion?: number; syncedAt?: number; sourceRevision?: string };
  }): Promise<VaultItem> {
    return this.store.transaction(async () => {
    if (!ITEM_FIELDS[args.type]) throw new Error(`unknown vault item type "${args.type}"`);
    const prior = args.id ? (await this.get(args.id)) : undefined;
    if (args.id && !prior) throw new Error(`no vault item ${args.id}`);
    if (prior && prior.type !== args.type) throw new Error(`vault item ${prior.id} is a ${prior.type}, not a ${args.type}`);
    const label = args.label?.trim() || prior?.label;
    if (!label) throw new Error('a vault item needs a label');
    if (!prior && (await this.list()).length >= 1000) throw new Error('organization vault item quota reached (1000)');
    if (Buffer.byteLength(JSON.stringify(args), 'utf8') > 65_536) throw new Error('vault item exceeds size limit (64 KiB)');
    if (args.type === 'note' && !args.replaceSecrets && args.secrets?.note !== undefined && !args.secrets.note.trim())
      throw new Error('a standalone note cannot be empty');
    if (args.type === 'session') {
      if (args.secrets?.session?.trim()) parseSavedSession(args.secrets.session);
      const domains = args.domains ?? prior?.domains ?? [];
      if (!domains.length) throw new Error('a saved session needs the site\'s domain');
      for (const domain of domains) { const error = sessionDomainError(domain); if (error) throw new Error(error); }
    }
    const id = prior?.id ?? newId('vi');
    const fields = new Set<VaultFieldName>(prior?.fields ?? []);
    if (args.replaceSecrets) for (const field of fields) {
      if (args.secrets?.[field] === undefined || (field !== 'note' && !args.secrets[field]?.trim())) {
        (await this.requireBroker().deleteHandle(itemHandle(id, field)));
        fields.delete(field);
      }
    }
    for (const field of ITEM_FIELDS[args.type]) {
      const value = args.secrets?.[field];
      // Pass notes are a complete snapshot, including an empty replacement.
      if (field === 'note' && value !== undefined) {
        (await this.requireBroker().registerHandle(itemHandle(id, field), value));
        fields.add(field);
        continue;
      }
      if (value?.trim()) {
        (await this.requireBroker().registerHandle(itemHandle(id, field), value));
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
      ...(args.type === 'session' && (args.exclusive ?? prior?.exclusive) ? { exclusive: true } : {}),
      fields: [...fields],
      policy: {
        use: args.policy?.use ?? prior?.policy.use ?? 'auto',
        reveal: args.policy?.reveal ?? prior?.policy.reveal ?? 'ask',
      },
      // Preserve origin identity; only import format and mirror clock change on sync.
      provenance: prior
        ? { ...prior.provenance, ...(args.provenance?.syncedAt !== undefined ? { sourceRevision: args.provenance.sourceRevision } : {}), ...(args.provenance?.connectorFormatVersion ? {connectorFormatVersion:args.provenance.connectorFormatVersion} : {}), ...(args.provenance?.passNotesVersion ? { passNotesVersion: args.provenance.passNotesVersion } : {}), ...(args.provenance?.syncedAt ? { syncedAt: args.provenance.syncedAt } : {}) }
        : { source: args.provenance?.source ?? 'manual', ...(args.provenance?.sourceRevision !== undefined ? { sourceRevision: args.provenance.sourceRevision } : {}), ...(args.provenance?.taskId ? { taskId: args.provenance.taskId } : {}), ...(args.provenance?.externalId ? { externalId: args.provenance.externalId } : {}), ...(args.provenance?.connectorFormatVersion ? {connectorFormatVersion:args.provenance.connectorFormatVersion} : {}), ...(args.provenance?.passNotesVersion ? { passNotesVersion: args.provenance.passNotesVersion } : {}), ...(args.provenance?.syncedAt ? { syncedAt: args.provenance.syncedAt } : {}), at: Date.now() },
      useCount: prior?.useCount ?? 0,
      frecencyScore: prior?.frecencyScore ?? 0,
      frecencyUpdatedAt: prior?.frecencyUpdatedAt ?? Date.now(),
      ...(prior?.lastUsedAt !== undefined ? { lastUsedAt: prior.lastUsedAt } : {}),
      // Also serves as an optimistic revision for in-flight connector pulls.
      updatedAt: Math.max(Date.now(), (prior?.updatedAt ?? 0) + 1),
    };
    (await this.store.kvSet(kvItems(this.organizationId), JSON.stringify([...(await this.list()).filter((i) => i.id !== id), item])));
    // Key material may have changed — drop any materialized copies.
    fs.rmSync(this.keyDir(id), { recursive: true, force: true });
    return item;

    });
  }

  /** Bind an item to a connector's external id (write-back round-trips, §9).
   *  The two-argument form preserves legacy callers/data; new write-back code
   *  supplies `connector` so multiple enabled stores retain distinct bindings.
   *  Provenance is otherwise birth-data and never mutated by `save`. */
  setExternalId(id: string, externalId: string): Promise<VaultItem>;
  setExternalId(id: string, connector: string, externalId: string): Promise<VaultItem>;
  async setExternalId(id: string, connectorOrExternalId: string, boundExternalId?: string): Promise<VaultItem> {
    return this.store.transaction(async () => {
    const all = (await this.list());
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
    item.updatedAt = Math.max(Date.now(), item.updatedAt + 1);
    (await this.store.kvSet(kvItems(this.organizationId), JSON.stringify(all)));
    return item;

    });
  }

  async setPolicy(id: string, patch: Partial<VaultItemPolicy>): Promise<VaultItem> {
    return this.store.transaction(async () => {
    const all = (await this.list());
    const item = all.find((i) => i.id === id);
    if (!item) throw new Error(`no vault item ${id}`);
    item.policy = { ...item.policy, ...patch };
    item.updatedAt = Math.max(Date.now(), item.updatedAt + 1);
    (await this.store.kvSet(kvItems(this.organizationId), JSON.stringify(all)));
    return item;

    });
  }

  async delete(id: string) {
    return this.store.transaction(async () => {
    const item = (await this.get(id));
    (await deleteItemConnectorWrites(this.store, this.broker, this.organizationId, id));
    for (const field of item?.fields ?? []) (await this.broker?.deleteHandle(itemHandle(id, field)));
    fs.rmSync(this.keyDir(id), { recursive: true, force: true });
    (await this.store.kvSet(kvItems(this.organizationId), JSON.stringify((await this.list()).filter((i) => i.id !== id))));
    (await this.store.kvDelete?.(kvUsagePrefix(this.organizationId) + id));

    });
  }

  // ── grants: task extensions + one-shot passes (human-resolved escalations) ──

  /** Caps a human granted this task after creation (§7 approve-for-task),
   *  merged into the workflow grant at every subsequent token mint. */
  async extensions(taskId: string): Promise<{ cap: Capability; grantedBy: string; at: number }[]> {
    const raw = (await this.store.kvGet(kvGrant(taskId)));
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  async extensionCaps(taskId: string): Promise<Capability[]> {
    return (await this.extensions(taskId)).map((e) => e.cap);
  }

  private async extend(taskId: string, cap: Capability, grantedBy: string) {
    return this.store.transaction(async () => {
    const cur = (await this.extensions(taskId));
    if (!cur.some((e) => e.cap === cap)) {
      (await this.store.kvSet(kvGrant(taskId), JSON.stringify([...cur, { cap, grantedBy, at: Date.now() }])));
    }

    });
  }

  private async passes(taskId: string): Promise<{ itemId: string; mode: AccessMode }[]> {
    const raw = (await this.store.kvGet(kvPasses(taskId)));
    if (!raw) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  private async addPass(taskId: string, itemId: string, mode: AccessMode) {
    return this.store.transaction(async () => {
    (await this.store.kvSet(kvPasses(taskId), JSON.stringify([...(await this.passes(taskId)), { itemId, mode }])));

    });
  }

  private async takePass(taskId: string, itemId: string, mode: AccessMode, consume: boolean): Promise<boolean> {
    return this.store.transaction(async () => {
    const all = (await this.passes(taskId));
    // A reveal pass also covers non-revealing use of the same item.
    const idx = all.findIndex((p) => p.itemId === itemId && (p.mode === mode || p.mode === 'reveal'));
    if (idx < 0) return false;
    if (consume) {
      all.splice(idx, 1);
      (await this.store.kvSet(kvPasses(taskId), JSON.stringify(all)));
    }
    return true;

    });
  }

  /** Sparse task-local policy overrides. Invalid persisted values are ignored so
   * a damaged/migrated KV entry cannot accidentally weaken a credential policy. */
  async taskPolicies(taskId: string): Promise<VaultTaskPolicyOverrides> {
    const raw = (await this.store.kvGet(kvTaskPolicies(taskId)));
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

  async setTaskPolicies(taskId: string, policies: VaultTaskPolicyOverrides): Promise<VaultTaskPolicyOverrides> {
    const clean: VaultTaskPolicyOverrides = {};
    for (const [itemId, policy] of Object.entries(policies ?? {})) {
      const next: Partial<VaultItemPolicy> = {};
      if (policy?.use === 'auto' || policy?.use === 'ask') next.use = policy.use;
      if (policy?.reveal === 'auto' || policy?.reveal === 'ask' || policy?.reveal === 'never') next.reveal = policy.reveal;
      if (Object.keys(next).length) clean[itemId] = next;
    }
    (await this.store.kvSet(kvTaskPolicies(taskId), JSON.stringify(clean)));
    return clean;
  }

  async effectivePolicy(taskId: string | undefined, item: VaultItem): Promise<VaultItemPolicy> {
    const override = taskId ? (await this.taskPolicies(taskId))[item.id] : undefined;
    return { ...item.policy, ...override };
  }

  // ── access decision (§5/§7): capability coverage, then item policy ──

  async covered(caps: Capability[], taskId: string | undefined, item: VaultItem): Promise<boolean> {
    // A task owns credentials it creates. This is deliberately only grant
    // coverage: the item's use/reveal policy still applies, so a same-task
    // credential with reveal=ask remains approval-gated for plaintext access.
    if (taskId && item.provenance.taskId === taskId) return true;
    const all = taskId ? [...caps, ...(await this.extensionCaps(taskId))] : caps;
    return itemCaps(item).some((c) => allows(all, c));
  }

  /**
   * Decide one access. A one-shot pass (a human approved exactly this) grants
   * regardless of coverage/policy and is consumed when `consume` is set — set
   * it on the actual use, not on peeks.
   *
   * `ambient` opts OUT of the pass entirely, for standing spawn-time injection
   * (`envFor`). A one-shot pass answers one request; it is not consumed by an
   * ambient injection and must not authorize one, or a `once` approval would
   * silently become permanent — `envFor` runs every turn, so the un-consumed pass
   * re-granted the secret into the agent's environment for the task's whole life.
   * `resolve`'s `task` action is the one that means "for the rest of this task",
   * and it grants a durable capability extension that `covered()` picks up here.
   */
  async access(
    caps: Capability[], taskId: string | undefined, item: VaultItem, mode: AccessMode,
    opts: { consume?: boolean; ambient?: boolean } = {},
  ): Promise<{ status: AccessStatus; reason?: string }> {
    // `never` is absolute: it is checked before a one-shot pass so an approval
    // that was parked for another reason (a reset report, a mode the human did
    // not look at) can never be spent on plaintext.
    const policyForTask = (await this.effectivePolicy(taskId, item));
    if (mode === 'reveal' && policyForTask.reveal === 'never') return { status: 'denied', reason: `"${item.label}" is never revealed in plaintext (${taskId ? 'task' : 'item'} policy)` };
    if (taskId && !opts.ambient && (await this.takePass(taskId, item.id, mode, opts.consume ?? false))) return { status: 'granted' };
    if (!(await this.covered(caps, taskId, item))) return { status: 'needs_approval', reason: 'this task was not granted this credential' };
    const policy = mode === 'reveal' ? policyForTask.reveal : policyForTask.use;
    if (policy !== 'auto') return { status: 'needs_approval', reason: `"${item.label}" requires per-${mode} approval (${taskId ? 'task' : 'item'} policy)` };
    return { status: 'granted' };
  }

  /** Resolve a secret field AFTER an access decision granted it. Audited. */
  async resolveField(item: VaultItem, field: VaultFieldName, ctx: { taskId?: string; principal?: string; mode: AccessMode }): Promise<string> {
    return this.store.transaction(async () => {
    if (!item.fields.includes(field)) throw new Error(`item "${item.label}" has no ${field}`);
    const handle = itemHandle(item.id, field);
    const secret = this.requireBroker().resolve(handle, { taskId: ctx.taskId, caps: [`use-credential:${handle}`] });
    // Read fresh usage: callers may reuse an item across several fields. An item
    // without its own usage key yet reads the index, which also migrates legacy
    // history before this access is audited, so it is counted only once.
    const usageKey = kvUsagePrefix(this.organizationId) + item.id;
    const stored = (await this.store.kvGet(usageKey));
    const current: ItemUsage | undefined = stored ? JSON.parse(stored) : (await this.list()).find((candidate) => candidate.id === item.id);
    (await this.store.appendAudit({
      principalId: ctx.principal ?? (ctx.taskId ? `task:${ctx.taskId}` : 'system'),
      action: ctx.mode === 'reveal' ? 'vault.revealed' : 'vault.used',
      detail: { itemId: item.id, label: item.label, field, ...(ctx.taskId ? { taskId: ctx.taskId } : {}) },
    }));
    // Usage must not move updatedAt, which connector sync uses for edits.
    if (current) {
      const now = Date.now();
      const usage: ItemUsage = {
        useCount: (current.useCount ?? 0) + 1,
        frecencyScore: decayVaultUsage(current.frecencyScore ?? 0, current.frecencyUpdatedAt ?? now, now) + 1,
        frecencyUpdatedAt: now,
        lastUsedAt: now,
      };
      (await this.store.kvSet(usageKey, JSON.stringify(usage)));
    }
    return secret;

    });
  }

  /** The current TOTP code for a login item (never the seed). */
  async totp(item: VaultItem, ctx: { taskId?: string; principal?: string }): Promise<string> {
    return totpCode((await this.resolveField(item, 'totp', { ...ctx, mode: 'use' })));
  }

  // ── spawn-time materialization (§5A) ──
  /**
   * Env for a task's agent subprocess from its granted `auto` items: `env`
   * items contribute their KEY=VALUE lines, `api-key` items their secret under
   * `envVar`, `ssh-key` items a 0600 key file path under `envVar`. `ask` items
   * and unattached items never inject ambiently. Key files are written to
   * `keys` — the receiving world, or a host directory — for one turn, and
   * `removeTurnKeys` deletes them when it ends (AU-33).
   */
  async envFor(taskId: string, caps: Capability[], keys?: World | string): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const item of (await this.list())) {
      if (!['env', 'api-key', 'ssh-key'].includes(item.type)) continue;
      if (item.provenance.taskId && item.provenance.taskId !== taskId
        && !caps.includes(`use-credential:item:${item.id}`)) continue;
      if ((await this.access(caps, taskId, item, 'use', { ambient: true })).status !== 'granted') continue;
      try {
        if (item.type === 'env' && item.fields.includes('env')) {
          for (const line of (await this.resolveField(item, 'env', { taskId, mode: 'use' })).split('\n')) {
            const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
            if (!m || line.trim().startsWith('#')) continue;
            env[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, '$2');
          }
        } else if (item.type === 'api-key' && item.envVar && item.fields.includes('secret')) {
          env[item.envVar] = (await this.resolveField(item, 'secret', { taskId, mode: 'use' }));
        } else if (item.type === 'ssh-key' && item.envVar && item.fields.includes('privateKey')) {
          env[item.envVar] = (await this.materializeKey(item, { taskId }, keys));
        }
      } catch (e) {
        // One corrupted/missing secret must not block every turn granted to it;
        // the failure is audited instead of silently skipped.
        (await this.store.appendAudit({ principalId: `task:${taskId}`, action: 'vault.inject.failed', detail: { itemId: item.id, error: e instanceof Error ? e.message : String(e) } }));
      }
    }
    return env;
  }

  // ── access requests (§7 — the request_spend-shaped escalation) ──

  async requests(filter: { taskId?: string; status?: CredentialAccessRequest['status'] } = {}): Promise<CredentialAccessRequest[]> {
    const raw = (await this.store.kvGet(kvRequests(this.organizationId)));
    const all: CredentialAccessRequest[] = raw ? parseIndex(raw, 'The credential request list') : [];
    return all.filter((r) => (!filter.taskId || r.taskId === filter.taskId) && (!filter.status || r.status === filter.status));
  }

  private async saveRequests(all: CredentialAccessRequest[]) {
    (await this.store.kvSet(kvRequests(this.organizationId), JSON.stringify(all)));
  }

  /**
   * An agent asks for access (§7). Outcomes mirror request_spend:
   * granted | needs_approval (request parked for a human) | not_in_vault
   * (no matching item; parked with the domain so the human can add one or say
   * "create it yourself") | denied (hard policy no).
   */
  async request(args: { taskId: string; projectId?: string; caps: Capability[]; itemId?: string; domain?: string; field?: VaultFieldName; mode?: AccessMode; kind?: 'access' | 'reset'; why?: string }): Promise<{ status: AccessStatus | 'not_in_vault'; reason?: string; requestId?: string; itemId?: string }> {
    const mode: AccessMode = args.mode === 'reveal' ? 'reveal' : 'use';
    const kind = args.kind === 'reset' ? 'reset' : 'access';
    const item = args.itemId
      ? (await this.get(args.itemId))
      : args.domain
        ? (await this.findByDomain(args.domain))[0]
        : undefined;
    if (!item) {
      if (!args.itemId && !args.domain) throw new Error('itemId or domain required');
      const parked = (await this.park({ ...args, mode, kind, itemId: undefined }));
      (await this.store.appendAudit({ principalId: `task:${args.taskId}`, action: 'vault.requested', detail: { domain: args.domain, itemId: args.itemId, mode, kind, status: 'not_in_vault' } }));
      return { status: 'not_in_vault', reason: args.itemId ? `no vault item ${args.itemId}` : `no vault item matches ${args.domain}`, requestId: parked.id };
    }
    // A reset report ALWAYS parks for the human — the whole point is that the
    // stored secret failed, so "granted" access to a wrong password is useless.
    if (kind !== 'reset') {
      const decision = (await this.access(args.caps, args.taskId, item, mode));
      if (decision.status === 'granted') return { status: 'granted', itemId: item.id };
      if (decision.status === 'denied') {
        (await this.store.appendAudit({ principalId: `task:${args.taskId}`, action: 'vault.requested', detail: { itemId: item.id, mode, status: 'denied' } }));
        return { status: 'denied', reason: decision.reason, itemId: item.id };
      }
    }
    const parked = (await this.park({ ...args, mode, kind, itemId: item.id }));
    (await this.store.appendAudit({ principalId: `task:${args.taskId}`, action: 'vault.requested', detail: { itemId: item.id, mode, kind, status: 'needs_approval' } }));
    return { status: 'needs_approval', reason: kind === 'reset' ? `reported invalid: "${item.label}" — the human will update it (or send a reset code)` : undefined, requestId: parked.id, itemId: item.id };
  }

  private async park(args: { taskId: string; projectId?: string; itemId?: string; domain?: string; field?: VaultFieldName; mode: AccessMode; kind?: 'access' | 'reset'; why?: string }): Promise<CredentialAccessRequest> {
    return this.store.transaction(async () => {
    const all = (await this.requests());
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
    (await this.saveRequests([...all, req]));
    return req;

    });
  }

  /**
   * A human resolves a parked request (§7): `once` (one-shot pass), `task`
   * (pass + a durable `use-credential:item:` extension of the task grant,
   * grantor recorded), `always` (extension + the item's policy flips to auto
   * for that mode), or `deny`. A not-in-vault request must be bound to an item
   * (created meanwhile) via `itemId` before a grant action.
   */
  async resolve(requestId: string, args: { action: 'once' | 'task' | 'always' | 'deny'; by: string; itemId?: string }): Promise<CredentialAccessRequest> {
    return this.store.transaction(async () => {
    const all = (await this.requests());
    const req = all.find((r) => r.id === requestId);
    if (!req) throw new Error(`no credential request ${requestId}`);
    if (req.status !== 'pending') throw new Error(`request ${requestId} is already ${req.status}`);
    if (args.action !== 'deny') {
      const itemId = req.itemId ?? args.itemId;
      const item = itemId ? (await this.get(itemId)) : undefined;
      if (!item) throw new Error('bind this request to a vault item first (add the item, then resolve with its itemId)');
      req.itemId = item.id;
      (await this.addPass(req.taskId, item.id, req.mode));
      if (args.action === 'task' || args.action === 'always') (await this.extend(req.taskId, `use-credential:item:${item.id}`, args.by));
      if (args.action === 'always') {
        (await this.setPolicy(item.id, req.mode === 'reveal' ? { reveal: 'auto' } : { use: 'auto' }));
      }
    }
    req.status = args.action === 'deny' ? 'denied' : 'granted';
    req.resolution = { action: args.action, by: args.by, at: Date.now() };
    (await this.saveRequests(all));
    (await this.store.appendAudit({ principalId: args.by, action: 'vault.request.resolved', detail: { requestId, taskId: req.taskId, itemId: req.itemId, action: args.action } }));
    return req;

    });
  }

  /** Write a key to a 0600 file for this turn and return its path. */
  private async materializeKey(item: VaultItem, ctx: { taskId?: string }, keys?: World | string): Promise<string> {
    if (!keys) throw new Error('no turn directory for key files');
    const secret = await this.resolveField(item, 'privateKey', { ...ctx, mode: 'use' });
    const content = secret.endsWith('\n') ? secret : `${secret}\n`;
    const name = `${crypto.createHash('sha256').update(item.id).digest('hex')}.key`;
    if (typeof keys === 'string') {
      fs.mkdirSync(keys, { recursive: true, mode: 0o700 });
      const file = path.join(keys, name);
      fs.writeFileSync(file, content, { mode: 0o600 });
      return file;
    }
    const relative = `${TURN_KEYS}/${name}`;
    await keys.writeFile(relative, content);
    const file = path.posix.join(keys.handle.root, relative);
    const mode = await keys.exec('chmod', ['600', file]);
    if (mode.code !== 0) throw new Error('could not restrict remote key file permissions');
    return file;
  }

  /** Copies of keys that versions before AU-33 kept on the host until the item
   *  was deleted; nothing reads them any more. */
  private keyDir(id: string): string {
    return path.join(this.home, 'vault-items', id);
  }

  private requireBroker(): CredentialBroker {
    if (!this.broker) throw new Error('vault items: no credential broker configured');
    return this.broker;
  }
}

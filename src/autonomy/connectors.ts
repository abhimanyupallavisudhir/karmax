import * as __asyncCollections from '../util/async-collections.js';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { hostLocal } from '../config/deployment.js';
import { paths } from '../config/paths.js';
import type { Repository } from '../domain/types.js';
import { git, gitOrThrow, isolatedGitEnvironment } from '../world/git.js';
import { materializeGitCredential, type GitCredential } from '../world/git-credential.js';
import { CredentialBroker } from './broker.js';
import { organizationScope } from './vault-keys.js';
import { connectorOutboxKey, readConnectorWrites, type PendingConnectorWrite } from './connector-writes.js';
import { GitProfiles } from './git-profiles.js';
import { ITEM_FIELDS, VaultItems, VaultItemType, VaultFieldName, VaultItemPolicy } from './vault-items.js';
import { unlockAgeIdentity, validateNativeAgeIdentity } from './age-identity.js';
import { hostOf, passEntryMetadata } from './pass-path.js';
import { passSecrets, updatePassSecret, createPassItem, parsePassItem } from './pass-format.js';
import { BRAND } from '../domain/brand.js';
export { passSecrets } from './pass-format.js';

const pexec = promisify(execFile);

// Hash ciphertext only: never persist a password hash in plaintext metadata.
function encryptedRevision(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * External password-store connectors (wiki plans/PLAN-passwords §9). The karmax vault
 * is the runtime source of truth; a connector is a **selective mirror**, not a
 * live proxy: the user connects a store, picks items/folders to pull in, and
 * (opt-in) lets agent-created items push back. Runtime credential resolution
 * always hits the karmax vault, so a connector being down never blocks agents
 * and a cloud world needs no path to the user's desktop.
 *
 * Self-hosted connectors shell out to the store's own CLI (`bw`, `op`, `pass`).
 * A managed cell never has a tenant-owned CLI profile: its 1Password connector
 * uses the official service-account SDK; Bitwarden is withheld because a
 * `BW_SESSION` unlocks one particular local CLI profile rather than identifying
 * a remotely usable account. Git-backed pass is the hosted alternative to a
 * local `~/.password-store`. Availability failures are data, not route errors.
 */

export interface ConnectorInfo {
  name: string;
  label: string;
  /** Present, authenticated, and usable by this deployment right now? */
  available: boolean;
  detail: string;
  /** Can this connector create new external entries? Updates are separate. */
  canPush: boolean;
  /** Field updates do not imply support for creating new entries. */
  canUpdate?: boolean;
  /** Selects the connection form without exposing connector secrets. */
  setup?: 'secret' | 'git-pass';
  checks?: Array<{ store: string; entry?: string; read: 'verified' | 'empty'; encryption: boolean; push: boolean }>;
}

/** One external entry, normalized to karmax's vocabulary (no secrets yet). */
export interface ExternalItem {
  externalId: string;
  type: VaultItemType;
  label: string;
  username?: string;
  domains?: string[];
  /** Grouping for the import UI (folder/collection/vault); '' = ungrouped. */
  folder?: string;
  /** Secret fields available to pull (so the UI can preview what arrives). */
  fields: VaultFieldName[];
  /** When the entry last changed in the external store (epoch ms), when the
   *  store can say. A re-sync skips entries that have not changed since they
   *  were last mirrored — decrypting a whole `pass` tree costs seconds per
   *  entry, so re-importing everything must not re-read everything. */
  changedAt?: number;
  /** Stable fingerprint of the encrypted source; independent of checkout clocks. */
  revision?: string;
}

/** An external entry WITH its secrets, ready to write into the vault. */
export interface ExternalSecretItem extends ExternalItem {
  secrets: Partial<Record<VaultFieldName, string>>;
}

/**
 * What a pull produced. Failures are DATA, not exceptions: one undecryptable
 * entry must not throw away the other 500 credentials of a bulk import (and
 * with them the many minutes the user waited for it).
 */
export interface PullResult {
  items: ExternalSecretItem[];
  failures: Array<{ externalId: string; error: string }>;
}

export interface CredentialConnector {
  readonly name: string;
  describe(): Promise<ConnectorInfo>;
  /** Enumerate mirrorable items (metadata only). */
  list(): Promise<ExternalItem[]>;
  /** Validate a candidate without publishing it to concurrent sync operations. */
  validateSecret?(secret: string): Promise<ConnectorInfo>;
  /** Fetch the selected items with their secrets. */
  pull(externalIds: string[]): Promise<PullResult>;
  /** Optional write-back of an agent-created item (creates a NEW entry). */
  push?(item: ExternalSecretItem): Promise<{ externalId: string }>;
  /**
   * Optional field-level update of an EXISTING entry, preserving everything
   * else (notes, other fields). This is how a rotated password propagates back
   * without the blind-overwrite data loss that `push` avoids by only creating.
   */
  updateSecret?(externalId: string, field: VaultFieldName, value: string): Promise<void>;
}

/** Injectable runner so tests can stub the CLIs. Returns {stdout} or throws. */
export type Exec = (cmd: string, args: string[], opts?: { env?: Record<string, string>; input?: string }) => Promise<string>;
/** A connector's secret, read from the vault when it is needed. */
export type SecretSource = () => string | undefined | Promise<string | undefined>;

const realExec: Exec = async (cmd, args, opts) => {
  const child = pexec(cmd, args, { env: { ...process.env, ...(opts?.env ?? {}) }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  child.child.stdin?.end(opts?.input);
  return (await child).stdout;
};

// ── Bitwarden (`bw` CLI, zero-knowledge; session key held in the vault) ───────

export class BitwardenConnector implements CredentialConnector {
  readonly name = 'bitwarden';
  constructor(private sessionKey: SecretSource, private exec: Exec = realExec) {}
  private async env(): Promise<Record<string, string>> {
    const key = await this.sessionKey();
    return key ? { BW_SESSION: key } : {};
  }
  async describe(): Promise<ConnectorInfo> {
    if (!await this.sessionKey()) return {
      name: this.name,
      label: 'Bitwarden',
      available: false,
      canPush: false, canUpdate: true,
      detail: 'needs the `bw` CLI on this host.',
    };
    try {
      const status = JSON.parse(await this.exec('bw', ['status'], { env: await this.env() }));
      const unlocked = status?.status === 'unlocked';
      return { name: this.name, label: 'Bitwarden', available: unlocked, canPush: false, canUpdate: true,
        detail: unlocked ? 'ready' : 'The Bitwarden session key is invalid or expired.' };
    } catch {
      return { name: this.name, label: 'Bitwarden', available: false, canPush: false, canUpdate: true,
        detail: 'needs the `bw` CLI on this host.' };
    }
  }
  async list(): Promise<ExternalItem[]> {
    const [items, folders] = await Promise.all([
      this.exec('bw', ['list', 'items'], { env: await this.env() }).then((s) => JSON.parse(s) as any[]),
      this.exec('bw', ['list', 'folders'], { env: await this.env() }).then((s) => JSON.parse(s) as any[]).catch(() => []),
    ]);
    const folderName = new Map<string, string>(folders.map((f: any) => [f.id, f.name]));
    return items.map((it) => normalizeBitwarden(it, folderName.get(it.folderId) ?? '')).filter((x): x is ExternalItem => !!x);
  }
  async pull(externalIds: string[]): Promise<PullResult> {
    const wanted = new Set(externalIds);
    const items = JSON.parse(await this.exec('bw', ['list', 'items'], { env: await this.env() })) as any[];
    const out: ExternalSecretItem[] = [];
    for (const it of items) {
      if (!wanted.has(it.id)) continue;
      const norm = normalizeBitwarden(it, '');
      if (!norm) continue;
      const secrets: Partial<Record<VaultFieldName, string>> = {};
      if (it.login?.password) secrets.password = it.login.password;
      if (it.login?.totp) secrets.totp = it.login.totp;
      if (it.notes) secrets.note = it.notes;
      out.push({ ...norm, secrets });
    }
    return { items: out, failures: [] };
  }
  /** Field-level edit: read the item JSON, change one field, `bw edit` it back —
   *  every other field (username, notes, uris, totp) is preserved. */
  async updateSecret(externalId: string, field: VaultFieldName, value: string): Promise<void> {
    const item = JSON.parse(await this.exec('bw', ['get', 'item', externalId], { env: await this.env() }));
    item.login = item.login ?? {};
    if (field === 'password') item.login.password = value;
    else if (field === 'totp') item.login.totp = value;
    else if (field === 'note') item.notes = value;
    else throw new Error(`Bitwarden write-back does not support the "${field}" field`);
    // The item JSON now carries the new secret: hand it over on stdin, never in
    // argv, where every process of the same user could read it from /proc.
    const encoded = Buffer.from(JSON.stringify(item)).toString('base64');
    await this.exec('bw', ['edit', 'item', externalId], { env: await this.env(), input: encoded });
  }
}

function normalizeBitwarden(it: any, folder: string): ExternalItem | undefined {
  const changedAt = timestampOf(it.revisionDate);
  if (it.type === 1 && it.login) {
    const domains = (it.login.uris ?? []).map((u: any) => hostOf(u?.uri)).filter(Boolean);
    return { externalId: it.id, type: 'login', label: it.name ?? 'login', username: it.login.username ?? undefined,
      domains, folder, fields: ['password', ...(it.login.totp ? (['totp'] as VaultFieldName[]) : []), ...(it.notes ? (['note'] as VaultFieldName[]) : [])], ...changedAt };
  }
  if (it.type === 2) return { externalId: it.id, type: 'note', label: it.name ?? 'note', folder, fields: ['note'], ...changedAt };
  return undefined; // cards/identities out of scope for v1
}

/** `{ changedAt }` for a store's revision date, or `{}` when it has none. */
function timestampOf(value: unknown): { changedAt?: number } {
  const ms = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  return Number.isFinite(ms) ? { changedAt: ms } : {};
}

// ── 1Password (`op` CLI for self-hosted installs) ─────────────────────────────

export class OnePasswordConnector implements CredentialConnector {
  readonly name = '1password';
  constructor(
    private token: SecretSource,
    private exec: Exec = realExec,
    private writer: OnePasswordSdkConnector = new OnePasswordSdkConnector(token),
  ) {}
  private async env(): Promise<Record<string, string>> {
    const t = await this.token();
    return t ? { OP_SERVICE_ACCOUNT_TOKEN: t } : {};
  }
  async describe(): Promise<ConnectorInfo> {
    if (!await this.token())
      return {
        name: this.name,
        label: '1Password',
        available: false,
        canPush: false,
        canUpdate: true,
        detail: 'needs the `op` CLI on this host.',
      };
    try {
      await this.exec('op', ['whoami', '--format=json'], { env: await this.env() });
      return { name: this.name, label: '1Password', available: true, canPush: false, canUpdate: true, detail: 'ready' };
    } catch {
      return {
        name: this.name,
        label: '1Password',
        available: false,
        canPush: false,
        canUpdate: true,
        detail: 'Check the service-account token and make sure the `op` CLI is installed.',
      };
    }
  }
  async list(): Promise<ExternalItem[]> {
    const items = JSON.parse(await this.exec('op', ['item', 'list', '--format=json'], { env: await this.env() })) as any[];
    return items.map((it) => ({
      externalId: it.id,
      type: categoryType(it.category),
      label: it.title ?? 'item',
      domains: (it.urls ?? []).map((u: any) => hostOf(u?.href)).filter(Boolean),
      folder: it.vault?.name ?? '',
      fields: itemFieldsFor(categoryType(it.category)),
      ...timestampOf(it.updated_at),
    }));
  }
  async pull(externalIds: string[]): Promise<PullResult> {
    const out: ExternalSecretItem[] = [];
    const failures: PullResult['failures'] = [];
    for (const id of externalIds) {
      let full: any;
      try {
        full = JSON.parse(await this.exec('op', ['item', 'get', id, '--format=json'], { env: await this.env() }));
      } catch (e) {
        failures.push({ externalId: id, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const type = categoryType(full.category);
      const byId = new Map<string, any>((full.fields ?? []).map((f: any) => [f.id, f]));
      const val = (fid: string) => byId.get(fid)?.value;
      const secrets: Partial<Record<VaultFieldName, string>> = {};
      if (type === 'login' && val('password')) secrets.password = val('password');
      const otp = (full.fields ?? []).find((f: any) => f.type === 'OTP');
      if (otp?.value) secrets.totp = otp.value;
      if (type === 'api-key') secrets.secret = val('credential') ?? val('password');
      if (type === 'ssh-key') {
        const key = val('private_key') ?? val('privateKey') ?? val('private key');
        if (key) secrets.privateKey = key;
      }
      // CLI 2 represents notes as a field. Its presence is authoritative even
      // when cleared; only older payloads fall back to the top-level property.
      const note = byId.has('notesPlain') ? val('notesPlain') : full.notesPlain;
      if ((type === 'login' || type === 'note') && typeof note === 'string') secrets.note = note;
      out.push({
        externalId: id,
        type,
        label: full.title ?? 'item',
        username: val('username'),
        domains: (full.urls ?? []).map((u: any) => hostOf(u?.href)).filter(Boolean),
        fields: Object.keys(secrets) as VaultFieldName[],
        secrets,
      });
    }
    return { items: out, failures };
  }
  /** Write-back edits one field through the SDK, with the same service-account
   * token (AU-29). `op item edit` accepts a new value only as an argv
   * assignment, readable by every local process from /proc, and its JSON
   * template form replaces the whole item, losing what the CLI's export cannot
   * round-trip (notably passkeys). The CLI names the vault holding the item.
   *
   * The SDK models no passkeys either, and its edit is a get-then-put of the
   * whole item. An item that may hold one keeps the CLI's in-place assignment:
   * the value is briefly visible in argv, which is better than losing a passkey. */
  async updateSecret(externalId: string, field: VaultFieldName, value: string): Promise<void> {
    const item = JSON.parse(await this.exec('op', ['item', 'get', externalId, '--format=json'], { env: await this.env() }));
    if (typeof item?.vault?.id !== 'string') throw new Error(`1Password item "${externalId}" has no vault`);
    const inPlace = () => this.assign(externalId, field, value);
    if (mentionsPasskey(item)) return inPlace();
    await this.writer.updateSecretIn(item.vault.id, externalId, field, value, inPlace);
  }

  private async assign(externalId: string, field: VaultFieldName, value: string): Promise<void> {
    const assignment =
      field === 'password' ? `password=${value}`
        : field === 'secret' ? `credential=${value}`
          : field === 'totp' ? `one-time password[otp]=${value}`
            : field === 'note' ? `notesPlain=${value}`
              : field === 'privateKey' ? `private_key=${value}`
                : undefined;
    if (!assignment) throw new Error(`1Password write-back does not support the "${field}" field`);
    await this.exec('op', ['item', 'edit', externalId, assignment], { env: await this.env() });
  }
}

/**
 * Narrow structural view of the official SDK. Keeping this interface here
 * makes the connector cheap to unit-test and keeps vendor types from leaking
 * into the rest of the credential-broker contract.
 */
export interface OnePasswordSdkClient {
  vaults: {
    list(params?: { decryptDetails?: boolean }): Promise<Array<{ id: string; title: string }>>;
  };
  items: {
    list(vaultId: string): Promise<any[]>;
    get(vaultId: string, itemId: string): Promise<any>;
    put(item: any): Promise<any>;
  };
}

export type OnePasswordClientFactory = (token: string) => Promise<OnePasswordSdkClient>;

const createOnePasswordClient: OnePasswordClientFactory = async (token) => {
  const sdk = await import('@1password/sdk');
  return sdk.createClient({
    auth: token,
    integrationName: BRAND,
    integrationVersion: '1.0.0',
  });
};

/**
 * Managed-hosting implementation. A service-account token is a complete,
 * least-privilege remote credential, so each connector instance can create an
 * isolated SDK client without reading or writing a profile in the host home.
 */
export class OnePasswordSdkConnector implements CredentialConnector {
  readonly name = '1password';
  private clientPromise?: Promise<OnePasswordSdkClient>;
  private catalogPromise?: Promise<Array<{ vault: { id: string; title: string }; item: any }>>;

  constructor(
    private token: SecretSource,
    private createClient: OnePasswordClientFactory = createOnePasswordClient,
  ) {}

  private async client(supplied?: string): Promise<OnePasswordSdkClient> {
    const token = supplied ?? await this.token();
    if (!token) throw new Error('no 1Password service-account token is connected');
    return this.clientPromise ??= this.createClient(token);
  }

  private async catalog(): Promise<Array<{ vault: { id: string; title: string }; item: any }>> {
    return this.catalogPromise ??= (async () => {
      const client = await this.client();
      const vaults = await client.vaults.list({ decryptDetails: true });
      const groups = await Promise.all(vaults.map(async (vault) =>
        (await client.items.list(vault.id)).map((item) => ({ vault, item }))));
      return groups.flat();
    })();
  }

  private async location(externalId: string): Promise<[vaultId: string, itemId: string]> {
    // Item IDs are what the previous `op` connector persisted. Keep that
    // stable across the hosted migration; the SDK's required vault ID is
    // transport metadata, not part of provenance identity.
    const matches = (await this.catalog()).filter(({ item }) => item.id === externalId);
    if (matches.length !== 1) {
      const why = matches.length ? 'is ambiguous across vaults' : 'was not found';
      throw new Error(`1Password item "${externalId}" ${why}`);
    }
    return [matches[0]!.vault.id, externalId];
  }

  async describe(): Promise<ConnectorInfo> {
    const token = await this.token();
    if (!token) return {
      name: this.name,
      label: '1Password',
      available: false,
      canPush: false, canUpdate: true,
      detail: 'Enter a 1Password service-account token.',
    };
    try {
      await (await this.client(token)).vaults.list({ decryptDetails: true });
      return {
        name: this.name,
        label: '1Password',
        available: true,
        canPush: false, canUpdate: true,
        detail: 'service account connected through the 1Password SDK',
      };
    } catch {
      return {
        name: this.name,
        label: '1Password',
        available: false,
        canPush: false, canUpdate: true,
        detail: 'the 1Password service-account token is invalid or unavailable',
      };
    }
  }

  async list(): Promise<ExternalItem[]> {
    return (await this.catalog()).map(({ vault, item }) => normalizeOnePasswordSdk(item, vault));
  }

  async pull(externalIds: string[]): Promise<PullResult> {
    const client = await this.client();
    const items: ExternalSecretItem[] = [];
    const failures: PullResult['failures'] = [];
    for (const externalId of externalIds) {
      try {
        const [vaultId, itemId] = await this.location(externalId);
        const item = await client.items.get(vaultId, itemId);
        items.push(onePasswordSdkSecret(item, externalId));
      } catch (e) {
        failures.push({ externalId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { items, failures };
  }

  async updateSecret(externalId: string, field: VaultFieldName, value: string): Promise<void> {
    const [vaultId, itemId] = await this.location(externalId);
    await this.updateSecretIn(vaultId, itemId, field, value);
  }

  /** `unmodelled` edits an item holding data the SDK cannot represent (a
   * passkey comes back `Unsupported`), which a put could drop; without it
   * such an item is refused and its write goes to review. */
  async updateSecretIn(vaultId: string, itemId: string, field: VaultFieldName, value: string,
    unmodelled?: () => Promise<void>): Promise<void> {
    const client = await this.client();
    const item = await client.items.get(vaultId, itemId);
    if (item.category === 'Unsupported' || (item.fields ?? []).some((candidate: any) => candidate.fieldType === 'Unsupported')) {
      if (unmodelled) return unmodelled();
      throw new Error('1Password item holds data the SDK cannot rewrite safely (such as a passkey); update it in 1Password');
    }
    if (field === 'note') {
      item.notes = value;
      await client.items.put(item);
      return;
    }
    const target = (item.fields ?? []).find((candidate: any) => onePasswordField(candidate, field));
    if (!target && field === 'totp') {
      // As `op item edit … 'one-time password[otp]=…'` did: add the field.
      const sectionId = 'totpsection';
      if (!(item.sections ?? []).some((section: any) => section.id === sectionId))
        item.sections = [...(item.sections ?? []), { id: sectionId, title: '' }];
      item.fields = [...(item.fields ?? []), { id: 'onetimepassword', title: 'one-time password', sectionId, fieldType: 'Totp', value }];
      await client.items.put(item);
      return;
    }
    if (!target) throw new Error(`1Password item does not contain a writable "${field}" field`);
    item.fields = item.fields.map((candidate: any) =>
      candidate === target ? { ...candidate, value } : candidate);
    await client.items.put(item);
  }
}

function normalizeOnePasswordSdk(item: any, vault: { id: string; title: string }): ExternalItem {
  const type = categoryType(item.category);
  return {
    externalId: item.id,
    type,
    label: item.title ?? 'item',
    domains: (item.websites ?? []).map((website: any) => hostOf(website?.url)).filter(Boolean),
    folder: vault.title,
    fields: itemFieldsFor(type),
    ...timestampOf(item.updatedAt),
  };
}

function onePasswordSdkSecret(item: any, externalId: string): ExternalSecretItem {
  const type = categoryType(item.category);
  const fields = item.fields ?? [];
  const value = (id: string) => fields.find((field: any) => field.id === id)?.value;
  const secrets: Partial<Record<VaultFieldName, string>> = {};
  if (type === 'login' && value('password')) secrets.password = value('password');
  const otp = fields.find((field: any) => field.fieldType === 'Totp' || field.type === 'OTP');
  if (otp?.value) secrets.totp = otp.value;
  if (type === 'api-key') secrets.secret = value('credential') ?? value('password');
  if (type === 'ssh-key') {
    const key = fields.find((field: any) => field.fieldType === 'SshKey')?.value
      ?? value('private_key') ?? value('privateKey') ?? value('private key');
    if (key) secrets.privateKey = key;
  }
  if ((type === 'note' || type === 'login') && item.notes) secrets.note = item.notes;
  return {
    externalId,
    type,
    label: item.title ?? 'item',
    username: value('username'),
    domains: (item.websites ?? []).map((website: any) => hostOf(website?.url)).filter(Boolean),
    fields: Object.keys(secrets) as VaultFieldName[],
    secrets,
  };
}

/** Does the CLI's view of an item show a passkey anywhere? */
function mentionsPasskey(item: unknown): boolean {
  return /passkey/i.test(JSON.stringify(item, (key, value) => key === 'value' ? undefined : value));
}

function onePasswordField(field: any, target: VaultFieldName): boolean {
  if (target === 'password') return field.id === 'password';
  if (target === 'secret') return field.id === 'credential' || field.id === 'password';
  if (target === 'totp') return field.fieldType === 'Totp' || field.type === 'OTP';
  if (target === 'privateKey') return field.fieldType === 'SshKey'
    || field.id === 'private_key' || field.id === 'privateKey' || field.id === 'private key';
  return false;
}

function categoryType(category: string): VaultItemType {
  switch (category) {
    case 'API_CREDENTIAL':
    case 'ApiCredentials':
      return 'api-key';
    case 'SSH_KEY':
    case 'SshKey':
      return 'ssh-key';
    case 'SECURE_NOTE':
    case 'SecureNote':
      return 'note';
    default: return 'login';
  }
}
function itemFieldsFor(type: VaultItemType): VaultFieldName[] {
  return type === 'login' ? ['password'] : [...ITEM_FIELDS[type]];
}

/** Folder of entries the vault exports into a password store. Earlier releases
 * exported under `karmax/`; those entries keep their identity. */
const PASS_EXPORT_FOLDER = BRAND;
const PASS_EXPORT_FOLDERS = [PASS_EXPORT_FOLDER, 'karmax'];
const PASS_EXPORT_IDENTITY = new RegExp(`^(?:${PASS_EXPORT_FOLDERS.join('|')})/[A-Za-z0-9._-]+$`);
const isPassExport = (externalId: string) => PASS_EXPORT_FOLDERS.some((folder) => externalId.startsWith(`${folder}/`));

/** A preview hint for typed exports; decryption remains authoritative. */
function passPathType(externalId: string): VaultItemType {
  const type=isPassExport(externalId) ? externalId.split('.').at(-1) : undefined;
  return type && Object.hasOwn(ITEM_FIELDS,type) ? type as VaultItemType : 'login';
}

// ── unix `pass` (GPG tree; the self-hosted / host-fallback spirit) ────────────

export class PassConnector implements CredentialConnector {
  readonly name = 'pass';
  constructor(
    private exec: Exec = realExec,
    private storeDir = path.resolve(process.env.PASSWORD_STORE_DIR || path.join(os.homedir(), '.password-store')),
  ) {}
  storeIdentity(): string {
    return fs.existsSync(this.storeDir) ? fs.realpathSync(this.storeDir) : this.storeDir;
  }
  private run: Exec = (cmd, args, opts) =>
    this.exec(cmd, args, { ...opts, env: { ...opts?.env, PASSWORD_STORE_DIR: this.storeDir } });
  async describe(): Promise<ConnectorInfo> {
    try {
      await this.run('pass', ['ls']);
      return { name: this.name, label: 'unix pass', available: true, canPush: true, detail: 'password store present' };
    } catch {
      return {
        name: this.name,
        label: 'unix pass',
        available: false,
        canPush: false,
        detail: 'the `pass` CLI / store is not set up (self-hosted only)',
      };
    }
  }
  async list(): Promise<ExternalItem[]> {
    return (await this.entries()).map((entry) => {
      const slash = entry.lastIndexOf('/');
      const { domain, username } = passEntryMetadata(entry);
      const type = passPathType(entry);
      return {
        externalId: entry,
        type,
        label: slash >= 0 ? entry.slice(slash + 1) : entry,
        folder: slash >= 0 ? entry.slice(0, slash) : '',
        domains: domain ? [domain] : [],
        ...(username ? { username } : {}),
        fields: itemFieldsFor(type),
        ...this.sourceState(entry),
      };
    });
  }
  async pull(externalIds: string[]): Promise<PullResult> {
    // Treat the store itself as the authority, not ids posted back by the UI.
    // Besides preventing stale/tampered selections from reaching `pass show`,
    // this keeps non-GPG files out of the import execution path as well as the
    // preview.
    const entries = new Set(await this.entries());
    const out: ExternalSecretItem[] = [];
    const failures: PullResult['failures'] = [];
    for (const id of externalIds) {
      if (!entries.has(id)) continue;
      const revision = this.sourceState(id);
      let body: string;
      try {
        body = await this.run('pass', ['show', id]);
      } catch (e) {
        // A single entry that will not decrypt (wrong recipient, a gpg hiccup)
        // is reported and skipped; the rest of the import still lands.
        failures.push({ externalId: id, error: gpgHint(e) });
        continue;
      }
      try {
        const parsed = parsePassItem(body);
        const secrets = parsed.secrets;
        const { domain, username } = passEntryMetadata(id);
        out.push({
          externalId: id,
          label: id,
          domains: domain ? [domain] : [],
          ...(username ? { username } : {}),
          ...parsed,
          fields: Object.keys(secrets) as VaultFieldName[],
          secrets,
          ...revision,
        });
      } catch {
        failures.push({ externalId: id, error: 'Invalid password-store item format' });
      }
    }
    return { items: out, failures };
  }
  /** Read the encrypted file's identity without invoking GPG. */
  private sourceState(entry: string): { changedAt?: number; revision?: string } {
    try {
      const file = path.join(this.storeDir, `${entry}.gpg`);
      return { changedAt: fs.statSync(file).mtimeMs, revision: encryptedRevision(file) };
    } catch {
      return {};
    }
  }
  private async entries(): Promise<string[]> {
    // `pass ls` cannot be used for enumeration: its `tree` output includes
    // arbitrary files from the store and merely removes `.gpg` from encrypted
    // entries. Inspect the filenames instead, so `notes.md` is ignored while a
    // legitimate password named `notes.md.gpg` is exposed as `notes.md`.
    const raw = await this.run('find', [
      '-L',
      this.storeDir,
      '-path',
      path.join(this.storeDir, '.git'),
      '-prune',
      '-o',
      '-type',
      'd',
      '-name',
      '.karmax-export-*',
      '-prune',
      '-o',
      '-type',
      'f',
      '-name',
      '*.gpg',
      '-print0',
    ]);
    return parsePassFiles(raw, this.storeDir);
  }
  /**
   * Field-level update that preserves the notes on lines 2+: read the whole
   * entry, update the password or token while preserving its format, and re-insert.
   */
  async updateSecret(externalId: string, field: VaultFieldName, value: string): Promise<void> {
    return serializeGitPass(`local-pass:${this.storeDir}`, async () => {
      let body: string;
      try {
        body = await this.run('pass', ['show', externalId]);
      } catch (e) {
        throw new Error(gpgHint(e));
      }
      const updated = updatePassSecret(body, field, value);
      try {
        await this.run('pass', ['insert', '-m', '-f', externalId], { input: updated });
      } catch (e) {
        throw new Error(gpgHint(e));
      }
    });
  }

  /**
   * Write-back creates a NEW entry (under `tavya/…`) for an agent-created
   * credential — it never overwrites an entry that was mirrored IN, because a
   * real `pass` file usually carries notes/fields karmax didn't capture, and
   * blind-overwriting would destroy them. Updating a synced entry is a
   * deliberate, separate action, not a side effect of write-back.
   */
  async push(item: ExternalSecretItem): Promise<{ externalId: string }> {
    const name = item.externalId || `${PASS_EXPORT_FOLDER}/${safePassName(item.label)}-${randomUUID()}.${item.type}`;
    if (!PASS_EXPORT_IDENTITY.test(name)) throw new Error('Invalid export identity');
    const body = createPassItem(item);
    return serializeGitPass(`local-pass:${this.storeDir}`, async () => {
      // Existing ciphertext is never blindly overwritten, even after a retry.
      const file = path.join(this.storeDir, `${name}.gpg`);
      const directory = path.dirname(file);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (
        fs.lstatSync(directory).isSymbolicLink() ||
        !inside(fs.realpathSync(this.storeDir), fs.realpathSync(directory))
      )
        throw new Error('The pass export directory must stay inside the password store');
      if (fs.existsSync(file)) {
        const existing = await this.run('pass', ['show', name]);
        if (existing !== body)
          throw new Error('Export destination already contains different data; it was not overwritten');
      } else {
        // pass insert overwrites existing files on non-interactive stdin even
        // without -f. Encrypt in an isolated staging store, then publish using
        // an exclusive hard link so a concurrent creator can never be clobbered.
        const staging = fs.mkdtempSync(path.join(directory, '.karmax-export-'));
        try {
          const recipients = fs.existsSync(path.join(directory, '.gpg-id')) ? directory : this.storeDir;
          for (const suffix of ['', '.sig']) {
            const source = path.join(recipients, `.gpg-id${suffix}`);
            if (fs.existsSync(source)) fs.copyFileSync(source, path.join(staging, `.gpg-id${suffix}`));
          }
          await this.exec('pass', ['insert', '-m', 'export'], { input: body, env: { PASSWORD_STORE_DIR: staging } });
          fs.linkSync(path.join(staging, 'export.gpg'), file);
        } finally {
          fs.rmSync(staging, { recursive: true, force: true });
        }
      }
      // Match pass's normal local Git bookkeeping, including recovery after a
      // process stopped between publishing ciphertext and committing it.
      if (fs.existsSync(path.join(this.storeDir, '.git'))) {
        await this.run('pass', ['git', 'add', '--', `${name}.gpg`]);
        const changed = await this.run('pass', ['git', 'diff', '--cached', '--name-only', '--', `${name}.gpg`]);
        if (changed.trim())
          await this.run('pass', ['git', 'commit', '-m', `Add pass entry ${name}`, '--', `${name}.gpg`]);
      }
      return { externalId: name };
    });
  }
}

/** Turn a raw GPG failure into an actionable message (§ the pass-unlock story:
 *  karmax never stores your GPG passphrase; it relies on gpg-agent being
 *  unlocked, which is the self-hosted reality). */
function gpgHint(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/no such file|not in the password store/i.test(msg)) return msg;
  if (/decrypt|gpg|passphrase|no secret key|inappropriate ioctl|pinentry/i.test(msg)) {
    return 'pass could not decrypt — your GPG key is locked. Unlock it once in a terminal (e.g. `pass show <any-entry>` and enter your passphrase), so gpg-agent caches it, then retry. tavya deliberately does not store your GPG master passphrase.';
  }
  return msg;
}

/** Convert NUL-separated `find` results into the ids accepted by `pass show`. */
export function parsePassFiles(raw: string, storeDir: string): string[] {
  const root = path.resolve(storeDir);
  const entries = raw.split('\0').flatMap((file) => {
    if (!file) return [];
    const relative = path.relative(root, path.resolve(file));
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !relative.endsWith('.gpg')) return [];
    return [relative.slice(0, -'.gpg'.length).split(path.sep).join('/')];
  });
  return entries.sort();
}

// ── Git-backed unix `pass` (hosted-safe, tenant-isolated) ───────────────────

interface GitPassConnection {
  repositoryUrl: string;
  /** Relative path inside the repository. Empty means auto-detect. */
  storePath?: string;
  /** Optional organization Git profile; otherwise the organization default. */
  gitProfile?: string;
  /** ASCII-armored secret key. It stays in the credential broker at rest. */
  gpgPrivateKey?: string;
  /** GPG remains the default for existing connections. */
  crypto?: 'gpg' | 'age';
  /** Native age secret identities (not plugins or filesystem references). */
  ageIdentity?: string;
  ageIdentityEncrypted?: string;
  agePassphrase?: string;
  validationEntry?: string;
  /** Optional passphrase for the secret key. */
  gpgPassphrase?: string;
}

interface GitPassOptions {
  hosted?: boolean;
  /** Tests may use a local bare remote; production accepts remote URLs only. */
  allowLocalRepository?: boolean;
  /** Prefer an organization-owned repository attachment over profile/host Git. */
  repositoryCredential?: (repositoryUrl: string) => Promise<GitCredential | undefined>;
}

const gitPassQueues = new Map<string, Promise<void>>();

async function serializeGitPass<T>(key: string, work: () => Promise<T>): Promise<T> {
  const prior = gitPassQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = prior.catch(() => undefined).then(() => gate);
  gitPassQueues.set(key, queued);
  await prior.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (gitPassQueues.get(key) === queued) gitPassQueues.delete(key);
  }
}

/**
 * An ongoing `pass` connector for hosted deployments. The password-store repo
 * is cloned into an organization-scoped cache, decrypted with an ephemeral
 * GNUPGHOME, and every write is committed and pushed before the call succeeds.
 * Git transport credentials come from an organization Git profile; the GPG
 * private key and its passphrase remain one opaque connector secret.
 */
class GitPassStoreConnector implements CredentialConnector {
  readonly name = 'pass-git';

  constructor(
    private secret: () => string | undefined,
    private organizationId = 'org_personal',
    private gitEnvironment: (profile?: string) => Record<string, string> | Promise<Record<string, string>> = () => ({}),
    private root = path.join(paths().state, 'connectors', 'pass-git'),
    private options: GitPassOptions = {},
  ) {}

  async describe(): Promise<ConnectorInfo> {
    const raw = this.secret();
    if (!raw) return {
      name: this.name,
      label: 'unix pass (Git)',
      available: false,
      canPush: true,
      setup: 'git-pass',
      detail: 'connect a Git password-store repository and its GPG private key',
    };
    try {
      const connection = this.connection(raw);
      return {
        name: this.name,
        label: 'unix pass (Git)',
        available: true,
        canPush: true,
        setup: 'git-pass',
        detail: `connected to ${redactedRepository(connection.repositoryUrl)}`,
      };
    } catch (e) {
      return {
        name: this.name,
        label: 'unix pass (Git)',
        available: false,
        canPush: true,
        setup: 'git-pass',
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /** A GitHub push may refresh this connector only when it names the exact
   *  attached repository. Match canonical owner/name across SSH and HTTPS
   *  transports instead of making the webhook depend on the URL spelling. */
  matchesRepository(repository: Repository): boolean {
    try {
      return repository.provider === 'github'
        && githubRepositorySlug(this.connection().repositoryUrl) === `${repository.owner}/${repository.name}`.toLowerCase();
    } catch {
      return false;
    }
  }

  async verify(): Promise<NonNullable<ConnectorInfo['checks']>[number]> {
    return this.inRepository(async (connection, checkout, store, env) => {
      const entries = this.entries(store);
      const entry = connection.validationEntry || entries[0];
      if (entry && !entries.includes(entry)) throw new Error('Selected verification entry was not found');
      let encryption = false;
      await this.withKeyContext(connection, async (home) => {
        if (connection.crypto === 'age') {
          await realExec('age-keygen', ['-y', path.join(home, 'identity')]);
        } else {
          const keys = await realExec('gpg', ['--homedir', home, '--batch', '--with-colons', '--list-secret-keys']);
          if (!keys.split('\n').some(line => line.startsWith('sec:'))) throw new Error('GPG private key is required');
        }
        if (entry) await this.decrypt(home, connection, this.entryFile(store, entry));
        try {
          await this.encrypt(home, path.join(home, 'probe'), 'karmax encryption preflight', this.recipients(store, entry ? path.dirname(this.entryFile(store, entry)) : store));
          encryption = true;
        } catch { /* Read-only imports remain usable without encryption recipients. */ }
      });
      // This checks transport access only: server-side hooks may still reject a real write.
      const push = await git(checkout, ['push', '--dry-run', 'origin', 'HEAD'], { env });
      return { store: '', ...(entry ? { entry } : {}), read: entry ? 'verified' : 'empty', encryption, push: push.code === 0 };
    });
  }

  async list(): Promise<ExternalItem[]> {
    return this.inRepository(async (_connection, _checkout, store, _env) =>
      this.entries(store).map((entry) => this.metadata(store, entry)));
  }

  async pull(externalIds: string[]): Promise<PullResult> {
    return this.inRepository(async (connection, _checkout, store, _env) => {
      const available = new Set(this.entries(store));
      return this.withKeyContext(connection, async (gpgHome) => {
        const items: ExternalSecretItem[] = [];
        const failures: PullResult['failures'] = [];
        for (const externalId of externalIds) {
          if (!available.has(externalId)) continue;
          try {
            const metadata = this.metadata(store, externalId);
            const body = await this.decrypt(gpgHome, connection, this.entryFile(store, externalId));
            const parsed = parsePassItem(body);
            items.push({ ...metadata, ...parsed, fields: Object.keys(parsed.secrets) as VaultFieldName[] });
          } catch (e) {
            failures.push({ externalId, error: connection.crypto === 'age' ? 'Could not decrypt this entry with the supplied age identity' : gitPassGpgError(e) });
          }
        }
        return { items, failures };
      });
    });
  }

  async updateSecret(externalId: string, field: VaultFieldName, value: string, expectedRevision?: string): Promise<void> {
    return this.updateSecrets(externalId, { [field]: value }, expectedRevision);
  }

  async updateSecrets(externalId: string, values: Partial<Record<VaultFieldName, string>>, expectedRevision?: string): Promise<void> {
    await this.inRepository(async (connection, checkout, store, env) => {
      if (!this.entries(store).includes(externalId)) throw new Error(`pass entry "${externalId}" was not found`);
      await this.withKeyContext(connection, async (gpgHome) => {
        const file = this.entryFile(store, externalId);
        const body = await this.decrypt(gpgHome, connection, file);
        const changes = Object.entries(values) as Array<[VaultFieldName, string]>;
        if (changes.every(([field, value]) => parsePassItem(body).secrets[field] === value)) return;
        if (expectedRevision && encryptedRevision(file) !== expectedRevision) throw new Error('Remote entry changed; import and review the remote value before retrying write-back');
        await this.encrypt(gpgHome, file, changes.reduce((text, [field, value]) => updatePassSecret(text, field, value), body), this.recipients(store, path.dirname(file)));
      });
      await this.commitAndPush(checkout, fileRelativeTo(checkout, this.entryFile(store, externalId)),
        `Update pass entry ${externalId}`, env);
    });
  }

  async push(item: ExternalSecretItem): Promise<{ externalId: string }> {
    return this.inRepository(async (connection, checkout, store, env) => {
      const body = createPassItem(item);
      const stem = safePassName(item.label)+(item.type === 'login' ? '' : `.${item.type}`);
      let externalId = item.externalId || `${PASS_EXPORT_FOLDER}/${stem}`;
      if (item.externalId && !PASS_EXPORT_IDENTITY.test(item.externalId)) throw new Error('Invalid export identity');
      if (item.externalId && fs.existsSync(this.entryFile(store, externalId))) {
        const existing = await this.withKeyContext(connection, home => this.decrypt(home, connection, this.entryFile(store, externalId)));
        if (existing !== body) throw new Error('Export destination already contains different data; it was not overwritten');
        return {externalId};
      }
      for (let suffix = 2; fs.existsSync(this.entryFile(store, externalId)); suffix += 1) {
        externalId = `${externalId.slice(0, externalId.indexOf('/'))}/${stem}-${suffix}`;
      }
      const file = this.entryFile(store, externalId);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const directory = path.dirname(file);
      if (fs.lstatSync(directory).isSymbolicLink() || !inside(store, fs.realpathSync(directory))) {
        throw new Error('The pass export directory must be a real directory inside the password store');
      }
      await this.withKeyContext(connection, async (gpgHome) => {
        await this.encrypt(gpgHome, file, body, this.recipients(store, path.dirname(file)));
      });
      await this.commitAndPush(checkout, fileRelativeTo(checkout, file), `Add pass entry ${externalId}`, env);
      return { externalId };
    });
  }

  private connection(raw = this.secret()): GitPassConnection {
    if (!raw) throw new Error('no Git-backed pass connection is configured');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Git-backed pass connection is invalid');
    }
    const value = parsed as Partial<GitPassConnection>;
    let repositoryUrl = String(value.repositoryUrl ?? '').trim();
    if (!repositoryUrl) throw new Error('repository URL is required');
    if (this.options.hosted) {
      repositoryUrl = hostedHttpsRepositoryUrl(repositoryUrl);
      const url = URL.parse(repositoryUrl);
      if (url?.protocol !== 'https:' || !HOSTED_GIT_HOSTS.includes(url.hostname)
        || (url.port && url.port !== '443') || url.username || url.password)
        throw new Error('hosted Git password stores need a GitHub, GitLab or Bitbucket URL such as https://github.com/you/password-store');
    }
    if (!this.options.allowLocalRepository && !isRemoteGitUrl(repositoryUrl)) {
      throw new Error('repository must use an HTTPS or SSH repository URL');
    }
    if (repositoryUrl.startsWith('-') || /[\r\n\0]/.test(repositoryUrl)) throw new Error('repository URL is invalid');
    if (/^https:\/\//i.test(repositoryUrl)) {
      const url = new URL(repositoryUrl);
      if (url.username || url.password) throw new Error('repository URL must not embed credentials; select a Git profile instead');
    }
    const gpgPrivateKey = String(value.gpgPrivateKey ?? '').trim();
    const crypto = value.crypto ?? 'gpg';
    if (crypto !== 'gpg' && crypto !== 'age') throw new Error('password-store encryption must be gpg or age');
    const ageIdentity = String(value.ageIdentity ?? '').trim();
    if (crypto === 'age') {
      if (value.ageIdentityEncrypted) {
        if (ageIdentity) throw new Error('Supply either a native or encrypted age identity');
        if (typeof value.ageIdentityEncrypted !== 'string' || value.ageIdentityEncrypted.length > 3 * 1024 * 1024
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.ageIdentityEncrypted) || !value.agePassphrase) throw new Error('Encrypted age identity and passphrase are required');
      } else validateNativeAgeIdentity(ageIdentity);
    } else if (!gpgPrivateKey) throw new Error('an armored GPG private key is required');
    if (gpgPrivateKey.length > 2 * 1024 * 1024) throw new Error('GPG private key is too large');
    const storePath = String(value.storePath ?? '').trim().replace(/\\/g, '/');
    if (storePath && (path.posix.isAbsolute(storePath) || storePath.split('/').includes('..'))) {
      throw new Error('password-store path must stay inside the repository');
    }
    const gitProfile = String(value.gitProfile ?? '').trim() || undefined;
    if (gitProfile && !/^[a-zA-Z0-9._-]+$/.test(gitProfile)) throw new Error('Git profile name is invalid');
    return {
      repositoryUrl,
      ...(storePath ? { storePath } : {}),
      ...(gitProfile ? { gitProfile } : {}),
      crypto,
      ...(crypto === 'age' ? { ageIdentity, ageIdentityEncrypted: value.ageIdentityEncrypted, agePassphrase: value.agePassphrase } : { gpgPrivateKey }),
      ...(value.validationEntry ? { validationEntry: String(value.validationEntry) } : {}),
      ...(value.gpgPassphrase ? { gpgPassphrase: String(value.gpgPassphrase) } : {}),
    };
  }

  private async inRepository<T>(work: (connection: GitPassConnection, checkout: string, store: string,
    env: Record<string, string>) => Promise<T>): Promise<T> {
    const connection = this.connection();
    const checkout = this.checkoutFor(connection.repositoryUrl);
    return serializeGitPass(checkout, async () => {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const credentialDir = fs.mkdtempSync(path.join(this.root, '.git-auth-'));
      try {
        const repositoryCredential = await this.options.repositoryCredential?.(connection.repositoryUrl);
        const { env } = materializeGitCredential(credentialDir, {
          ...(repositoryCredential ?? {}),
          env: { ...(await this.gitEnv(connection)), ...(repositoryCredential?.env ?? {}) },
        });
        await this.refresh(connection, checkout, env);
        const store = this.findStore(checkout, connection.storePath);
        // Keep transport credentials alive through asynchronous encryption and push.
        return await work(connection, checkout, store, env);
      } finally {
        fs.rmSync(credentialDir, { recursive: true, force: true });
      }
    });
  }

  private checkoutFor(repositoryUrl: string): string {
    const digest = createHash('sha256').update(`${this.organizationId}\0${repositoryUrl}`).digest('hex').slice(0, 32);
    return path.join(this.root, this.organizationId.replace(/[^a-zA-Z0-9._-]/g, '_'), digest, 'repo');
  }

  private async gitEnv(connection: GitPassConnection): Promise<Record<string, string>> {
    return {
      ...isolatedGitEnvironment(),
      ...(await this.gitEnvironment(connection.gitProfile)),
      // Belt to the URL check's braces: git itself refuses any other transport
      // (`ext::`, `fd::`, or a helper smuggled in through a redirect).
      GIT_ALLOW_PROTOCOL: this.options.hosted ? 'https' : this.options.allowLocalRepository ? 'https:ssh:file' : 'https:ssh',
      ...(this.options.hosted ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.followRedirects', GIT_CONFIG_VALUE_0: 'false' } : {}),
    };
  }

  private async refresh(connection: GitPassConnection, checkout: string, env: Record<string, string>): Promise<void> {
    const parent = path.dirname(checkout);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (fs.existsSync(path.join(checkout, '.git'))) {
      const status = await git(checkout, ['status', '--porcelain'], { env });
      const ahead = await git(checkout, ['rev-list', '--count', '@{upstream}..HEAD'], { env });
      if (status.code !== 0 || status.stdout.trim() || ahead.code !== 0 || Number(ahead.stdout.trim()) > 0) {
        fs.rmSync(checkout, { recursive: true, force: true });
      }
    } else if (fs.existsSync(checkout)) {
      fs.rmSync(checkout, { recursive: true, force: true });
    }
    if (!fs.existsSync(path.join(checkout, '.git'))) {
      await gitOrThrow(parent, ['clone', '--depth=1', '--', connection.repositoryUrl, path.basename(checkout)], { env });
      return;
    }
    const pulled = await git(checkout, ['pull', '--ff-only', '--quiet'], { env });
    if (pulled.code !== 0) throw new Error(`could not update password-store repository: ${pulled.stderr || pulled.stdout}`);
  }

  private findStore(checkout: string, configured?: string): string {
    if (configured) {
      const candidate = path.resolve(checkout, configured);
      const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
      if (!inside(checkout, candidate) || !stat?.isDirectory() || stat.isSymbolicLink()
        || !inside(checkout, fs.realpathSync(candidate))) {
        throw new Error(`password-store path "${configured}" is not a directory in the repository`);
      }
      return candidate;
    }
    const conventional = path.join(checkout, '.password-store');
    const conventionalStat = fs.lstatSync(conventional, { throwIfNoEntry: false });
    if (conventionalStat?.isDirectory() && !conventionalStat.isSymbolicLink()) return conventional;
    if (regularFile(path.join(checkout, this.format().recipients))) return checkout;
    const queue = [checkout];
    let visited = 0;
    while (queue.length) {
      const dir = queue.shift()!;
      if (++visited > 10_000) throw new Error('password-store repository contains too many directories to scan safely');
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.isSymbolicLink()) continue;
        const child = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === this.format().recipients) return dir;
        if (entry.isDirectory()) queue.push(child);
      }
    }
    throw new Error('no password store was found (set the path containing .gpg-id or .age-recipients)');
  }

  private entries(store: string): string[] {
    const files: string[] = [];
    const queue = [store];
    while (queue.length) {
      const dir = queue.shift()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.isSymbolicLink()) continue;
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) queue.push(child);
        else if (entry.isFile() && entry.name.endsWith(this.format().extension)) files.push(child);
        if (files.length > 100_000) throw new Error('password store contains too many entries');
      }
    }
    return files.map((file) => path.relative(store, file).slice(0, -this.format().extension.length).split(path.sep).join('/')).sort();
  }

  private metadata(store: string, externalId: string): ExternalItem {
    const { domain, username } = passEntryMetadata(externalId);
    const slash = externalId.lastIndexOf('/');
    const stat = fs.statSync(this.entryFile(store, externalId));
    return {
      externalId,
      type: passPathType(externalId),
      label: externalId,
      folder: slash >= 0 ? externalId.slice(0, slash) : '',
      domains: domain ? [domain] : [],
      ...(username ? { username } : {}),
      fields: itemFieldsFor(passPathType(externalId)),
      changedAt: stat.mtimeMs,
      revision: encryptedRevision(this.entryFile(store, externalId)),
    };
  }

  private entryFile(store: string, externalId: string): string {
    const normalized = externalId.replace(/\\/g, '/');
    if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw new Error('invalid pass entry id');
    }
    const file = path.resolve(store, `${normalized}${this.format().extension}`);
    if (!inside(store, file)) throw new Error('invalid pass entry id');
    return file;
  }

  private recipients(store: string, start: string): string[] {
    let dir = start;
    for (;;) {
      const idFile = path.join(dir, this.format().recipients);
      if (regularFile(idFile)) {
        const recipients = fs.readFileSync(idFile, 'utf8').split(/\r?\n/)
          .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
        if (!recipients.length) throw new Error(`${path.relative(store, idFile) || this.format().recipients} has no recipients`);
        return recipients;
      }
      if (dir === store) break;
      const parent = path.dirname(dir);
      if (!inside(store, parent) && parent !== store) break;
      dir = parent;
    }
    throw new Error(`no ${this.format().recipients} applies to ${path.relative(store, start) || '.'}`);
  }

  private format() {
    return this.connection().crypto === 'age'
      ? { extension: '.age', recipients: '.age-recipients' }
      : { extension: '.gpg', recipients: '.gpg-id' };
  }

  private async withKeyContext<T>(connection: GitPassConnection, work: (home: string) => Promise<T>): Promise<T> {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const home = fs.mkdtempSync(path.join(this.root, '.key-'));
    fs.chmodSync(home, 0o700);
    try {
      if (connection.crypto === 'age') {
        const identity = connection.ageIdentityEncrypted
          ? await unlockAgeIdentity(connection.ageIdentityEncrypted, connection.agePassphrase ?? '', home) : connection.ageIdentity!;
        validateNativeAgeIdentity(identity);
        fs.writeFileSync(path.join(home, 'identity'), `${identity}\n`, { mode: 0o600 });
      } else {
        await realExec('gpg', ['--homedir', home, '--batch', '--yes', '--import'], { input: `${connection.gpgPrivateKey}\n` });
      }
      return await work(home);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Remote entry changed')) throw e;
      if (connection.crypto === 'age') throw new Error('Git-backed pass could not decrypt or encrypt with the supplied age identity and recipients');
      throw new Error(gitPassGpgError(e));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  private decrypt(home: string, connection: GitPassConnection, file: string): Promise<string> {
    if (connection.crypto === 'age') return realExec('age', ['--decrypt', '--identity', path.join(home, 'identity'), file]);
    return realExec('gpg', ['--homedir', home, '--batch', '--yes', '--pinentry-mode', 'loopback',
      '--passphrase-fd', '0', '--decrypt', file], { input: `${connection.gpgPassphrase ?? ''}\n` });
  }

  private async encrypt(home: string, file: string, plaintext: string, recipients: string[]): Promise<void> {
    const temp = `${file}.karmax-${process.pid}-${Date.now()}`;
    try {
      const age = this.connection().crypto === 'age';
      // Native recipients only: never let store data request an executable age plugin.
      if (age && recipients.some(recipient => !/^age1[0-9a-z]{58}$/.test(recipient))) {
        throw new Error('age stores require native age1 recipients');
      }
      const args = age ? ['--encrypt', '--output', temp]
        : ['--homedir', home, '--batch', '--yes', '--trust-model', 'always', '--output', temp];
      for (const recipient of recipients) args.push('--recipient', recipient);
      if (!age) args.push('--encrypt');
      await realExec(age ? 'age' : 'gpg', args, { input: plaintext });
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  private async commitAndPush(checkout: string, relative: string, message: string,
    env: Record<string, string>): Promise<void> {
    await gitOrThrow(checkout, ['add', '--', relative], { env });
    if ((await git(checkout, ['diff', '--cached', '--quiet'], { env })).code === 0) return;
    await gitOrThrow(checkout, ['-c', `user.name=${BRAND}`, '-c', `user.email=${BRAND}@localhost`, 'commit', '-m', message], { env });
    const pushed = await git(checkout, ['push', 'origin', 'HEAD'], { env });
    if (pushed.code !== 0) {
      throw new Error(`password-store changed remotely or could not be pushed; retry to refresh it: ${pushed.stderr || pushed.stdout}`);
    }
  }
}

/** Compose explicitly connected gopass stores. Mount configuration lives on the
 * user's machine, so never infer or fetch additional remotes from repository data.
 * Mounts reserve their prefix, as in gopass. New exports go to the root store. */
export class GitPassConnector implements CredentialConnector {
  readonly name = 'pass-git';
  constructor(
    private secret: SecretSource,
    private organizationId = 'org_personal',
    private gitEnvironment: (profile?: string) => Record<string, string> | Promise<Record<string, string>> = () => ({}),
    private root = path.join(paths().state, 'connectors', 'pass-git'),
    private options: GitPassOptions = {},
  ) {}

  private async stores(): Promise<{ prefix: string; connector: GitPassStoreConnector }[]> {
    const raw = await this.secret();
    let config: any;
    try { config = raw ? JSON.parse(raw) : undefined; }
    catch { throw new Error('Git-backed pass connection is invalid'); }
    const mounts = config?.mounts ?? [];
    if (!Array.isArray(mounts) || mounts.length > 16) throw new Error('At most 16 password-store mounts are supported');
    const prefixes: string[] = [];
    const make = (secret: string | undefined) => new GitPassStoreConnector(() => secret,
      this.organizationId, this.gitEnvironment, this.root, this.options);
    const children = mounts.map((mount: any) => {
      const name = mount?.name;
      if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(name)
        || prefixes.some(prefix => name + '/' === prefix || (name + '/').startsWith(prefix) || prefix.startsWith(name + '/'))
        || mount.mounts !== undefined) throw new Error('Mount names must be unique, non-overlapping relative paths');
      const prefix = name + '/';
      prefixes.push(prefix);
      return { prefix, connector: make(JSON.stringify(mount)) };
    });
    return [{ prefix: '', connector: make(raw) }, ...children];
  }

  async describe(): Promise<ConnectorInfo> {
    try {
      const stores = await this.stores();
      const infos = await Promise.all(stores.map(store => store.connector.describe()));
      const unavailable = infos.find(info => !info.available);
      return unavailable ?? { ...infos[0]!, detail: infos[0]!.detail + (stores.length > 1 ? `; ${stores.length - 1} mounted stores` : '') };
    } catch (e) {
      return { name: this.name, label: 'unix pass / gopass (Git)', available: false, canPush: true, setup: 'git-pass',
        detail: e instanceof Error ? e.message : 'Invalid password-store connection' };
    }
  }

  async matchesRepository(repository: Repository): Promise<boolean> {
    try { return (await this.stores()).some(store => store.connector.matchesRepository(repository)); }
    catch { return false; }
  }

  async validateSecret(secret: string): Promise<ConnectorInfo> {
    const candidate = new GitPassConnector(() => secret, this.organizationId, this.gitEnvironment, this.root, this.options);
    const info = await candidate.describe();
    if (!info.available) throw new Error(info.detail);
    const checks: NonNullable<ConnectorInfo['checks']> = [];
    for (const store of await candidate.stores()) {
      try { checks.push({ ...await store.connector.verify(), store: store.prefix || 'root' }); }
      catch (e) { throw new Error(`Password store ${store.prefix || 'root'}: ${gitPassVerificationError(e)}`); }
    }
    return { ...info, checks };
  }

  async catalog(): Promise<{ items: ExternalItem[]; failures: Array<{ store: string; error: string }> }> {
    const stores = await this.stores();
    const items: ExternalItem[] = []; const failures: Array<{ store: string; error: string }> = [];
    for (const { prefix, connector } of stores) {
      try {
        for (const item of await connector.list()) {
          if (!prefix && stores.some(store => store.prefix && item.externalId.startsWith(store.prefix))) continue;
          items.push({ ...item, externalId: prefix + item.externalId, label: prefix + item.label,
            folder: prefix ? prefix + (item.folder ?? '') : item.folder });
        }
      } catch (error) { failures.push({ store: prefix || 'root', error: gitPassVerificationError(error) }); }
    }
    return { items, failures };
  }

  async list(): Promise<ExternalItem[]> {
    const info = await this.describe();
    if (!info.available) throw new Error(info.detail);
    const result = await this.catalog();
    if (result.failures.length) throw new Error(result.failures.map(f => `${f.store}: ${f.error}`).join('; '));
    return result.items;
  }

  async pull(externalIds: string[]): Promise<PullResult> {
    const stores = await this.stores();
    const result: PullResult = { items: [], failures: [] };
    for (const { prefix, connector } of stores) {
      const ids = externalIds.filter(id => prefix ? id.startsWith(prefix) : !stores.some(store => store.prefix && id.startsWith(store.prefix)));
      if (!ids.length) continue;
      let pulled: PullResult;
      try { pulled = await connector.pull(ids.map(id => id.slice(prefix.length))); }
      catch (error) {
        // Name the store's own problem (moved, emptied, unreadable key) so its owner
        // can act; raw Git output stays behind the helper's fixed wording (AU-41).
        const reason = gitPassVerificationError(error);
        result.failures.push(...ids.map(externalId => ({ externalId, error: `Store ${prefix || 'root'}: ${reason}` })));
        continue;
      }
      result.items.push(...pulled.items.map(item => ({ ...item, externalId: prefix + item.externalId,
        label: prefix + item.label, folder: prefix ? prefix + (item.folder ?? '') : item.folder })));
      result.failures.push(...pulled.failures.map(failure => ({ ...failure, externalId: prefix + failure.externalId })));
    }
    return result;
  }

  async updateSecret(externalId: string, field: VaultFieldName, value: string, expectedRevision?: string): Promise<void> {
    return this.updateSecrets(externalId, { [field]: value }, expectedRevision);
  }

  async updateSecrets(externalId: string, values: Partial<Record<VaultFieldName, string>>, expectedRevision?: string): Promise<void> {
    const stores = await this.stores();
    const store = stores.find(store => store.prefix && externalId.startsWith(store.prefix)) ?? stores[0]!;
    await store.connector.updateSecrets(externalId.slice(store.prefix.length), values, expectedRevision);
  }

  async push(item: ExternalSecretItem): Promise<{ externalId: string }> {
    const stores = await this.stores();
    // A mount named like an export folder would shadow all root exports.
    const shadowing = stores.find(store => isPassExport(store.prefix));
    if (shadowing) throw new Error(`The ${shadowing.prefix.replace(/\/$/, '')} mount reserves the export folder; rename that mount before exporting`);
    return stores[0]!.connector.push(item);
  }
}

/** HTTPS, `ssh://`, or scp-style `[user@]host:path`. The scp form must not be
 *  followed by a second colon: `ext::<command>` and `fd::<n>` are git transport
 *  helpers, not hosts, and would run a program instead of contacting one. */
function isRemoteGitUrl(value: string): boolean {
  return /^https:\/\/[^\s]+$/i.test(value)
    || /^ssh:\/\/[^\s]+$/i.test(value)
    || /^(?:[^@\s]+@)?[^:\s/]+:(?!:)[^\s]+$/.test(value);
}

const HOSTED_GIT_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org'];

/** `git@github.com:you/store.git` and `ssh://git@github.com/you/store.git` name
 * the same repository as its HTTPS URL, the only transport hosted Git uses. */
function hostedHttpsRepositoryUrl(value: string): string {
  const ssh = value.match(/^git@([^:/\s]+):(?!\/)(\S+)$/) ?? value.match(/^ssh:\/\/git@([^:/\s]+)(?::22)?\/(\S+)$/i);
  const host = ssh?.[1]!.toLowerCase();
  return host && HOSTED_GIT_HOSTS.includes(host) ? `https://${host}/${ssh![2]}` : value;
}

function githubRepositorySlug(value: string): string | undefined {
  const trimmed = value.trim().replace(/\/$/, '');
  let pathname: string | undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== 'github.com') return undefined;
    pathname = parsed.pathname;
  } catch {
    const scp = trimmed.match(/^(?:[^@\s]+@)?github\.com:([^\s]+)$/i);
    if (scp) pathname = `/${scp[1]}`;
  }
  const parts = pathname?.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  return parts?.length === 2 && parts.every(Boolean) ? `${parts[0]}/${parts[1]}`.toLowerCase() : undefined;
}

function gitPassRepositoryIdentity(secret: string | undefined): string | undefined {
  if (!secret) return undefined;
  try {
    const config = JSON.parse(secret);
    const identity = (store: any) => {
      const url = String(store.repositoryUrl ?? '').trim().replace(/\/$/, '');
      return [githubRepositorySlug(url) ?? url, store.storePath ?? '', store.crypto ?? 'gpg'];
    };
    return JSON.stringify([identity(config), (config.mounts ?? []).map((mount: any) =>
      [mount.name, ...identity(mount)]).sort((a: string[], b: string[]) => a[0]!.localeCompare(b[0]!))]);
  } catch {
    return undefined;
  }
}

function redactedRepository(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.replace(/^[^@\s]+@/, '');
  }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function fileRelativeTo(root: string, file: string): string {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('file is outside repository');
  return relative;
}

function regularFile(file: string): boolean {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return !!stat?.isFile() && !stat.isSymbolicLink();
}

function safePassName(label: string): string {
  const value = label.trim().replace(/[^A-Za-z0-9._@-]+/g, '-').replace(/^-+|-+$/g, '');
  return value || 'credential';
}

function gitPassGpgError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/spawn gpg ENOENT|gpg.*not found/i.test(message)) {
    return 'Git-backed pass requires GnuPG (`gpg`) on the tavya server';
  }
  if (/gpg|decrypt|secret key|passphrase|public key|decryption failed|bad key/i.test(message)) {
    return 'Git-backed pass could not use the supplied GPG key or passphrase';
  }
  return message;
}

/** Name the failing verification step without echoing raw Git output, which
 *  includes server paths. Only the connector's own messages pass through. */
function gitPassVerificationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(git (clone|pull)\b|could not update password-store repository)/.test(message)) {
    return 'cannot fetch the repository; select a Git profile that can access it';
  }
  if (/^(no password store was found|password-store path |password.store (repository )?contains too many|Selected verification entry|Git-backed pass |GPG private key|unknown Git profile)/.test(message)) {
    return message;
  }
  return 'repository, key or decryption verification failed';
}

// ── the registry + sync service (state in the store kv) ───────────────────────

// Connector config + unlock secret are ORGANIZATION-scoped: a tenant connects
// its own Bitwarden/1Password, and its session key must never be reachable from
// another org's world.
const kvConfig = (org: string, name: string) => `vault:connector:${org}:${name}`;
const connectorAuthHandle = (org: string, name: string) => `connector:${org}:${name}:auth`;

/** Truncate an epoch-milliseconds value to a whole millisecond, so timestamps of
 *  different precision (a float file mtime, an integer `Date.now()`) can be
 *  ordered against each other. See the comparison in {@link Connectors.sync}. */
const floorMs = (value: number | undefined): number | undefined =>
  value === undefined ? undefined : Math.floor(value);

export interface ConnectorConfig {
  /** Opt-in write-back of agent-created items. */
  writeBack?: boolean;
  /** Durable selective mirror subscription. `importNew` is the broader mode:
   *  it always implies `enabled` and refreshes the complete external store. */
  autoSync?: {
    /** `false` is persisted rather than erased so it is distinguishable from
     *  a connector imported before automatic subscriptions existed. */
    enabled: boolean;
    importNew: boolean;
    externalIds: string[];
    /** Applied only when automatic discovery creates a new vault item. */
    policy?: Partial<VaultItemPolicy>;
  };
  /** Last successful sync (epoch ms) + how many of its items the vault now
   *  mirrors. The count is the running total, not this batch's share, so a
   *  big import split into batches still reports what the user has. */
  lastSync?: { at: number; count: number };
  /** Operational visibility for webhook/backstop refreshes. */
  lastAutoSync?: {
    at: number;
    reason: 'github-push' | 'backstop';
    count: number;
    skipped: number;
    failures: number;
    revision?: string;
    error?: string;
  };
}

/** The outcome of one `sync` batch. */
export interface SyncResult {
  /** Items pulled and written this time. */
  count: number;
  itemIds: string[];
  /** Entries already mirrored and unchanged in the store — not re-read. */
  skipped: number;
  /** Entries the store could not hand over; the rest still landed. */
  failures: Array<{ externalId: string; error: string }>;
}

export interface ConnectorStore {
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  lock?(...keys: string[]): Promise<void>;
  kvGet(k: string): (string | undefined) | Promise<string | undefined>;
  kvSet(k: string, v: string): (void) | Promise<void>;
  findRepositoryBySshUrl?(organizationId: string, sshUrl: string): (Repository | undefined) | Promise<Repository | undefined>;
  listRepositories?(organizationId: string): (Repository[]) | Promise<Repository[]>;
}

export interface ConnectorGithubApp {
  brokerCredentials(repository: Repository): Promise<GitCredential>;
}

/** Resolve only an exact repository attachment owned by this organization.
 * Never substitutes a user/profile credential based on availability. */
export async function attachedRepositoryCredential(store: ConnectorStore, githubApp: ConnectorGithubApp | undefined,
  organizationId: string, repositoryUrl: string): Promise<GitCredential | undefined> {
  const slug = githubRepositorySlug(repositoryUrl);
  const repository = (await store.findRepositoryBySshUrl?.(organizationId, repositoryUrl))
    ?? (slug ? (await store.listRepositories?.(organizationId))?.find((candidate) =>
      candidate.provider === 'github' && `${candidate.owner}/${candidate.name}`.toLowerCase() === slug) : undefined);
  return repository && githubApp ? githubApp.brokerCredentials(repository) : undefined;
}

export class Connectors {
  private map = new Map<string, CredentialConnector>();
  constructor(
    private store: ConnectorStore,
    private items: VaultItems,
    private broker?: CredentialBroker,
    /** Owning organization; `items` must be constructed for the same org. */
    private organizationId = 'org_personal',
  ) {}

  register(connector: CredentialConnector): void {
    this.map.set(connector.name, connector);
  }
  get(name: string): CredentialConnector | undefined {
    return this.map.get(name);
  }
  names(): string[] {
    return [...this.map.keys()];
  }

  async config(name: string): Promise<ConnectorConfig> {
    const raw = await this.store.kvGet(kvConfig(this.organizationId, name));
    try {
      return JSON.parse(raw ?? '{}');
    } catch {
      return {};
    }
  }
  /** Connector configs and the outbox are rewritten under the organization's
   * vault lock (as are its items). */
  private lockVault(): Promise<void> | undefined {
    return this.store.lock?.(`vault:${this.organizationId}`);
  }

  async setConfig(name: string, patch: Partial<ConnectorConfig>): Promise<ConnectorConfig> {
    return this.store.transaction(async () => {
    await this.lockVault();
    const current = (await this.config(name));
    const next = { ...current, ...patch };
    (await this.store.kvSet(kvConfig(this.organizationId, name), JSON.stringify(next)));
    // Turning write-back on consents to the store connected now, so writes
    // queued while an earlier store was connected go to this one.
    if (next.writeBack && !current.writeBack) await this.retargetWrites(name);
    return next;
      });
  }

  /** Persist a selective refresh subscription. The server, not just the UI,
   *  enforces that importing future entries means tracking the whole store. */
  async setAutoSync(
    name: string,
    input: { keepUpdated?: boolean; importNew?: boolean; externalIds?: string[]; policy?: Partial<VaultItemPolicy> },
  ): Promise<ConnectorConfig> {
    if (!this.get(name)) throw new Error(`no connector "${name}"`);
    const importNew = input.importNew === true;
    const enabled = importNew || input.keepUpdated === true;
    const externalIds = [
      ...new Set(
        (input.externalIds ?? [])
          .map(String)
          .map((id) => id.trim())
          .filter(Boolean),
      ),
    ];
    if (externalIds.length > 100_000) throw new Error('automatic sync selection is too large');
    if (input.policy?.use !== undefined && !['auto', 'ask'].includes(input.policy.use))
      throw new Error('automatic sync blind-use policy must be auto or ask');
    if (input.policy?.reveal !== undefined && !['auto', 'ask', 'never'].includes(input.policy.reveal))
      throw new Error('automatic sync reveal policy must be auto, ask, or never');
    return (await this.setConfig(name, {
      autoSync: { enabled, importNew, externalIds, ...(input.policy ? { policy: input.policy } : {}) },
    }));
  }

  /** Refresh one durable subscription. `importNew` lists the store on every
   *  run, so entries added since the last import join the selected mirror. */
  async autoSync(name: string, reason: 'github-push' | 'backstop', revision?: string): Promise<SyncResult | undefined> {
    const config = (await this.config(name));
    let subscription = config.autoSync;
    if (!subscription) {
      // Automatic Git-backed subscriptions were added after connector imports
      // already existed in the wild. Missing config therefore means "legacy",
      // not "disabled": preserve the original selective mirror by tracking
      // exactly the items it imported, without opting into newly added entries.
      const externalIds = (await this.items
        .list())
        .filter((item) => item.provenance.source === `connector:${name}` && item.provenance.externalId)
        .map((item) => item.provenance.externalId!);
      if (!externalIds.length) return undefined;
      subscription = { enabled: true, importNew: false, externalIds };
      (await this.setConfig(name, { autoSync: subscription }));
    }
    if (!subscription?.enabled) return undefined;
    const connector = this.get(name);
    if (!connector) return undefined;
    try {
      const catalog = subscription.importNew && connector instanceof GitPassConnector ? await connector.catalog() : undefined;
      const externalIds = subscription.importNew
        ? [...new Set([...subscription.externalIds, ...(catalog?.items ?? await connector.list()).map((item) => item.externalId)])]
        : subscription.externalIds;
      const result = await this.sync(name, externalIds, { policy: subscription.policy });
      if (catalog) result.failures.push(...catalog.failures.map(failure => ({ externalId: failure.store, error: failure.error })));
      // Remember newly discovered ids as well. This keeps the UI truthful if
      // the operator later turns off import-new but leaves keep-updated on.
      if (subscription.importNew)
        (await this.setAutoSync(name, { keepUpdated: true, importNew: true, externalIds, policy: subscription.policy }));
      (await this.setConfig(name, {
        lastAutoSync: {
          at: Date.now(),
          reason,
          count: result.count,
          skipped: result.skipped,
          failures: result.failures.length,
          ...(revision ? { revision } : {}),
          ...(result.failures[0] ? { error: result.failures[0].error } : {}),
        },
      }));
      return result;
    } catch (error) {
      (await this.setConfig(name, {
        lastAutoSync: {
          at: Date.now(),
          reason,
          count: 0,
          skipped: 0,
          failures: 0,
          ...(revision ? { revision } : {}),
          error: error instanceof Error ? error.message : String(error),
        },
      }));
      throw error;
    }
  }

  /** Route a GitHub push to this organization's Git-backed pass connector only
   *  when both its durable subscription and exact repository binding match. */
  async autoSyncGitPush(repository: Repository, revision?: string): Promise<SyncResult | undefined> {
    const connector = this.get('pass-git');
    if (!(connector instanceof GitPassConnector) || !await connector.matchesRepository(repository)) return undefined;
    return this.autoSync('pass-git', 'github-push', revision);
  }

  /** Validate a connector secret before keeping it. A failed replacement restores
   *  the previous working secret, so clicking Connect can never manufacture a
   *  false-positive connection or break an existing one. `newStore` means a
   *  first connection or a different Git store: nothing is selected yet. */
  async connect(name: string, secret: string): Promise<{ connector: ConnectorInfo; newStore: boolean }> {
    const connector = this.get(name);
    if (!connector) throw new Error(`no connector "${name}"`);
    if (!this.broker) throw new Error('credential storage is unavailable');
    const value = secret.trim();
    const required =
      name === 'bitwarden'
        ? 'Enter a Bitwarden session key.'
        : name === '1password'
          ? 'Enter a 1Password service-account token.'
          : 'Enter the connector credential.';
    if (!value) throw new Error(required);

    const handle = connectorAuthHandle(this.organizationId, name);
    const previous = await this.secretFor(name);
    const replacedGitPassStore =
      name === 'pass-git' &&
      previous !== undefined &&
      gitPassRepositoryIdentity(previous) !== gitPassRepositoryIdentity(value);
    const validated = await connector.validateSecret?.(value);
    (await this.broker.registerHandle(handle, value, organizationScope(this.organizationId)));
    try {
      const info = validated ?? (await connector.describe());
      if (!info.available) throw new Error(info.detail);
      // A selection and write-back consent belong to one external store. Never
      // carry them silently to a different repository during reconfiguration.
      // Pending writes do follow it, still waiting for that consent: a rotation
      // not yet written anywhere is the only copy of the newest secret, and its
      // record is what keeps an import from overwriting it.
      if (replacedGitPassStore)
        await this.store.transaction(async () => {
          await this.lockVault();
          (await this.store.kvSet(
            kvConfig(this.organizationId, name),
            JSON.stringify({
              autoSync: { enabled: false, importNew: false, externalIds: [] },
            }),
          ));
          await this.retargetWrites(name);
        });
      return { connector: info, newStore: previous === undefined || replacedGitPassStore };
    } catch (error) {
      if (previous === undefined) (await this.broker.deleteHandle(handle));
      else (await this.broker.registerHandle(handle, previous, organizationScope(this.organizationId)));
      throw error;
    }
  }
  async secretFor(name: string): Promise<string | undefined> {
    const handle = connectorAuthHandle(this.organizationId, name);
    return await this.broker?.hasHandle(handle) ? this.broker!.resolve(handle, { caps: ['use-credential:*'] }) : undefined;
  }

  async describe(): Promise<(ConnectorInfo & { config: ConnectorConfig; pendingWrites: Array<Partial<Omit<PendingConnectorWrite, 'target' | 'snapshotHandle'>> & { itemId: string; label?: string }> })[]> {
    return Promise.all(
      this.names().map(async (name) => ({
        ...(await this.get(name)!.describe()),
        canPush: !!this.get(name)!.push,
        canUpdate: !!this.get(name)!.updateSecret,
        config: (await this.config(name)),
        pendingWrites: [...(await this.pendingWrites()).filter((write) => write.connector === name)
        .map(({ target, snapshotHandle, ...status }) => status),
          ...(name === 'pass-git' ? (await __asyncCollections.filter((await this.items.list()), async item => Object.keys((await this.pending(item.id)).fields).length)).map(item => ({ itemId: item.id, label: item.label })) : [])],
      })),
    );
  }

  /**
   * Mirror the selected external items into the vault (§9 selective mirror).
   * Re-syncing updates the same items (matched by connector + externalId)
   * rather than duplicating; new items start with the connector's policy
   * defaults (`use: auto`, `reveal: ask`).
   *
   * Two properties make a whole-store import survivable, because reading a
   * secret out of a real store is expensive (a `pass` entry costs a GPG
   * decrypt — seconds each, and gpg-agent serializes them):
   *  - **unchanged entries are not re-read.** Re-importing a 600-entry `pass`
   *    tree after adding one password costs one decrypt, not six hundred.
   *  - **failures are partial.** An entry that will not decrypt is reported
   *    and skipped instead of discarding everything else the pull collected.
   */
  async sync(
    name: string,
    externalIds: string[],
    opts: { policy?: Partial<VaultItemPolicy>; writeBack?: boolean; acceptRemote?: boolean } = {},
  ): Promise<SyncResult> {
    const connector = this.get(name);
    if (!connector) throw new Error(`no connector "${name}"`);
    if (opts.writeBack !== undefined) (await this.setConfig(name, { writeBack: opts.writeBack }));
    const source = `connector:${name}`;
    const isPass = name === 'pass' || name === 'pass-git';
    const vaultItems = (await this.items.list());
    const mirrored = new Map(
      vaultItems
        .filter((i) => i.provenance.source === source && i.provenance.externalId)
        .map((i) => [i.provenance.externalId!, i]),
    );
    // An agent-created item written back to this connector is already present
    // in the vault. Import-new must not mirror its external entry back as a
    // duplicate connector item when the resulting Git push wakes auto-sync.
    // Pass entries written by agents also need their source notes refreshed.
    if (isPass)
      for (const item of vaultItems) {
        const id = item.provenance.externalIds?.[name];
        if (id) mirrored.set(id, item);
      }
    const writtenBack = new Set(
      vaultItems.map((item) => item.provenance.externalIds?.[name]).filter((id): id is string => !!id),
    );

    // Only ask the store when something might be skippable (a first import has
    // nothing to compare against, and `list()` is itself a CLI round-trip).
    const pending = (await this.pendingWrites()).filter((write) => write.connector === name);
    let wanted = externalIds.filter(
      (id) => (isPass || !writtenBack.has(id)) && !pending.some((write) => write.externalId === id),
    );
    if (mirrored.size && !opts.acceptRemote) {
      const metadata = new Map((connector instanceof GitPassConnector ? (await connector.catalog()).items : await connector.list()).map((i) => [i.externalId, i]));
      wanted = wanted.filter((id) => {
        if (!metadata.has(id)) return true;
        // Whole milliseconds on BOTH sides. A source's change marker can be
        // finer-grained than the mirror clock it is compared against — a file
        // mtime carries sub-millisecond precision while `Date.now()` does not —
        // so an entry touched in the same millisecond the sync recorded reads
        // back as `clock + 0.31…`: strictly greater, hence "changed", hence
        // re-decrypted on every sync from then on. Comparing at the coarser of
        // the two resolutions is what makes the two numbers comparable at all.
        const at = floorMs(metadata.get(id)?.changedAt);
        const item = mirrored.get(id);
        if (isPass && item?.provenance.passNotesVersion !== 2) return true;
        if (!isPass && item?.provenance.connectorFormatVersion !== 1) return true;
        const revision = metadata.get(id)?.revision;
        if (revision !== undefined) return !item || item.provenance.sourceRevision !== revision;
        // Items mirrored before `syncedAt` existed fall back to `updatedAt`,
        // so an upgrade does not force one more full-store re-read; they get a
        // real mirror clock the first time they are pulled again.
        const since = floorMs(item && (item.provenance.syncedAt ?? item.updatedAt));
        return !(at !== undefined && since !== undefined && at <= since);
      });
    }

    const pendingBeforePull = new Map((await __asyncCollections.map([...mirrored.values()], async item => [item.id, (await this.store.kvGet(this.pendingKey(item.id)))])));
    const { items: pulled, failures } = wanted.length ? await connector.pull(wanted) : { items: [], failures: [] };
    // Nothing at all came back: surface why (a locked GPG key, an expired
    // session) rather than reporting a silent zero-item success.
    if (!pulled.length && failures.length) throw new Error(failures[0]!.error);
    const syncedAt = Date.now();
    const itemIds: string[] = [];
    let raced = 0;
    for (const ext of pulled) {
      const existing = mirrored.get(ext.externalId);
      await serializeGitPass(`writeback:${this.organizationId}:${existing?.id ?? ext.externalId}`, async () => {
        if (name === 'pass-git' && existing && pendingBeforePull.get(existing.id) !== (await this.store.kvGet(this.pendingKey(existing.id)))) {
          failures.push({ externalId: ext.externalId, error: 'Write-back changed during import; retry the import' }); return;
        }
        if (name === 'pass-git' && existing && Object.keys((await this.pending(existing.id)).fields).length && !opts.acceptRemote) {
          failures.push({ externalId: ext.externalId, error: 'Pending write-back: retry or explicitly use the remote value' }); return;
        }
        if ((existing && (await this.items.get(existing.id))?.updatedAt !== existing.updatedAt) ||
          (await this.pendingWrites()).some((write) => write.connector === name && write.externalId === ext.externalId)) {
          raced++;
          return;
        }
        const saved = (await this.items.save({
          id: existing?.id,
          type: ext.type,
          label: existing && !existing.provenance.source.startsWith('connector:') ? existing.label : ext.label,
          domains: existing && !existing.provenance.source.startsWith('connector:') ? existing.domains : ext.domains,
          username: existing && !existing.provenance.source.startsWith('connector:') ? existing.username : ext.username,
          // Apply the chosen import policy to NEW items only; a re-sync must not
          // clobber a policy the user has since tuned on an existing item.
          ...(existing ? {} : { policy: opts.policy }),
          secrets: ext.secrets,
          replaceSecrets: true,
          provenance: {
            source,
            externalId: ext.externalId,
            syncedAt,
            sourceRevision: ext.revision,
            ...(isPass ? { passNotesVersion: 2 } : { connectorFormatVersion: 1 }),
          },
        }));
        if (opts.acceptRemote) (await this.store.kvSet(this.pendingKey(saved.id), JSON.stringify({ fields: {}, generation: randomUUID() })));
        itemIds.push(saved.id);
      });
    }
    const total = (await this.items.list()).filter((i) => i.provenance.source === source).length;
    (await this.setConfig(name, { lastSync: { at: syncedAt, count: total } }));
    return { count: itemIds.length, itemIds, skipped: externalIds.length - wanted.length + raced, failures };
  }

  /** Durable outbox contains handles and routing only, never secret values. */
  async pendingWrites(): Promise<PendingConnectorWrite[]> {
    return (await readConnectorWrites(this.store, this.organizationId));
  }
  private async saveWrite(write: PendingConnectorWrite, remove = false): Promise<void> {
    return this.store.transaction(async () => {
    await this.lockVault();
    const current = (await this.pendingWrites());
    if (!current.some((entry) => entry.id === write.id)) return;
    if (
      current.some(
        (entry) =>
          entry.connector === write.connector &&
          entry.itemId === write.itemId &&
          entry.field === write.field &&
          entry.id !== write.id,
      )
    )
      return;
    const pending = current.filter((entry) => entry.id !== write.id);
    if (!remove) pending.push(write);
    (await this.store.kvSet(connectorOutboxKey(this.organizationId), JSON.stringify(pending)));
    if (remove && write.snapshotHandle && !pending.some((entry) => entry.snapshotHandle === write.snapshotHandle))
      (await this.broker?.deleteHandle(write.snapshotHandle));
      });
  }
  private async writeTarget(name: string): Promise<string> {
    const secret = await this.secretFor(name);
    const connector = this.get(name);
    const identity = connector instanceof PassConnector ? connector.storeIdentity()
      : name === 'pass-git' && secret ? gitPassRepositoryIdentity(secret) : (secret ?? name);
    return createHash('sha256')
      .update(identity ?? name)
      .digest('hex');
  }
  private async queueWrite(name: string, itemId: string, externalId: string, field?: VaultFieldName): Promise<PendingConnectorWrite> {
    // Chosen once: a re-run transaction must reuse the same snapshot handle.
    const writeId = randomUUID();
    return this.store.transaction(async () => {
    await this.lockVault();
    const existing = (await this.pendingWrites()).find(
      (entry) => entry.connector === name && entry.itemId === itemId && entry.field === field,
    );
    const write: PendingConnectorWrite = {
      id: writeId,
      connector: name,
      itemId,
      externalId: existing?.externalId ?? externalId,
      field,
      target: existing?.target ?? await this.writeTarget(name),
      attempts: 0,
      nextAttemptAt: Date.now(),
    };
    if (!field) {
      write.snapshotHandle = existing?.snapshotHandle ?? `connector-export:${this.organizationId}:${write.id}`;
      if (!existing?.snapshotHandle) {
        const item = (await this.items.get(itemId));
        if (!item || !this.broker) throw new Error('Credential storage is unavailable');
        const secrets: Partial<Record<VaultFieldName, string>> = {};
        for (const field of item.fields) {
          const value = await this.items.readSecret(item, field);
          if (value !== undefined) secrets[field] = value;
        }
        (await this.broker.registerHandle(
          write.snapshotHandle,
          JSON.stringify({
            externalId: write.externalId,
            type: item.type,
            label: item.label,
            username: item.username,
            domains: item.domains,
            fields: item.fields,
            secrets,
          }),
          organizationScope(this.organizationId),
        ));
      }
    }
    const pending = (await this.pendingWrites()).filter((entry) => entry.id !== existing?.id);
    pending.push(write);
    (await this.store.kvSet(connectorOutboxKey(this.organizationId), JSON.stringify(pending)));
    return write;
      });
  }
  private async executeWrite(write: PendingConnectorWrite): Promise<{ externalId: string } | undefined> {
    return serializeGitPass(`vault-outbox:${this.organizationId}:${write.connector}:${write.itemId}`, async () => {
      if (!(await this.pendingWrites()).some((entry) => entry.id === write.id)) return undefined;
      const item = (await this.items.get(write.itemId));
      if (!item) {
        (await this.saveWrite(write, true));
        return undefined;
      }
      if (!(await this.config(write.connector)).writeBack) return undefined;
      try {
        if (write.target !== await this.writeTarget(write.connector))
          throw new Error('The connected store changed; the pending write requires review');
        const connector = this.get(write.connector);
        if (!connector) throw new Error('Connector is unavailable');
        let externalId = write.externalId;
        if (write.field) {
          const binding =
            item.provenance.source === `connector:${write.connector}`
              ? item.provenance.externalId
              : (item.provenance.externalIds?.[write.connector] ?? item.provenance.externalId);
          if (binding !== externalId || item.provenance.source.startsWith('import:'))
            throw new Error('The item binding changed; the pending write requires review');
          if (!connector.updateSecret) throw new Error('Connector cannot update existing items');
          const value = await this.items.readSecret(item, write.field);
          if (value !== undefined) await connector.updateSecret(externalId, write.field, value);
        } else {
          if (!connector.push) throw new Error('Connector cannot create external items');
          if (item.provenance.source.startsWith('connector:') || item.provenance.source.startsWith('import:'))
            throw new Error('Imported items cannot be exported automatically');
          const bound = item.provenance.externalIds?.[write.connector];
          if (bound) {
            if (!connector.updateSecret) throw new Error('Connector cannot update an existing export');
            for (const field of item.fields) {
              const value = await this.items.readSecret(item, field);
              if (value !== undefined) await connector.updateSecret(bound, field, value);
            }
            (await this.saveWrite(write, true));
            return { externalId: bound };
          }
          if (!write.snapshotHandle || !this.broker) throw new Error('Export snapshot is unavailable');
          const snapshot = JSON.parse(
            await this.broker.resolve(write.snapshotHandle, { caps: ['use-credential:*'] }),
          ) as ExternalSecretItem;
          const result = await connector.push(snapshot);
          externalId = result.externalId;
          await this.items.setExternalId(item.id, write.connector, externalId);
          // Replaying the immutable creation snapshot makes a lost response
          // distinguishable from a collision. Reconcile any later rotation only
          // after that exact external entry has been acknowledged and bound.
          const current = (await this.items.get(item.id))!;
          for (const field of current.fields) {
            const value = await this.items.readSecret(current, field);
            if (value !== undefined && value !== snapshot.secrets[field]) {
              if (!connector.updateSecret) throw new Error('Connector cannot update an existing export');
              await connector.updateSecret(externalId, field, value);
            }
          }
        }
        (await this.saveWrite(write, true));
        return { externalId };
      } catch (error) {
        // Vendor stderr can contain the submitted secret. Keep operational
        // state and user-facing errors free of provider output.
        const message =
          error instanceof Error &&
          /^(The connected store changed|The item binding changed|Export destination already contains different data)/.test(
            error.message,
          )
            ? error.message
            : 'External store write failed; the vault is saved and the write is pending retry';
        (await this.saveWrite({
          ...write,
          attempts: write.attempts + 1,
          nextAttemptAt: Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(write.attempts, 7)),
          error: message,
        }));
        throw new Error(message);
      }
    });
  }
  async discardWrites(name: string): Promise<number> {
    return this.store.transaction(async () => {
    await this.lockVault();
    const pending = (await this.pendingWrites()).filter((write) => write.connector === name);
    for (const write of pending) (await this.saveWrite(write, true));
    let rotations = 0;
    if (name === 'pass-git') for (const item of (await this.items.list())) {
      if (Object.keys((await this.pending(item.id)).fields).length) {
        (await this.store.kvSet(this.pendingKey(item.id), JSON.stringify({ fields: {}, generation: randomUUID() })));
        rotations++;
      }
    }
    return pending.length + rotations;
      });
  }

  /** Point a Git store's pending writes at the store connected now. Delivery
   *  still refuses an entry that changed since the rotation was based on it,
   *  and an export whose destination holds different data. Other connectors
   *  have no store identity beyond their secret, so theirs stay blocked. */
  private async retargetWrites(name: string): Promise<void> {
    if (name !== 'pass-git') return;
    return this.store.transaction(async () => {
      await this.lockVault();
      const target = await this.writeTarget(name);
      const writes = (await this.pendingWrites());
      if (writes.some((write) => write.connector === name && write.target !== target))
        (await this.store.kvSet(connectorOutboxKey(this.organizationId), JSON.stringify(writes.map((write) =>
          write.connector !== name || write.target === target ? write
            : { ...write, target, attempts: 0, nextAttemptAt: Date.now(), error: undefined }))));
      const binding = gitPassRepositoryIdentity(await this.secretFor(name));
      for (const item of (await this.items.list())) {
        const pending = (await this.pending(item.id));
        if (Object.keys(pending.fields).length && pending.binding !== binding)
          (await this.store.kvSet(this.pendingKey(item.id), JSON.stringify({ ...pending, binding })));
      }
    });
  }

  async retryWrites(
    options: { dueOnly?: boolean; connector?: string } = {},
  ): Promise<Array<{ connector: string; itemId: string; error?: string }>> {
    const results: Array<{ connector: string; itemId: string; error?: string }> = [];
    for (const write of (await __asyncCollections.filter((await this.pendingWrites()), 
        async (entry) =>
          (!options.connector || entry.connector === options.connector) &&
          (!options.dueOnly || entry.nextAttemptAt <= Date.now()) &&
          (await this.config(entry.connector)).writeBack,
      ))
      .slice(0, 100)) {
      try {
        const result = await this.executeWrite(write);
        if (result) results.push({ connector: write.connector, itemId: write.itemId });
      } catch (error) {
        results.push({ connector: write.connector, itemId: write.itemId, error: (error as Error).message });
      }
    }
    // Keep the already-shipped, revision-checked Git rotation records compatible
    // with the general retry controls and the automatic recovery sweep.
    if ((!options.connector || options.connector === 'pass-git') && (await this.config('pass-git')).writeBack) {
      for (const item of (await __asyncCollections.filter((await this.items.list()), async item => Object.keys((await this.pending(item.id)).fields).length)).slice(0, Math.max(0, 100 - results.length))) {
        try {
          const result = await this.retryWriteBack(item.id);
          if (result) results.push({ connector: 'pass-git', itemId: item.id });
        } catch {
          results.push({ connector: 'pass-git', itemId: item.id,
            error: 'External write remains pending; retry or review the remote value' });
        }
      }
    }
    return results;
  }

  /**
   * Push an **agent-created** vault item back out to the store as a NEW entry
   * (opt-in, §9). Write-back's purpose is that accounts an agent registers
   * survive beyond karmax in your own password manager — it is not a two-way
   * sync. Items that were mirrored IN from a connector are refused: pushing
   * them back would risk clobbering notes/fields karmax never captured.
   */
  async writeBack(name: string, itemId: string): Promise<{ externalId: string } | undefined> {
    const connector = this.get(name);
    if (!connector?.push) throw new Error(`connector "${name}" does not support creating external items (existing entries can be updated)`);
    if (!(await this.config(name)).writeBack) return undefined;
    const item = (await this.items.get(itemId));
    if (!item) throw new Error(`no vault item ${itemId}`);
    if (item.type === 'session') throw new Error('a saved browser session stays in the vault: it expires and rotates, so it is not written to other stores');
    if (item.provenance.source.startsWith('import:')) {
      throw new Error('this item came from a one-way file import; write-back to the imported file is unavailable');
    }
    if (item.provenance.source.startsWith('connector:'))
      throw new Error(
        'this item was mirrored in from a store; write-back only pushes agent-created items back out (it never overwrites a synced entry)',
      );
    const pending = (await this.pendingWrites()).find(
      (write) => write.connector === name && write.itemId === itemId && !write.field,
    );
    if (pending) return this.executeWrite(pending);
    const existing = item.provenance.externalIds?.[name];
    if (existing) return { externalId: existing };
    // A stable path survives lost responses and process restarts. The connector
    // checks existing content before acknowledging an idempotent creation.
    const write = (await this.queueWrite(name, itemId, `${PASS_EXPORT_FOLDER}/${item.id}.${item.type}`));
    return this.executeWrite(write);
  }

  /**
   * Push a newly-created vault item to every connector whose write-back toggle
   * is enabled. This is the automatic half of the signup contract: an agent
   * only needs `vault:store`; it must not also need the administrative
   * `credential:write` capability merely to honor an operator's existing
   * connector policy. Failures are reported per connector while the karmax
   * vault remains the durable source of truth.
   */
  async writeBackCreated(itemId: string): Promise<Array<{ connector: string; externalId?: string; error?: string }>> {
    const results: Array<{ connector: string; externalId?: string; error?: string }> = [];
    if ((await this.items.get(itemId))?.type === 'session') return results;
    for (const name of this.names()) {
      if (!(await this.config(name)).writeBack) continue;
      try {
        const pushed = await this.writeBack(name, itemId);
        if (pushed) results.push({ connector: name, externalId: pushed.externalId });
      } catch (e) {
        results.push({ connector: name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return results;
  }

  /**
   * Propagate rotated secret fields to every external store already bound to
   * the item. Imported items have one source binding; agent-created items may
   * have several write-back bindings. This deliberately uses updateSecret,
   * never push/create, so connector-specific preservation rules (for example
   * pass notes on lines 2+) remain intact.
   *
   * Legacy agent-created items have one unlabelled `externalId`. Use it only
   * when exactly one enabled update-capable connector is an unambiguous target;
   * never risk sending the same id to several stores. Connector errors do not
   * roll back the already-correct karmax vault.
   */
  private pendingKey(itemId: string): string { return `pass-writeback:${this.organizationId}:${itemId}`; }
  private async pending(itemId: string): Promise<{ binding?: string; externalId?: string; fields: Partial<Record<VaultFieldName, string>> }> {
    const raw = (await this.store.kvGet(this.pendingKey(itemId)));
    return raw ? JSON.parse(raw) : { fields: {} };
  }

  async retryWriteBack(itemId: string) {
    if (!(await this.config('pass-git')).writeBack) return undefined;
    const fields = Object.keys((await this.pending(itemId)).fields) as VaultFieldName[];
    if (!fields.length) throw new Error('No pending write-back for this item');
    const pending = (await this.pending(itemId));
    return { connector: 'pass-git', fields: await this.propagateGit(itemId, fields, pending.externalId!) };
  }

  async acceptRemote(itemId: string) {
    const pending = (await this.pending(itemId));
    if (!pending.externalId || pending.binding !== gitPassRepositoryIdentity(await this.secretFor('pass-git'))) throw new Error('Write-back connection changed; review the current connection');
    const result = await this.sync('pass-git', [pending.externalId], { acceptRemote: true });
    if (result.count !== 1 || result.failures.length) throw new Error(result.failures[0]?.error ?? 'Remote value was not imported');
    return result;
  }

  private async propagateGit(itemId: string, fields: VaultFieldName[], externalId: string): Promise<VaultFieldName[]> {
    return serializeGitPass(`writeback:${this.organizationId}:${itemId}`, async () => {
      const item = (await this.items.get(itemId));
      const name = 'pass-git';
      const connector = this.get(name);
      if (!item || !(connector instanceof GitPassConnector) || !(await this.config(name)).writeBack) return [];
      const bound = item.provenance.source === 'connector:pass-git' ? item.provenance.externalId
        : item.provenance.externalIds?.[name] ?? item.provenance.externalId;
      if (item.provenance.source.startsWith('import:') || bound !== externalId)
        throw new Error('Write-back item binding changed; review the current connection');
      const pending = (await this.pending(itemId));
      const binding = gitPassRepositoryIdentity(await this.secretFor(name));
      if (Object.keys(pending.fields).length && (pending.binding !== binding || pending.externalId !== externalId)) throw new Error('Write-back connection changed; review the current connection');
      const values: Partial<Record<VaultFieldName, string>> = {};
      for (const field of new Set([...Object.keys(pending.fields) as VaultFieldName[], ...fields])) {
        if (item.fields.includes(field)) {
          const value = await this.items.readSecret(item, field);
          if (value !== undefined) values[field] = value;
        }
      }
      if (!Object.keys(values).length) return [];
      // Persist all fields before any push. A multi-field rotation is one Git
      // commit, so a rejected push cannot silently drop its remaining fields.
      const previousRevision = Object.values(pending.fields)[0];
      pending.fields = Object.fromEntries(Object.keys(values).map(field => [field, previousRevision ?? 'unverified']));
      pending.binding = binding; pending.externalId = externalId;
      const queued = JSON.stringify(pending);
      (await this.store.kvSet(this.pendingKey(itemId), queued));
      // A transport failure during revision lookup must leave a durable intent
      // too. Without a verified revision, retries fail closed on changed data.
      const revision = previousRevision
        ?? (await connector.catalog()).items.find(entry => entry.externalId === externalId)?.revision
        ?? (item.provenance.source === 'connector:pass-git' ? item.provenance.sourceRevision : undefined)
        ?? 'unverified';
      if (!(await this.items.get(itemId)) || (await this.store.kvGet(this.pendingKey(itemId))) !== queued) return [];
      if (binding !== gitPassRepositoryIdentity(await this.secretFor(name))) throw new Error('Write-back connection changed; review the current connection');
      if (!(await this.config(name)).writeBack) return [];
      pending.fields = Object.fromEntries(Object.keys(values).map(field => [field, revision]));
      (await this.store.kvSet(this.pendingKey(itemId), JSON.stringify(pending)));
      await connector.updateSecrets(externalId, values, revision);
      (await this.store.kvSet(this.pendingKey(itemId), JSON.stringify({ fields: {}, generation: randomUUID() })));
      return Object.keys(values) as VaultFieldName[];
    });
  }

  async propagate(
    itemId: string,
    fields: VaultFieldName[],
  ): Promise<
    | {
        connector: string;
        fields: VaultFieldName[];
        error?: string;
        failures?: Array<{ connector: string; field: VaultFieldName; error: string }>;
      }
    | undefined
  > {
    const item = (await this.items.get(itemId));
    if (!item) return undefined;
    // File imports are snapshots, not bindings. Their vendor item IDs exist
    // solely to make a later file import idempotent and must never be routed to
    // any connector, including through legacy or accidentally-added bindings.
    if (item.provenance.source.startsWith('import:')) return undefined;

    let bindings: Array<[connector: string, externalId: string]> = [];
    if (item.provenance.source.startsWith('connector:') && item.provenance.externalId) {
      bindings = [[item.provenance.source.slice('connector:'.length), item.provenance.externalId]];
    } else if (item.provenance.externalIds) {
      bindings = Object.entries(item.provenance.externalIds);
    } else if (item.provenance.externalId && !item.provenance.source.startsWith('import:')) {
      const candidates = (await __asyncCollections.filter(this.names(), 
        async (name) => Boolean(this.get(name)?.updateSecret) && Boolean((await this.config(name)).writeBack),
      ));
      if (candidates.length > 1) {
        throw new Error(`legacy write-back binding is ambiguous across enabled connectors: ${candidates.join(', ')}`);
      }
      if (candidates.length === 1) bindings = [[candidates[0]!, item.provenance.externalId]];
    }

    const failures: Array<{ connector: string; field: VaultFieldName; error: string }> = [];
    const pushedConnectors: string[] = [];
    const pushedFields = new Set<VaultFieldName>();
    for (const [name, externalId] of bindings) {
      if (!(await this.config(name)).writeBack) continue;
      const connector = this.get(name);
      let connectorUpdated = false;
      if (connector instanceof GitPassConnector) {
        try {
          const updated = await this.propagateGit(itemId, fields, externalId);
          for (const field of updated) pushedFields.add(field);
          connectorUpdated = updated.length > 0;
        } catch {
          for (const field of fields) failures.push({ connector: name, field,
            error: 'External store write failed; the vault is saved and the write is pending retry' });
        }
      } else for (const field of fields) {
        if (!item.fields.includes(field)) continue;
        const value = await this.items.readSecret(item, field);
        if (value === undefined) continue;
        const write = (await this.queueWrite(name, itemId, externalId, field));
        try {
          const result = await this.executeWrite(write);
          if (result) {
            pushedFields.add(field);
            connectorUpdated = true;
          }
        } catch (error) {
          failures.push({ connector: name, field, error: (error as Error).message });
        }
      }
      if (connectorUpdated) pushedConnectors.push(name);
    }
    return pushedConnectors.length || failures.length
      ? {
          connector: pushedConnectors.join(', '),
          fields: [...pushedFields],
          ...(failures.length
            ? { failures, error: 'Vault saved; some external writes failed and are pending retry' }
            : {}),
        }
      : undefined;
  }
}

/** The standard registry, one construction shared
 *  by every gateway call site so the wiring cannot drift.
 *
 *  A managed cell uses 1Password's stateless service-account SDK. Bitwarden's
 *  session key and local `pass` both depend on tenant-owned host state, so they
 *  remain host-local. Git-backed pass is isolated and works in every mode. */
export function defaultConnectors(store: ConnectorStore, items: VaultItems, broker: CredentialBroker | undefined,
  organizationId: string, opts: { hostLocal?: boolean; hosted?: boolean; githubApp?: ConnectorGithubApp } = {}): Connectors {
  const connectors = new Connectors(store, items, broker, organizationId);
  if (opts.hosted) {
    connectors.register(new OnePasswordSdkConnector(() => connectors.secretFor('1password')));
  } else {
    connectors.register(new OnePasswordConnector(() => connectors.secretFor('1password')));
    if (opts.hostLocal ?? hostLocal()) {
      connectors.register(new BitwardenConnector(() => connectors.secretFor('bitwarden')));
      connectors.register(new PassConnector());
    }
  }
  const profiles = new GitProfiles(store, broker, paths().state, organizationId);
  connectors.register(new GitPassConnector(
    () => connectors.secretFor('pass-git'),
    organizationId,
    async (requested) => {
      const profileName = requested || (await profiles.defaultProfile());
      if (!profileName) return {};
      const profile = (await profiles.get(profileName));
      if (!profile) throw new Error(`unknown Git profile "${profileName}"`);
      return (await profiles.env(profile, {}));
    },
    undefined,
    { hosted: opts.hosted, repositoryCredential: (repositoryUrl) =>
      attachedRepositoryCredential(store, opts.githubApp, organizationId, repositoryUrl) },
  ));
  return connectors;
}

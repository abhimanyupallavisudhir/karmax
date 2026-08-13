import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { GitProfiles } from './git-profiles.js';
import { VaultItems, VaultItemType, VaultFieldName, VaultItemPolicy } from './vault-items.js';
import { hostOf, passEntryMetadata } from './pass-path.js';

const pexec = promisify(execFile);

/**
 * External password-store connectors (PLAN-passwords.md §9). The karmax vault
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
  /** Does this connector support opt-in external write-back? */
  canPush: boolean;
  /** Selects the connection form without exposing connector secrets. */
  setup?: 'secret' | 'git-pass';
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

const realExec: Exec = async (cmd, args, opts) => {
  const child = pexec(cmd, args, { env: { ...process.env, ...(opts?.env ?? {}) }, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  if (opts?.input) {
    child.child.stdin?.write(opts.input);
    child.child.stdin?.end();
  }
  return (await child).stdout;
};

// ── Bitwarden (`bw` CLI, zero-knowledge; session key held in the vault) ───────

export class BitwardenConnector implements CredentialConnector {
  readonly name = 'bitwarden';
  constructor(private sessionKey: () => string | undefined, private exec: Exec = realExec) {}
  private env(): Record<string, string> {
    const key = this.sessionKey();
    return key ? { BW_SESSION: key } : {};
  }
  async describe(): Promise<ConnectorInfo> {
    if (!this.sessionKey()) return {
      name: this.name,
      label: 'Bitwarden',
      available: false,
      canPush: true,
      detail: 'needs the `bw` CLI on this host.',
    };
    try {
      const status = JSON.parse(await this.exec('bw', ['status'], { env: this.env() }));
      const unlocked = status?.status === 'unlocked';
      return { name: this.name, label: 'Bitwarden', available: unlocked, canPush: true,
        detail: unlocked ? 'ready' : 'The Bitwarden session key is invalid or expired.' };
    } catch {
      return { name: this.name, label: 'Bitwarden', available: false, canPush: true,
        detail: 'needs the `bw` CLI on this host.' };
    }
  }
  async list(): Promise<ExternalItem[]> {
    const [items, folders] = await Promise.all([
      this.exec('bw', ['list', 'items'], { env: this.env() }).then((s) => JSON.parse(s) as any[]),
      this.exec('bw', ['list', 'folders'], { env: this.env() }).then((s) => JSON.parse(s) as any[]).catch(() => []),
    ]);
    const folderName = new Map<string, string>(folders.map((f: any) => [f.id, f.name]));
    return items.map((it) => normalizeBitwarden(it, folderName.get(it.folderId) ?? '')).filter((x): x is ExternalItem => !!x);
  }
  async pull(externalIds: string[]): Promise<PullResult> {
    const wanted = new Set(externalIds);
    const items = JSON.parse(await this.exec('bw', ['list', 'items'], { env: this.env() })) as any[];
    const out: ExternalSecretItem[] = [];
    for (const it of items) {
      if (!wanted.has(it.id)) continue;
      const norm = normalizeBitwarden(it, '');
      if (!norm) continue;
      const secrets: Partial<Record<VaultFieldName, string>> = {};
      if (it.login?.password) secrets.password = it.login.password;
      if (it.login?.totp) secrets.totp = it.login.totp;
      if (norm.type === 'note' && it.notes) secrets.note = it.notes;
      out.push({ ...norm, secrets });
    }
    return { items: out, failures: [] };
  }
  /** Field-level edit: read the item JSON, change one field, `bw edit` it back —
   *  every other field (username, notes, uris, totp) is preserved. */
  async updateSecret(externalId: string, field: VaultFieldName, value: string): Promise<void> {
    const item = JSON.parse(await this.exec('bw', ['get', 'item', externalId], { env: this.env() }));
    item.login = item.login ?? {};
    if (field === 'password') item.login.password = value;
    else if (field === 'totp') item.login.totp = value;
    else if (field === 'note') item.notes = value;
    else throw new Error(`Bitwarden write-back does not support the "${field}" field`);
    const encoded = Buffer.from(JSON.stringify(item)).toString('base64');
    await this.exec('bw', ['edit', 'item', externalId, encoded], { env: this.env() });
  }
}

function normalizeBitwarden(it: any, folder: string): ExternalItem | undefined {
  const changedAt = timestampOf(it.revisionDate);
  if (it.type === 1 && it.login) {
    const domains = (it.login.uris ?? []).map((u: any) => hostOf(u?.uri)).filter(Boolean);
    return { externalId: it.id, type: 'login', label: it.name ?? 'login', username: it.login.username ?? undefined,
      domains, folder, fields: ['password', ...(it.login.totp ? (['totp'] as VaultFieldName[]) : [])], ...changedAt };
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
  constructor(private token: () => string | undefined, private exec: Exec = realExec) {}
  private env(): Record<string, string> {
    const t = this.token();
    return t ? { OP_SERVICE_ACCOUNT_TOKEN: t } : {};
  }
  async describe(): Promise<ConnectorInfo> {
    if (!this.token()) return {
      name: this.name,
      label: '1Password',
      available: false,
      canPush: true,
      detail: 'needs the `op` CLI on this host.',
    };
    try {
      await this.exec('op', ['whoami', '--format=json'], { env: this.env() });
      return { name: this.name, label: '1Password', available: true, canPush: true, detail: 'ready' };
    } catch {
      return { name: this.name, label: '1Password', available: false, canPush: true,
        detail: 'Check the service-account token and make sure the `op` CLI is installed.' };
    }
  }
  async list(): Promise<ExternalItem[]> {
    const items = JSON.parse(await this.exec('op', ['item', 'list', '--format=json'], { env: this.env() })) as any[];
    return items.map((it) => ({ externalId: it.id, type: categoryType(it.category), label: it.title ?? 'item',
      domains: (it.urls ?? []).map((u: any) => hostOf(u?.href)).filter(Boolean),
      folder: it.vault?.name ?? '', fields: itemFieldsFor(categoryType(it.category)), ...timestampOf(it.updated_at) }));
  }
  async pull(externalIds: string[]): Promise<PullResult> {
    const out: ExternalSecretItem[] = [];
    const failures: PullResult['failures'] = [];
    for (const id of externalIds) {
      let full: any;
      try {
        full = JSON.parse(await this.exec('op', ['item', 'get', id, '--format=json'], { env: this.env() }));
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
      if (otp?.totp) secrets.totp = otp.totp;
      else if (otp?.value) secrets.totp = otp.value;
      if (type === 'api-key') secrets.secret = val('credential') ?? val('password');
      out.push({ externalId: id, type, label: full.title ?? 'item', username: val('username'),
        domains: (full.urls ?? []).map((u: any) => hostOf(u?.href)).filter(Boolean), fields: Object.keys(secrets) as VaultFieldName[], secrets });
    }
    return { items: out, failures };
  }
  /** Field-level edit via `op item edit` — assignments touch only the named
   *  field, leaving notes and everything else in the item intact. */
  async updateSecret(externalId: string, field: VaultFieldName, value: string): Promise<void> {
    const assignment =
      field === 'password' ? `password=${value}`
      : field === 'secret' ? `credential=${value}`
      : field === 'totp' ? `one-time password[otp]=${value}`
      : field === 'note' ? `notesPlain=${value}`
      : undefined;
    if (!assignment) throw new Error(`1Password write-back does not support the "${field}" field`);
    await this.exec('op', ['item', 'edit', externalId, assignment], { env: this.env() });
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
    integrationName: 'Krmax',
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
    private token: () => string | undefined,
    private createClient: OnePasswordClientFactory = createOnePasswordClient,
  ) {}

  private client(token = this.token()): Promise<OnePasswordSdkClient> {
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
    const token = this.token();
    if (!token) return {
      name: this.name,
      label: '1Password',
      available: false,
      canPush: true,
      detail: 'Enter a 1Password service-account token.',
    };
    try {
      await (await this.client(token)).vaults.list({ decryptDetails: true });
      return {
        name: this.name,
        label: '1Password',
        available: true,
        canPush: true,
        detail: 'service account connected through the 1Password SDK',
      };
    } catch {
      return {
        name: this.name,
        label: '1Password',
        available: false,
        canPush: true,
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
    const client = await this.client();
    const [vaultId, itemId] = await this.location(externalId);
    const item = await client.items.get(vaultId, itemId);
    if (field === 'note') {
      item.notes = value;
      await client.items.put(item);
      return;
    }
    const target = (item.fields ?? []).find((candidate: any) => onePasswordField(candidate, field));
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
      ?? value('privateKey') ?? value('private key');
    if (key) secrets.privateKey = key;
  }
  if (type === 'note' && item.notes) secrets.note = item.notes;
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

function onePasswordField(field: any, target: VaultFieldName): boolean {
  if (target === 'password') return field.id === 'password';
  if (target === 'secret') return field.id === 'credential' || field.id === 'password';
  if (target === 'totp') return field.fieldType === 'Totp' || field.type === 'OTP';
  if (target === 'privateKey') return field.fieldType === 'SshKey'
    || field.id === 'privateKey' || field.id === 'private key';
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
  return type === 'login' ? ['password'] : type === 'api-key' ? ['secret'] : type === 'ssh-key' ? ['privateKey'] : ['note'];
}

// ── unix `pass` (GPG tree; the self-hosted / host-fallback spirit) ────────────

export class PassConnector implements CredentialConnector {
  readonly name = 'pass';
  constructor(
    private exec: Exec = realExec,
    private storeDir = path.resolve(process.env.PASSWORD_STORE_DIR || path.join(os.homedir(), '.password-store')),
  ) {}
  async describe(): Promise<ConnectorInfo> {
    try {
      await this.exec('pass', ['ls']);
      return { name: this.name, label: 'unix pass', available: true, canPush: true, detail: 'password store present' };
    } catch {
      return { name: this.name, label: 'unix pass', available: false, canPush: false, detail: 'the `pass` CLI / store is not set up (self-hosted only)' };
    }
  }
  async list(): Promise<ExternalItem[]> {
    return (await this.entries()).map((entry) => {
      const slash = entry.lastIndexOf('/');
      const { domain, username } = passEntryMetadata(entry);
      return { externalId: entry, type: 'login' as const,
        label: slash >= 0 ? entry.slice(slash + 1) : entry,
        folder: slash >= 0 ? entry.slice(0, slash) : '',
        domains: domain ? [domain] : [], ...(username ? { username } : {}),
        fields: ['password'] as VaultFieldName[], ...this.changedAt(entry) };
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
      let body: string;
      try {
        body = await this.exec('pass', ['show', id]);
      } catch (e) {
        // A single entry that will not decrypt (wrong recipient, a gpg hiccup)
        // is reported and skipped; the rest of the import still lands.
        failures.push({ externalId: id, error: gpgHint(e) });
        continue;
      }
      const lines = body.replace(/\r/g, '').split('\n');
      // `pass` convention: the FIRST line is the password; everything after is
      // free-form notes/fields. Only line 1 is ever the credential for `use`
      // (fill/inject); an `otpauth://` line anywhere becomes the TOTP seed.
      const password = lines[0] ?? '';
      const otp = lines.slice(1).find((l) => l.trim().startsWith('otpauth://'))?.trim();
      const secrets: Partial<Record<VaultFieldName, string>> = { password };
      if (otp) secrets.totp = otp;
      const { domain, username } = passEntryMetadata(id);
      out.push({ externalId: id, type: 'login', label: id, domains: domain ? [domain] : [],
        ...(username ? { username } : {}),
        fields: Object.keys(secrets) as VaultFieldName[], secrets, ...this.changedAt(id) });
    }
    return { items: out, failures };
  }
  /** The entry file's mtime — `pass` keeps one GPG file per entry, so the
   *  filesystem already records when a credential last changed. */
  private changedAt(entry: string): { changedAt?: number } {
    try {
      return { changedAt: fs.statSync(path.join(this.storeDir, `${entry}.gpg`)).mtimeMs };
    } catch {
      return {};
    }
  }
  private async entries(): Promise<string[]> {
    // `pass ls` cannot be used for enumeration: its `tree` output includes
    // arbitrary files from the store and merely removes `.gpg` from encrypted
    // entries. Inspect the filenames instead, so `notes.md` is ignored while a
    // legitimate password named `notes.md.gpg` is exposed as `notes.md`.
    const raw = await this.exec('find', [
      '-L', this.storeDir,
      '-path', path.join(this.storeDir, '.git'), '-prune',
      '-o', '-type', 'f', '-name', '*.gpg', '-print0',
    ]);
    return parsePassFiles(raw, this.storeDir);
  }
  /**
   * Field-level update that preserves the notes on lines 2+: read the whole
   * entry, replace only line 1 (password) or the `otpauth://` line (totp), and
   * re-insert. This is why "line 1 is the password" is enforced precisely.
   */
  async updateSecret(externalId: string, field: VaultFieldName, value: string): Promise<void> {
    let body: string;
    try {
      body = await this.exec('pass', ['show', externalId]);
    } catch (e) {
      throw new Error(gpgHint(e));
    }
    const lines = body.replace(/\r/g, '').replace(/\n$/, '').split('\n');
    if (field === 'password') {
      lines[0] = value;
    } else if (field === 'totp') {
      const idx = lines.findIndex((l, i) => i > 0 && l.trim().startsWith('otpauth://'));
      if (idx >= 0) lines[idx] = value;
      else lines.push(value); // no existing seed → append one
    } else {
      throw new Error(`pass write-back does not support the "${field}" field`);
    }
    try {
      await this.exec('pass', ['insert', '-m', '-f', externalId], { input: lines.join('\n') + '\n' });
    } catch (e) {
      throw new Error(gpgHint(e));
    }
  }
  /**
   * Write-back creates a NEW entry (under `karmax/…`) for an agent-created
   * credential — it never overwrites an entry that was mirrored IN, because a
   * real `pass` file usually carries notes/fields karmax didn't capture, and
   * blind-overwriting would destroy them. Updating a synced entry is a
   * deliberate, separate action, not a side effect of write-back.
   */
  async push(item: ExternalSecretItem): Promise<{ externalId: string }> {
    const name = `karmax/${item.label}`.replace(/[^A-Za-z0-9._@/-]+/g, '-').replace(/\/+/g, '/');
    const body = [item.secrets.password ?? '', ...(item.secrets.totp ? [item.secrets.totp] : [])].join('\n');
    try {
      await this.exec('pass', ['insert', '-m', '-f', name], { input: body + '\n' });
    } catch (e) {
      throw new Error(gpgHint(e));
    }
    return { externalId: name };
  }
}

/** Turn a raw GPG failure into an actionable message (§ the pass-unlock story:
 *  karmax never stores your GPG passphrase; it relies on gpg-agent being
 *  unlocked, which is the self-hosted reality). */
function gpgHint(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/no such file|not in the password store/i.test(msg)) return msg;
  if (/decrypt|gpg|passphrase|no secret key|inappropriate ioctl|pinentry/i.test(msg)) {
    return 'pass could not decrypt — your GPG key is locked. Unlock it once in a terminal (e.g. `pass show <any-entry>` and enter your passphrase), so gpg-agent caches it, then retry. karmax deliberately does not store your GPG master passphrase.';
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
  gpgPrivateKey: string;
  /** Optional passphrase for the secret key. */
  gpgPassphrase?: string;
}

interface GitPassOptions {
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
export class GitPassConnector implements CredentialConnector {
  readonly name = 'pass-git';

  constructor(
    private secret: () => string | undefined,
    private organizationId = 'org_personal',
    private gitEnvironment: (profile?: string) => Record<string, string> = () => ({}),
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

  async list(): Promise<ExternalItem[]> {
    return this.inRepository(async (_connection, _checkout, store, _env) =>
      this.entries(store).map((entry) => this.metadata(store, entry)));
  }

  async pull(externalIds: string[]): Promise<PullResult> {
    return this.inRepository(async (connection, _checkout, store, _env) => {
      const available = new Set(this.entries(store));
      return this.withGpg(connection, async (gpgHome) => {
        const items: ExternalSecretItem[] = [];
        const failures: PullResult['failures'] = [];
        for (const externalId of externalIds) {
          if (!available.has(externalId)) continue;
          try {
            const body = await this.decrypt(gpgHome, connection, this.entryFile(store, externalId));
            const lines = body.replace(/\r/g, '').split('\n');
            const password = lines[0] ?? '';
            const totp = lines.slice(1).find((line) => line.trim().startsWith('otpauth://'))?.trim();
            const secrets: Partial<Record<VaultFieldName, string>> = { password };
            if (totp) secrets.totp = totp;
            items.push({ ...this.metadata(store, externalId), fields: Object.keys(secrets) as VaultFieldName[], secrets });
          } catch (e) {
            failures.push({ externalId, error: gitPassGpgError(e) });
          }
        }
        return { items, failures };
      });
    });
  }

  async updateSecret(externalId: string, field: VaultFieldName, value: string): Promise<void> {
    await this.inRepository(async (connection, checkout, store, env) => {
      if (!this.entries(store).includes(externalId)) throw new Error(`pass entry "${externalId}" was not found`);
      await this.withGpg(connection, async (gpgHome) => {
        const file = this.entryFile(store, externalId);
        const body = await this.decrypt(gpgHome, connection, file);
        const lines = body.replace(/\r/g, '').replace(/\n$/, '').split('\n');
        if (field === 'password') {
          lines[0] = value;
        } else if (field === 'totp') {
          const index = lines.findIndex((line, i) => i > 0 && line.trim().startsWith('otpauth://'));
          if (index >= 0) lines[index] = value;
          else lines.push(value);
        } else {
          throw new Error(`Git-backed pass write-back does not support the "${field}" field`);
        }
        await this.encrypt(gpgHome, file, lines.join('\n') + '\n', this.recipients(store, path.dirname(file)));
      });
      await this.commitAndPush(checkout, fileRelativeTo(checkout, this.entryFile(store, externalId)),
        `Update pass entry ${externalId}`, env);
    });
  }

  async push(item: ExternalSecretItem): Promise<{ externalId: string }> {
    return this.inRepository(async (connection, checkout, store, env) => {
      if (item.type !== 'login' || item.secrets.password === undefined) {
        throw new Error('Git-backed pass write-back supports login items with a password');
      }
      let stem = safePassName(item.label);
      let externalId = `karmax/${stem}`;
      for (let suffix = 2; fs.existsSync(this.entryFile(store, externalId)); suffix += 1) {
        externalId = `karmax/${stem}-${suffix}`;
      }
      const file = this.entryFile(store, externalId);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const body = [item.secrets.password, ...(item.username ? [`username: ${item.username}`] : []),
        ...(item.secrets.totp ? [item.secrets.totp] : [])].join('\n') + '\n';
      await this.withGpg(connection, async (gpgHome) => {
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
    const repositoryUrl = String(value.repositoryUrl ?? '').trim();
    if (!repositoryUrl) throw new Error('repository URL is required');
    if (!this.options.allowLocalRepository && !isRemoteGitUrl(repositoryUrl)) {
      throw new Error('repository must use an HTTPS or SSH repository URL');
    }
    if (repositoryUrl.startsWith('-') || /[\r\n\0]/.test(repositoryUrl)) throw new Error('repository URL is invalid');
    if (/^https:\/\//i.test(repositoryUrl)) {
      const url = new URL(repositoryUrl);
      if (url.username || url.password) throw new Error('repository URL must not embed credentials; select a Git profile instead');
    }
    const gpgPrivateKey = String(value.gpgPrivateKey ?? '').trim();
    if (!gpgPrivateKey) throw new Error('an armored GPG private key is required');
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
      gpgPrivateKey,
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
          env: { ...this.gitEnv(connection), ...(repositoryCredential?.env ?? {}) },
        });
        await this.refresh(connection, checkout, env);
        const store = this.findStore(checkout, connection.storePath);
        return work(connection, checkout, store, env);
      } finally {
        fs.rmSync(credentialDir, { recursive: true, force: true });
      }
    });
  }

  private checkoutFor(repositoryUrl: string): string {
    const digest = createHash('sha256').update(`${this.organizationId}\0${repositoryUrl}`).digest('hex').slice(0, 32);
    return path.join(this.root, this.organizationId.replace(/[^a-zA-Z0-9._-]/g, '_'), digest, 'repo');
  }

  private gitEnv(connection: GitPassConnection): Record<string, string> {
    return { ...isolatedGitEnvironment(), ...this.gitEnvironment(connection.gitProfile) };
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
    if (regularFile(path.join(checkout, '.gpg-id'))) return checkout;
    const queue = [checkout];
    let visited = 0;
    while (queue.length) {
      const dir = queue.shift()!;
      if (++visited > 10_000) throw new Error('password-store repository contains too many directories to scan safely');
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.isSymbolicLink()) continue;
        const child = path.join(dir, entry.name);
        if (entry.isFile() && entry.name === '.gpg-id') return dir;
        if (entry.isDirectory()) queue.push(child);
      }
    }
    throw new Error('no password store was found (set the path containing .gpg-id)');
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
        else if (entry.isFile() && entry.name.endsWith('.gpg')) files.push(child);
        if (files.length > 100_000) throw new Error('password store contains too many entries');
      }
    }
    return files.map((file) => path.relative(store, file).slice(0, -4).split(path.sep).join('/')).sort();
  }

  private metadata(store: string, externalId: string): ExternalItem {
    const { domain, username } = passEntryMetadata(externalId);
    const slash = externalId.lastIndexOf('/');
    const stat = fs.statSync(this.entryFile(store, externalId));
    return {
      externalId,
      type: 'login',
      label: externalId,
      folder: slash >= 0 ? externalId.slice(0, slash) : '',
      domains: domain ? [domain] : [],
      ...(username ? { username } : {}),
      fields: ['password'],
      changedAt: stat.mtimeMs,
    };
  }

  private entryFile(store: string, externalId: string): string {
    const normalized = externalId.replace(/\\/g, '/');
    if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      throw new Error('invalid pass entry id');
    }
    const file = path.resolve(store, `${normalized}.gpg`);
    if (!inside(store, file)) throw new Error('invalid pass entry id');
    return file;
  }

  private recipients(store: string, start: string): string[] {
    let dir = start;
    for (;;) {
      const idFile = path.join(dir, '.gpg-id');
      if (regularFile(idFile)) {
        const recipients = fs.readFileSync(idFile, 'utf8').split(/\r?\n/)
          .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
        if (!recipients.length) throw new Error(`${path.relative(store, idFile) || '.gpg-id'} has no recipients`);
        return recipients;
      }
      if (dir === store) break;
      const parent = path.dirname(dir);
      if (!inside(store, parent) && parent !== store) break;
      dir = parent;
    }
    throw new Error(`no .gpg-id applies to ${path.relative(store, start) || '.'}`);
  }

  private async withGpg<T>(connection: GitPassConnection, work: (home: string) => Promise<T>): Promise<T> {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const home = fs.mkdtempSync(path.join(this.root, '.gpg-'));
    fs.chmodSync(home, 0o700);
    try {
      await realExec('gpg', ['--homedir', home, '--batch', '--yes', '--import'], { input: `${connection.gpgPrivateKey}\n` });
      return await work(home);
    } catch (e) {
      throw new Error(gitPassGpgError(e));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  private decrypt(home: string, connection: GitPassConnection, file: string): Promise<string> {
    return realExec('gpg', ['--homedir', home, '--batch', '--yes', '--pinentry-mode', 'loopback',
      '--passphrase-fd', '0', '--decrypt', file], { input: `${connection.gpgPassphrase ?? ''}\n` });
  }

  private async encrypt(home: string, file: string, plaintext: string, recipients: string[]): Promise<void> {
    const temp = `${file}.karmax-${process.pid}-${Date.now()}`;
    try {
      const args = ['--homedir', home, '--batch', '--yes', '--trust-model', 'always', '--output', temp];
      for (const recipient of recipients) args.push('--recipient', recipient);
      args.push('--encrypt');
      await realExec('gpg', args, { input: plaintext });
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  private async commitAndPush(checkout: string, relative: string, message: string,
    env: Record<string, string>): Promise<void> {
    await gitOrThrow(checkout, ['add', '--', relative], { env });
    await gitOrThrow(checkout, ['-c', 'user.name=karmax', '-c', 'user.email=karmax@localhost', 'commit', '-m', message], { env });
    const pushed = await git(checkout, ['push', 'origin', 'HEAD'], { env });
    if (pushed.code !== 0) {
      throw new Error(`password-store changed remotely or could not be pushed; retry to refresh it: ${pushed.stderr || pushed.stdout}`);
    }
  }
}

function isRemoteGitUrl(value: string): boolean {
  return /^https:\/\/[^\s]+$/i.test(value)
    || /^ssh:\/\/[^\s]+$/i.test(value)
    || /^(?:[^@\s]+@)?[^:\s/]+:[^\s]+$/.test(value);
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
    return 'Git-backed pass requires GnuPG (`gpg`) on the Karmax server';
  }
  if (/gpg|decrypt|secret key|passphrase|public key|decryption failed|bad key/i.test(message)) {
    return 'Git-backed pass could not use the supplied GPG key or passphrase';
  }
  return message;
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
  /** Last successful sync (epoch ms) + how many of its items the vault now
   *  mirrors. The count is the running total, not this batch's share, so a
   *  big import split into batches still reports what the user has. */
  lastSync?: { at: number; count: number };
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
  kvGet(k: string): string | undefined;
  kvSet(k: string, v: string): void;
  findRepositoryBySshUrl?(organizationId: string, sshUrl: string): Repository | undefined;
}

export interface ConnectorGithubApp {
  brokerCredentials(repository: Repository): Promise<GitCredential>;
}

/** Resolve only an exact repository attachment owned by this organization.
 * Never substitutes a user/profile credential based on availability. */
export async function attachedRepositoryCredential(store: ConnectorStore, githubApp: ConnectorGithubApp | undefined,
  organizationId: string, repositoryUrl: string): Promise<GitCredential | undefined> {
  const repository = store.findRepositoryBySshUrl?.(organizationId, repositoryUrl);
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

  config(name: string): ConnectorConfig {
    try {
      return JSON.parse(this.store.kvGet(kvConfig(this.organizationId, name)) ?? '{}');
    } catch {
      return {};
    }
  }
  setConfig(name: string, patch: Partial<ConnectorConfig>): ConnectorConfig {
    const next = { ...this.config(name), ...patch };
    this.store.kvSet(kvConfig(this.organizationId, name), JSON.stringify(next));
    return next;
  }

  /** Validate a connector secret before keeping it. A failed replacement restores
   *  the previous working secret, so clicking Connect can never manufacture a
   *  false-positive connection or break an existing one. */
  async connect(name: string, secret: string): Promise<ConnectorInfo> {
    const connector = this.get(name);
    if (!connector) throw new Error(`no connector "${name}"`);
    if (!this.broker) throw new Error('credential storage is unavailable');
    const value = secret.trim();
    const required = name === 'bitwarden' ? 'Enter a Bitwarden session key.'
      : name === '1password' ? 'Enter a 1Password service-account token.'
        : 'Enter the connector credential.';
    if (!value) throw new Error(required);

    const handle = connectorAuthHandle(this.organizationId, name);
    const previous = this.secretFor(name);
    this.broker.registerHandle(handle, value);
    try {
      const info = await connector.describe();
      if (!info.available) throw new Error(info.detail);
      return info;
    } catch (error) {
      if (previous === undefined) this.broker.deleteHandle(handle);
      else this.broker.registerHandle(handle, previous);
      throw error;
    }
  }
  secretFor(name: string): string | undefined {
    const handle = connectorAuthHandle(this.organizationId, name);
    return this.broker?.hasHandle(handle)
      ? this.broker.resolve(handle, { caps: ['use-credential:*'] })
      : undefined;
  }

  async describe(): Promise<(ConnectorInfo & { config: ConnectorConfig })[]> {
    return Promise.all(this.names().map(async (name) => ({ ...(await this.get(name)!.describe()), config: this.config(name) })));
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
  async sync(name: string, externalIds: string[], opts: { policy?: Partial<VaultItemPolicy>; writeBack?: boolean } = {}): Promise<SyncResult> {
    const connector = this.get(name);
    if (!connector) throw new Error(`no connector "${name}"`);
    if (opts.writeBack !== undefined) this.setConfig(name, { writeBack: opts.writeBack });
    const source = `connector:${name}`;
    const mirrored = new Map(this.items.list()
      .filter((i) => i.provenance.source === source && i.provenance.externalId)
      .map((i) => [i.provenance.externalId!, i]));

    // Only ask the store when something might be skippable (a first import has
    // nothing to compare against, and `list()` is itself a CLI round-trip).
    let wanted = externalIds;
    if (mirrored.size) {
      const changedAt = new Map((await connector.list()).map((i) => [i.externalId, i.changedAt]));
      wanted = externalIds.filter((id) => {
        // Whole milliseconds on BOTH sides. A source's change marker can be
        // finer-grained than the mirror clock it is compared against — a file
        // mtime carries sub-millisecond precision while `Date.now()` does not —
        // so an entry touched in the same millisecond the sync recorded reads
        // back as `clock + 0.31…`: strictly greater, hence "changed", hence
        // re-decrypted on every sync from then on. Comparing at the coarser of
        // the two resolutions is what makes the two numbers comparable at all.
        const at = floorMs(changedAt.get(id));
        const item = mirrored.get(id);
        // Items mirrored before `syncedAt` existed fall back to `updatedAt`,
        // so an upgrade does not force one more full-store re-read; they get a
        // real mirror clock the first time they are pulled again.
        const since = floorMs(item && (item.provenance.syncedAt ?? item.updatedAt));
        return !(at !== undefined && since !== undefined && at <= since);
      });
    }

    const { items: pulled, failures } = await connector.pull(wanted);
    // Nothing at all came back: surface why (a locked GPG key, an expired
    // session) rather than reporting a silent zero-item success.
    if (!pulled.length && failures.length) throw new Error(failures[0]!.error);
    const syncedAt = Date.now();
    const itemIds: string[] = [];
    for (const ext of pulled) {
      const existing = mirrored.get(ext.externalId);
      const saved = this.items.save({
        id: existing?.id,
        type: ext.type,
        label: ext.label,
        domains: ext.domains,
        username: ext.username,
        // Apply the chosen import policy to NEW items only; a re-sync must not
        // clobber a policy the user has since tuned on an existing item.
        ...(existing ? {} : { policy: opts.policy }),
        secrets: ext.secrets,
        provenance: { source, externalId: ext.externalId, syncedAt },
      });
      itemIds.push(saved.id);
    }
    const total = this.items.list().filter((i) => i.provenance.source === source).length;
    this.setConfig(name, { lastSync: { at: syncedAt, count: total } });
    return { count: itemIds.length, itemIds, skipped: externalIds.length - wanted.length, failures };
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
    if (!connector?.push) throw new Error(`connector "${name}" does not support write-back`);
    if (!this.config(name).writeBack) return undefined;
    const item = this.items.get(itemId);
    if (!item) throw new Error(`no vault item ${itemId}`);
    if (item.provenance.source.startsWith('import:')) {
      throw new Error('this item came from a one-way file import; write-back to the imported file is unavailable');
    }
    if (item.provenance.source.startsWith('connector:')) throw new Error('this item was mirrored in from a store; write-back only pushes agent-created items back out (it never overwrites a synced entry)');
    const secrets: Partial<Record<VaultFieldName, string>> = {};
    for (const field of item.fields) {
      const value = this.items.readSecret(item, field);
      if (value !== undefined) secrets[field] = value;
    }
    const result = await connector.push({
      externalId: item.provenance.externalIds?.[name] ?? '',
      type: item.type,
      label: item.label,
      username: item.username,
      domains: item.domains,
      fields: item.fields,
      secrets,
    });
    // Record which connector owns this external id. Agent-created items may be
    // written to several enabled stores, and rotations must target each exact
    // entry rather than reuse one ambiguous id.
    this.items.setExternalId(item.id, name, result.externalId);
    return result;
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
    for (const name of this.names()) {
      const connector = this.get(name);
      if (!connector?.push || !this.config(name).writeBack) continue;
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
  async propagate(itemId: string, fields: VaultFieldName[]): Promise<{ connector: string; fields: VaultFieldName[] } | undefined> {
    const item = this.items.get(itemId);
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
      const candidates = this.names().filter((name) =>
        Boolean(this.get(name)?.updateSecret) && Boolean(this.config(name).writeBack));
      if (candidates.length > 1) {
        throw new Error(`legacy write-back binding is ambiguous across enabled connectors: ${candidates.join(', ')}`);
      }
      if (candidates.length === 1) bindings = [[candidates[0]!, item.provenance.externalId]];
    }

    const pushedConnectors: string[] = [];
    const pushedFields = new Set<VaultFieldName>();
    for (const [name, externalId] of bindings) {
      const connector = this.get(name);
      if (!connector?.updateSecret || !this.config(name).writeBack) continue;
      let connectorUpdated = false;
      for (const field of fields) {
        if (!item.fields.includes(field)) continue;
        const value = this.items.readSecret(item, field);
        if (value === undefined) continue;
        await connector.updateSecret(externalId, field, value);
        pushedFields.add(field);
        connectorUpdated = true;
      }
      if (connectorUpdated) pushedConnectors.push(name);
    }
    return pushedConnectors.length
      ? { connector: pushedConnectors.join(', '), fields: [...pushedFields] }
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
    (requested) => {
      const profileName = requested || profiles.defaultProfile();
      if (!profileName) return {};
      const profile = profiles.get(profileName);
      if (!profile) throw new Error(`unknown Git profile "${profileName}"`);
      return profiles.env(profile, {});
    },
    undefined,
    { repositoryCredential: (repositoryUrl) =>
      attachedRepositoryCredential(store, opts.githubApp, organizationId, repositoryUrl) },
  ));
  return connectors;
}

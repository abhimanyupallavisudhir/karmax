import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CredentialBroker } from './broker.js';
import { VaultItems, VaultItemType, VaultFieldName, VaultItemPolicy } from './vault-items.js';

const pexec = promisify(execFile);

/**
 * External password-store connectors (PLAN-passwords.md §9). The karmax vault
 * is the runtime source of truth; a connector is a **selective mirror**, not a
 * live proxy: the user connects a store, picks items/folders to pull in, and
 * (opt-in) lets agent-created items push back. Runtime credential resolution
 * always hits the karmax vault, so a connector being down never blocks agents
 * and a cloud world needs no path to the user's desktop.
 *
 * Every real connector shells out to the store's own CLI (`bw`, `op`, `pass`),
 * so nothing here re-implements their crypto and the user's unlock secret stays
 * in the CLI's hands. Availability is probed like the git preflight — a missing
 * or locked CLI reports `connected: false` with a hint rather than throwing.
 */

export interface ConnectorInfo {
  name: string;
  label: string;
  /** Present + usable right now (CLI installed and unlocked)? */
  available: boolean;
  detail: string;
  /** Does this connector support writing agent-created items back out? */
  canPush: boolean;
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
}

/** An external entry WITH its secrets, ready to write into the vault. */
export interface ExternalSecretItem extends ExternalItem {
  secrets: Partial<Record<VaultFieldName, string>>;
}

export interface CredentialConnector {
  readonly name: string;
  describe(): Promise<ConnectorInfo>;
  /** Enumerate mirrorable items (metadata only). */
  list(): Promise<ExternalItem[]>;
  /** Fetch the selected items with their secrets. */
  pull(externalIds: string[]): Promise<ExternalSecretItem[]>;
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
    try {
      const status = JSON.parse(await this.exec('bw', ['status'], { env: this.env() }));
      const unlocked = status?.status === 'unlocked';
      return { name: this.name, label: 'Bitwarden', available: unlocked, canPush: true,
        detail: unlocked ? 'unlocked and ready to mirror' : `Bitwarden is ${status?.status ?? 'locked'} — unlock it in Connectors to sync` };
    } catch {
      return { name: this.name, label: 'Bitwarden', available: false, canPush: true, detail: 'the `bw` CLI is not installed or not logged in' };
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
  async pull(externalIds: string[]): Promise<ExternalSecretItem[]> {
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
    return out;
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
  if (it.type === 1 && it.login) {
    const domains = (it.login.uris ?? []).map((u: any) => hostOf(u?.uri)).filter(Boolean);
    return { externalId: it.id, type: 'login', label: it.name ?? 'login', username: it.login.username ?? undefined,
      domains, folder, fields: ['password', ...(it.login.totp ? (['totp'] as VaultFieldName[]) : [])] };
  }
  if (it.type === 2) return { externalId: it.id, type: 'note', label: it.name ?? 'note', folder, fields: ['note'] };
  return undefined; // cards/identities out of scope for v1
}

// ── 1Password (`op` CLI + service-account token; no desktop ceremony) ─────────

export class OnePasswordConnector implements CredentialConnector {
  readonly name = '1password';
  constructor(private token: () => string | undefined, private exec: Exec = realExec) {}
  private env(): Record<string, string> {
    const t = this.token();
    return t ? { OP_SERVICE_ACCOUNT_TOKEN: t } : {};
  }
  async describe(): Promise<ConnectorInfo> {
    try {
      await this.exec('op', ['whoami', '--format=json'], { env: this.env() });
      return { name: this.name, label: '1Password', available: true, canPush: true, detail: 'service account connected' };
    } catch {
      return { name: this.name, label: '1Password', available: false, canPush: true, detail: 'paste a 1Password service-account token to connect (needs the `op` CLI on this host)' };
    }
  }
  async list(): Promise<ExternalItem[]> {
    const items = JSON.parse(await this.exec('op', ['item', 'list', '--format=json'], { env: this.env() })) as any[];
    return items.map((it) => ({ externalId: it.id, type: categoryType(it.category), label: it.title ?? 'item',
      domains: (it.urls ?? []).map((u: any) => hostOf(u?.href)).filter(Boolean),
      folder: it.vault?.name ?? '', fields: itemFieldsFor(categoryType(it.category)) }));
  }
  async pull(externalIds: string[]): Promise<ExternalSecretItem[]> {
    const out: ExternalSecretItem[] = [];
    for (const id of externalIds) {
      const full = JSON.parse(await this.exec('op', ['item', 'get', id, '--format=json'], { env: this.env() }));
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
    return out;
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

function categoryType(category: string): VaultItemType {
  switch (category) {
    case 'API_CREDENTIAL': return 'api-key';
    case 'SSH_KEY': return 'ssh-key';
    case 'SECURE_NOTE': return 'note';
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
        fields: ['password'] as VaultFieldName[] };
    });
  }
  async pull(externalIds: string[]): Promise<ExternalSecretItem[]> {
    // Treat the store itself as the authority, not ids posted back by the UI.
    // Besides preventing stale/tampered selections from reaching `pass show`,
    // this keeps non-GPG files out of the import execution path as well as the
    // preview.
    const entries = new Set(await this.entries());
    const out: ExternalSecretItem[] = [];
    for (const id of externalIds) {
      if (!entries.has(id)) continue;
      let body: string;
      try {
        body = await this.exec('pass', ['show', id]);
      } catch (e) {
        throw new Error(gpgHint(e));
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
        fields: Object.keys(secrets) as VaultFieldName[], secrets });
    }
    return out;
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

function hostOf(value?: string): string {
  if (!value) return '';
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname;
  } catch {
    return '';
  }
}

/**
 * `pass` has no schema: folders are commonly followed by a hostname and then
 * a username (`software/www.overleaf.com/alice@example.com`). Treating the
 * whole store path as a URL makes the first folder look like the host, which
 * produces unusable and unsafe domain metadata. Find the first DNS-looking
 * path component instead and use the final component as the username when it
 * follows that host.
 */
function passEntryMetadata(entry: string): { domain?: string; username?: string } {
  const parts = entry.split('/').map((part) => part.trim()).filter(Boolean);
  const domainIndex = parts.findIndex((part) => {
    if (part.includes('@') || part.startsWith('.') || !part.includes('.')) return false;
    const host = hostOf(part);
    return host === part.toLowerCase()
      && host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label));
  });
  if (domainIndex < 0) return {};
  const domain = hostOf(parts[domainIndex]);
  const username = domainIndex < parts.length - 1 ? parts.at(-1) : undefined;
  return { domain, ...(username ? { username } : {}) };
}

// ── the registry + sync service (state in the store kv) ───────────────────────

// Connector config + unlock secret are ORGANIZATION-scoped: a tenant connects
// its own Bitwarden/1Password, and its session key must never be reachable from
// another org's world.
const kvConfig = (org: string, name: string) => `vault:connector:${org}:${name}`;
const connectorAuthHandle = (org: string, name: string) => `connector:${org}:${name}:auth`;

export interface ConnectorConfig {
  /** Opt-in write-back of agent-created items. */
  writeBack?: boolean;
  /** Last successful sync (epoch ms) + how many items it wrote. */
  lastSync?: { at: number; count: number };
}

export interface ConnectorStore {
  kvGet(k: string): string | undefined;
  kvSet(k: string, v: string): void;
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

  /** Store a connector's unlock secret (bw session key / op token) in the vault. */
  connect(name: string, secret: string): void {
    this.broker?.registerHandle(connectorAuthHandle(this.organizationId, name), secret);
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
   */
  async sync(name: string, externalIds: string[], opts: { policy?: Partial<VaultItemPolicy>; writeBack?: boolean } = {}): Promise<{ count: number; itemIds: string[] }> {
    const connector = this.get(name);
    if (!connector) throw new Error(`no connector "${name}"`);
    if (opts.writeBack !== undefined) this.setConfig(name, { writeBack: opts.writeBack });
    const pulled = await connector.pull(externalIds);
    const source = `connector:${name}`;
    const itemIds: string[] = [];
    for (const ext of pulled) {
      const existing = this.items.findByExternal(source, ext.externalId);
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
        provenance: { source, externalId: ext.externalId },
      });
      itemIds.push(saved.id);
    }
    this.setConfig(name, { lastSync: { at: Date.now(), count: itemIds.length } });
    return { count: itemIds.length, itemIds };
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
    if (item.provenance.source.startsWith('connector:')) throw new Error('this item was mirrored in from a store; write-back only pushes agent-created items back out (it never overwrites a synced entry)');
    const secrets: Partial<Record<VaultFieldName, string>> = {};
    for (const field of item.fields) {
      const value = this.items.readSecret(item, field);
      if (value !== undefined) secrets[field] = value;
    }
    const result = await connector.push({ externalId: item.provenance.externalId ?? '', type: item.type, label: item.label, username: item.username, domains: item.domains, fields: item.fields, secrets });
    // Record the external id so a later re-sync updates rather than duplicates.
    this.items.setExternalId(item.id, result.externalId);
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
   * Propagate rotated secret fields of a mirrored-in item back to its source
   * store, field-level (notes preserved). Called after a rotation when the
   * source connector has write-back enabled; a no-op (best-effort) otherwise.
   * Returns the fields it actually pushed. Unlike `writeBack`, this is FOR
   * connector-sourced items — the update-existing counterpart to push-create.
   */
  async propagate(itemId: string, fields: VaultFieldName[]): Promise<{ connector: string; fields: VaultFieldName[] } | undefined> {
    const item = this.items.get(itemId);
    if (!item || !item.provenance.source.startsWith('connector:') || !item.provenance.externalId) return undefined;
    const name = item.provenance.source.slice('connector:'.length);
    const connector = this.get(name);
    if (!connector?.updateSecret || !this.config(name).writeBack) return undefined;
    const pushed: VaultFieldName[] = [];
    for (const field of fields) {
      if (!item.fields.includes(field)) continue;
      const value = this.items.readSecret(item, field);
      if (value === undefined) continue;
      await connector.updateSecret(item.provenance.externalId, field, value);
      pushed.push(field);
    }
    return pushed.length ? { connector: name, fields: pushed } : undefined;
  }
}

/** The standard registry (Bitwarden + 1Password + pass), one construction shared
 *  by every gateway call site so the wiring cannot drift. */
export function defaultConnectors(store: ConnectorStore, items: VaultItems, broker: CredentialBroker | undefined, organizationId: string): Connectors {
  const connectors = new Connectors(store, items, broker, organizationId);
  connectors.register(new BitwardenConnector(() => connectors.secretFor('bitwarden')));
  connectors.register(new OnePasswordConnector(() => connectors.secretFor('1password')));
  connectors.register(new PassConnector());
  return connectors;
}

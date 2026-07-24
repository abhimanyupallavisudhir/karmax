import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CredentialBroker } from './broker.js';
import { VaultItems, VaultItemType, VaultFieldName } from './vault-items.js';

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
  /** Optional write-back of an agent-created item. */
  push?(item: ExternalSecretItem): Promise<{ externalId: string }>;
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
    const items = JSON.parse(await this.exec('bw', ['list', 'items'], { env: this.env() })) as any[];
    return items.map((it) => normalizeBitwarden(it)).filter((x): x is ExternalItem => !!x);
  }
  async pull(externalIds: string[]): Promise<ExternalSecretItem[]> {
    const wanted = new Set(externalIds);
    const items = JSON.parse(await this.exec('bw', ['list', 'items'], { env: this.env() })) as any[];
    const out: ExternalSecretItem[] = [];
    for (const it of items) {
      if (!wanted.has(it.id)) continue;
      const norm = normalizeBitwarden(it);
      if (!norm) continue;
      const secrets: Partial<Record<VaultFieldName, string>> = {};
      if (it.login?.password) secrets.password = it.login.password;
      if (it.login?.totp) secrets.totp = it.login.totp;
      if (norm.type === 'note' && it.notes) secrets.note = it.notes;
      out.push({ ...norm, secrets });
    }
    return out;
  }
}

function normalizeBitwarden(it: any): ExternalItem | undefined {
  if (it.type === 1 && it.login) {
    const domains = (it.login.uris ?? []).map((u: any) => hostOf(u?.uri)).filter(Boolean);
    return { externalId: it.id, type: 'login', label: it.name ?? 'login', username: it.login.username ?? undefined,
      domains, fields: ['password', ...(it.login.totp ? (['totp'] as VaultFieldName[]) : [])] };
  }
  if (it.type === 2) return { externalId: it.id, type: 'note', label: it.name ?? 'note', fields: ['note'] };
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
      return { name: this.name, label: '1Password', available: false, canPush: true, detail: 'set a 1Password service-account token in Connectors (needs the `op` CLI)' };
    }
  }
  async list(): Promise<ExternalItem[]> {
    const items = JSON.parse(await this.exec('op', ['item', 'list', '--format=json'], { env: this.env() })) as any[];
    return items.map((it) => ({ externalId: it.id, type: categoryType(it.category), label: it.title ?? 'item',
      domains: (it.urls ?? []).map((u: any) => hostOf(u?.href)).filter(Boolean),
      fields: itemFieldsFor(categoryType(it.category)) }));
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
  constructor(private exec: Exec = realExec) {}
  async describe(): Promise<ConnectorInfo> {
    try {
      await this.exec('pass', ['ls']);
      return { name: this.name, label: 'unix pass', available: true, canPush: true, detail: 'password store present' };
    } catch {
      return { name: this.name, label: 'unix pass', available: false, canPush: false, detail: 'the `pass` CLI / store is not set up (self-hosted only)' };
    }
  }
  async list(): Promise<ExternalItem[]> {
    // `pass git ls-files`-free enumeration: the tree is under ~/.password-store.
    const raw = await this.exec('pass', ['ls']);
    return parsePassTree(raw).map((entry) => ({ externalId: entry, type: 'login' as const, label: entry,
      domains: [hostOf(entry)].filter(Boolean) as string[], fields: ['password'] }));
  }
  async pull(externalIds: string[]): Promise<ExternalSecretItem[]> {
    const out: ExternalSecretItem[] = [];
    for (const id of externalIds) {
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
      out.push({ externalId: id, type: 'login', label: id, domains: [hostOf(id)].filter(Boolean) as string[],
        fields: Object.keys(secrets) as VaultFieldName[], secrets });
    }
    return out;
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

/** ANSI SGR colour codes `tree` (behind `pass ls`) wraps directory names in. */
const ANSI = /\x1b\[[0-9;]*m/g;

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

/** Turn `tree`-style `pass ls` output into flat store paths. `pass` does not
 *  mark folders, so a node is a leaf iff nothing nests under it (lookahead). */
export function parsePassTree(raw: string): string[] {
  const nodes: { depth: number; name: string }[] = [];
  // `pass ls` shells out to `tree`, which colours directory names with ANSI SGR
  // codes. Strip them first, or they end up inside the entry path and the later
  // `pass show <path>` fails with "not in the password store".
  for (const line of raw.replace(ANSI, '').split('\n')) {
    if (!line.trim() || /password store/i.test(line)) continue;
    const connector = line.search(/[├└]── /);
    if (connector < 0) continue;
    const depth = connector / 4 + 1; // 4 columns of indentation per level
    const name = line.slice(connector + 4).trim().replace(/\/$/, '');
    if (name) nodes.push({ depth, name });
  }
  const out: string[] = [];
  const stack: string[] = [];
  nodes.forEach((node, i) => {
    stack[node.depth - 1] = node.name;
    stack.length = node.depth;
    const next = nodes[i + 1];
    const isLeaf = !next || next.depth <= node.depth;
    if (isLeaf) out.push(stack.join('/'));
  });
  return out;
}

function hostOf(value?: string): string {
  if (!value) return '';
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname;
  } catch {
    return '';
  }
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
  async sync(name: string, externalIds: string[]): Promise<{ count: number; itemIds: string[] }> {
    const connector = this.get(name);
    if (!connector) throw new Error(`no connector "${name}"`);
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
}

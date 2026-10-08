import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SqlDatabase } from '../store/sql.js';
import type { CredentialBroker } from './broker.js';
import { organizationScope } from './vault-keys.js';
import { RefreshLeases, type RefreshOutcome } from './refresh-lease.js';
import { syncDirectory, writeDurably } from './vault.js';

/**
 * Model logins in the vault (data epoch 6; wiki planned/host-local-state,
 * step 2). A Claude, Codex or ACP subscription login is the credential its CLI
 * keeps in its config home: `.credentials.json`, `auth.json`, the captured
 * setup token, OpenCode's `auth.json`. Those files are now a vault entry of
 * the account's organization, `model-login:<org>:<provider>:<account>`, and
 * the files in `config-homes/` are a cache of it: the app materializes them
 * before it uses a login and writes a change back (a sign-in, a local turn's
 * own refresh) through the login's refresh lease. Session histories and the
 * rest of a home stay on disk (step 3 moves them).
 *
 * Every refresh the app starts runs on a private copy of the credential, under
 * the lease, and is written back with a compare-and-set (`refresh-lease.ts`):
 * one refresh per single-use refresh token, whichever process asks.
 *
 * The cache follows the vault by a three-way comparison with what it last
 * synchronized (`.karmax-login-sync`, a digest): files unchanged since then
 * take the vault's credential; a vault unchanged since then takes the files'
 * (a CLI on this host changed them); both changed is a conflict the vault wins.
 */
export const MODEL_LOGINS_MOVED_MARKER = 'migration:model-logins-to-vault:v1';
export const MODEL_LOGIN_PREFIX = 'model-login:';
const FORMAT = 'karmax-model-login:v1';
/** What the cache last synchronized, in the home (never uploaded to a sandbox). */
export const LOGIN_SYNC_FILE = '.karmax-login-sync';
/** A sign-in in progress, inside the home (never uploaded to a sandbox). */
export const PENDING_LOGIN = '.karmax-login-pending';
/** Where the import keeps the files it found (data epoch 6), beside `config-homes/`. */
export const RETIRED_LOGINS = 'retired-epoch6';

/** Each provider's credential files, relative to its home; a trailing `/` is
 * every file in that directory. The captured setup token and the login's
 * metadata travel with it. */
const CREDENTIAL_FILES: Record<string, string[]> = {
  claude: ['.credentials.json', '.claude/.credentials.json'],
  codex: ['auth.json'],
  opencode: ['data/opencode/auth.json'],
  grok: ['auth.json'],
  kimi: ['credentials/'],
};
const COMMON_FILES = ['karmax-oauth.json', 'karmax-login.json'];
export const MODEL_LOGIN_PROVIDERS = Object.keys(CREDENTIAL_FILES);

export interface ModelLogin { organizationId: string; provider: string; account: string; home: string; handle: string }

export function modelLoginHandle(organizationId: string, provider: string, account: string): string {
  return `${MODEL_LOGIN_PREFIX}${organizationId}:${provider}:${account}`;
}

/** The credential files of a home, as one canonical string (undefined: none). */
export function readLoginBundle(home: string, provider: string): string | undefined {
  const files: Record<string, string> = {};
  const read = (relative: string) => {
    const file = path.join(home, relative);
    // A provider-writable home: never follow a link out of it.
    try { if (fs.lstatSync(file).isFile()) files[relative] = fs.readFileSync(file, 'utf8'); } catch { /* absent */ }
  };
  for (const spec of [...(CREDENTIAL_FILES[provider] ?? []), ...COMMON_FILES]) {
    if (!spec.endsWith('/')) { read(spec); continue; }
    let names: string[] = [];
    try { if (fs.lstatSync(path.join(home, spec)).isDirectory()) names = fs.readdirSync(path.join(home, spec)); } catch { /* absent */ }
    for (const name of names.filter((name) => !name.includes('.karmax-tmp-'))) read(`${spec}${name}`);
  }
  const names = Object.keys(files).sort();
  return names.length ? JSON.stringify({ format: FORMAT, files: Object.fromEntries(names.map((name) => [name, files[name]])) }) : undefined;
}

function bundleFiles(bundle: string | undefined): Record<string, string> {
  if (bundle === undefined) return {};
  const parsed = JSON.parse(bundle) as { format?: unknown; files?: unknown };
  if (parsed?.format !== FORMAT || !parsed.files || typeof parsed.files !== 'object') throw new Error('not a model login');
  return parsed.files as Record<string, string>;
}

/** Make a home's credential files exactly `bundle`'s (none, for undefined). */
export function writeLoginBundle(home: string, provider: string, bundle: string | undefined): void {
  const wanted = bundleFiles(bundle);
  for (const relative of Object.keys(bundleFiles(readLoginBundle(home, provider))))
    if (!(relative in wanted)) fs.rmSync(path.join(home, relative), { force: true });
  for (const [relative, content] of Object.entries(wanted)) {
    if (relative.split('/').includes('..') || path.isAbsolute(relative)) throw new Error(`a model login names a file outside its home: ${relative}`);
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    let current: string | undefined;
    try { if (fs.lstatSync(file).isFile()) current = fs.readFileSync(file, 'utf8'); } catch { /* absent */ }
    // Replaced by rename, so a link at the path is replaced, not followed.
    if (current !== content) writeDurably(file, content, false);
  }
}

const digest = (bundle: string | undefined) => bundle === undefined ? '' : crypto.createHash('sha256').update(bundle).digest('hex');
function readBase(home: string): string {
  try { return String(JSON.parse(fs.readFileSync(path.join(home, LOGIN_SYNC_FILE), 'utf8')).digest ?? ''); } catch { return ''; }
}
function writeBase(home: string, bundle: string | undefined): void {
  if (readBase(home) === digest(bundle) && fs.existsSync(path.join(home, LOGIN_SYNC_FILE))) return;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  writeDurably(path.join(home, LOGIN_SYNC_FILE), JSON.stringify({ digest: digest(bundle) }), false);
}

export interface LoginsBoot {
  audit: (action: 'model-logins.moved-to-vault', detail: Record<string, unknown>) => Promise<unknown>;
  log?: (line: string) => void;
}

export class ModelLogins {
  readonly leases: RefreshLeases;

  constructor(readonly root: string, private broker: CredentialBroker, leases: RefreshLeases | SqlDatabase) {
    this.root = path.resolve(root);
    this.leases = leases instanceof RefreshLeases ? leases : new RefreshLeases(leases);
  }

  /** The managed login a config home holds; undefined for a home this
   * installation does not manage (an ambient `~/.claude`). */
  identify(home: string): ModelLogin | undefined {
    const relative = path.relative(this.root, path.resolve(home));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    const parts = relative.split(path.sep);
    const [organizationId, name] = parts.length === 1 ? ['org_personal', parts[0]!]
      : parts.length === 3 && parts[0] === 'organizations' ? [parts[1]!, parts[2]!] : [undefined, undefined];
    if (!organizationId || !name) return undefined;
    const dash = name.indexOf('-');
    const provider = name.slice(0, dash);
    const account = name.slice(dash + 1);
    if (dash < 1 || !account || !CREDENTIAL_FILES[provider]) return undefined;
    return { organizationId, provider, account, home: path.resolve(home), handle: modelLoginHandle(organizationId, provider, account) };
  }

  /** The home a vault entry belongs in. */
  homeOf(handle: string): ModelLogin | undefined {
    const [prefix, organizationId, provider, account, ...rest] = handle.split(':');
    if (`${prefix}:` !== MODEL_LOGIN_PREFIX || !organizationId || !provider || !account || rest.length) return undefined;
    const home = organizationId === 'org_personal' ? path.join(this.root, `${provider}-${account}`)
      : path.join(this.root, 'organizations', organizationId, `${provider}-${account}`);
    const login = this.identify(home);
    return login?.handle === handle ? login : undefined;
  }

  /** The login's credential as the vault holds it. */
  async stored(login: ModelLogin): Promise<string | undefined> {
    if (!await this.broker.hasHandle(login.handle)) return undefined;
    try { return await this.broker.resolve(login.handle, { caps: [`use-credential:${login.handle}`] }); }
    catch (error) { if (await this.broker.hasHandle(login.handle)) throw error; return undefined; }
  }

  private write(login: ModelLogin, observed: string | undefined, next: string): Promise<boolean> {
    return this.broker.replaceHandleIfUnchanged(login.handle, observed, next, organizationScope(login.organizationId), { history: false });
  }

  private materialize(login: ModelLogin, bundle: string | undefined): void {
    writeLoginBundle(login.home, login.provider, bundle);
    writeBase(login.home, bundle);
  }

  /**
   * Bring a managed home's cache and the vault into agreement, before the
   * app uses the login and after anything on this host may have changed it.
   * Cheap when they agree; otherwise under the login's lease.
   */
  async sync(home: string): Promise<void> {
    const login = this.identify(home);
    if (!login) return;
    const stored = await this.stored(login);
    if (readLoginBundle(login.home, login.provider) === stored && readBase(login.home) === digest(stored)) return;
    await this.leases.hold(login.handle, () => this.reconcile(login));
  }

  private async reconcile(login: ModelLogin): Promise<void> {
    const stored = await this.stored(login);
    const disk = readLoginBundle(login.home, login.provider);
    const base = readBase(login.home);
    if (disk === stored) return writeBase(login.home, stored);
    // The files are as last synchronized (or gone): the vault moved on.
    if (disk === undefined || digest(disk) === base) return this.materialize(login, stored);
    // The vault is as last synchronized: a CLI here changed the files.
    if (digest(stored) === base) {
      if (await this.write(login, stored, disk)) return writeBase(login.home, disk);
      return this.materialize(login, await this.stored(login));
    }
    console.warn(`[model-logins] ${login.handle}: the cached credential and the vault both changed; keeping the vault's`);
    this.materialize(login, stored);
  }

  /**
   * Run a provider CLI that may refresh the login (`claude -p /usage`, Codex
   * `app-server`), on a private copy of its credential, under its lease; write
   * back what the CLI left with a compare-and-set, and update the cache.
   * `skipIfChanged`: a refresh someone else completed meanwhile is the result
   * (a waiter re-reads rather than refreshing again); otherwise `run` always
   * runs (a usage read), one at a time.
   */
  async refresh<T>(home: string, run: (privateHome: string) => Promise<T>, options: { skipIfChanged: boolean }):
    Promise<{ outcome: RefreshOutcome; result?: T }> {
    const login = this.identify(home);
    if (!login) throw new Error(`${home} is not a managed login`);
    await this.sync(home);
    const begin = await this.stored(login);
    const outcome = await this.leases.refresh<T>({
      credential: login.handle,
      ...(options.skipIfChanged ? { since: { value: begin } } : {}),
      read: () => this.stored(login),
      refresh: async (current) => {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-login-'));
        try {
          writeLoginBundle(scratch, login.provider, current);
          const result = await run(scratch);
          return { next: readLoginBundle(scratch, login.provider), result };
        } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
      },
      write: async (current, next, held) => await held() && this.write(login, current, next),
      // The cache follows, unless a CLI on this host changed it meanwhile.
      settled: async () => this.reconcile(login),
    });
    // A waiter: the winner's credential, into this host's cache.
    if (outcome.outcome === 'raced') await this.sync(home);
    return { outcome: outcome.outcome, ...(outcome.result === undefined ? {} : { result: outcome.result }) };
  }

  /** Where a sign-in CLI writes, so a refresh settling meanwhile cannot
   * overwrite the new credential in the cache; `adopt` takes it from there. */
  pendingHome(home: string): string {
    return this.identify(home) ? path.join(home, PENDING_LOGIN) : home;
  }

  /**
   * A sign-in finished in `pendingHome`: its credential files replace the
   * login's (a new sign-in wins over whatever the vault held), under the
   * lease, and the pending directory goes. Nothing to adopt: nothing changes.
   */
  async adopt(home: string): Promise<boolean> {
    const login = this.identify(home);
    if (!login) return false;
    const pending = path.join(login.home, PENDING_LOGIN);
    const files = bundleFiles(readLoginBundle(pending, login.provider));
    if (!Object.keys(files).length) { fs.rmSync(pending, { recursive: true, force: true }); return false; }
    await this.leases.hold(login.handle, async () => {
      await this.reconcile(login);
      for (const [relative, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(login.home, relative)), { recursive: true, mode: 0o700 });
        writeDurably(path.join(login.home, relative), content, false);
      }
      const bundle = readLoginBundle(login.home, login.provider)!;
      await this.broker.registerHandle(login.handle, bundle, organizationScope(login.organizationId), { history: false });
      writeBase(login.home, bundle);
    });
    fs.rmSync(pending, { recursive: true, force: true });
    return true;
  }

  /** Disconnect: the vault entry goes (the home keeps its histories), and the
   * import's retired copy with it. */
  async forget(home: string): Promise<void> {
    const login = this.identify(home);
    if (!login) return;
    // The cached files go under the same lease: left behind, another
    // process's sync would take them for a new sign-in and restore the login.
    await this.leases.hold(login.handle, async () => {
      await this.broker.deleteHandle(login.handle);
      if (fs.existsSync(login.home)) this.materialize(login, undefined);
    });
    fs.rmSync(this.retiredPath(login.home), { recursive: true, force: true });
  }

  /** A renamed login keeps its credential (and its retired copy). */
  async rename(from: string, to: string): Promise<void> {
    const source = this.identify(from);
    const target = this.identify(to);
    if (!source || !target || source.handle === target.handle) return;
    if (await this.broker.hasHandle(source.handle))
      await this.broker.updateHandle(source.handle, target.handle, organizationScope(target.organizationId));
    const retired = this.retiredPath(source.home);
    if (fs.existsSync(retired) && !fs.existsSync(this.retiredPath(target.home))) {
      fs.mkdirSync(path.dirname(this.retiredPath(target.home)), { recursive: true, mode: 0o700 });
      fs.renameSync(retired, this.retiredPath(target.home));
    }
  }

  /** An organization's logins, with the import's retired copies (its vault
   * scope is shredded separately, which is what makes the entries unreadable). */
  async forgetOrganization(organizationId: string): Promise<void> {
    for (const handle of await this.broker.listHandles())
      if (handle.startsWith(`${MODEL_LOGIN_PREFIX}${organizationId}:`)) await this.broker.deleteHandle(handle);
    fs.rmSync(path.join(this.retiredRoot(), 'organizations', organizationId), { recursive: true, force: true });
  }

  /** Every managed home on this host that holds (or held) a login. */
  homes(): ModelLogin[] {
    const list = (dir: string) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return []; } };
    const homes = list(this.root).map((entry) => path.join(this.root, entry.name));
    for (const organization of list(path.join(this.root, 'organizations')))
      for (const entry of list(path.join(this.root, 'organizations', organization.name)))
        homes.push(path.join(this.root, 'organizations', organization.name, entry.name));
    return homes.flatMap((home) => this.identify(home) ?? []);
  }

  private retiredRoot(): string { return path.join(path.dirname(this.root), RETIRED_LOGINS, path.basename(this.root)); }
  private retiredPath(home: string): string { return path.join(this.retiredRoot(), path.relative(this.root, home)); }

  /** Keep the files the import found, unchanged, beside the cache: the way
   * back to the previous release (its pre-update backup has them too). */
  private retire(login: ModelLogin): void {
    const files = bundleFiles(readLoginBundle(login.home, login.provider));
    const retired = this.retiredPath(login.home);
    for (const [relative, content] of Object.entries(files)) {
      const target = path.join(retired, relative);
      if (fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeDurably(target, content, false);
    }
    if (fs.existsSync(retired)) syncDirectory(retired);
  }

  /** Has the import of data epoch 6 completed in this database? */
  static async moved(db: SqlDatabase): Promise<boolean> {
    return !!await db.prepare('SELECT v FROM kv WHERE k = ?').get(MODEL_LOGINS_MOVED_MARKER);
  }

  /**
   * Data epoch 6, at the primary's boot, resumably:
   * 1. every home's credential files are written to its vault entry (the files
   *    are authoritative until 3, so a repeat overwrites);
   * 2. every entry is read back and compared with the files;
   * 3. the marker row commits (audited first): from here the vault is the login;
   * 4. each home's files are kept in `retired-epoch6/` and become the cache;
   * 5. logins the vault holds and this host has no files for are materialized.
   * A crash before 3 repeats 1–2; after it, the boot finishes 4–5. `step` lets tests interrupt it.
   */
  async moveIntoVault(db: SqlDatabase, boot: LoginsBoot, step: (name: 'copied' | 'verified' | 'marked') => void = () => {}):
    Promise<{ logins: number } | undefined> {
    let report: { logins: number } | undefined;
    if (!await ModelLogins.moved(db)) {
      const found = this.homes().flatMap((login) => {
        const bundle = readLoginBundle(login.home, login.provider);
        return bundle === undefined ? [] : [{ login, bundle }];
      });
      for (const { login, bundle } of found)
        await this.broker.registerHandle(login.handle, bundle, organizationScope(login.organizationId), { history: false });
      step('copied');
      for (const { login, bundle } of found)
        if (await this.stored(login) !== bundle)
          throw new Error(`the model login ${login.handle} does not read back the same from the vault; its files are unchanged and `
            + 'still the login. Nothing was lost; report this before restarting');
      step('verified');
      const byProvider: Record<string, number> = {};
      for (const { login } of found) byProvider[login.provider] = (byProvider[login.provider] ?? 0) + 1;
      report = { logins: found.length };
      await boot.audit('model-logins.moved-to-vault', { logins: found.length, byProvider });
      await db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO NOTHING')
        .run(MODEL_LOGINS_MOVED_MARKER, JSON.stringify({ at: new Date().toISOString(), logins: found.length }));
      step('marked');
    }
    // A home never synchronized holds the files the import found: keep them, then they are the cache.
    for (const login of this.homes())
      if (!fs.existsSync(path.join(login.home, LOGIN_SYNC_FILE))) { this.retire(login); await this.sync(login.home); }
    for (const handle of await this.broker.listHandles()) {
      const login = handle.startsWith(MODEL_LOGIN_PREFIX) ? this.homeOf(handle) : undefined;
      if (login && !fs.existsSync(path.join(login.home, LOGIN_SYNC_FILE))) await this.sync(login.home);
    }
    if (report?.logins) boot.log?.(`Model logins: moved ${report.logins} into the vault (data epoch 6)`);
    return report;
  }
}

/** The installation's model logins, for code that knows only a config home
 * (the provider refreshes in `agent/usage.ts`). */
let installed: ModelLogins | undefined;
export function useModelLogins(logins: ModelLogins | undefined): void { installed = logins; }
export function modelLoginsFor(home: string | undefined, logins = installed): ModelLogins | undefined {
  return home && logins?.identify(home) ? logins : undefined;
}

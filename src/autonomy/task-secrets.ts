import { SecretScrubber } from '../agent/activity.js';
import type { Store } from '../store/db.js';
import type { CredentialBroker } from './broker.js';
import type { PaymentRegistry } from './payments.js';

/**
 * Which secrets a task has received (SS-3). A reveal happens in whichever
 * process serves `/api/vault/resolve`, while the turn that prints it runs in a
 * worker, and a terminal or transcript download may be served by yet another
 * gateway. So each delivery records a *reference* — never the value — and every
 * process that archives or serves something about the task resolves those
 * references through its own broker into a scrubber.
 *
 * References live in `kv` as `secretref:<taskId>:<ref>`, one row each, so
 * recording is an idempotent insert and reading is a primary-key range:
 *  - `handle:<broker handle>` — a vault item field, project secret, MCP
 *    connection, per-world service value or model key the task received;
 *  - `card:<cardId>` — a payment card filled for the task (resolved through its
 *    payment rail, since an issuer's card is not in the vault);
 *  - `task:<intentId>` — everything another task received, for a fork that
 *    carries that task's conversation.
 *
 * The `<taskId>` in the key is the task's intent (`intentOf`).
 */
const prefix = (taskId: string) => `secretref:${taskId}:`;
export const handleRef = (handle: string) => `handle:${handle}`;
export const cardRef = (cardId: string) => `card:${cardId}`;
export const taskRef = (taskId: string) => `task:${taskId}`;

/** Stores without `kvClaim` (test doubles) record with an upsert; without
 * `getTask`, a task is its own intent. */
type RefStore = {
  kvClaim?(k: string, v: string): boolean | Promise<boolean>;
  kvSet(k: string, v: string): void | Promise<void>;
  getTask?(id: string): Promise<{ intentId?: string } | undefined> | { intentId?: string } | undefined;
};

/** References are kept per intent, not per attempt: a task's attempts share
 * one conversation (the Confirm agent's session is the intent's), so what one
 * received is scrubbed from all of them, and a turn finds them under the
 * intent it already knows, with no extra read. */
async function intentOf(store: Pick<RefStore, 'getTask'>, taskId: string): Promise<string> {
  return (store.getTask ? (await store.getTask(taskId))?.intentId : undefined) ?? taskId;
}

/** Remember that `taskId` received these secrets. */
export async function recordSecretRefs(store: RefStore, taskId: string | undefined,
  refs: Array<string | undefined>): Promise<void> {
  if (!taskId || taskId === '*') return;
  const owner = (await intentOf(store, taskId));
  for (const raw of new Set(refs)) {
    if (!raw) continue;
    // A fork carries its source's conversation: name the source's intent.
    const ref = raw.startsWith('task:') ? taskRef((await intentOf(store, raw.slice(5)))) : raw;
    if (ref === taskRef(owner)) continue;
    if (store.kvClaim) (await store.kvClaim(`${prefix(owner)}${ref}`, '1'));
    else (await store.kvSet(`${prefix(owner)}${ref}`, '1'));
  }
}

/**
 * The values inside one resolved secret worth scrubbing on their own, besides
 * the whole secret. A secret often carries public metadata beside its secret
 * material (a Google service-account key its project id, e-mail and
 * googleapis.com URLs; an OAuth connection its endpoints and expiry), and
 * scrubbing that would redact it from everything the task shows. So a part is
 * scrubbed only when it is secret by its name or by its shape:
 *  - by name: its key ends in a secret noun (`private_key`, `client_secret`,
 *    `access_token`, `API_KEY`, `password`, `cookies`, `cvc`…) or is a key's id
 *    (`private_key_id`), or it sits under such a key and its own key does not
 *    name metadata (`token_type`, `expires_in`, a cookie's `domain`). A key
 *    ending in a metadata noun (`token_uri`, `client_id`, `expires_at`) or
 *    naming a public key (`public_key`) is not secret;
 *  - by shape (`generatedParts`): a generated-looking token, a URL's
 *    credentials, a card number.
 * A URL without credentials, an e-mail address or a date is never secret,
 * whatever its key.
 * The parts are a JSON secret's leaves, the assignments of a `.env`, INI or
 * YAML text (named by their variable), and the halves of an `ID:SECRET` pair
 * (the second is secret by position). Other token-like lines of multi-line
 * text (a PEM key's body) and an `Authorization` value's credential are
 * scrubbed as they are; prose lines (a login's notes) only as the whole note.
 */
export function secretValues(plaintext: string, depth = 0): string[] {
  const values = [plaintext, plaintext.trim()];
  if (depth > 8) return values;
  const leaf = (value: string, secret: boolean | undefined) => {
    if (secret && !publicShape(value)) values.push(...secretValues(value, depth + 1));
    values.push(...generatedParts(value));
  };
  let json: unknown;
  try { json = JSON.parse(plaintext); } catch { /* not JSON */ }
  if (json !== null && typeof json === 'object') {
    const visit = (value: unknown, secret: boolean | undefined, level: number): void => {
      if (level > 8) return;
      if (typeof value === 'string' || typeof value === 'number') leaf(String(value), secret);
      else if (Array.isArray(value)) for (const item of value) visit(item, secret, level + 1);
      else if (value && typeof value === 'object')
        for (const [key, item] of Object.entries(value)) visit(item, keySecrecy(key) ?? secret, level + 1);
    };
    visit(json, undefined, 0);
    return values;
  }
  const line = plaintext.trim();
  const scheme = line.match(/^(?:Bearer|Basic|Token|Bot)\s+(\S+)$/i);
  if (scheme) values.push(scheme[1]!);
  const pair = line.match(/^([^\s:]+):(?!\/\/)([^\s:]+)$/);
  if (pair) values.push(...generatedParts(pair[1]!), pair[2]!);
  if (plaintext.includes('\n')) {
    for (const text of plaintext.split(/\r?\n/)) {
      const assignment = text.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|:\s)\s*(.*?)\s*$/);
      if (assignment) leaf(assignment[2]!.replace(/^(["'])(.*)\1$/, '$2'), keySecrecy(assignment[1]!) === true);
      else if (!/\s/.test(text.trim()) && !text.startsWith('-----') && !/^\[.*\]$/.test(text.trim())) values.push(text.trim());
    }
  }
  return values;
}

/** Nouns that name secret material when they end a key (plurals included). */
const SECRET_NOUNS = new Set(['secret', 'token', 'password', 'passwd', 'pass', 'pwd', 'pw', 'passphrase', 'key', 'credential',
  'auth', 'authorization', 'cookie', 'session', 'storage', 'pin', 'cvc', 'cvv', 'cvv2', 'csc', 'otp', 'totp', 'verifier',
  'dsn', 'pat', 'signature', 'salt', 'seed', 'mnemonic']);
/** Nouns that name public metadata when they end a key. */
const METADATA_NOUNS = new Set(['url', 'uri', 'endpoint', 'type', 'method', 'expires', 'expiry', 'expiration', 'at', 'in',
  'id', 'name', 'username', 'user', 'email', 'account', 'project', 'label', 'path', 'domain', 'host', 'origin', 'scope',
  'issuer', 'region', 'brand', 'hint', 'kind', 'format', 'version', 'supported', 'status', 'date', 'time']);

/** Whether a key names a secret (`true`), names metadata (`false`), or neither
 * (`undefined`: its value is as secret as its parent's). */
function keySecrecy(key: string): boolean | undefined {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const noun = (word: string | undefined) => !!word && (SECRET_NOUNS.has(word) || SECRET_NOUNS.has(word.replace(/s$/, '')));
  const last = words.at(-1);
  if (!last) return undefined;
  if (words.includes('public') || words.includes('publishable')) return false;
  if (noun(last) || (last === 'id' && words.at(-2) === 'key')) return true;
  return METADATA_NOUNS.has(last) || METADATA_NOUNS.has(last.replace(/s$/, '')) ? false : undefined;
}

/** A URL without credentials, an e-mail address or a date. */
function publicShape(value: string): boolean {
  const v = value.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(v)) return true;
  if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(v)) return false;
  try { const url = new URL(v); return !url.username && !url.password; } catch { return false; }
}

/** The parts of a value that are secret by shape alone: a generated-looking
 * token (an unbroken run of at least 24 characters mixing lower case, upper
 * case and digits, or of 32 hex digits with letters and digits, either way at
 * 3 bits of entropy per character or more, alone or between `-_.:~`); a
 * URL's password, and its user when that looks generated (a Sentry DSN);
 * a card number (13–19 digits passing Luhn). URLs, e-mail addresses, dates,
 * domains, names, numbers and short words never are. */
function generatedParts(value: string): string[] {
  const v = value.trim();
  if (/^\d(?:[ -]?\d){12,18}$/.test(v) && luhn(v.replace(/\D/g, ''))) return [v];
  if (!v || /\s/.test(v)) return [];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
    try {
      const url = new URL(v);
      const user = decodeURIComponent(url.username);
      const password = decodeURIComponent(url.password);
      if (!password && !generated(user)) return [];
      return [v, ...(password ? [password] : []), ...(generated(user) ? [user] : [])];
    } catch { return []; }
  }
  return generated(v) || v.split(/[-_.:~]/).some(generated) ? [v] : [];
}

function generated(token: string): boolean {
  const hex = /^[0-9a-f]+$/i.test(token) && /\d/.test(token) && /[a-f]/i.test(token);
  if (hex ? token.length < 32 : token.length < 24) return false;
  if (!hex && !(/[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token))) return false;
  const counts = new Map<string, number>();
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / token.length) * Math.log2(count / token.length);
  return bits >= 3;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

export interface SecretSources {
  store: Pick<Store, 'kvEntries'>;
  broker?: Pick<CredentialBroker, 'resolve'>;
  /** A filled card's details, from its payment rail. */
  cardDetails?: (cardId: string) => Promise<{ number?: string } | undefined>;
}

/** Resolve a card the way a fill did: through the card's own rail. */
export function paymentCardDetails(store: Pick<Store, 'getCard'>, registry?: PaymentRegistry): SecretSources['cardDetails'] {
  if (!registry) return undefined;
  return async (cardId) => {
    const card = (await store.getCard(cardId));
    const rail = card ? registry.forCard(card) : undefined;
    return rail?.retrieveCardDetails ? rail.retrieveCardDetails(cardId) : undefined;
  };
}

/** Where a task's references are kept: its intent, shared by every attempt.
 * Pass the task when the caller has already read it. */
export async function secretScope(store: Pick<Store, 'getTask'>, taskId: string,
  task?: { intentId?: string } | null): Promise<string[]> {
  return [task !== undefined ? (task?.intentId ?? taskId) : (await intentOf(store, taskId))];
}

const RETRY_MS = 30_000;
const REREAD_MS = 20_000;
const MAX_TASKS = 64;

/**
 * The scrubber for one task, kept current with what the task has received.
 * `refresh()` reads the task's references and resolves only the new ones, so
 * callers may refresh before every archival write: a value revealed a moment
 * ago is recorded before the reveal answers, and is therefore scrubbed from the
 * very next thing written. Refreshes are serialized; a refresh requested while
 * one runs starts a new read when it ends.
 */
export class TaskSecrets {
  /** When each reference was last resolved. */
  private resolved = new Map<string, number>();
  private retryAt = new Map<string, number>();
  private current?: Promise<void>;
  private queued?: Promise<void>;

  constructor(private sources: SecretSources, private roots: string[], readonly scrubber = new SecretScrubber()) {}

  async refresh(): Promise<SecretScrubber> {
    if (!this.current) {
      this.current = this.load().finally(() => { this.current = undefined; });
    } else {
      // The running read may have begun before the caller's secret was recorded.
      this.queued ??= this.current.catch(() => {}).then(() => {
        this.queued = undefined;
        return this.refresh().then(() => {});
      });
      await this.queued;
      return this.scrubber;
    }
    await this.current;
    return this.scrubber;
  }

  private async load(): Promise<void> {
    const tasks = [...new Set(this.roots)];
    for (let index = 0; index < tasks.length; index++) {
      const from = prefix(tasks[index]!);
      for (const { key } of (await this.sources.store.kvEntries(from))) {
        const ref = key.slice(from.length);
        if (ref.startsWith('task:')) {
          const taskId = ref.slice(5);
          if (!tasks.includes(taskId) && tasks.length < MAX_TASKS) tasks.push(taskId);
          continue;
        }
        const at = this.resolved.get(ref);
        // A card never changes; a handle can (an MCP access token is refreshed
        // into the world, an item is rotated), so it is read again now and then.
        // Earlier values stay scrubbed.
        if (at !== undefined && (!ref.startsWith('handle:') || Date.now() - at < REREAD_MS)) continue;
        if ((this.retryAt.get(ref) ?? 0) > Date.now()) continue;
        try {
          for (const value of await this.resolve(ref)) this.scrubber.add(...secretValues(value));
          this.resolved.set(ref, Date.now());
          this.retryAt.delete(ref);
        } catch {
          // A deleted item stays unresolvable; a transient failure is retried.
          this.retryAt.set(ref, Date.now() + RETRY_MS);
        }
      }
    }
  }

  private async resolve(ref: string): Promise<string[]> {
    if (ref.startsWith('handle:')) {
      const handle = ref.slice(7);
      if (!this.sources.broker) throw new Error('no credential broker');
      return [await this.sources.broker.resolve(handle, { caps: [`use-credential:${handle}`] })];
    }
    if (ref.startsWith('card:')) {
      if (!this.sources.cardDetails) throw new Error('no payment rail');
      const details = await this.sources.cardDetails(ref.slice(5));
      return details?.number ? [details.number] : [];
    }
    return [];
  }
}

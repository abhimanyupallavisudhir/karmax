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
 *  - `task:<taskId>` — everything another task received, for a fork that
 *    carries that task's conversation.
 */
const prefix = (taskId: string) => `secretref:${taskId}:`;
export const handleRef = (handle: string) => `handle:${handle}`;
export const cardRef = (cardId: string) => `card:${cardId}`;
export const taskRef = (taskId: string) => `task:${taskId}`;

/** Stores without `kvClaim` (test doubles) record with an upsert. */
type RefStore = { kvClaim?(k: string, v: string): boolean | Promise<boolean>; kvSet(k: string, v: string): void | Promise<void> };

/** Remember that `taskId` received these secrets. */
export async function recordSecretRefs(store: RefStore, taskId: string | undefined,
  refs: Array<string | undefined>): Promise<void> {
  if (!taskId || taskId === '*') return;
  for (const ref of new Set(refs)) {
    if (!ref) continue;
    if (store.kvClaim) (await store.kvClaim(`${prefix(taskId)}${ref}`, '1'));
    else (await store.kvSet(`${prefix(taskId)}${ref}`, '1'));
  }
}

/** The values inside one resolved secret worth scrubbing on their own: the
 * strings of a JSON secret (an MCP connection's tokens, a card), each value of
 * a `.env` bag, and each token-like line of a multi-line key. Prose lines (a
 * login's notes) are scrubbed only as the whole note. */
export function secretValues(plaintext: string): string[] {
  const values = [plaintext, plaintext.trim()];
  const leaves = (value: unknown, depth = 0): void => {
    if (depth > 6) return;
    if (typeof value === 'string' || typeof value === 'number') values.push(String(value));
    else if (Array.isArray(value)) for (const item of value) leaves(item, depth + 1);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) leaves(item, depth + 1);
  };
  try { leaves(JSON.parse(plaintext)); } catch { /* not JSON */ }
  if (plaintext.includes('\n')) {
    for (const line of plaintext.split(/\r?\n/)) {
      const assignment = line.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/);
      if (assignment) values.push(assignment[1]!.replace(/^(["'])(.*)\1$/, '$2'));
      else if (!/\s/.test(line.trim()) && !line.startsWith('-----')) values.push(line.trim());
    }
  }
  return values;
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

/** A task and its sibling attempts: they share an intent's conversation (the
 * Confirm agent's session is the intent's), so what one received is scrubbed
 * from all of them. */
export async function secretScope(store: Pick<Store, 'getTask' | 'attemptsOf'>, taskId: string): Promise<string[]> {
  const task = (await store.getTask(taskId));
  if (!task?.intentId) return [taskId];
  return [...new Set([taskId, ...(await store.attemptsOf(task.intentId)).map((attempt) => attempt.id)])];
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
      return [this.sources.broker.resolve(handle, { caps: [`use-credential:${handle}`] })];
    }
    if (ref.startsWith('card:')) {
      if (!this.sources.cardDetails) throw new Error('no payment rail');
      const details = await this.sources.cardDetails(ref.slice(5));
      return details?.number ? [details.number] : [];
    }
    return [];
  }
}

import crypto from 'node:crypto';
import { Message } from '../domain/types.js';
import { anthropicUserContent } from './images.js';

/** Bound the SDK handshake separately from model/tool execution. Heartbeating
 * an unresponsive startup otherwise hides it until the whole turn times out.
 * Do not await iterator.return() on timeout: a stuck next() can block it too.
 * The caller aborts the provider process; its late next() outcome stays handled.
 */
export async function* withClaudeStartupDeadline<T>(stream: AsyncIterable<T>, abort: () => void): AsyncGenerator<T> {
  const iterator = stream[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first: IteratorResult<T>;
  try {
    first = await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error('Claude agent did not respond during startup within 5 minutes; retrying the session.'),
            { code: 'ETIMEDOUT' }));
          abort();
        }, 5 * 60_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
  let next = first;
  try {
    while (!next.done) {
      yield next.value;
      next = await iterator.next();
    }
  } finally { if (!next.done) await iterator.return?.(); }
}

/**
 * Streaming-input plumbing for the Claude Agent SDK's in-flight follow-up
 * injection (SPEC §5.6). The SDK's `query({ prompt })` accepts an
 * `AsyncIterable<SDKUserMessage>`; while that iterable stays open the session
 * stays alive, and each message we yield is delivered to the LIVE agent at its
 * next turn boundary — the "inject after the next tool call" behaviour the CLI
 * has when a human types while the agent works. We keep the iterable open,
 * yield the initial delta, then yield each polled follow-up, and close it to end
 * the turn once the agent is idle with nothing pending.
 */

/** One SDK streaming-input user message (the shape the SDK's `prompt` iterable yields). */
export interface SdkUserMessage {
  type: 'user';
  parent_tool_use_id: null;
  message: { role: 'user'; content: string | any[] };
  /** Client id the harness echoes on the assistant frame answering this message
   *  (`user_message_uuid(s)`), so the adapter can tell its own input was consumed. */
  uuid: string;
}

/** Wrap a karmax {@link Message} as an SDK streaming-input user message, resolving
 *  any image attachments to content blocks (text-only ⇒ a plain string, unchanged). */
export function toSdkUserMessage(content: string | any[]): SdkUserMessage {
  return { type: 'user', parent_tool_use_id: null, message: { role: 'user', content }, uuid: crypto.randomUUID() };
}

/** Content (string or blocks) for a follow-up injected mid-turn. */
export function followUpContent(m: Message): string | any[] {
  return anthropicUserContent(m);
}

export interface FollowUpInjector {
  /** The live input stream to hand the SDK as its `prompt`. */
  stream: AsyncGenerator<SdkUserMessage>;
  /** Queue a message for the live session; ignored once closed. */
  push(msg: SdkUserMessage): void;
  /** End the input stream — the SDK drains any queued input, finishes, and the
   *  query iterator ends (the turn boundary). Idempotent. */
  close(): (void) | Promise<void>;
  /** True once {@link close} has been called. */
  readonly closed: boolean;
}

/**
 * A push-driven async input stream. `stream` yields whatever is `push`ed; when
 * the queue is empty it awaits the next push (keeping the SDK session alive);
 * `close` makes it return (ending the session). `initial` messages are yielded
 * first, before any pushed follow-up, so the turn always starts from them.
 */
export function createFollowUpInjector(initial: SdkUserMessage[]): FollowUpInjector {
  const queue: SdkUserMessage[] = [...initial];
  let waiter: ((r: IteratorResult<SdkUserMessage>) => void) | null = null;
  let closed = false;

  async function* stream(): AsyncGenerator<SdkUserMessage> {
    for (;;) {
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (closed) return;
      const next = await new Promise<IteratorResult<SdkUserMessage>>((resolve) => {
        waiter = resolve;
      });
      if (next.done) return;
      yield next.value;
    }
  }

  return {
    stream: stream(),
    push(msg: SdkUserMessage) {
      if (closed) return;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: msg, done: false });
      } else {
        queue.push(msg);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      if (waiter) {
        const w = waiter;
        waiter = null;
        w({ value: undefined as any, done: true });
      }
    },
    get closed() {
      return closed;
    },
  };
}

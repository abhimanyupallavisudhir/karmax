import type { Store } from '../store/db.js';
import { projectPath } from '../domain/console-links.js';
import type { CredentialBroker } from '../autonomy/broker.js';
import type { KarmaxEvent, TaskRecord } from '../domain/types.js';
import type { ProjectEvent } from '../domain/project-events.js';
import { IncomingWebhooks, type IncomingWebhook } from './incoming-webhooks.js';
import { ChatLinks } from './chat-links.js';
import { BRAND } from '../domain/brand.js';
import type { ChatMention } from './chat-platforms.js';

/**
 * A chat bot answers where it was asked (wiki features/events-and-automations):
 * when a mention starts a run (or reaches one already working on
 * its thread), and when that run needs someone, is ready for review, finishes or
 * fails. Each answer is posted once: a claim in the store keys it by run and
 * moment, so a restart or a second process never repeats one.
 */

/** Where a bot's own message points, so a reply to it joins the right thread. */
export const chatThreadKey = (hookId: string, messageId: string) => `chat-thread:${hookId}:${messageId}`;
const conversationKey = (runId: string) => `chat-run:${runId}`;

interface Conversation { hookId: string; channel: string; thread?: string }

export class ChatReplies {
  private hooks: IncomingWebhooks;
  constructor(private deps: { store: Store; broker: CredentialBroker; publicUrl: () => string | undefined; fetcher?: typeof fetch;
    log?: (message: string) => void }) {
    this.hooks = new IncomingWebhooks(deps.store, deps.broker);
  }

  /** A mention started run `runId`, or was told to it. */
  async announce(event: ProjectEvent, runId: string, how: 'started' | 'told'): Promise<void> {
    if (!event.source.startsWith('chat:') || event.type !== 'chat.mention') return;
    const channel = (event.payload.channel as { id?: string } | undefined)?.id;
    if (!channel) return;
    const conversation: Conversation = { hookId: event.source.slice('chat:'.length), channel,
      ...(typeof event.payload.thread === 'string' ? { thread: event.payload.thread } : {}) };
    if (how === 'started') await this.deps.store.kvSet(conversationKey(runId), JSON.stringify(conversation));
    const link = await this.link(runId);
    await this.say(conversation, `${how === 'started' ? 'On it' : 'Passed on to the task working on this'}${link ? `: ${link}` : '.'}`,
      `${runId}:${event.id}`);
  }

  /** A task's lifecycle event: answer the mention that started it, at the moments that matter. */
  async observe(event: KarmaxEvent): Promise<void> {
    if (event.type !== 'view.updated') return;
    const raw = await this.deps.store.kvGet(conversationKey(event.taskId));
    if (!raw) return;
    const status = String(event.payload.status ?? '');
    const waitingFor = event.payload.waitingFor;
    const moment = status === 'done' ? 'done' : status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled'
      : waitingFor === 'human' ? 'input' : event.payload.stage === 'review' && status === 'waiting' ? 'review' : undefined;
    if (!moment) return;
    const task = await this.deps.store.getTask(event.taskId);
    if (!task) return;
    const link = await this.link(task.id, task);
    const detail = moment === 'input' ? String(event.payload.waitingDetail ?? '') : summaryOf(task);
    const lead = { done: 'Done.', failed: 'It failed.', cancelled: 'Cancelled.', input: 'I need your input:', review: 'Ready for review.' }[moment];
    await this.say(JSON.parse(raw) as Conversation, [lead, detail.slice(0, 1500), link].filter(Boolean).join('\n'),
      `${task.id}:${moment}:${moment === 'input' || moment === 'review' ? event.ts : ''}`);
  }

  /** What someone the bot does not know is told: a link to link their chat
   *  account to their tavya account (src/integrations/chat-links.ts).
   *
   *  The link is a bearer secret: whoever opens it first links the sender's
   *  chat account to themselves. So it goes only where the sender alone sees
   *  it: a direct message, Slack's ephemeral message in a channel, or (`reply`
   *  false) the caller's own answer in the delivery, which Discord shows only
   *  to them. In a group the bot cannot whisper in (Telegram), the group is told
   *  to message the bot directly, with no link, and the link goes there.
   *
   *  Each is said at most once while it holds, so a group is not spammed; a
   *  later message after it lapsed gets a fresh one. */
  async decline(hook: IncomingWebhook, mention: ChatMention, reply: boolean): Promise<string | undefined> {
    const links = new ChatLinks(this.deps.store);
    const base = this.deps.publicUrl()?.replace(/\/+$/, '');
    if (!base) {
      if (!(await this.deps.store.kvClaim(`chat-declined:${hook.id}:${mention.author.id}`, '1'))) return undefined;
      const text = 'Only people this project allows can ask me.';
      if (reply) this.post(hook, mention, text);
      return text;
    }
    const whisper = reply && !mention.private && this.hooks.canWhisper(hook);
    if (reply && !mention.private && !whisper) {
      if (!(await links.hintOnce(hook, mention.author.id))) return undefined;
      const direct = hook.kind === 'telegram' && hook.bot?.username ? `: https://t.me/${hook.bot.username}` : '.';
      const text = `Message me directly to link your ${BRAND} account${direct}`;
      this.post(hook, mention, text);
      return text;
    }
    if (reply && await links.offered(hook.id, mention.author.id)) return undefined;
    const { token } = await links.offer(hook, mention.author);
    const text = `Link your ${BRAND} account to ask me: ${base}/link/chat?t=${token}`;
    if (whisper) {
      void this.hooks.whisper(hook, { channel: mention.channel.id, ...(mention.thread ? { thread: mention.thread } : {}), user: mention.author.id },
        text, this.deps.fetcher ?? fetch).catch(async (error) => {
        // Never fall back to the channel: take the offer back, so their next message tries again.
        await links.withdraw(hook.id, mention.author.id, token);
        this.deps.log?.(`chat reply on ${hook.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else if (reply) this.post(hook, mention, text);
    return text;
  }

  /** A linked person who cannot start tasks in the bot's project is told so, once. */
  async refuse(hook: IncomingWebhook, mention: ChatMention, userId: string, reply: boolean): Promise<string | undefined> {
    if (!(await this.deps.store.kvClaim(`chat-refused:${hook.id}:${mention.author.id}:${userId}`, '1'))) return undefined;
    const text = `Your ${BRAND} account can't start tasks in this project.`;
    if (reply) this.post(hook, mention, text);
    return text;
  }

  private post(hook: IncomingWebhook, mention: ChatMention, text: string): void {
    void this.hooks.reply(hook, { channel: mention.channel.id, ...(mention.thread ? { thread: mention.thread } : {}) }, text, this.deps.fetcher ?? fetch)
      .catch((error) => this.deps.log?.(`chat reply on ${hook.kind} failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async say(conversation: Conversation, text: string, once: string): Promise<void> {
    if (!(await this.deps.store.kvClaim(`chat-said:${once}`, '1'))) return;
    const hook = await this.hooks.get(conversation.hookId);
    if (!hook?.kind) return;
    try {
      const sent = await this.hooks.reply(hook, { channel: conversation.channel, ...(conversation.thread ? { thread: conversation.thread } : {}) },
        text, this.deps.fetcher ?? fetch);
      if (sent.messageId && conversation.thread) await this.deps.store.kvSet(chatThreadKey(hook.id, sent.messageId), conversation.thread);
    } catch (error) {
      await this.deps.store.kvDelete(`chat-said:${once}`);
      this.deps.log?.(`chat reply on ${hook.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async link(taskId: string, known?: TaskRecord): Promise<string | undefined> {
    const task = known ?? await this.deps.store.getTask(taskId);
    return task ? this.projectUrl(task.projectId, `tasks/${task.num ?? task.id}`) : undefined;
  }

  private async projectUrl(projectId: string, rest: string): Promise<string | undefined> {
    const base = this.deps.publicUrl()?.replace(/\/+$/, '');
    const project = await this.deps.store.getProject(projectId);
    if (!base || !project) return undefined;
    const organization = project.organizationId ? await this.deps.store.getOrganization(project.organizationId) : undefined;
    return `${base}${projectPath(project, organization)}/${rest}`;
  }
}

function summaryOf(task: TaskRecord): string {
  const view = task.lastView as { reviewInfo?: { summary?: string }; messages?: Array<{ role: string; text: string }> } | undefined;
  const lastAgent = [...(view?.messages ?? [])].reverse().find((message) => message.role === 'agent')?.text;
  return (view?.reviewInfo?.summary || lastAgent || '').trim();
}

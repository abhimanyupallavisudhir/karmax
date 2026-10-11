import crypto from 'node:crypto';
import type { Store } from '../store/db.js';
import { DEFAULT_SITE_NAME } from '../domain/brand.js';
import type { Message } from '../domain/types.js';

export async function sharingPolicy(store: Store, projectId: string) {
  const project = (await store.getProject(projectId));
  if (!project) throw new Error('project not found');
  const organization = (await store.kvGet(`conversation-sharing:organization:${project.organizationId}`)) === 'enabled';
  const value = (await store.kvGet(`conversation-sharing:project:${projectId}`)) === 'disabled' ? 'disabled' : 'inherit';
  return { organization, value, effective: organization && value !== 'disabled' };
}

export interface ConversationShare {
  id: string; taskId: string; projectId: string; role: string; title: string; createdAt: number;
  messages: Array<Pick<Message, 'role' | 'text'>>;
}
const indexKey = (taskId: string, role: string) => `conversation-share-index:${taskId}:${role}`;
export async function currentShare(store: Store, taskId: string, role: string): Promise<ConversationShare | undefined> {
  const id = (await store.kvGet(indexKey(taskId, role)));
  const raw = id && (await store.kvGet(`conversation-share:${id}`));
  return raw ? JSON.parse(raw) : undefined;
}
export async function revokeShare(store: Store, taskId: string, role: string) {
  return store.transaction(async () => {
  (await store.lock(`kv:${indexKey(taskId, role)}`));
  const old = (await currentShare(store, taskId, role));
  if (old) (await store.kvDelete(`conversation-share:${old.id}`));
  (await store.kvDelete(indexKey(taskId, role)));

  });
}
export async function createShare(store: Store, taskId: string, role: string, messages: Message[]) {
  return store.transaction(async () => {
  // One public share per conversation: the index is rewritten under its lock.
  (await store.lock(`kv:${indexKey(taskId, role)}`));
  const task = (await store.getTask(taskId));
  if (!task || !(await sharingPolicy(store, task.projectId)).effective) throw new Error('Public conversation sharing is disabled');
  const existing = (await currentShare(store, taskId, role));
  if (existing) return existing;
  const share: ConversationShare = { id: crypto.randomBytes(32).toString('base64url'), taskId,
    projectId: task.projectId, role, title: task.title, createdAt: Date.now(),
    messages: messages.filter(m => m.role === 'user' || m.role === 'agent').map(m => ({ role: m.role, text: m.text })) };
  (await store.kvSet(`conversation-share:${share.id}`, JSON.stringify(share)));
  (await store.kvSet(indexKey(taskId, role), share.id));
  return share;

  });
}
export async function publicShare(store: Store, id: string): Promise<ConversationShare | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return;
  const raw = (await store.kvGet(`conversation-share:${id}`));
  if (!raw) return;
  const share: ConversationShare = JSON.parse(raw);
  const task = (await store.getTask(share.taskId));
  if (!task || task.projectId !== share.projectId || !(await store.getProject(share.projectId))
    || !(await sharingPolicy(store, share.projectId)).effective) return;
  return share;
}
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function publicConversationHtml(share?: ConversationShare, options: { siteName?: string; signedIn?: boolean } = {}) {
  const name = escape(options.siteName ?? DEFAULT_SITE_NAME);
  const title = share ? escape(share.title) : 'Conversation unavailable';
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow"><title>${title} · ${name}</title>
  <link rel="icon" href="/brand/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shared-conversation.css">
  <script defer src="/markdown.js"></script><script defer src="/shared-conversation.js"></script>
</head><body class="shared-page">
  <header class="topbar shared-topbar">
    <a class="brand" href="/" aria-label="${name} home"><img class="mark" src="/brand/icon-192.png" alt=""><span>${name}</span></a>
    <span class="spacer"></span>
    <nav aria-label="Main navigation">${options.signedIn
      ? '<a class="btn sm" href="/">Open workspace</a>'
      : `<a class="shared-home" href="/">Home</a><a class="btn sm" href="/login">Sign in</a><a class="btn sm primary" href="/signup">Join ${name}</a>`}</nav>
  </header>
  <main class="shared-main">${share ? `
    <header class="shared-heading">
      <div class="shared-eyebrow">Shared conversation</div>
      <h1>${title}</h1>
      <div class="shared-toolbar"><p title="A fixed snapshot of message text. Attachments and tool activity aren’t included.">Snapshot · <time datetime="${new Date(share.createdAt).toISOString()}">${new Date(share.createdAt).toISOString().slice(0, 10)}</time></p>
        <button type="button" class="conversation-math" aria-label="Typeset math" aria-pressed="true" title="Typeset math in all conversations" hidden><span class="tex-mark" aria-hidden="true">T<span>E</span>X</span></button>
      </div>
    </header>
    <div class="thread shared-thread">${share.messages.map(m => `<article class="msg ${m.role === 'user' ? 'user' : 'agent'}" data-share-message>
      <div class="msg-meta"><span class="role">${m.role === 'user' ? 'User' : 'Agent'}</span></div>
      <div class="msg-text">${escape(m.text)}</div>
    </article>`).join('')}</div>` : `
    <section class="shared-unavailable"><div class="shared-eyebrow">Shared conversation</div>
      <h1>Conversation unavailable</h1><p>This link may have been revoked or sharing disabled.</p>
      <a class="btn" href="/">Go to homepage</a>
    </section>`}
  </main>
</body></html>`;
}

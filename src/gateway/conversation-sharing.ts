import crypto from 'node:crypto';
import type { Store } from '../store/db.js';
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
  const old = (await currentShare(store, taskId, role));
  if (old) (await store.kvDelete(`conversation-share:${old.id}`));
  (await store.kvDelete(indexKey(taskId, role)));
}
export async function createShare(store: Store, taskId: string, role: string, messages: Message[]) {
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
export function publicConversationHtml(share?: ConversationShare) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${share ? escape(share.title) : 'Conversation unavailable'}</title><style>body{font:16px/1.6 system-ui,sans-serif;color:#222;background:#faf9f6;margin:0}main{max-width:850px;margin:48px auto;padding:0 24px}h1{line-height:1.2}article{background:white;border:1px solid #ddd;border-radius:12px;padding:24px;margin:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}small{color:#666}</style><main>${share ? `<small>Public conversation · ${escape(share.role)} · Snapshot from ${new Date(share.createdAt).toISOString().slice(0, 10)}</small><h1>${escape(share.title)}</h1><p>This snapshot contains user and agent message text. Attachments and tool activity are not included.</p>${share.messages.map(m => `<article><b>${m.role === 'user' ? 'User' : 'Agent'}</b><pre>${escape(m.text)}</pre></article>`).join('')}` : '<h1>Conversation unavailable</h1><p>This link may have been revoked or sharing disabled.</p>'}</main></html>`;
}

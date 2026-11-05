import crypto from 'node:crypto';
import type { Store } from '../store/db.js';
import type { FilePins, FileKind } from '../world/project-files.js';
import { sharingPolicy } from './conversation-sharing.js';
import { DEFAULT_SITE_NAME } from '../domain/brand.js';

/**
 * Public links to a file or folder of a project's Files (wiki
 * features/project-files): a fixed snapshot, like a shared conversation. The
 * link pins each repository's commit and each data resource's version under
 * the path when it is made, so later changes never reach it. One link per
 * path; revoking and sharing again makes a new snapshot. It answers only while
 * the organization and project allow public links (the same setting as
 * shared conversations), and is gone with the project.
 */
export interface FileShare {
  id: string; projectId: string; path: string; kind: FileKind; pins: FilePins;
  createdAt: number; createdBy?: string;
}

const indexKey = (projectId: string, filePath: string) => `file-share-index:${projectId}:${filePath}`;

export async function currentFileShare(store: Store, projectId: string, filePath: string): Promise<FileShare | undefined> {
  const id = await store.kvGet(indexKey(projectId, filePath));
  const raw = id && await store.kvGet(`file-share:${id}`);
  return raw ? JSON.parse(raw) : undefined;
}

/** Every live link of a project, newest first. */
export async function projectFileShares(store: Store, projectId: string): Promise<FileShare[]> {
  const shares: FileShare[] = [];
  for (const entry of await store.kvEntries(`file-share-index:${projectId}:`)) {
    const raw = await store.kvGet(`file-share:${entry.value}`);
    if (raw) shares.push(JSON.parse(raw));
  }
  return shares.sort((a, b) => b.createdAt - a.createdAt);
}

export async function revokeFileShare(store: Store, projectId: string, filePath: string): Promise<void> {
  await store.transaction(async () => {
    await store.lock(`kv:${indexKey(projectId, filePath)}`);
    const old = await currentFileShare(store, projectId, filePath);
    if (old) await store.kvDelete(`file-share:${old.id}`);
    await store.kvDelete(indexKey(projectId, filePath));
  });
}

/** The path's link, made now from `snapshot` unless one exists. */
export async function createFileShare(store: Store, projectId: string, filePath: string, createdBy: string | undefined,
  snapshot: () => Promise<{ pins: FilePins; kind: FileKind }>): Promise<FileShare> {
  if (!(await sharingPolicy(store, projectId)).effective) throw new Error('Public links are turned off for this project');
  const existing = await currentFileShare(store, projectId, filePath);
  if (existing) return existing;
  // Read the versions outside the transaction: it may fetch from GitHub.
  const { pins, kind } = await snapshot();
  return store.transaction(async () => {
    await store.lock(`kv:${indexKey(projectId, filePath)}`);
    const raced = await currentFileShare(store, projectId, filePath);
    if (raced) return raced;
    const share: FileShare = { id: crypto.randomBytes(32).toString('base64url'), projectId, path: filePath, kind, pins,
      createdAt: Date.now(), ...(createdBy ? { createdBy } : {}) };
    await store.kvSet(`file-share:${share.id}`, JSON.stringify(share));
    await store.kvSet(indexKey(projectId, filePath), share.id);
    return share;
  });
}

/** A link anyone may read, or nothing (unknown, revoked, sharing turned off, project gone). */
export async function publicFileShare(store: Store, id: string): Promise<FileShare | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return;
  const raw = await store.kvGet(`file-share:${id}`);
  if (!raw) return;
  const share: FileShare = JSON.parse(raw);
  if (!(await store.getProject(share.projectId))) return;
  try { if (!(await sharingPolicy(store, share.projectId)).effective) return; } catch { return; }
  return share;
}

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The public page's shell; web/shared-files.js draws the snapshot into it. */
export function publicFilesHtml(share: FileShare | undefined, options: { siteName?: string; signedIn?: boolean; skin?: string } = {}): string {
  const name = escape(options.siteName ?? DEFAULT_SITE_NAME);
  const title = share ? escape(share.path.split('/').filter(Boolean).pop() || 'Files') : 'Link unavailable';
  return `<!doctype html>
<html lang="en"${options.skin === 'classic' ? ' data-skin="classic"' : ''}><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow"><title>${title} · ${name}</title>
  <link rel="icon" href="/brand/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shared-conversation.css">
  <script defer src="/markdown.js"></script><script defer src="/file-view.js"></script><script defer src="/shared-files.js"></script>
</head><body class="shared-page shared-files-page">
  <header class="topbar shared-topbar">
    <a class="brand" href="/" aria-label="${name} home"><img class="mark" src="/brand/icon-192.png" alt=""><span>${name}</span></a>
    <span class="spacer"></span>
    <nav aria-label="Main navigation">${options.signedIn
      ? '<a class="btn sm" href="/">Open workspace</a>'
      : `<a class="shared-home" href="/">Home</a><a class="btn sm" href="/login">Sign in</a><a class="btn sm primary" href="/signup">Join ${name}</a>`}</nav>
  </header>
  <main class="shared-main shared-files-main">${share ? `
    <div id="shared-files" data-share="${escape(share.id)}" data-root="${escape(share.path.split('/').filter(Boolean).pop() || 'Files')}"
      data-created="${new Date(share.createdAt).toISOString()}"></div>` : `
    <section class="shared-unavailable"><div class="shared-eyebrow">Shared files</div>
      <h1>Link unavailable</h1><p>This link may have been revoked or sharing turned off.</p>
      <a class="btn" href="/">Go to homepage</a>
    </section>`}
  </main>
</body></html>`;
}

import { describe, expect, it } from 'vitest';
import { previewLocation, toPublicPayload } from '../src/gateway/server.js';
import { hashPreviewToken, previewCookieHeader, previewCookieValue, previewLeaseOrigin, previewTokenMatches } from '../src/gateway/previews.js';
import { PREVIEW_TLS_GRACE_MS, Store } from '../src/store/db.js';

const remoteWorld = {
  kind: 'e2b',
  id: 'sandbox-secret-id',
  root: '/home/user/project',
  branch: 'karmax/task-1',
  base: 'main',
  repo: 'git@github.com:acme/private.git',
  meta: { trafficAccessToken: 'secret' },
} as const;

function view(world: Record<string, unknown>, worldPath: string) {
  return {
    taskId: 'task-1',
    title: 'Cloud task',
    workflow: 'software-dev',
    stage: 'do',
    status: 'active',
    messages: [],
    actions: [],
    state: { recoveryWorld: world, useful: 'kept' },
    world,
    worldPath,
  };
}

describe('public gateway payloads', () => {
  it('projects a cloud world to availability without leaking its handle or virtual path', () => {
    expect(toPublicPayload(view(remoteWorld, remoteWorld.root))).toEqual({
      taskId: 'task-1',
      title: 'Cloud task',
      workflow: 'software-dev',
      stage: 'do',
      status: 'active',
      messages: [],
      actions: [],
      state: { useful: 'kept' },
      worldAvailable: true,
      worldProvider: 'e2b',
    });
  });

  it('names the wiki checkout folder so wiki citations link to the wiki, without its location', () => {
    const withWiki = { ...remoteWorld, repos: [
      { name: 'private', repo: remoteWorld.repo, root: '/home/user/project/private', branch: remoteWorld.branch, base: 'main' },
      { name: 'acme-wiki', role: 'project-wiki', repo: 'git@github.com:acme/acme-wiki.git',
        root: '/home/user/project/acme-wiki', branch: remoteWorld.branch, base: 'main' },
    ] };
    const payload = toPublicPayload(view(withWiki, withWiki.root)) as Record<string, unknown>;
    expect(payload.worldWiki).toBe('acme-wiki');
    expect(JSON.stringify(payload)).not.toContain('/home/user/project');
  });

  it('redacts world handles nested in event payloads', () => {
    expect(toPublicPayload({ type: 'world.created', payload: { handle: remoteWorld } })).toEqual({
      type: 'world.created',
      payload: { handle: { kind: 'e2b' } },
    });
  });

  it('keeps a local path so local users can copy a terminal command', () => {
    const local = { ...remoteWorld, kind: 'worktree', id: 'task-1', root: '/tmp/world' };
    expect(toPublicPayload(view(local, local.root))).toMatchObject({
      worldAvailable: true,
      worldProvider: 'worktree',
      worldPath: '/tmp/world',
      state: { useful: 'kept' },
    });
  });

  it('keeps cloud-service loopback redirects behind the authenticated proxy', () => {
    expect(previewLocation('task/1', 3000, '/login?next=%2F')).toBe('/api/tasks/task%2F1/preview/3000/login?next=%2F');
    expect(previewLocation('task-1', 3000, 'http://localhost:3000/ready')).toBe('/api/tasks/task-1/preview/3000/ready');
    expect(previewLocation('task-1', 3000, 'https://example.com/docs')).toBe('https://example.com/docs');
    expect(previewLocation('task-1', 3000, 'javascript:alert(1)')).toBeUndefined();
    expect(previewLocation('task-1', 3000, '/login', '/preview/lease-1')).toBe('/preview/lease-1/login');
  });

  it('uses constant-time preview capabilities and a lease-scoped HttpOnly cookie', () => {
    const token = 'private-preview-capability';
    expect(previewTokenMatches(hashPreviewToken(token), token)).toBe(true);
    expect(previewTokenMatches(hashPreviewToken(token), 'wrong')).toBe(false);
    const cookie = previewCookieHeader('lease/1', token, Date.now() + 60_000);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/preview/lease%2F1/');
    expect(previewCookieValue(cookie, 'lease/1')).toBe(token);
    const env = { KARMAX_PREVIEW_ORIGIN: 'https://preview.example.com' } as NodeJS.ProcessEnv;
    expect(previewLeaseOrigin('lease-a', env)).toMatch(/^https:\/\/p-[a-f0-9]{24}\.preview\.example\.com$/);
    expect(previewLeaseOrigin('lease-a', env)).not.toBe(previewLeaseOrigin('lease-b', env));
  });

  // Task 364: the review server died two seconds after its lease was minted,
  // the lease was revoked, and Caddy's refusal surfaced in the browser as
  // ERR_SSL_PROTOCOL_ERROR. Liveness belongs to HTTP, which can say "stopped";
  // TLS only needs to know the name is one karmax issued, and only for a while.
  it('keeps a certificate available for a recently stopped preview so HTTP can explain it', async () => {
    const previous = process.env.KARMAX_PREVIEW_ORIGIN;
    process.env.KARMAX_PREVIEW_ORIGIN = 'https://preview.example.com';
    try {
      const store = (await Store.create(':memory:'));
      const project = (await store.createProject('Preview'));
      const task = (await store.createTask({ projectId: project.id, title: 'Run app', workflow: 'just-do',
        workflowVersion: '1', params: { prompt: 'run it' } }));
      const now = Date.now();
      const lease = (await store.createPreviewLease({ id: 'preview-stopped', organizationId: project.organizationId!,
        projectId: project.id, taskId: task.id, worldId: task.id, generation: 1, port: 4173, public: false,
        provider: 'e2b', createdBy: 'system:review-action', createdAt: now, expiresAt: now + 60_000 }));
      (await store.revokePreviewLease(lease.id));
      expect((await store.previewHostnameAllowed(lease.hostname!, now))).toBe(true);
      expect((await store.previewHostnameAllowed(lease.hostname!, now + 60_000 + PREVIEW_TLS_GRACE_MS - 1))).toBe(true);
      expect((await store.previewHostnameAllowed(lease.hostname!, now + 60_000 + PREVIEW_TLS_GRACE_MS))).toBe(false);
      expect((await store.previewHostnameAllowed('invented.preview.example.com', now))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.KARMAX_PREVIEW_ORIGIN;
      else process.env.KARMAX_PREVIEW_ORIGIN = previous;
    }
  });

  it('allows on-demand TLS only for an opaque preview hostname karmax issued', async () => {
    const previous = process.env.KARMAX_PREVIEW_ORIGIN;
    process.env.KARMAX_PREVIEW_ORIGIN = 'https://preview.example.com';
    try {
      const store = (await Store.create(':memory:'));
      const project = (await store.createProject('Preview'));
      const task = (await store.createTask({ projectId: project.id, title: 'Run app', workflow: 'just-do',
        workflowVersion: '1', params: { prompt: 'run it' } }));
      const lease = (await store.createPreviewLease({ id: 'preview-live', organizationId: project.organizationId!,
        projectId: project.id, taskId: task.id, worldId: task.id, generation: 1, port: 3000, public: false,
        provider: 'e2b', createdBy: 'owner', createdAt: Date.now(), expiresAt: Date.now() + 60_000 }));
      expect(lease.hostname).toMatch(/^p-[a-f0-9]{24}\.preview\.example\.com$/);
      expect((await store.previewHostnameAllowed(lease.hostname!))).toBe(true);
      expect((await store.previewHostnameAllowed(lease.hostname!.toUpperCase()))).toBe(true);
      expect((await store.previewHostnameAllowed('invented.preview.example.com'))).toBe(false);
      expect((await store.previewHostnameAllowed(''))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.KARMAX_PREVIEW_ORIGIN;
      else process.env.KARMAX_PREVIEW_ORIGIN = previous;
    }
  });
});

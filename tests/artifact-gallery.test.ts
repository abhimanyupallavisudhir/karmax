import { afterEach, describe, expect, it } from 'vitest';
import { artifactGalleryFixture } from './helpers/artifact-gallery-fixture.js';
import { capsOf } from './helpers/project-files-fixture.js';
import { storeBackends } from './helpers/store-backends.js';
import { projectArtifactGallery } from '../src/platform/artifact-gallery.js';
import { reviewTargetKey } from '../src/store/review-artifacts.js';

// The artifact gallery (wiki features/project-files): every file a Review
// attached that nothing superseded, from GET /api/projects/:id/artifacts and
// the organization's GET /api/organizations/:id/artifacts.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('artifact gallery', () => {
  it('keeps the latest of each path: underway tasks as attached, done ones as their repository has them now', async () => {
    const f = await artifactGalleryFixture(cleanups);
    const response = await fetch(`${f.server.url}/api/projects/${f.project.id}/artifacts`, { headers: { authorization: `Bearer ${f.viewer}` } });
    expect(response.status).toBe(200);
    const { artifacts } = await response.json() as { artifacts: any[] };
    const byPath = Object.fromEntries(artifacts.map((item) => [item.path, item]));
    // Deleted from the repository, never saved, cancelled, web pages and commands: gone.
    expect(Object.keys(byPath).sort()).toEqual(['shots/home.png', 'site/docs/report.md', 'site/notes/never.md', 'site/screens/new.png', 'site/src/app.ts']);

    // Attached again by a task still underway: that one, from its Review.
    expect(byPath['shots/home.png']).toMatchObject({ taskId: f.tasks.active.id, num: f.tasks.active.num, label: 'Home page, redesigned',
      state: 'active', source: 'review', index: 1, at: 3_000, mediaType: 'image/png' });
    // Relative to the agent's working folder.
    expect(byPath['site/screens/new.png']).toMatchObject({ taskId: f.tasks.active.id, state: 'active', source: 'review', index: 0, name: 'new.png' });
    // Done and in Git: the repository's file now (rewritten since it was attached).
    expect(byPath['site/docs/report.md']).toMatchObject({ taskId: f.tasks.first.id, state: 'done', source: 'repository', at: 1_000,
      bytes: Buffer.byteLength('# Report\n\nFinal.\n'), label: 'Report' });
    expect(byPath['site/docs/report.md'].index).toBeUndefined();
    expect(byPath['site/src/app.ts']).toMatchObject({ taskId: f.tasks.source.id, source: 'repository', name: 'app.ts' });
    // Done, never committed: its saved copy.
    expect(byPath['site/notes/never.md']).toMatchObject({ taskId: f.tasks.notes.id, state: 'done', source: 'review', index: 0, at: 2_000 });

    // Newest first.
    const saved = artifacts.filter((item) => item.at < 10_000).map((item) => item.path);
    expect(saved).toEqual(['shots/home.png', 'site/notes/never.md', 'site/docs/report.md']);
    expect(artifacts.map((item) => item.at)).toEqual(artifacts.map((item) => item.at).sort((a, b) => b - a));
  });

  it('serves the organization’s projects as one, to those who may read their tasks', async () => {
    const f = await artifactGalleryFixture(cleanups);
    const organization = await fetch(`${f.server.url}/api/organizations/${f.project.organizationId}/artifacts`, { headers: { authorization: `Bearer ${f.viewer}` } });
    expect(organization.status).toBe(200);
    const { artifacts } = await organization.json() as { artifacts: any[] };
    expect(artifacts.length).toBe(5);
    expect(new Set(artifacts.map((item) => item.projectId))).toEqual(new Set([f.project.id]));

    const outsider = await f.tokenFor(['repository:read']);
    expect((await fetch(`${f.server.url}/api/projects/${f.project.id}/artifacts`, { headers: { authorization: `Bearer ${outsider}` } })).status).toBe(403);
    // Without repository:read a done task's file shows as it was saved, or not at all.
    const reader = await f.tokenFor(['task:read', 'project:read', 'organization:read']);
    const { artifacts: limited } = await (await fetch(`${f.server.url}/api/projects/${f.project.id}/artifacts`, { headers: { authorization: `Bearer ${reader}` } })).json() as { artifacts: any[] };
    expect(limited.find((item) => item.path === 'site/docs/report.md')).toMatchObject({ source: 'review', index: 0 });
    expect(limited.find((item) => item.path === 'site/src/app.ts')).toBeUndefined();
    expect(capsOf('viewer')).toContain('task:read');
  });
});

describe.each(storeBackends)('artifact gallery queries ($name)', ({ open }) => {
  it('reads each principal task’s Review actions and saved copies', async () => {
    const store = await open();
    const project = await store.createProject('Gallery');
    const task = await store.createTask({ projectId: project.id, title: 'Shoot', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'x' } });
    const bare = await store.createTask({ projectId: project.id, title: 'No review', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'y' } });
    const world = { kind: 'e2b', id: 'w1', root: '/w', branch: 'b', base: 'main' };
    await store.saveView(task.id, { taskId: task.id, title: 'Shoot', workflow: 'software-dev', stage: 'done', status: 'done', messages: [], actions: [], state: {},
      updatedAt: 1, world, reviewInfo: { actions: [{ kind: 'open', label: 'Shot', target: '/w/shot.png' }] } } as any);
    await store.saveView(bare.id, { taskId: bare.id, title: 'No review', workflow: 'software-dev', stage: 'do', status: 'active', messages: [], actions: [], state: {}, updatedAt: 1 } as any);
    await store.savePromotedArtifact({ id: 'review-1', organizationId: project.organizationId!, projectId: project.id, taskId: task.id, objectKey: 'k',
      sha256: 'x', bytes: 3, mediaType: 'image/png', name: 'shot.png', createdAt: 42 });
    await store.savePromotedArtifact({ id: 'other-1', organizationId: project.organizationId!, projectId: project.id, taskId: task.id, objectKey: 'k2',
      sha256: 'x', bytes: 3, mediaType: 'image/png', name: 'other.png', createdAt: 43 });
    await store.kvSet(`review-artifacts:${task.id}`, JSON.stringify({ [reviewTargetKey('/w/shot.png')]: 'review-1' }));

    const rows = await store.reviewAttachmentTasks(project.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: task.id, num: task.num, title: 'Shoot', status: 'done', stage: 'done', world: { root: '/w' },
      actions: [{ kind: 'open', label: 'Shot', target: '/w/shot.png' }] });
    const { artifacts, indexes } = await store.reviewArtifactsOf(project.id, [task.id, bare.id]);
    expect([...artifacts.keys()]).toEqual(['review-1']);
    expect(artifacts.get('review-1')).toMatchObject({ bytes: 3, createdAt: 42 });
    expect(indexes.get(task.id)).toEqual({ [reviewTargetKey('/w/shot.png')]: 'review-1' });

    const gallery = await projectArtifactGallery({ store }, project.id, { repository: true });
    expect(gallery).toEqual([expect.objectContaining({ path: 'shot.png', source: 'review', index: 0, at: 42, bytes: 3, state: 'done' })]);
  });
});

import { afterEach, expect, it } from 'vitest';
import { cliFixture } from './helpers/cli-fixture.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('emits project events from a laptop and from a task\'s world, collapsing repeated keys', async () => {
  const f = await cliFixture(cleanups);
  const emitted = await f.tavya(f.laptop, ['emit', 'orders.created', '-d', '{"id":7}', '--key', 'order-7',
    '--subject', 'https://shop.example/orders/7', '--project', f.project.id]);
  expect(emitted.code, emitted.stderr).toBe(0);
  expect(emitted.stdout).toMatch(/^orders\.created: recorded \(pev_/);
  const again = await f.tavya(f.laptop, ['emit', 'orders.created', '-d', '{"id":7}', '--key', 'order-7', '--project', f.project.id]);
  expect(again.stdout).toMatch(/already recorded/);
  const [event] = await f.store.listProjectEvents(f.project.id);
  expect(event).toMatchObject({ type: 'orders.created', key: 'order-7', subject: 'https://shop.example/orders/7', payload: { id: 7 },
    source: 'user:alice', origin: 'external', hops: 0 });

  // In a task's world there is no workspace: the task token names the project.
  // A run's events come from its series, so a poller's re-emits collapse across runs.
  const series = await f.store.createTask({ projectId: f.project.id, title: 'Poller', workflow: 'software-dev', workflowVersion: '1.27.0', params: { prompt: 'p', repeatable: true } });
  const run = await f.store.createTask({ projectId: f.project.id, title: 'Poller', workflow: 'software-dev', workflowVersion: '1.27.0',
    params: { prompt: 'p', runOf: series.id, trigger: { hops: 2 } } });
  const { token } = await f.tokens.mint({ taskId: run.id, profileId: 'do', principal: `agent:${run.id}`, projectId: f.project.id,
    ceiling: ['task:create', 'task:read'], grantorCaps: ['task:create', 'task:read'] });
  const fromWorld = await f.tavya(f.dir, ['emit', 'feed.item', '-d', '{"title":"New release"}', '--key', 'item-1', '--json'], { token });
  expect(fromWorld.code, fromWorld.stderr).toBe(0);
  expect(JSON.parse(fromWorld.stdout)).toMatchObject({ duplicate: false, event: { projectId: f.project.id, source: `task:${series.id}`, origin: 'task', hops: 3 } });

  // Emitting can start runs, so it needs task creation authority.
  const viewer = await f.tavya(f.laptop, ['emit', 'orders.created', '--project', f.project.id], { token: f.viewer });
  expect(viewer.code).not.toBe(0);
  expect(viewer.stderr).toContain('task:create');
  const bad = await f.tavya(f.laptop, ['emit', 'orders.created', '-d', '[1]', '--project', f.project.id]);
  expect(bad.code).not.toBe(0);
  expect(bad.stderr).toMatch(/payload/);
});

import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxApi } from '../src/platform/api.js';

/**
 * The empty-repo guard. A repo-oriented workflow (its manifest declares a `repos`
 * param) run against a project with no repository configured used to silently get
 * a throwaway README-only scratch world from the worktree provider — the agent
 * worked in an empty sandbox instead of the user's code, with no signal. The API
 * now refuses the *run* early with an actionable message.
 *
 * No Temporal here on purpose: the guard fires before `client.workflow.start`, so
 * a stub client that records starts is enough to prove both "never started" (on
 * refusal) and "started" (once a repo is configured).
 */
describe('repo-required guard (empty-repo footgun)', () => {
  let store: Store;
  let api: KarmaxApi;
  let token: string;
  let started: unknown[][];

  beforeEach(() => {
    store = new Store(':memory:');
    const tokens = new TokenAuthority();
    started = [];
    const client = {
      workflow: {
        start: async (...a: unknown[]) => {
          started.push(a);
          return {};
        },
      },
    } as any;
    api = new KarmaxApi({ store, client, taskQueue: 'tq', tokens });
    token = tokens.mint({
      taskId: 't',
      profileId: 'do',
      principal: 'user:a',
      ceiling: ['create-task', 'read-task'],
      grantorCaps: ['create-task', 'read-task'],
    }).token;
  });

  it('refuses to run a repo-oriented workflow when no repo is configured', async () => {
    const p = store.createProject('NoRepo', {}); // repos unset
    await expect(
      api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'do a thing' }),
    ).rejects.toThrow(/repository/i);
    expect(started).toHaveLength(0); // the workflow was never started
  });

  it('treats blank/whitespace repo entries as unconfigured', async () => {
    const p = store.createProject('Blank', { repos: ['', '   '] });
    await expect(
      api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'x' }),
    ).rejects.toThrow(/repository/i);
    expect(started).toHaveLength(0);
  });

  it('allows the run once a repository is configured', async () => {
    const p = store.createProject('HasRepo', { repos: ['/some/repo'] });
    const task = await api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'x' });
    expect(task.workflow).toBe('software-dev');
    expect(started).toHaveLength(1); // guard passed → workflow started
  });

  it('lets a draft be saved without a repo, but blocks queueing it', async () => {
    const p = store.createProject('Draft', {});
    const draft = await api.createTask(token, {
      projectId: p.id,
      workflow: 'software-dev',
      prompt: 'x',
      draft: true,
    });
    expect(started).toHaveLength(0); // a draft starts nothing
    await expect(api.queueTask(token, draft.id)).rejects.toThrow(/repository/i);
    expect(started).toHaveLength(0); // still not started after the refused queue
  });

  // The scratch-sandbox incident: the guard and the world builder read different
  // sources. A project-settings overlay with an empty `repos` list shadowed the
  // configured repo, so the effective repo list resolved to nothing and the task
  // got a silent scratch world — while the config-only guard happily passed. The
  // guard now reads the SAME effective repos the world is built from.
  const startedInput = () => (started[0]![1] as any).args[0];

  it('an empty project-settings repos list does not shadow the configured repo', async () => {
    const p = store.createProject('OverlayEmpty', { repos: ['/some/repo'] });
    store.setSettings(p.id, 'software-dev', { repos: [] }); // blank list saved in settings
    const task = await api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'x' });
    expect(task.workflow).toBe('software-dev');
    expect(started).toHaveLength(1); // runs — falls back to the configured repo, no scratch world
    expect(startedInput().project.repos).toEqual(['/some/repo']);
  });

  it('allows the run when the repo comes only from the settings overlay (not project config)', async () => {
    const p = store.createProject('OverlayOnly', {}); // config has no repo…
    store.setSettings(p.id, 'software-dev', { repos: ['/from/settings'] }); // …but settings does
    const task = await api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'x' });
    expect(task.workflow).toBe('software-dev');
    expect(started).toHaveLength(1); // guard reads the effective repos, so this passes
    expect(startedInput().project.repos).toEqual(['/from/settings']);
  });

  it('still refuses when the effective repos resolve empty everywhere', async () => {
    const p = store.createProject('AllEmpty', { repos: ['/cfg'] });
    store.setSettings(p.id, 'software-dev', { repos: ['   '] }); // whitespace-only overlay wins, resolves empty
    await expect(
      api.createTask(token, { projectId: p.id, workflow: 'software-dev', prompt: 'x' }),
    ).rejects.toThrow(/repository/i);
    expect(started).toHaveLength(0);
  });
});

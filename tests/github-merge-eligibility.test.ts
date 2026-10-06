import { describe, expect, it } from 'vitest';
import { Store } from '../src/store/db.js';
import { KarmaxApi } from '../src/platform/api.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import type { TaskView } from '../src/domain/types.js';

/** "Can I merge this task's pull requests?" — asked by whoever is about to
 * confirm it, person or agent, and answered with who can. */
async function fixture(mergers: Record<string, string[]>) {
  const store = await Store.create(':memory:');
  const organization = await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' });
  const project = await store.createProject('Site', { remote: 'pr' }, organization.id);
  for (const userId of ['creator', 'reviewer', 'lead', 'unconnected'])
    await store.setOrganizationMembership(organization.id, userId, 'member');
  await store.setProjectMembership(project.id, { kind: 'organization', organizationId: organization.id }, 'member');
  const githubApp = {
    activeUserAccountId: async (userId: string) => userId === 'unconnected' ? undefined : `gh-${userId}`,
    repositoryPermission: async (userId: string, slug: string) => ({ canMerge: (mergers[slug] ?? []).includes(userId) }),
  } as any;
  const tokens = new TokenAuthority(store);
  const api = new KarmaxApi({ store, tokens, githubApp, client: {} as any, taskQueue: 'test' });
  const task = await store.createTask({ projectId: project.id, title: 'Change', workflow: 'software-dev', workflowVersion: '1.4.0',
    createdBy: { kind: 'user', userId: 'creator' }, params: { prompt: 'work' } });
  const pr = (slug: string, number: number) => ({ repo: slug.split('/')[1]!, slug, number, url: `https://github.com/${slug}/pull/${number}`, state: 'open' as const });
  await store.saveView(task.id, { taskId: task.id, title: 'Change', workflow: 'software-dev', stage: 'review', status: 'waiting',
    messages: [], actions: [], state: {}, updatedAt: 1, prs: [pr('acme/site', 7), pr('acme/docs', 3)] } as TaskView);
  const as = async (userId: string) => (await tokens.mintPrincipal(`user:${userId}`, ['task:read'], project.id, undefined, organization.id)).token;
  return { store, project, task, api, tokens, as };
}

describe('merge eligibility', () => {
  it('tells someone who cannot merge who can', async () => {
    const f = await fixture({ 'acme/site': ['lead', 'reviewer'], 'acme/docs': ['lead'] });
    const answer = await f.api.mergeEligibility(await f.as('reviewer'), f.task.id);
    expect(answer).toMatchObject({ required: true, canMerge: false, blocked: true,
      pullRequests: [{ slug: 'acme/site', number: 7 }, { slug: 'acme/docs', number: 3 }],
      eligibleUserIds: ['lead'], audience: ['user:lead'] });
  });

  it('lets the merge proceed when the caller or the creator can merge', async () => {
    const f = await fixture({ 'acme/site': ['lead', 'creator'], 'acme/docs': ['lead', 'creator'] });
    expect(await f.api.mergeEligibility(await f.as('lead'), f.task.id)).toMatchObject({ canMerge: true, blocked: false });
    // The creator sponsors the merge when the reviewer cannot.
    expect(await f.api.mergeEligibility(await f.as('reviewer'), f.task.id)).toMatchObject({ canMerge: false, blocked: false });
  });

  it('answers an agent the same way', async () => {
    const f = await fixture({ 'acme/site': ['lead'], 'acme/docs': ['lead'] });
    const agent = (await f.tokens.mint({ taskId: f.task.id, profileId: 'do', role: 'do', principal: `task-agent:${f.task.id}:do`,
      projectId: f.project.id, ceiling: ['task:read'], grantorCaps: ['task:read'] })).token;
    expect(await f.api.mergeEligibility(agent, f.task.id)).toMatchObject({ canMerge: false, blocked: true, audience: ['user:lead'] });
  });

  it('requires nothing of a task that does not merge through pull requests', async () => {
    const f = await fixture({});
    const plain = await f.store.createTask({ projectId: f.project.id, title: 'Local', workflow: 'just-do', workflowVersion: '1.0.0',
      createdBy: { kind: 'user', userId: 'creator' }, params: { prompt: 'work', remote: 'none' } });
    expect(await f.api.mergeEligibility(await f.as('reviewer'), plain.id)).toMatchObject({ required: false, blocked: false });
  });
});

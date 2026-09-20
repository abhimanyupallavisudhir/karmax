import { describe, it, expect } from 'vitest';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { Store } from '../src/store/db.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { Overlays } from '../src/store/overlays.js';
import { WorldRegistry } from '../src/world/registry.js';
import { GithubActionsApi } from '../src/integrations/github-actions.js';
import { httpOps } from '../src/platform/mcp.js';
import { platformToolHandlers } from '../src/agent/tools.js';
import { findFreePortFrom } from '../src/util/ports.js';

describe('Actions evidence through agent transports and the real gateway', () => {
  it('retrieves successful completion using only read authority, forwarding bounded selection and denying writes', async () => {
    const store = (await Store.create(':memory:'));
    const tokens = new TokenAuthority();
    const org = (await store.createOrganization({ name: 'Acme', ownerUserId: 'owner' }));
    const project = (await store.createProject('App', {}, org.id));
    const connection = (await store.upsertGitConnection({ organizationId: org.id, provider: 'github',
      installationId: '1', accountLogin: 'acme', accountType: 'Organization' }));
    const repository = (await store.upsertRepository({ organizationId: org.id, provider: 'github', providerId: '1',
      owner: 'acme', name: 'app', sshUrl: 'git@github.com:acme/app.git', defaultBranch: 'main', private: true,
      gitConnectionId: connection.id }));
    (await store.attachProjectRepository({ projectId: project.id, repositoryId: repository.id }));
    const task = (await store.createTask({ projectId: project.id, title: 'Verify', workflow: 'software-dev', workflowVersion: '1.0.0', params: { prompt: 'Verify deployment' } }));
    const mint = async (cap: string) => (await tokens.mint({ taskId: task.id, projectId: project.id, profileId: 'do', principal: 'user:owner',
      ceiling: [cap], grantorCaps: [cap] } as any)).token;
    const read = (await mint('github:actions:read'));
    const calls: string[] = [];
    const actions = new GithubActionsApi('installation-secret', { fetch: (async (input) => {
      const url = new URL(String(input)); calls.push(url.pathname + url.search);
      if (url.pathname.endsWith('/workflows')) return Response.json({ total_count: 1, workflows: [{ id: 7, path: '.github/workflows/deploy.yml' }] });
      if (url.pathname.endsWith('/attempts/1')) return Response.json({ id: 42, run_attempt: 1, head_sha: 'workflow-sha', event: 'workflow_run' });
      if (url.pathname.endsWith('/jobs/99')) return Response.json({ id: 99, run_id: 42, run_attempt: 1, conclusion: 'success' });
      if (url.pathname.endsWith('/logs')) return new Response('setup\nreadiness passed\nUpdate complete at target-sha\n');
      return new Response('missing', { status: 404 });
    }) as typeof fetch });
    const client = {} as any;
    const api = new KarmaxApi({ store, tokens, client, taskQueue: 'test', githubApp: { actions: () => actions } as any });
    const gateway = (await Gateway.create({ api, store, tokens, client, taskQueue: 'test', staticDir: '.',
      bus: new KarmaxBus(), contributions: new ContributionRegistry(), overlays: new Overlays(),
      worlds: new WorldRegistry(), agentInfo: { provider: 'mock', reason: 'test' } }));
    const server = await gateway.listen(await findFreePortFrom(48650));
    try {
      const ops = httpOps(server.url, read);
      const result: any = await ops.inspectGithubActionsRun({ repository: 'acme/app', runId: 42, view: 'log',
        jobId: 99, attempt: 1, tailLines: 2, maxChars: 256, offsetLines: 0 });
      expect(result.log.excerpt).toBe('readiness passed\nUpdate complete at target-sha');
      expect(result.log).toMatchObject({ tailLines: 2, maxChars: 256, offsetLines: 0, tailComplete: true });
      expect(await ops.listGithubActionsWorkflows({ repository: 'acme/app', page: 2, perPage: 1 })).toMatchObject({ page: 2 });
      expect(calls).toContain('/repos/acme/app/actions/workflows?per_page=1&page=2');
      const handlers = platformToolHandlers({} as any, { platformRequest: async (method: string, path: string) => {
        const response = await fetch(`${server.url}${path}`, { method, headers: { authorization: `Bearer ${read}` } });
        expect(response.status).toBe(200); return response.json();
      } } as any);
      const native = JSON.parse(await handlers.inspect_github_actions_run!({ repository: 'acme/app', run_id: 42,
        view: 'log', job_id: 99, attempt: 1, tail_lines: 1, offset_lines: 1, max_chars: 256 }));
      expect(native.log.excerpt).toBe('readiness passed');
      expect(JSON.parse(await handlers.list_github_actions_workflows!({ repository: 'acme/app', page: 2, per_page: 1 })).page).toBe(2);
      await expect((await ops.manageGithubActionsRun({ runId: 42, action: 'cancel' }))).rejects.toMatchObject({ status: 403 });
      await expect((await httpOps(server.url, (await mint('github:actions:write'))).inspectGithubActionsRun({ runId: 42, view: 'jobs' }))).rejects.toMatchObject({ status: 403 });
      await expect((await ops.inspectGithubActionsRun({ repository: 'acme/outside', runId: 42, view: 'jobs' }))).rejects.toMatchObject({ status: 404 });
      expect(JSON.stringify((await store.eventsSince(task.id, 0)))).not.toMatch(/Update complete|installation-secret|readiness passed/);
    } finally { await server.close(); (await store.close()); }
  });
});

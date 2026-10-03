import { roleCeiling } from '../src/contrib/manifests.js';
import { CAPABILITIES, allows } from '../src/platform/capabilities.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { DEFAULT_AUTHORIZATION_PROFILES } from '../src/platform/authorization.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { LocalObjectStore } from '../src/store/objects.js';
import { Overlays } from '../src/store/overlays.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { ObjectSnapshotEngine, ProjectResourceService } from '../src/world/resources.js';
import * as processes from '../src/util/processes.js';
import { findFreePortFrom } from '../src/util/ports.js';

let nextPort = 49_900;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

describe('human and agent authorization-level parity', () => {
  it.each(DEFAULT_AUTHORIZATION_PROFILES)('$name has the same HTTP authority for both actors', async (profile) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-parity-'));
    const store = (await Store.create(':memory:'));
    (await store.claimPersonalOrganization('me'));
    const project = (await store.createProject('Parity'));
    (await store.kvSet(`avatars:project:${project.id}`, 'enabled'));
    const siblingProject = await store.createProject('Sibling');
    const foreignOrg = await store.createOrganization({ name: 'Foreign' });
    const foreignProject = await store.createProject('Foreign', {}, foreignOrg.id);
    const taskIds: string[] = [];
    for (const p of [project, siblingProject, foreignProject]) taskIds.push((await store.createTask({
      projectId: p.id, title: p.name, workflow: 'just-do', workflowVersion: '1', params: { prompt: p.name, draft: true },
    })).id);
    vi.spyOn(processes, 'sampleProcesses').mockReturnValue({ supported: true, ts: Date.now(),
      groups: taskIds.map((taskId, i) => ({ key: String(i), kind: 'agent', label: `Task ${i}`, taskId,
        cpuPct: 1, rssMb: 2, procs: [{ pid: i + 100, ppid: 1, cmd: `task ${i}`, cpuPct: 1, rssMb: 2, ageSec: 3 }] })),
      totals: { procs: 3, cpuPct: 3, rssMb: 6 },
    });
    const tokens = new TokenAuthority();
    const worlds = new WorldRegistry();
    const objects = new LocalObjectStore(path.join(dir, 'objects'));
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const resources = new ProjectResourceService(store, worlds, new ObjectSnapshotEngine(objects, broker), broker);
    const client = { workflow: { getHandle: () => ({}) } } as any;
    const api = new KarmaxApi({ store, tokens, client, worlds, resources, broker, taskQueue: 'test' });
    const gateway = (await Gateway.create({ api, store, tokens, client, worlds, resources, broker, objects,
      taskQueue: 'test', staticDir: 'web', bus: new KarmaxBus(), contributions: new ContributionRegistry(),
      overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'authorization parity test' } }));
    const server = await gateway.listen(await findFreePortFrom(nextPort += 10));
    cleanups.push(async () => { await server.close(); (await store.close()); fs.rmSync(dir, { recursive: true, force: true }); });

    // Use an actual gateway browser session, then give both actors exactly the
    // same canonical level and scope. Delegation supplies identity, not power.
    const session = await (await fetch(`${server.url}/api/session`)).json() as { token: string };
    const humanToken = (gateway as any).sessions.get(session.token).apiToken as string;
    const human = (await tokens.verify(humanToken))!;
    human.caps = [...profile.capabilities];
    human.organizationId = profile.id === 'god' ? undefined : project.organizationId;
    human.projectId = ['administrator', 'superadmin', 'god'].includes(profile.id) ? undefined : project.id;
    const delegation = (await tokens.delegateHuman(humanToken, { taskId: 'parity-agent',
      projectId: human.projectId, organizationId: human.organizationId }))!;
    const agent = (await tokens.mint({ taskId: 'parity-agent', principal: 'task:parity-agent', profileId: profile.id,
      projectId: human.projectId, organizationId: human.organizationId, delegationId: delegation.id,
      ceiling: roleCeiling('do'), grantorCaps: [...profile.capabilities] }));
    for (const role of ['do', 'confirm', 'resolve', 'merge']) {
      const roleToken = (await tokens.mint({ taskId: `${role}-parity`, principal: `task:${role}-parity`,
        profileId: profile.id, role, projectId: human.projectId, organizationId: human.organizationId,
        ceiling: roleCeiling(role), grantorCaps: [...profile.capabilities] }));
      for (const capability of [...CAPABILITIES, '*']) {
        expect(allows(roleToken.record.caps, capability), `${profile.id}/${role}: ${capability}`)
          .toBe(allows(human.caps, capability));
      }
    }
    const projectWrite = ['maintainer', 'administrator', 'superadmin', 'god'].includes(profile.id);
    const orgAdmin = ['administrator', 'superadmin', 'god'].includes(profile.id);
    const statuses: number[][] = [];
    for (const [kind, token] of [['human', session.token], ['agent', agent.token]] as const) {
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const call = async (method: string, route: string, body?: unknown) => fetch(`${server.url}${route}`, {
        method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const existing = (await store.createResourceAttachment({ organizationId: project.organizationId!, projectId: project.id,
        name: `Existing ${kind}`, driver: 'volume@1', target: { kind: 'path', path: `existing-${kind}` },
        access: 'read', isolation: 'fork', publish: 'discard', source: {}, credentialHandles: [] }));
      const checks: Array<[Response, number]> = [
        [await call('GET', `/api/projects/${project.id}/resources`), 200],
        [await call('POST', `/api/projects/${project.id}/resources`, { name: `Data ${kind}`,
          files: [{ path: 'data.txt', data: 'data', encoding: 'utf8' }] }), projectWrite ? 200 : 403],
        [await call('PATCH', `/api/projects/${project.id}/resources/${existing.id}`, { enabled: false }), projectWrite ? 200 : 403],
        [await call('DELETE', `/api/projects/${project.id}/resources/${existing.id}`), projectWrite ? 200 : 403],
        [await call('POST', `/api/projects/${project.id}/secrets`, { name: `KEY_${kind.toUpperCase()}`, value: 'test-key' }), projectWrite ? 200 : 403],
        [await call('GET', '/api/vault/items'), orgAdmin || profile.id === 'developer' || profile.id === 'maintainer' ? 200 : 403],
        [await call('DELETE', '/api/vault/items/nonexistent'), orgAdmin ? 200 : 403],
        [await call('GET', `/api/diagnostics?projectId=${project.id}`), profile.id === 'viewer' ? 403 : 200],
        [await call('GET', `/api/processes?projectId=${project.id}`), profile.id === 'viewer' ? 403 : 200],
        [await call('PUT', `/api/organizations/${project.organizationId}/settings/__common__`, { values: { test: true } }), orgAdmin ? 200 : 403],
        [await call('PUT', `/api/settings/project/${project.id}/__common__`, { values: { test: true } }), projectWrite ? 200 : 403],
        [await call('PUT', '/api/settings/global/__common__', { values: { test: true } }), profile.id === 'god' ? 200 : 403],
        [await call('GET', '/api/users'), profile.id === 'god' ? 200 : 403],
        [await call('POST', '/api/users', { name: 'New account' }), profile.id === 'god' ? 400 : 403],
        [await call('POST', `/api/projects/${project.id}/avatars`, { name: `Helper ${kind}`,
          prompt: 'Help with project work.', runtime: { provider: 'mock' } }), profile.id === 'viewer' ? 403 : 201],
        [await call('POST', `/api/projects/${project.id}/avatars`, { name: `Organization helper ${kind}`,
          prompt: 'Help across the organization.', runtime: { provider: 'mock' }, authorityMode: 'restricted',
          authorization: { level: profile.id, scope: 'organization' } }), orgAdmin ? 201 : 403],
        [await call('GET', '/api/user/default-organization'), 200],
        [await call('GET', `/api/inbox?organizationId=${project.organizationId}`), 200],
      ];
      if (profile.id !== 'viewer') {
        const diagnostics: any = await (await call('GET', `/api/diagnostics?projectId=${project.id}`)).json();
        expect(diagnostics.host).toBeDefined();
        expect(diagnostics.runtimeLifecycle).toEqual([]);
        expect(diagnostics.controlPlane).toBeUndefined();
        const processes: any = await (await call('GET', `/api/processes?projectId=${project.id}`)).json();
        expect(processes.groups.map((group: any) => group.taskId)).toEqual([taskIds[0]]);
        expect(processes.totals).toEqual({ procs: 1, cpuPct: 1, rssMb: 2 });
        expect(processes.canKill).toBe(false);
        const unfiltered: any = await (await call('GET', '/api/processes')).json();
        expect(unfiltered.groups.map((group: any) => group.taskId)).toEqual(
          profile.id === 'god' ? taskIds : ['administrator', 'superadmin'].includes(profile.id) ? taskIds.slice(0, 2) : taskIds.slice(0, 1));
        expect(unfiltered.canKill).toBe(profile.id === 'god');
      }
      for (const [response, expected] of checks) {
        expect(response.status, `${profile.id} ${kind}: ${response.url}: ${await response.text()}`).toBe(expected);
      }
      statuses.push(checks.map(([response]) => response.status));
    }
    expect(statuses[0]).toEqual(statuses[1]);
    if (profile.id === 'god') {
      const autonomous = (await tokens.mint({ taskId: 'autonomous-admin', principal: 'task:autonomous-admin',
        profileId: 'god', ceiling: ['*'], grantorCaps: ['*'] }));
      const response = await fetch(`${server.url}/api/users`, {
        method: 'POST', headers: { authorization: `Bearer ${autonomous.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New account' }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'identity service unavailable' });
    }

  });
});

it('enforces Developer ownership through HTTP and records the agent as creator', async () => {
  const store = await Store.create(':memory:');
  await store.claimPersonalOrganization('me');
  const project = await store.createProject('Ownership');
  const tokens = new TokenAuthority(store);
  const worlds = new WorldRegistry();
  const client = { workflow: { getHandle: () => ({}) } } as any;
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test' });
  const gateway = await Gateway.create({ api, store, tokens, client, worlds, taskQueue: 'test',
    staticDir: 'web', bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'ownership test' } });
  const server = await gateway.listen(await findFreePortFrom(nextPort += 10));
  cleanups.push(async () => { await server.close(); await store.close(); });
  const makeTask = (title: string) => store.createTask({ projectId: project.id, title,
    workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: title, draft: true },
    createdBy: { kind: 'user', userId: 'me' } });
  const own = await makeTask('Own');
  const sibling = await makeTask('Same human, different agent');
  const caps = DEFAULT_AUTHORIZATION_PROFILES.find(p => p.id === 'developer')!.capabilities;
  const agent = await tokens.mint({ taskId: own.id, principal: 'user:me', profileId: 'developer',
    projectId: project.id, organizationId: project.organizationId, ceiling: caps, grantorCaps: ['*'] });
  const human = await tokens.mintPrincipal('user:me', caps, project.id, undefined, project.organizationId);
  const call = (token: string, method: string, route: string, body?: unknown) => fetch(`${server.url}${route}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setPriority = (token: string, taskId: string) => call(token, 'PUT', `/api/tasks/${taskId}/priority`, { priority: 2 });
  expect((await setPriority(agent.token, own.id)).status).toBe(200);
  expect((await setPriority(agent.token, sibling.id)).status).toBe(403);
  expect((await setPriority(human.token, sibling.id)).status).toBe(200);
  const created = await call(agent.token, 'POST', `/api/projects/${project.id}/tasks`, { projectId: project.id,
    title: 'Created by agent', prompt: 'Help', workflow: 'just-do', draft: true });
  const task: any = await created.json();
  expect(created.status, JSON.stringify(task)).toBe(200);
  expect((await store.getTask(task.id))?.createdBy).toEqual({ kind: 'task-agent', taskId: own.id, role: 'do' });
  expect((await setPriority(agent.token, task.id)).status).toBe(200);
  // Task-bound operations must reach their domain checks with own-task authority.
  await expect(api.publishTaskBranch(agent.token)).rejects.toThrow('no recoverable world');
  const publish = await call(agent.token, 'POST', '/api/agent/git/publish');
  expect(await publish.text()).toContain('no recoverable world');
  const proposal = await call(agent.token, 'POST', '/api/agent/resource-candidates', {});
  expect(await proposal.text()).toContain('project resources are unavailable');
  const request = await call(agent.token, 'POST', '/api/agent/collaboration/request',
    { taskId: sibling.id, action: 'publish_branch' });
  expect(request.status).toBe(403);

  expect((await call(agent.token, 'PUT', `/api/settings/project/${project.id}/__common__`, { values: {} })).status).toBe(403);
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Gateway } from '../src/gateway/server.js';
import { KarmaxApi } from '../src/platform/api.js';
import { AuthorizationService, ORGANIZATION_GRANT_CEILING } from '../src/platform/authorization.js';
import { PLATFORM_API_CATALOG } from '../src/platform/catalog.js';
import { TokenAuthority } from '../src/platform/tokens.js';
import { Store } from '../src/store/db.js';
import { Overlays } from '../src/store/overlays.js';
import { KarmaxBus } from '../src/contrib/bus.js';
import { ContributionRegistry } from '../src/contrib/registry.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';

/**
 * Every documented route × a caller with full authority in one organization,
 * aimed at another organization's objects (CI-38q). The per-route tenant tests
 * elsewhere pick the routes someone thought of; this walks
 * `PLATFORM_API_CATALOG`, the same list `describe_platform` hands agents, so a
 * route added there is probed here without anyone remembering to.
 *
 * Each probe substitutes the foreign tenant's ids into the path, the query and
 * the body. Whatever the route answers, it must not return the foreign
 * tenant's data, start or signal its task's workflow, or change a stored row
 * that belongs to it; a route whose path or query names a foreign object must
 * also refuse. Hosted mode, where the tenancy boundary is the product.
 */

/** Unique text in every foreign object, so a leak shows up in any response body. */
const SECRET = 'foreign-tenant-secret';

type Probe = { method: string; route: string; url: string; body?: string; targetsForeign: boolean };

let dir: string;
let store: Store;
let base: string;
let close: () => Promise<void>;
let foreign: Record<string, string>;
const callers: Record<string, Record<string, string>> = {};
const workflowCalls: string[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-tenancy-matrix-'));
  store = await Store.create(':memory:', { hosted: true });
  const tokens = new TokenAuthority();
  const authorization = await AuthorizationService.create(store);

  const home = await store.createOrganization({ name: 'Home', ownerUserId: 'alice' });
  const homeProject = await store.createProject('Home project', {}, home.id);
  await authorization.bootstrapOrganizationOwner('system:test', 'alice', home.id);
  const homeTask = await store.createTask({ projectId: homeProject.id, title: 'Home task', workflow: 'just-do',
    workflowVersion: '1', params: { prompt: 'home' }, createdBy: { kind: 'user', userId: 'alice' } });

  const other = await store.createOrganization({ name: `${SECRET} org`, ownerUserId: 'bob' });
  await authorization.bootstrapOrganizationOwner('system:test', 'bob', other.id);
  const project = await store.createProject(`${SECRET} project`, {}, other.id);
  const task = await store.createTask({ projectId: project.id, title: `${SECRET} task`, workflow: 'just-do',
    workflowVersion: '1', params: { prompt: `${SECRET} prompt` }, createdBy: { kind: 'user', userId: 'bob' } });
  const tag = await store.createTag({ projectId: project.id, name: `${SECRET} tag` });
  await store.addTaskTag(task.id, tag.id);
  const view = await store.createView({ projectId: project.id, name: `${SECRET} view`, query: {} as any });
  const team = await store.createTeam({ organizationId: other.id, name: `${SECRET} team` });
  foreign = { organizationId: other.id, projectId: project.id, taskId: task.id, tagId: tag.id, viewId: view.id,
    teamId: team.id, userId: 'bob' };

  const client = {
    workflow: {
      getHandle: (id: string) => {
        const record = (kind: string) => async () => { workflowCalls.push(`${kind} ${id}`); return kind === 'query' ? [] : {}; };
        return { query: record('query'), signal: record('signal'), terminate: record('terminate'),
          cancel: record('cancel'), describe: record('describe'), executeUpdate: record('update'),
          startUpdate: record('update'), result: record('result') };
      },
      start: async (_type: unknown, options: { workflowId: string }) => { workflowCalls.push(`start ${options.workflowId}`); return {}; },
      signalWithStart: async (_type: unknown, options: { workflowId: string }) => {
        workflowCalls.push(`signalWithStart ${options.workflowId}`); return {};
      },
      list: async function* () {},
    },
  } as any;
  const worlds = new WorldRegistry();
  const api = new KarmaxApi({ store, tokens, client, worlds, taskQueue: 'test', contentDir: dir });
  const alice = { id: 'alice', name: 'Alice', email: 'alice@example.test' };
  const gateway = await Gateway.create({ api, store, tokens, client, worlds, authorization, hosted: true,
    identity: { sessionActive: async (id: string) => id === 'alice-session', connectOrganizationNames: () => {},
      session: async (headers: Headers) => headers.get('cookie') === 'fixture=alice'
        ? { user: alice, session: { id: 'alice-session' } } : null,
      listUsers: async () => [alice, { id: 'bob', name: `${SECRET} user`, email: 'bob@example.test' }],
    } as any,
    taskQueue: 'test', staticDir: dir, bus: new KarmaxBus(), contributions: new ContributionRegistry(),
    overlays: new Overlays(), agentInfo: { provider: 'mock', reason: 'tenancy matrix' } });
  const running = await gateway.listen(await findFreePortFrom(49_300));
  base = running.url;
  close = running.close;
  // listen() repairs every project's wiki in the background; let that write
  // land before the matrix snapshots the foreign tenant's rows.
  await vi.waitFor(async () => {
    for (const id of [homeProject.id, project.id]) if (!(await store.projectWiki(id))) throw new Error('wiki not ready');
  }, { timeout: 30_000 });

  callers['organization administrator'] = { cookie: 'fixture=alice' };
  // The widest token a workflow mints for an organization-scoped agent: the
  // whole organization grant ceiling, bound to the home organization.
  const agent = await tokens.mint({ taskId: homeTask.id, profileId: 'administrator', principal: 'user:alice',
    organizationId: home.id, ceiling: ORGANIZATION_GRANT_CEILING, grantorCaps: ORGANIZATION_GRANT_CEILING });
  callers['organization-scoped agent'] = { authorization: `Bearer ${agent.token}` };
}, 60_000);

afterAll(async () => {
  await close?.();
  await store?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** `/api/a/b|c/d` alternates the suffix after the last `/` before the first `|`. */
function alternatives(route: string): string[] {
  const pipe = route.indexOf('|');
  if (pipe < 0) return [route];
  const cut = route.lastIndexOf('/', pipe) + 1;
  return route.slice(cut).split('|').map((alternative) => `${route.slice(0, cut)}${alternative}`);
}

/** The foreign object a bare `:id` names, by the collection it sits in. */
function foreignId(route: string, param: string): string | undefined {
  if (param === 'organizationId' || param === 'projectId' || param === 'taskId' || param === 'teamId' || param === 'userId')
    return foreign[param];
  if (param !== 'id') return undefined;
  if (route.startsWith('/api/tags/')) return foreign.tagId;
  if (route.startsWith('/api/views/')) return foreign.viewId;
  if (route.startsWith('/api/users/')) return foreign.userId;
  return undefined;
}

function probes(): Probe[] {
  const out: Probe[] = [];
  for (const entries of Object.values(PLATFORM_API_CATALOG)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const [methods, spec] = entry.split(' ');
      if (!methods || !spec || methods === 'WS') continue;
      const [rawRoute, rawQuery] = spec.split('?');
      for (const route of alternatives(rawRoute!)) {
        let targetsForeign = false;
        const concrete = route.replace(/:([A-Za-z]+)/g, (_match, param: string) => {
          const id = foreignId(route, param);
          if (id) targetsForeign = true;
          return encodeURIComponent(id ?? `unknown-${param}`);
        });
        const url = new URL(`${base}${concrete}`);
        for (const key of (rawQuery ?? '').split(/[&|]/).map((value) => value.split('=')[0]).filter(Boolean)) {
          const id = foreignId(route, key!);
          if (id) targetsForeign = true;
          url.searchParams.set(key!, id ?? 'x');
        }
        for (const method of methods.split('|')) out.push({ method, route: `${method} ${route}`, url: url.toString(),
          targetsForeign,
          ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify({ ...foreign, name: 'x', title: 'x',
            prompt: 'x', email: 'x@example.test', ids: [foreign.taskId], taskIds: [foreign.taskId] }) }) });
      }
    }
  }
  return out;
}

/** Every stored row that mentions a foreign id, keyed by table. Audit and event
 * rows are the only ones a refused request is expected to add. */
async function foreignRows(): Promise<Record<string, string[]>> {
  const ids = Object.values(foreign);
  const tables = await store.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>;
  const rows: Record<string, string[]> = {};
  for (const { name } of tables) {
    if (name === 'audit_log' || name === 'events' || name.startsWith('sqlite_')) continue;
    const mentions = (await store.db.prepare(`SELECT * FROM "${name}"`).all() as unknown[])
      .map((row) => JSON.stringify(row)).filter((row) => ids.some((id) => row.includes(id))).sort();
    if (mentions.length) rows[name] = mentions;
  }
  return rows;
}

describe('every catalog route refuses another organization\'s objects', () => {
  it('covers the catalog', () => {
    const all = probes();
    expect(all.length).toBeGreaterThan(300);
    expect(all.filter((probe) => probe.targetsForeign).length).toBeGreaterThan(150);
  });

  for (const caller of ['organization administrator', 'organization-scoped agent']) {
    it(`as the home ${caller}`, async () => {
      const before = await foreignRows();
      workflowCalls.length = 0;
      const failures: string[] = [];
      for (const probe of probes()) {
        let status: number, text: string;
        try {
          const response = await fetch(probe.url, { method: probe.method, redirect: 'manual',
            headers: { 'content-type': 'application/json', ...callers[caller] },
            ...(probe.body ? { body: probe.body } : {}), signal: AbortSignal.timeout(10_000) });
          status = response.status;
          text = await response.text();
        } catch (error) {
          failures.push(`${probe.route}: ${(error as Error).message}`);
          continue;
        }
        if (text.includes(SECRET)) failures.push(`${probe.route} ${status} returned foreign data`);
        if (probe.targetsForeign && status < 400) failures.push(`${probe.route} answered ${status} for a foreign object`);
      }
      const touched = workflowCalls.filter((call) => call.includes(foreign.taskId!));
      expect(failures).toEqual([]);
      expect(touched).toEqual([]);
      expect(await foreignRows()).toEqual(before);
    }, 180_000);
  }
});

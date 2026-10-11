// Saved sessions held by tasks' browsers: refreshed into the vault after each
// turn and when the world parks or is destroyed, and, when marked one task at
// a time, in at most one live task's browser. The refresh reads a real
// Chromium; the activity cases run the real turn and teardown activities.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { Vault } from '../src/autonomy/vault.js';
import { VaultItems } from '../src/autonomy/vault-items.js';
import { openPage } from '../src/autonomy/cdp.js';
import * as worldFill from '../src/autonomy/world-fill.js';
import * as connectionRuntime from '../src/mcp/connections/runtime.js';
import * as remoteProcess from '../src/agent/remote-process.js';
import { acquireLease, recordHold, settleTaskSessions, LEASE_STALE_MS } from '../src/autonomy/session-holds.js';
import type { SavedSession } from '../src/autonomy/browser-session.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';
import { findFreePortFrom } from '../src/util/ports.js';
import { launchChromium } from './helpers/browser.js';

let browser: Browser, devtools: string, context: BrowserContext;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-session-holds-'));

beforeAll(async () => {
  const cdpPort = await findFreePortFrom(49700);
  devtools = `http://127.0.0.1:${cdpPort}`;
  browser = await launchChromium({ args: [`--remote-debugging-port=${cdpPort}`] });
  context = browser.contexts()[0] ?? await browser.newContext();
  await (await context.newPage()).goto('about:blank');
}, 60_000);
afterAll(async () => { await browser?.close(); fs.rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

/** What the host's /usr/local/bin points at; a test must leave it as it was. */
const binSnapshot = () => Object.fromEntries(fs.readdirSync('/usr/local/bin').map((name) => {
  try { return [name, fs.readlinkSync(path.join('/usr/local/bin', name))]; } catch { return [name, String(fs.statSync(path.join('/usr/local/bin', name)).mtimeMs)]; }
}));
const session = (value: string): SavedSession => ({ version: 1, capturedAt: 1, storage: [],
  cookies: [{ name: 'sid', value, domain: 'app.example.com', path: '/', secure: true, httpOnly: true }] });
const storedValue = async (vault: VaultItems, id: string) => JSON.parse((await vault.readSecret((await vault.get(id))!, 'session'))!).cookies[0].value;
/** The site rotated the session in the task's browser. */
const rotate = async (value: string) => {
  await context.clearCookies();
  await context.addCookies([{ name: 'sid', value, domain: 'app.example.com', path: '/', secure: true, httpOnly: true }]);
};

async function setup() {
  const store = await Store.create(':memory:');
  const broker = new CredentialBroker(new Vault(fs.mkdtempSync(path.join(dir, 'vault-'))));
  const vault = new VaultItems(store, broker, dir);
  const project = await store.createProject('Sessions');
  const task = async (title: string) => store.createTask({ projectId: project.id, title, workflow: 'just-do', workflowVersion: '1', params: { prompt: '' } });
  const item = await vault.save({ type: 'session', label: 'example.com (signed in)', domains: ['example.com'],
    secrets: { session: JSON.stringify(session('S1')) } });
  return { store, broker, vault, project, task, item };
}

describe('one task at a time', () => {
  it('lends the session to one live task and frees it when that task ends or lets the lease go stale', async () => {
    const { store, vault, item, task } = await setup();
    try {
      const a = await task('a'), b = await task('b');
      const exclusive = await vault.save({ id: item.id, type: 'session', exclusive: true });
      expect(exclusive.exclusive).toBe(true);
      expect(await acquireLease(store, 'org_personal', item, b.id)).toEqual({ granted: true });
      expect(await acquireLease(store, 'org_personal', item, a.id)).toEqual({ granted: true });

      expect(await acquireLease(store, 'org_personal', exclusive, a.id)).toEqual({ granted: true });
      expect(await acquireLease(store, 'org_personal', exclusive, a.id)).toEqual({ granted: true });
      expect(await acquireLease(store, 'org_personal', exclusive, b.id)).toMatchObject({ granted: false, heldBy: { taskId: a.id, title: 'a' } });
      // A day without a refresh, and the lease is free.
      expect(await acquireLease(store, 'org_personal', exclusive, b.id, Date.now() + LEASE_STALE_MS + 1)).toEqual({ granted: true });
      await store.saveView(b.id, { taskId: b.id, title: 'b', workflow: 'just-do', stage: 'done', status: 'done' } as any);
      expect(await acquireLease(store, 'org_personal', exclusive, a.id)).toEqual({ granted: true });
    } finally { await store.close(); }
  });
});

describe('settling a task\'s sessions', () => {
  it('refreshes what the browser rotated, keeps the stored copy otherwise, and lets go on release', async () => {
    const { store, broker, vault, item, task } = await setup();
    try {
      const a = await task('a'), b = await task('b');
      await vault.save({ id: item.id, type: 'session', exclusive: true });
      await recordHold(store, 'org_personal', a.id, item.id);
      expect(await acquireLease(store, 'org_personal', (await vault.get(item.id))!, a.id)).toEqual({ granted: true });
      const world = { handle: { id: a.id } } as any;
      const opened: string[][] = [];
      const openWorldPage = async (_w: unknown, domains: string[]) => { opened.push(domains); return openPage(devtools, { expectDomains: domains, anyPage: true }); };

      await rotate('S2');
      expect(await settleTaskSessions({ store, broker, taskId: a.id, world, release: false, openPage: openWorldPage }))
        .toEqual({ refreshed: [item.id], released: [] });
      expect(await storedValue(vault, item.id)).toBe('S2');
      expect(opened).toEqual([['example.com']]);
      // Signed out in the browser: the working copy stays.
      await context.clearCookies();
      expect((await settleTaskSessions({ store, broker, taskId: a.id, world, release: false, openPage: openWorldPage })).refreshed).toEqual([]);
      expect(await storedValue(vault, item.id)).toBe('S2');

      expect(await settleTaskSessions({ store, broker, taskId: a.id, release: true })).toEqual({ refreshed: [], released: [item.id] });
      expect(await acquireLease(store, 'org_personal', (await vault.get(item.id))!, b.id)).toEqual({ granted: true });
      // Nothing held, nothing opened.
      const lazy = vi.fn(async () => world);
      await settleTaskSessions({ store, broker, taskId: a.id, world: lazy, release: true, openPage: openWorldPage });
      expect(lazy).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });
});

describe('the activities that end turns and worlds', () => {
  it.each([
    ['cloud', { kind: 'e2b', version: 2, sealedProviderRef: 'sealed' }, true],
    ['local', { kind: 'memory' }, false],
  ] as const)('refresh a %s task\'s sessions after its turn, and let go when its world is destroyed', async (_name, shape, refreshed) => {
    vi.spyOn(connectionRuntime, 'prepareConnections').mockResolvedValue([]);
    // The world below runs on this host while shaped as a cloud sandbox, and
    // a sandbox's bootstrap links its managed Node into /usr/local/bin.
    vi.spyOn(remoteProcess, 'prewarmRemoteAgentHome').mockImplementation(() => {});
    const hostBin = binSnapshot();
    const home = fs.mkdtempSync(path.join(dir, 'home-'));
    vi.stubEnv('KARMAX_HOME', home);
    vi.stubEnv('KARMAX_AGENT_MIN_FREE_MB', '0');
    vi.stubEnv('KARMAX_AGENT_MAX_LOAD_FACTOR', '0');
    const { store, broker, vault, item, project, task } = await setup();
    const worlds = new WorldRegistry();
    const pages = vi.spyOn(worldFill, 'openWorldPage').mockImplementation(async (_w, opts) => {
      expect(opts).toMatchObject({ expectDomains: ['example.com'], cdpUrl: 'http://127.0.0.1:9222', anyPage: true });
      return openPage(devtools, { expectDomains: opts.expectDomains, anyPage: true });
    });
    const core = makeCoreActivities({ store, worlds, broker, profiles: new ProfileResolver(store, 'mock'),
      adapters: new Map([['mock', { provider: 'mock', runTurn: async () => {
        await rotate('S3');
        return { termination: { kind: 'success', status: 'mock.completed' }, output: 'done' };
      } }]]) } as any);
    const a = await task('a');
    await recordHold(store, 'org_personal', a.id, item.id);
    const handle = await core.createWorld({ taskId: a.id, projectId: project.id, kind: 'memory', base: 'main' });
    const world = await worlds.open(handle);
    const shaped = { ...handle, ...shape } as typeof handle;
    const open = vi.spyOn(worlds, 'open').mockResolvedValue(Object.assign(Object.create(Object.getPrototypeOf(world)), world, { handle: shaped }));
    try {
      await core.runAgentTurn({ taskId: a.id, role: 'do', worldHandle: shaped, messages: [],
        task: { projectId: project.id, title: a.title, prompt: '', project: {}, workflow: 'just-do' } as any });
      expect(await storedValue(vault, item.id)).toBe(refreshed ? 'S3' : 'S1');
      expect(pages).toHaveBeenCalledTimes(refreshed ? 1 : 0);
    } finally {
      open.mockRestore();
      await core.destroyWorld(handle);
    }
    expect(await store.kvGet(`vault:session-holds:${a.id}`)).toBeUndefined();
    expect(binSnapshot()).toEqual(hostBin);
    await store.close();
  });
});

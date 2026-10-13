import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bootHarness } from './helpers/harness.js';
import { liveEnabled } from './helpers/live-gate.js';
import { MockAdapter } from '../src/agent/mock.js';
import { FlyDriver } from '../src/world/fly.js';
import { HetznerDriver } from '../src/world/hetzner.js';
import { VmWorldProvider, type VmDriver } from '../src/world/vm/provider.js';
import { ProjectEnvironment } from '../src/store/project-environment.js';
import type { ResolvedWorldProviderConnection } from '../src/world/connections.js';
import type { World, WorldHandle } from '../src/world/types.js';

/**
 * A whole task on a Fly.io or Hetzner computer, as tavya.io runs one (the VM
 * twin of e2b-workflow-live). pramana#39, the first production Hetzner task,
 * never got a world: provisioning stock Debian failed. This drives a task
 * through the hosted lifecycle on the real control plane with setup commands
 * like pramana's — apt packages outside the volume and `pip install` outside a
 * virtualenv, as projects written for E2B do — and checks them in every turn:
 * the world is made (provisioning the machine when no image or snapshot has
 * it yet), setup runs, the agent works, the world parks at Review, a follow-up
 * wakes it with its files and its setup intact (on Hetzner the slow way: a new
 * server on the same volume, whose root disk lacks setup's packages until it
 * replays), and Done deletes everything.
 *
 * Opt in with KARMAX_RUN_LIVE=1 and HCLOUD_TOKEN and/or FLY_API_TOKEN (a Fly
 * organization with a payment method: its free trial stops machines at 300 s).
 * A deterministic model; real Temporal; about $0.05 of compute per provider.
 * Hetzner boots its provisioned snapshot if the project has one, else
 * provisions from stock Debian as a project's first world does.
 */
const providers = [
  { kind: 'hetzner', name: 'Hetzner', apiKey: process.env.HCLOUD_TOKEN, driver: (): VmDriver => new HetznerDriver(),
    // KARMAX_HETZNER_IMAGE=debian-12: provision from stock even when the project has a snapshot.
    config: { region: process.env.KARMAX_HETZNER_LOCATION, image: process.env.KARMAX_HETZNER_IMAGE } },
  { kind: 'fly', name: 'Fly.io', apiKey: process.env.FLY_API_TOKEN, driver: (): VmDriver => new FlyDriver(),
    config: { region: process.env.KARMAX_FLY_REGION, organization: process.env.KARMAX_FLY_ORG } },
];
const SETUP = [
  // pramana's own first two setup commands, the package installed from PyPI instead of its checkout.
  'S=$(command -v sudo >/dev/null 2>&1 && echo sudo); $S apt-get update -qq && $S apt-get install -y -qq tesseract-ocr poppler-utils',
  'pip install -q pypdf rapidfuzz',
];
const BOOT = ['date +%s >> "$HOME/vm-boots.log"'];
// Prints only `boots N` when setup's tools are all there.
const CHECK = 'for c in tesseract pdftotext; do command -v $c > /dev/null || echo "missing $c"; done; '
  + 'python -c "import pypdf, rapidfuzz" 2>&1 | tail -1; echo "boots $(wc -l < "$HOME/vm-boots.log")"';

describe.each(providers)('a live $name task end to end', ({ kind, name, apiKey, driver, config }) => {
  it.skipIf(!liveEnabled() || !apiKey)('makes its world, runs setup and the agent, parks at Review, wakes on a follow-up with its files and setup, and deletes it at Done', async () => {
    const previousHome = process.env.KARMAX_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-live-vm-workflow-'));
    process.env.KARMAX_HOME = home; // a home label no production sweep owns, and only this run's machines
    const connection: ResolvedWorldProviderConnection = { provider: kind, apiKey: apiKey!, config };
    const provider = new VmWorldProvider(driver(), async () => connection);
    const mock = new MockAdapter();
    const worlds: World[] = [];
    // What each turn found in its world (asserted outside the turn, which would only fail and retry).
    const checks: string[] = [];
    const results: string[] = [];
    const h = await bootHarness('mock', { provider: 'mock', async runTurn(input, ctx) {
      worlds.push(input.world);
      expect(input.world.handle.kind).toBe(kind);
      results.push(await input.world.readFile('result.txt').catch((error) => `unreadable: ${error}`));
      // Setup's apt packages and pip modules are there in every turn, whatever the machine went through.
      const check = await input.world.exec('bash', ['-lc', CHECK]).catch((error) => ({ stdout: `exec failed: ${error?.stack ?? error}`, stderr: '' }));
      checks.push(`${check.stdout}${check.stderr}`.trim());
      return mock.runTurn(input, ctx);
    } }, { checkpoints: true });
    h.worlds.register(provider);
    // Hetzner: park straight to a deleted server, so the wake is a new server on the same volume.
    if (kind === 'hetzner') process.env.KARMAX_HETZNER_PARK_GRACE = '0';
    let taskId: string | undefined;
    let token: string | undefined;
    const started = Date.now();
    const at: Record<string, number> = {};
    try {
      const project = (await h.store.createProject(`${name} live workflow`, { worldProvider: kind, repos: [] }));
      await new ProjectEnvironment(h.store).setSpec(project.id, { setup: SETUP, boot: BOOT });
      token = (await h.tokens.mintPrincipal('user:live', ['*'], project.id)).token;
      const task = await h.api.createTask(token, { projectId: project.id, title: `${name} live workflow`, workflow: 'just-do',
        prompt: `@write result.txt ::${name} task complete\n@run test -f result.txt`,
        params: { 'agent:do': { provider: 'mock' }, computer: { provider: kind, diskGb: 20 } } });
      taskId = task.id;
      const handle = h.client.workflow.getHandle(task.id);
      const view = async () => (await handle.query<any>('view'));
      const ended = handle.result().then(() => { throw new Error('Task ended early'); });
      const trail = async () => (await h.store.eventsSince(task.id, 0))
        .filter((event) => !event.type.startsWith('agent.output'))
        .map((event) => `${event.type}${/warning|fail|error/.test(event.type) ? ` ${JSON.stringify(event.payload).slice(0, 400)}` : ''}`)
        .slice(-40).join(', ');
      const until = (what: string, check: () => Promise<boolean>, timeout = 30 * 60_000) => Promise.race([ended,
        expect.poll(check, { timeout, interval: 3000, message: what }).toBe(true)
          .catch(async (error) => { throw new Error(`${error.message}; events: ${await trail()}`); })])
        .then(() => { at[what] = Math.round((Date.now() - started) / 1000); });

      await until('first Review', async () => (await view()).stage === 'review');
      expect(checks[0]).toBe('boots 1');
      expect(await h.store.eventsOfType(task.id, 'world.warning')).toEqual([]);
      await until('world parked', async () => (await h.store.eventsOfType(task.id, 'world.parked')).length > 0, 10 * 60_000);
      expect(await h.store.eventsOfType(task.id, 'checkpoint.warning')).toEqual([]);
      expect(await provider.probe(worlds[0]!.handle as WorldHandle)).toBe('parked');

      await h.api.signalTask(token, task.id, 'followUp', '@write second.txt ::resumed\n@run test -f second.txt');
      await until('resumed turn', async () => checks.length === 2);
      // The machine restarted: its boot hook ran again (and on Hetzner setup too, on the new server).
      expect(checks[1], await trail()).toBe('boots 2');
      expect(results[1]).toBe(`${name} task complete`);
      await until('second Review', async () => (await view()).stage === 'review' && (await view()).status === 'waiting');

      await handle.signal('confirm');
      expect((await handle.result() as any).stage).toBe('done');
      at.done = Math.round((Date.now() - started) / 1000);
      await expect.poll(() => provider.probe(worlds[0]!.handle as WorldHandle), { timeout: 5 * 60_000, interval: 5000 }).toBe('missing');
      expect(JSON.stringify(await handle.fetchHistory())).not.toContain(apiKey);
      console.log(`VM-WORKFLOW-LIVE ${JSON.stringify({ provider: name, secondsSinceStart: at })}`);
    } finally {
      delete process.env.KARMAX_HETZNER_PARK_GRACE;
      if (taskId && token) await h.api.signalTask(token, taskId, 'cancel').catch(() => undefined);
      try { await h.stop(); }
      finally {
        // Teardown failures must not leave a billable live-test machine or volume behind.
        for (const entry of await provider.listSandboxes().catch(() => [])) await entry.destroy().catch(() => undefined);
        if (previousHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = previousHome;
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
  }, 75 * 60_000);
});

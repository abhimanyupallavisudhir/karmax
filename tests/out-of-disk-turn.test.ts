import { describe, expect, it } from 'vitest';
import { makeCoreActivities } from '../src/activities/core.js';
import { ProfileResolver } from '../src/agent/profiles.js';
import { Store } from '../src/store/db.js';
import { WorldRegistry } from '../src/world/registry.js';

const GB = 2 ** 20;
/** What the in-world disk guard prints (src/agent/disk-guard.sh). */
const usage = (usedGb: number, totalGb: number, ballast = 'present', beforeGb?: number) =>
  `KARMAX_USAGE disk_total_kb=${totalGb * GB} disk_used_kb=${usedGb * GB} disk_avail_kb=${(totalGb - usedGb) * GB} `
  + `disk_avail_before_kb=${(beforeGb ?? totalGb - usedGb) * GB} mem_total_kb=2097152 mem_avail_kb=1048576 ballast=${ballast} ballast_kb=524288\n`;

/** A cloud world whose disk reads `disk()`; turns fail or succeed as `run` says. */
async function harness(disk: () => string, run: (input: any) => unknown) {
  const store = await Store.create(':memory:');
  // org_personal's E2B account allows 29 GB of disk.
  await store.upsertWorldProviderConnection({ organizationId: 'org_personal', provider: 'e2b', credentialHandle: 'h', config: {} });
  await store.setWorldProviderConnectionLimits('org_personal', 'e2b', { diskGb: 29, checkedAt: 1 });
  const commands: string[] = [];
  const world = {
    handle: { version: 2, kind: 'e2b', id: 'disk-task', root: '/home/user/karmax', branch: 'tavya/disk-task', base: 'main',
      meta: { computer: { cpu: 2, memoryMb: 2048 } } },
    async exec(cmd: string, args: string[]) {
      if (cmd === 'sh' && args[1] === '') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'sh' && args[2] === 'disk-guard') {
        commands.push(args[3]!);
        return { code: 0, stdout: args[3] === 'check' ? disk() : 'P 8808038 /home/user/karmax/data/pramana.db.tmp\n', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async writeFile() {}, async readFile() { return ''; }, async listFiles() { return []; }, async destroy() {},
    async diagnose() { return undefined; },
  };
  const worlds = new WorldRegistry();
  worlds.register({ kind: 'e2b', capabilities: { remote: true }, async create() { throw new Error('unused'); },
    async open() { return world; }, async destroy() {} } as any);
  const adapters = new Map([['mock', { provider: 'mock', runTurn: run }]]) as any;
  const core = makeCoreActivities({ store, worlds, adapters, profiles: new ProfileResolver(store, 'mock') });
  const turn = (text = 'build the database') => core.runAgentTurn({
    taskId: 'disk-task', role: 'do', worldHandle: world.handle,
    messages: [{ id: 'm0', role: 'user', text, ts: 0 }],
    task: { taskId: 'disk-task', projectId: 'project', title: 'Rebuild', prompt: text, project: {}, workflow: 'software-dev' },
  } as any);
  return { store, turn, commands, close: async () => { await new Promise((resolve) => setTimeout(resolve, 100)); await store.close(); } };
}

describe('out of disk', () => {
  it('classifies a turn that failed writing to a full disk as disk-full, never a code bug', async () => {
    const { turn, store, close } = await harness(() => usage(22, 22, 'released', 0), async () => {
      throw new Error('Claude Code process exited with code 1: ENOSPC: no space left on device, write');
    });
    try {
      const error = await turn().then(() => undefined, (caught) => caught);
      expect(error).toMatchObject({ type: 'world-disk-full', nonRetryable: true });
      expect(error.message).toMatch(/^Out of disk: this task's computer filled its 22 GB disk, so its agent stopped\. Bigger disk \(up to 29 GB\) fixes it/);
      expect(JSON.parse((await store.kvGet('world-usage:disk-task'))!)).toMatchObject({ disk: { usedMb: 22 * 1024, totalMb: 22 * 1024 } });
    } finally { await close(); }
  });

  // pramana#3, W7 and W2: with 0 bytes free the harness could not start (exit 127).
  it('recognizes a harness that could not start on a full disk, whatever it said', async () => {
    const { turn, close } = await harness(() => usage(22, 22, 'released', 0), async () => {
      throw new Error('Claude Code process exited with code 127');
    });
    try {
      expect(await turn().then(() => undefined, (caught) => caught)).toMatchObject({ type: 'world-disk-full' });
    } finally { await close(); }
  });

  it('leaves an ordinary failure alone when the disk has room', async () => {
    const { turn, close } = await harness(() => usage(10, 22), async () => { throw new Error('Claude Code process exited with code 1'); });
    try {
      expect(await turn().then(() => undefined, (caught) => caught)).toMatchObject({ type: 'agent-error' });
    } finally { await close(); }
  });

  it('tells the agent, when it resumes, that the disk was full and where the space went', async () => {
    let fail = true;
    const prompts: string[] = [];
    const { turn, close } = await harness(() => (fail ? usage(22, 22, 'released', 0) : usage(21, 22, 'missing')), async (input) => {
      prompts.push(input.messages.at(-1).text);
      if (fail) throw new Error('database or disk is full');
      return { termination: { kind: 'success', status: 'end_turn' }, output: 'ok', session: 's1' };
    });
    try {
      await turn().catch(() => undefined);
      fail = false;
      await turn('carry on');
      const told = prompts.at(-1)!;
      expect(told).toMatch(/^carry on\n\n\[tavya disk\] Disk 21 of 22 GB used \(95%\)\. Your last turn stopped because the disk was full\./);
      expect(told).toContain('platform_request(POST, "/api/tasks/disk-task/bigger-disk", {"diskGb": 29})');
      expect(told).toContain('8.4 GB /home/user/karmax/data/pramana.db.tmp');
    } finally { await close(); }
  });

  it('tells the agent once when its disk passes 90%, and when the reserve had to go', async () => {
    let reading = usage(20, 22);
    const prompts: string[] = [];
    const { turn, close } = await harness(() => reading, async (input) => {
      prompts.push(input.messages.at(-1).text);
      return { termination: { kind: 'success', status: 'end_turn' }, output: 'ok', session: 's1' };
    });
    try {
      await turn('first');
      expect(prompts[0]).toContain('[tavya disk] Disk 20 of 22 GB used (91%).');
      await turn('second');
      expect(prompts[1]).toBe('second');
      reading = usage(21.9, 22, 'released', 0.05);
      await turn('third');
      expect(prompts[2]).toMatch(/512 MB reserve kept for starting you was deleted/);
    } finally { await close(); }
  });
});

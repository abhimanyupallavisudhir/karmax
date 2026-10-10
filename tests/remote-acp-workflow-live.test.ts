import { describe, expect, it } from 'vitest';
import { bootHarness } from './helpers/harness.js';
import { liveEnabled } from './helpers/live-gate.js';
import { apiKeyEnv } from '../src/agent/provider-registry.js';
import { DaytonaWorldProvider } from '../src/world/daytona.js';
import { E2BWorldProvider } from '../src/world/e2b.js';
import type { WorldProvider } from '../src/world/types.js';

/**
 * A real OpenCode task in a cloud world, driven through the platform as the
 * console drives it (task #526): the workflow leases the credential, the
 * activity prewarms the sandbox and runs the ACP adapter there, the agent
 * writes a file and signals completion through karmax_control, the task waits
 * at Review (the world parks), and a follow-up resumes the same native session.
 *
 * Opt in with KARMAX_RUN_LIVE=1, the model vendor's metered key
 * (ANTHROPIC_API_KEY by default, or as KARMAX_LIVE_OPENCODE_MODEL names it; never
 * a subscription login) and DAYTONA_API_KEY and/or E2B_API_KEY. Two
 * Haiku turns and one small sandbox per provider, deleted at the end.
 */
const model = process.env.KARMAX_LIVE_OPENCODE_MODEL ?? 'anthropic/claude-haiku-4-5';
const keyName = apiKeyEnv(model.split('/')[0]!);

const providers: Array<{ name: string; enabled: boolean; make: () => WorldProvider }> = [
  { name: 'daytona', enabled: !!process.env.DAYTONA_API_KEY, make: () => new DaytonaWorldProvider() },
  { name: 'e2b', enabled: !!process.env.E2B_API_KEY, make: () => new E2BWorldProvider() },
];

describe.each(providers)('OpenCode task end to end in $name', ({ name, enabled, make }) => {
  it.skipIf(!liveEnabled() || !enabled || !process.env[keyName])('works, waits at Review, and continues its session on a follow-up', async () => {
    const provider = make();
    const h = await bootHarness('opencode', undefined, { checkpoints: true });
    h.worlds.register(provider as any);
    let taskId: string | undefined;
    let token: string | undefined;
    try {
      const project = (await h.store.createProject(`OpenCode live ${name}`, { worldProvider: name, repos: [] }));
      token = (await h.tokens.mintPrincipal('user:live', ['*'], project.id)).token;
      const task = await h.api.createTask(token, { projectId: project.id, title: `OpenCode in ${name}`, workflow: 'just-do',
        prompt: 'Create a file named result.txt in the current directory containing exactly the text: opencode remote ok. '
          + 'Then call the karmax_control signal_completion tool with a one-line summary.',
        params: { 'agent:do': { provider: 'opencode', model } } });
      taskId = task.id;
      const handle = h.client.workflow.getHandle(task.id);
      const view = async () => (await handle.query<any>('view'));
      const ended = handle.result().then(() => { throw new Error('Task ended early'); });
      const trail = async () => (await h.store.eventsSince(task.id, 0)).map((event) => `${event.type}${
        event.type === 'turn.result' || event.type.includes('failed') ? ` ${JSON.stringify(event.payload).slice(0, 400)}` : ''}`)
        .filter((type) => !type.startsWith('agent.output')).slice(-40).join(', ');
      const until = (what: string, check: () => Promise<boolean>) => Promise.race([ended,
        expect.poll(check, { timeout: 600_000, interval: 3000, message: what }).toBe(true)
          .catch(async (error) => { throw new Error(`${error.message}; events: ${await trail()}`); })]);

      await until('first Review', async () => (await view()).stage === 'review');
      const session = await h.store.kvGet(`session:${task.id}:do`);
      expect(session).toMatch(/^ses_/);
      const world = await h.worlds.open((await h.store.currentWorld(task.id)) as any);
      expect((await world.readFile('result.txt')).trim()).toBe('opencode remote ok');
      // signal_completion reached the activity over the sandbox PTY.
      expect((await h.store.eventsOfType(task.id, 'turn.result')).map((event) => event.payload.completed)).toEqual([true]);

      await h.api.signalTask(token, task.id, 'followUp',
        'What exact text did you write into result.txt? Append a second line to it with exactly that same text, then call signal_completion.');
      await until('second Review', async () => {
        const v = await view();
        return v.stage === 'review' && v.status === 'waiting' && (await h.store.eventsOfType(task.id, 'turn.result')).length >= 2;
      });
      // The same native session continued, so the agent remembered its first turn.
      expect(await h.store.kvGet(`session:${task.id}:do`)).toBe(session);
      const resumed = await h.worlds.open((await h.store.currentWorld(task.id)) as any);
      expect((await resumed.readFile('result.txt')).trim().split('\n')).toEqual(['opencode remote ok', 'opencode remote ok']);
      const failures = (await h.store.eventsOfType(task.id, 'agent.activity'))
        .filter((event) => event.payload.phase === 'failed' && String(event.payload.id).startsWith('acp-'));
      expect(failures).toEqual([]);
      await handle.signal('confirm');
      expect((await handle.result() as any).stage).toBe('done');
      expect(JSON.stringify(await handle.fetchHistory())).not.toContain(process.env[keyName]);
    } finally {
      if (taskId && token) await h.api.signalTask(token, taskId, 'cancel').catch(() => undefined);
      try { await h.stop(); }
      finally {
        for (const entry of await provider.listSandboxes?.() ?? []) if (entry.taskId === taskId) await entry.destroy();
      }
    }
  }, 1_500_000);
});

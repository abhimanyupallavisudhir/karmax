import { describe, expect, it } from 'vitest';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { RemoteSpawnedProcess } from '../src/agent/remote-process.js';
import type { World, WorldPtyTermination } from '../src/world/types.js';

/**
 * pramana#137 (2026-11-09): the machine under a working agent was stopped, and
 * its turn then showed Working for six hours, answering nothing; Stop could
 * not end it either. The world reported the agent's process as lost, which
 * `RemoteSpawnedProcess` passed on as an exit with neither a code nor a
 * signal. A real child process never ends that way, and the Agent SDK (0.3.319)
 * has no branch for it: once the output is read it waits for an `exit` event
 * that has already been emitted, so its message stream never ends, not even
 * when aborted.
 *
 * These run the real SDK over a process that speaks just enough of the
 * harness's protocol to finish a turn.
 */
function lostAgent(ending: WorldPtyTermination | undefined, lostAfterMs = 100) {
  let out!: (chunk: string) => void;
  let exit!: (code: number | null, termination?: WorldPtyTermination) => void;
  const say = (message: Record<string, unknown>) => out(`${JSON.stringify(message)}\n`);
  const world = {
    handle: { id: 'task_lost', root: '/workspace' },
    async openPty() {
      return {
        onData(listener: typeof out) { out = listener; queueMicrotask(() => out('\x1eKARMAX_AGENT_READY\x1e\n')); return () => {}; },
        onExit(listener: typeof exit) { exit = listener; return () => {}; },
        async write(data: string) {
          for (const line of data.split('\n').filter(Boolean)) {
            let frame: any;
            try { frame = JSON.parse(line); } catch { continue; }
            if (frame.type === 'control_request')
              say({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id, response: {} } });
            if (frame.type !== 'user') continue;
            say({ type: 'system', subtype: 'init', session_id: 'sess-lost', mcp_servers: [] });
            say({ type: 'assistant', session_id: 'sess-lost', message: { role: 'assistant', content: [{ type: 'text', text: 'The site is back up.' }] } });
            say({ type: 'result', subtype: 'success', is_error: false, session_id: 'sess-lost', num_turns: 1, result: 'The site is back up.' });
            // The machine stops: the world can no longer say how the process ended.
            setTimeout(() => exit(null, ending), lostAfterMs);
          }
        },
        async resize() {}, async close() {},
      };
    },
    async exec() { return { code: 0, stdout: '', stderr: '' }; },
  } as unknown as World;
  let child: RemoteSpawnedProcess | undefined;
  const abortController = new AbortController();
  async function* prompt() {
    yield { type: 'user', message: { role: 'user', content: 'is the site up?' }, parent_tool_use_id: null, session_id: '' };
    await new Promise<void>((resolve) => abortController.signal.addEventListener('abort', () => resolve(), { once: true }));
  }
  const stream = query({ prompt: prompt() as any, options: { abortController,
    spawnClaudeCodeProcess: (spawned: { signal: AbortSignal }) => (child = new RemoteSpawnedProcess(world, 'agent', '/workspace', {}, spawned.signal)) as any } });
  const types: string[] = [];
  const ended = (async () => {
    try { for await (const message of stream) types.push(message.type); return 'ended'; }
    catch (error) { return `threw: ${error instanceof Error ? error.message : String(error)}`; }
  })();
  const outcome = Promise.race([ended, new Promise<string>((resolve) => setTimeout(() => resolve('never ended'), 5000))])
    .finally(() => abortController.abort());
  return { outcome, types, lost: () => child?.lost };
}

describe('the Agent SDK over an agent whose sandbox is lost', () => {
  it('ends its stream with a failure, so the turn can be retried', async () => {
    const run = lostAgent({ lost: new Error('the connection to the VM kept dropping; the process may still be running there') });
    expect(await run.outcome).toMatch(/^threw: .*SIGHUP/);
    expect(run.types).toEqual(['system', 'assistant', 'result']);
    expect(run.lost()?.message).toMatch(/^lost the connection to the agent in the sandbox/);
  }, 15_000);

  it('does the same when the world says nothing about how the process ended', async () => {
    const run = lostAgent(undefined);
    expect(await run.outcome).toMatch(/^threw: .*SIGHUP/);
    expect(run.lost()?.message).toMatch(/ended without an exit status/);
  }, 15_000);
});

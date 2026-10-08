import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AcpAdapter } from '../src/agent/acp.js';
import { hostAcpSessionFile, validAcpExport } from '../src/agent/remote-acp.js';
import { prewarmRemoteAgentHome } from '../src/agent/remote-process.js';
import { prepareConnections } from '../src/mcp/connections/runtime.js';
import { DaytonaWorldProvider } from '../src/world/daytona.js';
import { E2BWorldProvider } from '../src/world/e2b.js';
import type { World } from '../src/world/types.js';
import { liveEnabled } from './helpers/live-gate.js';

/**
 * OpenCode in real cloud worlds (remote-acp.ts), end to end through the ACP
 * adapter: the pinned `opencode-ai` installed in the sandbox, the relay on the
 * provider PTY, a session/new, a session/prompt over 128 KiB (Daytona closes a
 * PTY on any input frame over 64 KiB, task #514) with a system prompt over
 * 128 KiB beside it, a karmax_control tool call made by the model and served
 * by this process, and the session continued after the sandbox lost it.
 *
 * Opt in with KARMAX_RUN_LIVE=1, E2B_API_KEY and/or DAYTONA_API_KEY, and
 * ANTHROPIC_API_KEY (a metered key: never a subscription login, whose refresh
 * tokens are single-use). Each provider spends one sandbox, deleted at the
 * end, and about 0.3 USD of Claude Haiku.
 */
const model = process.env.KARMAX_LIVE_OPENCODE_MODEL ?? 'anthropic/claude-haiku-4-5';
const providers = [
  { name: 'E2B', enabled: !!process.env.E2B_API_KEY, create: (taskId: string) => new E2BWorldProvider().create({ taskId, base: 'main' }) },
  { name: 'Daytona', enabled: !!process.env.DAYTONA_API_KEY, create: (taskId: string) => new DaytonaWorldProvider().create({ taskId, base: 'main',
    network: { unrestricted: true }, resources: { cpu: 2, memoryMb: 2048, gpu: 0 } }) },
];

describe.each(providers)('OpenCode in a live $name world', ({ name, enabled, create }) => {
  const live = liveEnabled() && enabled && !!process.env.ANTHROPIC_API_KEY;
  let world: World;
  let home: string;
  let previousHome: string | undefined;
  let session: string;
  const marker = `LIVE-${name.toUpperCase()}-${Date.now().toString(36)}`;

  async function turn(text: string, opts: { session?: string; systemPrompt?: string; reviews?: any[]; activities?: any[];
    agentMcp?: any[]; secretEnv?: Record<string, string> } = {}) {
    const output: string[] = [];
    let started: string | undefined;
    // As core.ts does: the sandbox is prepared beside prompt preparation.
    prewarmRemoteAgentHome(world, 'opencode', undefined, opts.session);
    const result = await new AcpAdapter('opencode').runTurn({
      profile: { id: 'live', name: 'Live', provider: 'opencode', model, role: 'do' },
      world,
      messages: [{ id: 'm', role: 'user', text, ts: Date.now() }],
      systemPrompt: opts.systemPrompt ?? 'You are a careful assistant. Follow the user exactly.',
      role: 'do',
      resolvedAuth: { apiKey: process.env.ANTHROPIC_API_KEY },
      extraEnv: { KARMAX_TOKEN: 'live-test-token' },
      ...(opts.session ? { session: opts.session } : {}),
      ...(opts.agentMcp ? { agentMcp: opts.agentMcp } : {}),
      ...(opts.secretEnv ? { secretEnv: opts.secretEnv } : {}),
    } as any, {
      emit(value: string) { output.push(value); },
      emitActivity(activity: any) { opts.activities?.push(activity); },
      onSession(id: string) { started = id; },
      heartbeat() {},
      createReviewInfo(info: any) { opts.reviews?.push(info); },
    } as any);
    return { result, session: started! };
  }

  beforeAll(async () => {
    if (!live) return;
    previousHome = process.env.KARMAX_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-live-acp-'));
    process.env.KARMAX_HOME = home;
    world = await create(`live-opencode-${name.toLowerCase()}-${Date.now()}`);
  }, 600_000);

  afterAll(async () => {
    if (!live) return;
    await world?.destroy().catch(() => undefined);
    if (previousHome === undefined) delete process.env.KARMAX_HOME; else process.env.KARMAX_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }, 300_000);

  it.skipIf(!live)('runs a real turn: handshake, session/new, a >128 KiB prompt and system prompt, and a control tool round trip', async () => {
    const systemPrompt = 'You are a careful assistant. Follow the user exactly.\n'
      + 'Background notes for the remote OpenCode transport test (ignore their content).\n'.repeat(1700);
    const filler = 'Context line for the remote ACP framing test; it carries no instructions.\n'.repeat(1800);
    expect(Buffer.byteLength(systemPrompt)).toBeGreaterThan(128 * 1024);
    expect(Buffer.byteLength(filler)).toBeGreaterThan(128 * 1024);
    const reviews: any[] = [];
    const activities: any[] = [];
    const { result, session: id } = await turn(`${filler}\nNow do exactly this: call the tool karmax_control_create_review_info `
      + `once, with the argument caption set to "${marker}". After it returns, reply with the single word DONE.`,
    { systemPrompt, reviews, activities });
    session = id;
    if (!reviews.length) console.log(JSON.stringify({ output: result.output, activities: activities.slice(-20) }, null, 1),
      (await world.exec('bash', ['-c', `tail -n 80 ${world.handle.root}/.karmax-injection/agent/opencode/api/data/opencode/log/*.log; tail -c 3000 ${world.handle.root}/.karmax-injection/agent/opencode/api/agent-stderr.log`])).stdout);
    expect(result.termination).toEqual({ kind: 'success', status: 'end_turn' });
    expect(reviews.map((review) => review.caption)).toContain(marker);
    expect(result.output).toMatch(/DONE/);
    // The session is on the host for a retry or a restored world.
    const stored = fs.readFileSync(hostAcpSessionFile('opencode', session));
    expect(validAcpExport(stored, session)).toBe(true);
    expect(activities.filter((activity) => activity.id === 'acp-session-export')).toEqual([]);
  }, 900_000);

  it.skipIf(!live)('continues the same native session after the sandbox lost it', async () => {
    expect(session).toBeTruthy();
    // A world restored from a checkpoint has no `.karmax-injection/`.
    const wiped = await world.exec('bash', ['-c', `rm -rf ${world.handle.root}/.karmax-injection/agent/opencode/api/data ${world.handle.root}/.karmax-injection/agent/opencode/api/karmax-sessions`]);
    expect(wiped.code).toBe(0);
    const { result, session: resumed } = await turn('What exact caption did you give the review a moment ago? Reply with only that text.', { session });
    expect(resumed).toBe(session);
    expect(result.output).toContain(marker);
  }, 900_000);

  it.skipIf(!live)('gives the agent the browser MCP and the work environment inside the sandbox', async () => {
    const cleanups: Array<() => Promise<void>> = [];
    try {
      // Exactly as core.ts prepares a task's selected connections.
      const agentMcp = await prepareConnections(undefined, world, ['browser:chrome-devtools'], 'live-project', 'live-task',
        (cleanup) => cleanups.push(cleanup));
      const title = `KX${Date.now().toString(36)}`;
      const secret = `work-${Date.now().toString(36)}`;
      const { result } = await turn('Do two things, then answer. 1) With your bash tool run exactly: echo "$KX_LIVE_WORK" '
        + `2) With the chrome-devtools tool new_page, open the URL data:text/html,<title>${title}</title>hello and read the page title. `
        + 'Answer with one line: the echoed text, a space, then the page title.', { agentMcp, secretEnv: { KX_LIVE_WORK: secret } });
      expect(result.output).toContain(secret);
      expect(result.output).toContain(title);
    } finally { for (const cleanup of cleanups) await cleanup().catch(() => undefined); }
  }, 900_000);
});

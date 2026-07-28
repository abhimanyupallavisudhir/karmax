import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorldRegistry } from '../src/world/registry.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { ClaudeAdapter } from '../src/agent/claude.js';
import { CodexAdapter } from '../src/agent/codex.js';
import { ConfigHomeManager, capturedToken } from '../src/autonomy/config-homes.js';
import { materializeFork } from '../src/agent/fork.js';
import { probeClaudeUsage } from '../src/agent/usage.js';
import { paths } from '../src/config/paths.js';
import type { PlatformToolContext } from '../src/agent/types.js';

/**
 * LIVE provider smoke tests — real models, real credentials. Each rail is gated on
 * its own credential being present + KARMAX_SKIP_LIVE!=1, so the hermetic suite
 * (and CI without creds) skips them. They spend a sliver of real quota. Run with:
 *   ANTHROPIC_API_KEY=… npx vitest run tests/live-providers.test.ts
 *   (or with a Claude Code / Codex subscription login present)
 */
const NOTLIVE = process.env.KARMAX_SKIP_LIVE === '1';

const ctx = (): PlatformToolContext => ({
  signalCompletion() {},
  createReviewInfo() {},
  createSubTask() {},
  addCheckout() { return Promise.resolve({ name: '', root: '', branch: '' }); },
  respondToSubTask() {},
  raiseToParent() {},
  waitForSubtasks() {},
  saveSkill() {},
  resolveDecision() {},
  confirmDecision() {},
  async requestSpend() { return { status: 'denied' as const }; },
  emit() {},
  emitActivity() {},
});

let worldsHome: string;
let worlds: WorldRegistry;
async function makeWorld(): Promise<any> {
  const w: any = await worlds.create('worktree', { taskId: `live-${Math.random().toString(36).slice(2, 8)}`, base: 'main' } as any);
  return worlds.open(w.handle);
}
const profile = (over: any = {}): any => ({ id: 'live', name: 'live', provider: 'claude', role: 'do', capabilities: [], maxTurns: 4, ...over });
const SYS = 'You are a terse test assistant. Do exactly what is asked, nothing more.';

beforeAll(() => {
  worldsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-live-worlds-'));
  worlds = new WorldRegistry();
  worlds.register(new WorktreeProvider(worldsHome));
});
afterAll(() => { try { fs.rmSync(worldsHome, { recursive: true, force: true }); } catch { /* ignore */ } });

// ── rail gates ──
const claudeKey = !NOTLIVE && ClaudeAdapter.hasApiKey();
const claudeSub = !NOTLIVE && ClaudeAdapter.hasAmbientLogin();
const codexKey = !NOTLIVE && CodexAdapter.hasApiKey();
const codexSub = !NOTLIVE && CodexAdapter.hasAmbientSubscription();
// Two+ logged-in Claude config-homes → login-switch test is possible.
const claudeHomes = (() => {
  try {
    return new ConfigHomeManager(paths().configHomes).list().filter((a) => a.provider === 'claude' && a.loggedIn);
  } catch { return []; }
})();
const canSwitch = !NOTLIVE && claudeHomes.length >= 2;

describe.skipIf(!claudeKey)('LIVE Claude — API key (Messages API)', () => {
  it('runs a turn and returns text', async () => {
    const r = await new ClaudeAdapter().runTurn(
      { profile: profile({ provider: 'claude' }), world: await makeWorld(), messages: [{ id: 'm', role: 'user', text: 'Reply with exactly: READY', ts: 0 }], systemPrompt: SYS, role: 'do', resolvedAuth: { apiKey: process.env.ANTHROPIC_API_KEY } } as any,
      ctx(),
    );
    expect(r.output.toUpperCase()).toContain('READY');
  }, 120_000);
});

describe.skipIf(!claudeSub)('LIVE Claude — subscription (Agent SDK)', () => {
  it('runs a turn on the ambient Claude Code login', async () => {
    const r = await new ClaudeAdapter().runTurn(
      { profile: profile({ provider: 'claude' }), world: await makeWorld(), messages: [{ id: 'm', role: 'user', text: 'Reply with exactly: READY', ts: 0 }], systemPrompt: SYS, role: 'do' } as any,
      ctx(),
    );
    expect(r.output.toUpperCase()).toContain('READY');
  }, 180_000);
});

describe.skipIf(!codexKey)('LIVE Codex — API key (Responses API)', () => {
  it('reaches the Responses API (text, or a billing/quota error if the key has no credits)', async () => {
    try {
      const r = await new CodexAdapter().runTurn(
        { profile: profile({ provider: 'codex', model: 'gpt-5.5' }), world: await makeWorld(), messages: [{ id: 'm', role: 'user', text: 'Reply with exactly: READY', ts: 0 }], systemPrompt: SYS, role: 'do', resolvedAuth: { apiKey: process.env.OPENAI_API_KEY } } as any,
        ctx(),
      );
      expect(r.output.toUpperCase()).toContain('READY');
    } catch (e) {
      // The wiring is verified if we actually reached OpenAI and got a proper
      // account-state rejection (this key has no credits). A code/transport bug
      // would look different (network error, 400 bad-request, auth failure).
      expect(String(e)).toMatch(/insufficient_quota|exceeded your current quota|billing|Responses API 429/i);
    }
  }, 120_000);
});

describe.skipIf(!codexSub)('LIVE Codex — subscription (app-server)', () => {
  it('runs a headless app-server turn on the subscription and returns text', async () => {
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    const r = await new CodexAdapter().runTurn(
      { profile: profile({ provider: 'codex', model: 'gpt-5.5' }), world: await makeWorld(), messages: [{ id: 'm', role: 'user', text: 'Reply with exactly the word READY and do not modify any files.', ts: 0 }], systemPrompt: SYS, role: 'do', resolvedAuth: { configHome: codexHome } } as any,
      ctx(),
    );
    expect(r.output.length).toBeGreaterThan(0);
    expect(r.session).toBeTruthy(); // a thread id we can resume
  }, 180_000);

  it('delivers a follow-up that lands mid-turn into the LIVE thread (turn/steer, SPEC §5.6)', async () => {
    const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
    let injected = false;
    const steerCtx: PlatformToolContext = {
      ...ctx(),
      // Deliver ONE follow-up on the first poll (index ≥ 1). While the turn runs the
      // adapter steers it into the live thread; if the window is missed it drives a
      // follow-on turn — either way the turn must report both messages delivered.
      async pullFollowUps(fromIndex: number) {
        if (!injected && fromIndex >= 1) { injected = true; return [{ id: 'f1', role: 'user', text: 'Acknowledge with the word GOT_IT.', ts: 1 }] as any; }
        return [];
      },
    };
    const r = await new CodexAdapter().runTurn(
      // A single long-running shell command gives a reliable in-flight window.
      { profile: profile({ provider: 'codex', model: 'gpt-5.5', effort: 'low' }), world: await makeWorld(), messages: [{ id: 'm', role: 'user', text: 'Run exactly the shell command `sleep 8` and nothing else, then reply DONE.', ts: 0 }], systemPrompt: SYS, role: 'do', resolvedAuth: { configHome: codexHome } } as any,
      steerCtx,
    );
    // The adapter consumed both the initial message and the mid-turn follow-up — proving
    // the app-server steer/inject path end-to-end against the live server.
    expect(r.delivered).toBe(2);
    expect(r.session).toBeTruthy();
  }, 180_000);
});

describe.skipIf(!canSwitch)('LIVE Claude — resume conversation under a SWITCHED login', () => {
  it('preserves context when the second turn runs under a different login (fresh session + msgs replay)', async () => {
    const [homeA, homeB] = claudeHomes;
    const world = await makeWorld();
    const a = new ClaudeAdapter();
    // Turn 1 under login A: plant a fact.
    const t1 = await a.runTurn(
      { profile: profile(), world, messages: [{ id: 'm1', role: 'user', text: 'The secret code word is BANANA. Reply with exactly: OK', ts: 0 }], systemPrompt: SYS, role: 'do', resolvedAuth: { configHome: homeA!.path, oauthToken: capturedToken(homeA!.path) } } as any,
      ctx(),
    );
    // Turn 2 under login B: session is DROPPED (login switched, §2.5), context carried
    // by replaying the conversation (msgs), not the provider session id.
    const t2 = await a.runTurn(
      {
        profile: profile(),
        world,
        messages: [
          { id: 'm1', role: 'user', text: 'The secret code word is BANANA. Reply with exactly: OK', ts: 0 },
          { id: 'a1', role: 'agent', text: t1.output, ts: 1 },
          { id: 'm2', role: 'user', text: 'What is the secret code word? Reply with just the word.', ts: 2 },
        ],
        systemPrompt: SYS,
        role: 'do',
        resolvedAuth: { configHome: homeB!.path, oauthToken: capturedToken(homeB!.path) }, // different login
      } as any,
      ctx(),
    );
    expect(t2.output.toUpperCase()).toContain('BANANA');
  }, 240_000);
});

// The fork-bug fix (SPEC §10.5): a NATIVE fork — materialize the source session into
// the fork's (home × world), run `--fork-session` — must give REAL continuity (recall
// the source conversation) and a NEW session id, without mutating the source. This is
// the codified version of the manual codeword-recall proof.
describe.skipIf(!claudeSub)('LIVE Claude — native fork of a prior session (SPEC §10.5)', () => {
  it('branches a NEW session that RECALLS the source conversation (not prompt-stuffing)', async () => {
    const a = new ClaudeAdapter();
    const home = path.join(os.homedir(), '.claude'); // ambient login home
    const codeword = 'ZQX' + Math.random().toString(36).slice(2, 8).toUpperCase();
    // Turn 1 (source) in world A: plant the codeword; capture the session id.
    const worldA = await makeWorld();
    const t1 = await a.runTurn(
      { profile: profile(), world: worldA, messages: [{ id: 'm1', role: 'user', text: `Remember this codeword, I'll ask later: ${codeword}. Reply with only: noted`, ts: 0 }], systemPrompt: SYS, role: 'do' } as any,
      ctx(),
    );
    expect(t1.session).toBeTruthy();
    // Fork into a FRESH world (new cwd): make the source session visible here, then run
    // with fork:true. If materialize fails the fork can't be native — fail loudly.
    const worldB = await makeWorld();
    expect(materializeFork({ provider: 'claude', session: t1.session!, forkHome: home, worldPath: worldB.handle.root, srcHome: home })).toBe(true);
    const t2 = await a.runTurn(
      { profile: profile(), world: worldB, messages: [{ id: 'm2', role: 'user', text: 'What codeword did I give you earlier? Reply with ONLY the codeword.', ts: 0 }], session: t1.session, fork: true, systemPrompt: SYS, role: 'do' } as any,
      ctx(),
    );
    expect(t2.output.toUpperCase()).toContain(codeword); // real continuity
    expect(t2.session).not.toBe(t1.session); // forked → a new session id, source untouched
  }, 300_000);
});

// Proactive quota (#6): `claude -p '/usage'` yields real numbers for a full-login
// credential (the ambient one). A setup-token login would report unavailable instead.
describe.skipIf(!claudeSub)('LIVE Claude — /usage polling', () => {
  it('returns real session/weekly usage for the ambient full-login credential (or a clean unavailable)', async () => {
    const r = await probeClaudeUsage({}); // ambient ~/.claude
    if (!r.ok) {
      expect(['setup-token', 'not-subscription', 'logged-out']).toContain(r.reason);
      return;
    }
    expect(typeof r.session?.pct === 'number' || typeof r.week?.pct === 'number').toBe(true);
    if (r.session) { expect(r.session.pct).toBeGreaterThanOrEqual(0); expect(r.session.pct).toBeLessThanOrEqual(100); }
  }, 60_000);
});

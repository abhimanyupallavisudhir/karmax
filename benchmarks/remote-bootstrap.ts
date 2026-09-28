/** Remote agent turn start-up without a sandbox or model (LT-1, AD-12, AD-13, LT-22).
 *
 * The "sandbox" is a local directory (tests/helpers/directory-sandbox.ts).
 * Every world operation pays a round trip and a bandwidth cost modelled on the
 * tavya.io E2B traces of 2026-09-22/23 (benchmarks/results/startup-*.json.gz:
 * a quiesce exec or verified listing ≈ 180 ms, Codex CLI start ≈ 1 s, account
 * read ≈ 0.7 s, a baked Chromium's launch smoke test ≈ 4 s of the 5.7 s
 * `tool.connection.prepare`), and a fake Codex app-server answers on the agent
 * PTY and appends to its rollout like the real one. Real karmax code runs
 * everything else: browser connection preparation (the default
 * `browser:chrome-devtools`), seeding, history reconciliation, tool migration,
 * MCP selection and the post-turn export. No sandbox, model or credit is used.
 *
 *   npx tsx benchmarks/remote-bootstrap.ts [turns=8] [growthKiB=512] [promptMs=0]
 *
 * Reports, per turn, turn start → `turn/start` (the model starts), the part
 * of it connection preparation took after the prompt was ready, and
 * `turn/start` → adapter return (the post-turn export), plus provider round
 * trips, sandbox commands before the model starts, bytes moved each way and
 * native CLI starts. With promptMs > 0 the turn first spends that long
 * preparing its prompt (the traces' wiki snapshot took 0.8–1.6 s), with the
 * sandbox bootstrap started beside it as runAgentTurn does. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexAdapter } from '../src/agent/codex.js';
import { prewarmRemoteAgentHome } from '../src/agent/remote-process.js';
import { prepareConnections } from '../src/mcp/connections/runtime.js';
import { TimingTrace, withTiming, type TimingRow } from '../src/timing/index.js';
import { directorySandbox, freshCodexHome, newMeter, stageBakedBrowser, stageRemoteRuntime,
  type SandboxLatency } from '../tests/helpers/directory-sandbox.js';

export const E2B_LATENCY: SandboxLatency = { roundTripMs: 180, bytesPerMs: 10_000, cliStartMs: 900, accountReadMs: 700, smokeMs: 4000 };
const TOOLS = ['browser:chrome-devtools'];

export interface TurnSample {
  turn: number; modelStartMs: number; connectionMs: number; exportMs: number; roundTrips: number; execsBeforeModel: number;
  uploadedKiB: number; downloadedKiB: number; cliStarts: number; historyKiB: number; spans: Record<string, number>;
}

export async function benchmarkRemoteBootstrap(turns = 8, growthKiB = 512, latency = E2B_LATENCY, promptMs = 0): Promise<TurnSample[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-bench-sandbox-'));
  const localHome = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-bench-home-'));
  const samples: TurnSample[] = [];
  try {
    stageRemoteRuntime(root);
    stageBakedBrowser(root, latency.smokeMs);
    freshCodexHome(localHome);
    fs.writeFileSync(path.join(localHome, 'config.toml'), 'model = "gpt-5.5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n');
    fs.mkdirSync(path.join(localHome, 'skills/review'), { recursive: true });
    fs.writeFileSync(path.join(localHome, 'skills/review/SKILL.md'), 'review skill\n');
    let session: string | undefined;
    for (let turn = 1; turn <= turns; turn++) {
      const meter = newMeter();
      const world = directorySandbox(root, meter, { latency, growth: growthKiB * 1024 });
      const rows: TimingRow[] = [];
      const started = performance.now();
      let connectionMs = 0;
      const result = await withTiming(new TimingTrace({ taskId: 'benchmark' }, (row) => { rows.push(row); }), async () => {
        // As runAgentTurn: the sandbox bootstrap starts beside prompt preparation,
        // then the turn's tools are prepared and the adapter runs.
        if (promptMs > 0) {
          prewarmRemoteAgentHome(world, 'codex', localHome, session, TOOLS);
          await new Promise((resolve) => setTimeout(resolve, promptMs));
        }
        const connecting = performance.now();
        const agentMcp = await prepareConnections(undefined, world, TOOLS, 'project', 'benchmark', () => {});
        connectionMs = performance.now() - connecting;
        return new CodexAdapter().runTurn({
          profile: { id: 'benchmark', name: 'codex', provider: 'codex', role: 'do', capabilities: [], mcpConnections: TOOLS },
          world, messages: [{ id: `m${turn}`, role: 'user', text: 'continue', ts: 0 }], systemPrompt: 'Do the task.',
          role: 'do', resolvedAuth: { configHome: localHome }, agentMcp, ...(session ? { session } : {}),
        } as any, { emit() {}, emitActivity() {}, platformRequest: async () => [] } as any);
      });
      const finished = performance.now();
      if (result.termination.kind !== 'success' || !meter.modelStartedAt) throw new Error(`turn ${turn} failed: ${JSON.stringify(result.termination)}`);
      session = result.session;
      const history = fs.readdirSync(path.join(localHome, 'sessions'), { recursive: true }).map(String)
        .filter((name) => name.endsWith(`${session}.jsonl`)).map((name) => fs.statSync(path.join(localHome, 'sessions', name)).size)[0] ?? 0;
      const spans: Record<string, number> = {};
      for (const row of rows) if (row.phase === 'end') spans[row.name] = Math.round((spans[row.name] ?? 0) + row.durationMs!);
      samples.push({ turn, modelStartMs: Math.round(meter.modelStartedAt - started), connectionMs: Math.round(connectionMs), exportMs: Math.round(finished - meter.modelStartedAt),
        roundTrips: meter.roundTrips, execsBeforeModel: meter.execsAtModelStart ?? 0, uploadedKiB: Math.round(meter.uploaded / 1024), downloadedKiB: Math.round(meter.downloaded / 1024),
        cliStarts: meter.cliStarts.length, historyKiB: Math.round(history / 1024), spans });
    }
    return samples;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(localHome, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [turns, growth, promptMs] = process.argv.slice(2).map(Number);
  const samples = await benchmarkRemoteBootstrap(turns || undefined, growth || undefined, E2B_LATENCY, promptMs || 0);
  console.table(samples.map((sample) => { const { spans: _, ...row } = sample; return row; }));
  if (process.env.KARMAX_BENCHMARK_SPANS) for (const sample of samples) console.log(sample.turn, JSON.stringify(sample.spans));
  const resumed = samples.slice(1).map((sample) => sample.modelStartMs).sort((a, b) => a - b);
  console.log(JSON.stringify({ latency: E2B_LATENCY, promptMs: promptMs || 0, firstTurnModelStartMs: samples[0]?.modelStartMs,
    resumedModelStartMedianMs: resumed[resumed.length >> 1], lastTurn: samples.at(-1) }));
}

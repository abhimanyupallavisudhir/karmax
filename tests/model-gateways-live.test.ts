// Live smoke test of model gateways (wiki features/model-gateways): the real
// Claude Code and Codex harnesses, driven by the real adapters in a local
// worktree world, against OpenRouter — directly (the OpenRouter rail) and
// through tavya's /api/model-gateway proxy (an operator gateway pointed at
// OpenRouter's Anthropic-compatible endpoint). Spends real OpenRouter credit,
// a few cents a run (Haiku 5.5 / GPT-6 Luna); stops once a run has spent
// KARMAX_LIVE_GATEWAY_BUDGET_USD (default 0.30), read from the key itself.
//
//   KARMAX_RUN_LIVE=1 OPENROUTER_KEY=sk-or-… npx vitest run tests/model-gateways-live.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ClaudeAdapter } from '../src/agent/claude.js';
import { CodexAdapter } from '../src/agent/codex.js';
import { WorktreeProvider } from '../src/world/worktree.js';
import { git, gitOrThrow, ensureIdentity } from '../src/world/git.js';
import { newId } from '../src/util/id.js';
import { Store } from '../src/store/db.js';
import { Vault } from '../src/autonomy/vault.js';
import { CredentialBroker } from '../src/autonomy/broker.js';
import { ConfigHomeManager } from '../src/autonomy/config-homes.js';
import { issueGatewayToken, openRouterTurnAuth, proxyTurnAuth, saveModelGateway } from '../src/agent/model-gateways.js';
import { proxyModelGateway } from '../src/gateway/model-gateway-proxy.js';
import type { PlatformToolContext, TurnInput } from '../src/agent/types.js';
import type { AgentProfile } from '../src/domain/types.js';
import { liveEnabled } from './helpers/live-gate.js';

const KEY = process.env.OPENROUTER_KEY ?? process.env.OPENROUTER_API_KEY;
const LIVE = liveEnabled() && !!KEY;
const BUDGET_USD = Number(process.env.KARMAX_LIVE_GATEWAY_BUDGET_USD ?? 0.3);

/** What the key has spent, all time (OpenRouter's own reading). */
async function keyUsage(): Promise<number> {
  const response = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${KEY}` } });
  return Number(((await response.json()) as any)?.data?.usage ?? NaN);
}

describe.skipIf(!LIVE)('model gateways, live against OpenRouter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karmax-gateway-live-'));
  const homes = new ConfigHomeManager(path.join(dir, 'homes'));
  let startUsd = 0;
  const spentSoFar = async () => (await keyUsage()) - startUsd;
  const report: string[] = [];

  beforeAll(async () => {
    delete process.env.KARMAX_OPENROUTER_API_URL;
    startUsd = await keyUsage();
  });
  afterAll(async () => {
    report.push(`total spent: $${(await spentSoFar()).toFixed(4)}`);
    console.log(`[model-gateways-live]\n${report.join('\n')}`);
    fs.appendFileSync(path.join(os.tmpdir(), 'model-gateways-live.txt'), `${new Date().toISOString()}\n${report.join('\n')}\n`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function world() {
    const repo = fs.mkdtempSync(path.join(dir, 'repo-'));
    await gitOrThrow(repo, ['init', '-q', '-b', 'main']);
    await ensureIdentity(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# live\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-q', '-m', 'init']);
    return new WorktreeProvider(path.join(dir, 'worlds')).create({ taskId: newId('task'), repo, base: 'main' });
  }

  function context(events: string[]): PlatformToolContext & { usage?: any } {
    const ctx: any = {
      openPr: () => {}, signalCompletion: () => {}, createReviewInfo: () => {}, createSubTask: () => {},
      addCheckout: async () => ({ name: '', root: '', branch: '' }), respondToSubTask: () => {}, raiseToParent: () => {},
      waitForSubtasks: () => {}, requestWait: () => {}, jobStarted: () => {}, saveSkill: () => {}, resolveDecision: () => {},
      confirmDecision: () => {}, requestSpend: async () => ({ status: 'denied' }), emit: () => {},
      emitActivity: (activity: any) => { if (activity?.phase === 'failed') events.push(`${activity.title}: ${activity.detail ?? ''}`); },
      reportUsage: (usage: any) => { ctx.usage = usage; },
    };
    return ctx;
  }

  const prompt = (file: string) => `Run the shell command \`uname -s\` and write exactly its output to ${file} in the working directory, then stop.`;

  async function turn(adapter: ClaudeAdapter | CodexAdapter, profile: AgentProfile, auth: TurnInput['resolvedAuth'], label: string) {
    if ((await spentSoFar()) > BUDGET_USD) throw new Error(`over the live budget of $${BUDGET_USD} before ${label}`);
    const w = await world();
    const events: string[] = [];
    const ctx = context(events);
    const before = await keyUsage();
    try {
      const result = await adapter.runTurn({ profile, world: w, role: 'do', systemPrompt: 'You are a headless coding agent. Follow the instruction exactly.',
        messages: [{ id: 'm1', role: 'user', ts: 0, text: prompt('result.txt') }], resolvedAuth: auth } as TurnInput, ctx);
      const file = path.join(w.handle.root, 'result.txt');
      const written = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : undefined;
      // OpenRouter books a moment after the response.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      report.push(`${label}: wrote ${JSON.stringify(written)}, usage ${JSON.stringify(ctx.usage ?? result.usage)}, key spent $${((await keyUsage()) - before).toFixed(4)}${events.length ? `, failed activities: ${events.join(' | ')}` : ''}`);
      return { written, usage: ctx.usage ?? result.usage, result };
    } finally { await w.destroy().catch(() => {}); }
  }

  const haiku: AgentProfile = { id: 'live', name: 'do', provider: 'claude', role: 'do', model: 'claude-haiku-5-5', capabilities: [] } as any;

  it('a. Claude Code through the OpenRouter rail', async () => {
    const auth = { configHome: homes.gatewayHome('claude', 'org_live_a'), gateway: openRouterTurnAuth('claude', 'anthropic/claude-haiku-5.5', KEY!) };
    const { written, usage } = await turn(new ClaudeAdapter(), haiku, auth, 'a. Claude Code → OpenRouter');
    expect(written).toBe('Linux');
    expect(usage?.outputTokens).toBeGreaterThan(0);
  }, 300_000);

  it('b. Claude Code through an operator gateway (OpenRouter) via tavya\'s proxy, booked as agent.cost', async () => {
    const store = await Store.create(':memory:');
    const broker = new CredentialBroker(new Vault(path.join(dir, 'vault')));
    const organization = await store.createOrganization({ name: 'Live', ownerUserId: 'owner' });
    const project = await store.createProject('Live', {}, organization.id);
    const task = await store.createTask({ projectId: project.id, title: 'Live', workflow: 'just-do', workflowVersion: '1.0.0', params: { prompt: 'x' } as any });
    const gateway = await saveModelGateway(store, broker, undefined, { name: 'OpenRouter as a gateway', harnesses: ['claude', 'codex'],
      baseUrl: 'https://openrouter.ai/api', models: ['claude-haiku-5-5', 'gpt-6-luna'], priceMultiplier: 1, apiKey: KEY!, enabled: true });
    const server = http.createServer((req, res) => {
      if (!req.url!.startsWith('/api/model-gateway')) { res.writeHead(404); res.end(); return; }
      void proxyModelGateway({ store, broker }, req, res, req.url!.slice('/api/model-gateway'.length));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/model-gateway`;
    try {
      const token = await issueGatewayToken(store, { gatewayId: gateway.id, harness: 'claude', organizationId: organization.id, projectId: project.id, taskId: task.id });
      const auth = { configHome: homes.gatewayHome('claude', organization.id), gateway: proxyTurnAuth(gateway, 'claude', 'claude-haiku-5-5', token, root) };
      const { written } = await turn(new ClaudeAdapter(), haiku, auth, 'b. Claude Code → proxy → OpenRouter');
      const costs = await store.db.prepare("SELECT costMicros, metadata FROM usage_events WHERE kind='agent.cost'").all() as any[];
      const booked = costs.reduce((total, row) => total + Number(row.costMicros), 0);
      report.push(`b. booked ${costs.length} requests, $${(booked / 1e6).toFixed(4)} at list price: ${costs.map((row) => JSON.parse(row.metadata).model).join(', ')}`);
      expect(written).toBe('Linux');
      expect(costs.length).toBeGreaterThan(0);
      expect(booked).toBeGreaterThan(0);

      if ((await spentSoFar()) > BUDGET_USD) return;
      const codexToken = await issueGatewayToken(store, { gatewayId: gateway.id, harness: 'codex', organizationId: organization.id, projectId: project.id, taskId: task.id });
      const codexAuth = { configHome: homes.gatewayHome('codex', organization.id), gateway: proxyTurnAuth(gateway, 'codex', 'gpt-6-luna', codexToken, root) };
      const before = costs.length;
      const codex = await turn(new CodexAdapter(), { ...haiku, provider: 'codex', model: 'gpt-6-luna' } as any, codexAuth, 'c. Codex → proxy → OpenRouter');
      const after = await store.db.prepare("SELECT costMicros, metadata FROM usage_events WHERE kind='agent.cost'").all() as any[];
      report.push(`c. booked ${after.length - before} Codex requests: $${(after.slice(before).reduce((t, r) => t + Number(r.costMicros), 0) / 1e6).toFixed(4)}`);
      expect(codex.written).toBe('Linux');
      expect(after.length).toBeGreaterThan(before);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await store.close();
    }
  }, 600_000);
});

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { bootHarness, type Harness } from '../tests/helpers/harness.js';
import { ServiceConnections, type ConnectionBackend } from '../src/integrations/service-connections.js';
import { platformToolHandlers } from '../src/agent/tools.js';
import { timed, timingReport, type TimingRow } from '../src/timing/index.js';
import type { AgentAdapter } from '../src/agent/types.js';

const scenarios = ['conversation', 'one-action', 'sequential-actions', 'parallel-actions'] as const;
export async function benchmarkLatency(repeats = 5) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) throw Error('repeats must be 1–100');
  let h: Harness | undefined;
  const rows: TimingRow[] = [];
  const samples: { scenario: string; mode: string; taskId: string; report: ReturnType<typeof timingReport> }[] = [];
  const oldGateway = process.env.KARMAX_GATEWAY_URL;
  const oldMemory = process.env.KARMAX_AGENT_MIN_FREE_MB;
  const oldLoad = process.env.KARMAX_AGENT_MAX_LOAD_FACTOR;
  // Isolated fixture has no model subprocess. Keep host load policy from
  // dominating repeatability; production reports retain real admission waits.
  process.env.KARMAX_AGENT_MIN_FREE_MB = '0'; process.env.KARMAX_AGENT_MAX_LOAD_FACTOR = '0';
  const endpoint = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume fixture request, never persist content */ }
    await new Promise(r => setTimeout(r, req.url === '/model' ? 5 : 8));
    res.setHeader('content-type', 'application/json'); res.end('{"ok":true}');
  });
  endpoint.listen(0, '127.0.0.1'); await once(endpoint, 'listening');
  const url = `http://127.0.0.1:${(endpoint.address() as any).port}`;
  const request = async (route: string) => {
    const response = await fetch(url + route, { method: 'POST', body: '{}' });
    if (!response.ok) throw Error('fixture HTTP failed');
    return response.json();
  };
  let connectionIds: string[] = [];
  const adapter: AgentAdapter = { provider: 'mock', async runTurn(input, ctx) {
    const scenario = input.messages.filter(m => m.role === 'user').at(-1)?.text ?? '';
    const model = () => timed('provider.fixture-roundtrip', () => request('/model'));
    await model();
    const handlers = platformToolHandlers(input.world, ctx);
    if (scenario !== 'conversation') {
      await handlers.search_connection_tools!({ connection_id: connectionIds[0], search: 'read fixture' });
      const action = (index: number) => handlers.execute_connection_tool!({ connection_id: connectionIds[index], tool: 'FIXTURE_READ', arguments: {} });
      if (scenario === 'one-action') await action(0);
      else if (scenario === 'parallel-actions') await Promise.all([0, 1, 2].map(action));
      else for (const index of [0, 1, 2]) { await action(index); await model(); }
      await model();
    }
    ctx.emitActivity({ id: `text-${input.messages.length}`, kind: 'message', phase: 'completed', title: 'Fixture complete' });
    ctx.onSession?.('fixture-session');
    return { termination: { kind: 'success', status: 'completed' }, output: 'Fixture complete', session: 'fixture-session' };
  } };
  try {
    h = await bootHarness('mock', adapter);
    const project = h.store.createProject('Latency fixture', { worldProvider: 'worktree', openGithubPr: false });
    let account = 0;
    const backend: ConnectionBackend = {
      catalog: async () => [{ slug: 'fixture', name: 'Fixture' }],
      authorize: async () => ({ id: `fixture-${++account}`, url: 'https://connect.composio.dev/fixture' }),
      active: async () => true, session: async () => 'fixture-session', disconnect: async () => {},
      tools: async () => { await request('/catalog'); return [{ slug: 'FIXTURE_READ', name: 'Read isolated fixture', inputParameters: { type: 'object' } }]; },
      execute: async () => request('/service'),
    };
    const service = new ServiceConnections(h.store, h.broker, () => backend);
    await service.configure('isolated-fixture-key');
    for (let i = 0; i < 3; i++) {
      const connected = await service.connect('org_personal', 'a', { toolkit: 'fixture' });
      const id = connected.connection.id; connectionIds.push(id);
      await service.refresh('org_personal', id); await service.share('org_personal', id, 'a', [project.id]);
    }
    const gateway = await h.startGateway({ serviceConnections: service });
    process.env.KARMAX_GATEWAY_URL = gateway.internalUrl;
    const token = h.tokens.mintPrincipal('user:a', ['*'], project.id).token;
    const api = async (route: string, body?: unknown) => {
      const response = await fetch(gateway.internalUrl + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result: any = await response.json();
      if (!response.ok) throw Error(`fixture gateway ${response.status}: ${result.error}`);
      return result;
    };
    const wait = async (taskId: string, count: number) => {
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        const report = timingReport(h!.store.eventsOfType(taskId, 'timing').map(e => e.payload as unknown as TimingRow));
        const view = h!.store.getTask(taskId)?.lastView;
        if (report.attempts.filter(a => a.status === 'ok').length >= count && view?.stage === 'review') return report;
        if (view?.status === 'failed') throw Error(`fixture task failed: ${taskId}`);
        await new Promise(r => setTimeout(r, 25));
      }
      throw Error(`fixture turn timed out: ${taskId}`);
    };
    for (let repeat = 0; repeat < repeats; repeat++) {
      // Rotate scenario order to avoid giving one scenario every initial warmup.
      for (let offset = 0; offset < scenarios.length; offset++) {
        const scenario = scenarios[(repeat + offset) % scenarios.length]!;
        const task = await api(`/api/projects/${project.id}/tasks`, { projectId: project.id, workflow: 'just-do', title: 'Latency fixture',
          prompt: scenario, params: { worldProvider: 'worktree', doProvider: 'mock' } });
        const taskId = task.id;
        const cold = await wait(taskId, 1);
        samples.push({ scenario, mode: 'fresh-world', taskId, report: cold });
        await api(`/api/tasks/${taskId}/signal`, { signal: 'followUp', text: scenario, role: 'do' });
        const warm = await wait(taskId, 2);
        const coldIds = new Set(cold.observations.map(r => r.id));
        samples.push({ scenario, mode: 'reused-world-resumed-fixture', taskId,
          report: timingReport(warm.observations.filter(r => !coldIds.has(r.id))) });
        rows.push(...warm.observations);
        await api(`/api/tasks/${taskId}/signal`, { signal: 'cancel' });
        await h.client.workflow.getHandle(taskId).result().catch(() => {});
      }
    }
    const groups = scenarios.flatMap(scenario => ['fresh-world', 'reused-world-resumed-fixture'].map(mode => {
      const observations = samples.filter(s => s.scenario === scenario && s.mode === mode).flatMap(s => s.report.observations);
      const report = timingReport(observations);
      return { scenario, mode, attempts: report.attempts.length, firstResponse: report.requestFirstResponse,
        completion: report.requestCompletion, activityFirstResponse: report.firstResponse, activityCompletion: report.completion };
    }));
    return { kind: 'isolated-fixture', environment: { node: process.version, platform: process.platform,
      arch: process.arch, cpus: os.availableParallelism(), repeats, collectedAt: new Date().toISOString() },
      limitations: ['Real gateway, Temporal, SQLite, local git world, runtime and managed-connection path.',
        'Scripted model; loopback HTTP delays: model 5ms, discovery/action 8ms. Not real model or service performance.',
        'Fresh means a new local world/session; worker, gateway and service fixture are already running.',
        'Resumed means reused world plus a scripted session marker, not a real provider cache.',
        'Parallel actions use three distinct fixture accounts; sequential runs include model continuations.',
        'Host memory/load gates disabled in this isolated run. No browser is attached. No Grok Bot measurements.'],
      groups, report: timingReport(rows) };
  } finally {
    await h?.stop(); endpoint.closeAllConnections(); await new Promise<void>(r => endpoint.close(() => r()));
    for (const [key, value] of Object.entries({ KARMAX_GATEWAY_URL: oldGateway,
      KARMAX_AGENT_MIN_FREE_MB: oldMemory, KARMAX_AGENT_MAX_LOAD_FACTOR: oldLoad })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await benchmarkLatency(Number(process.argv[2] ?? 5));
  const output = process.argv[3];
  if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, report: undefined }, null, 2));
}
